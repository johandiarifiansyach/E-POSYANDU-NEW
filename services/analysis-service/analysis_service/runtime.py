"""Runtime controls for scalable dataset analysis.

The analysis service is intentionally stateful at process scope.  WHO tables
are immutable, so repeated dashboard requests can reuse a bounded in-memory
result cache while a per-assessment cache lets unchanged children skip the
expensive WHO/ML pass.  Dataset requests are executed by a small bounded
worker queue so bursts cannot create an unbounded number of analysis tasks.

Only aggregate dashboard responses are cached here.  Child/table responses
contain identifying data and are therefore not retained by this runtime cache.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import Any, Callable, Generic, TypeVar


T = TypeVar("T")


def _positive_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def _non_negative_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(0.0, value)


def payload_fingerprint(payload: Any) -> str:
    """Return a stable, non-sensitive cache key for a JSON-compatible value."""

    encoded = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class TtlLruCache(Generic[T]):
    """Small thread-safe TTL/LRU cache with defensive copies."""

    def __init__(self, maxsize: int, ttl_seconds: float) -> None:
        self.maxsize = max(1, maxsize)
        self.ttl_seconds = max(0.0, ttl_seconds)
        self._values: OrderedDict[str, tuple[float, T]] = OrderedDict()
        self._lock = threading.RLock()
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def get(self, key: str) -> T | None:
        now = time.monotonic()
        with self._lock:
            entry = self._values.get(key)
            if entry is None:
                self.misses += 1
                return None
            expires_at, value = entry
            if self.ttl_seconds and expires_at <= now:
                self._values.pop(key, None)
                self.misses += 1
                return None
            self._values.move_to_end(key)
            self.hits += 1
            return copy.deepcopy(value)

    def set(self, key: str, value: T) -> None:
        # A zero TTL intentionally disables reuse rather than creating an
        # unbounded cache; useful for diagnostics and controlled benchmarks.
        expires_at = time.monotonic() + self.ttl_seconds
        with self._lock:
            if key in self._values:
                self._values.pop(key, None)
            self._values[key] = (expires_at, copy.deepcopy(value))
            self._values.move_to_end(key)
            while len(self._values) > self.maxsize:
                self._values.popitem(last=False)
                self.evictions += 1

    def clear(self) -> None:
        with self._lock:
            self._values.clear()
            self.hits = self.misses = self.evictions = 0

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "size": len(self._values),
                "maxsize": self.maxsize,
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
            }


class QueueFullError(RuntimeError):
    """Raised when the bounded analysis queue cannot accept more work."""


class BoundedWorkerQueue:
    """A fixed worker pool with explicit backpressure for dataset requests.

    Threads remain the default because they preserve the low-overhead PyO3
    path.  Standalone Python deployments can opt into processes when profiling
    shows CPU-bound batches are limited by the GIL; each process loads the
    immutable WHO tables once and receives only a picklable dataset payload.
    """

    def __init__(
        self,
        workers: int,
        queue_size: int,
        acquire_timeout: float = 1.0,
        mode: str = "thread",
    ) -> None:
        self.workers = max(1, workers)
        self.queue_size = max(0, queue_size)
        self.acquire_timeout = max(0.0, acquire_timeout)
        normalized_mode = str(mode or "thread").strip().casefold()
        self.mode = normalized_mode if normalized_mode in {"thread", "process"} else "thread"
        self._slots = threading.BoundedSemaphore(self.workers + self.queue_size)
        if self.mode == "process":
            self._executor = ProcessPoolExecutor(max_workers=self.workers)
        else:
            self._executor = ThreadPoolExecutor(
                max_workers=self.workers,
                thread_name_prefix="analysis-worker",
            )

    def run(self, function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        if not self._slots.acquire(timeout=self.acquire_timeout):
            raise QueueFullError("Antrean analisis Python sedang penuh.")
        if self.mode == "process":
            # Do not submit a bound method: the queue owns a semaphore and is
            # intentionally not picklable. Release the slot in this parent
            # process after the child result is available, including errors.
            try:
                future = self._executor.submit(function, *args, **kwargs)
                return future.result()
            finally:
                self._slots.release()
        try:
            future = self._executor.submit(self._execute, function, args, kwargs)
        except BaseException:
            self._slots.release()
            raise
        return future.result()

    def _execute(self, function: Callable[..., T], args: tuple[Any, ...], kwargs: dict[str, Any]) -> T:
        try:
            return function(*args, **kwargs)
        finally:
            self._slots.release()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)


class AnalysisRuntime:
    """Caching and worker policy for the gRPC dataset endpoint."""

    def __init__(
        self,
        *,
        dashboard_cache_size: int = 128,
        dashboard_cache_ttl: float = 15.0,
        worker_count: int = 2,
        queue_size: int = 16,
        queue_timeout: float = 1.0,
        worker_mode: str = "thread",
    ) -> None:
        self.dashboard_cache: TtlLruCache[dict[str, Any]] = TtlLruCache(
            dashboard_cache_size,
            dashboard_cache_ttl,
        )
        self.workers = BoundedWorkerQueue(
            worker_count,
            queue_size,
            queue_timeout,
            mode=worker_mode,
        )

    @classmethod
    def from_env(cls, *, worker_mode: str | None = None) -> "AnalysisRuntime":
        # Embedded PyO3 callers pass ``thread`` explicitly because forking a
        # process that owns an in-process CPython interpreter is unsupported.
        # Standalone Python/gRPC keeps the environment-controlled default.
        selected_worker_mode = (
            worker_mode
            if worker_mode is not None
            else os.environ.get("ANALYSIS_DATASET_WORKER_MODE", "thread")
        )
        return cls(
            dashboard_cache_size=_positive_int("ANALYSIS_DASHBOARD_CACHE_SIZE", 128),
            dashboard_cache_ttl=_non_negative_float("ANALYSIS_DASHBOARD_CACHE_TTL_SECONDS", 15.0),
            worker_count=_positive_int("ANALYSIS_DATASET_WORKERS", 2),
            queue_size=_positive_int("ANALYSIS_DATASET_QUEUE_SIZE", 16, minimum=0),
            queue_timeout=_non_negative_float("ANALYSIS_DATASET_QUEUE_TIMEOUT_SECONDS", 1.0),
            worker_mode=selected_worker_mode,
        )

    def analyze_dataset(
        self,
        dataset: dict[str, Any],
        *,
        payload_json: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Analyze a dataset and return ``(result, cache_hit)``.

        The fingerprint includes all raw rows and request parameters.  Any
        insert/update/delete therefore produces a new key automatically; the
        short TTL is an additional safety bound for external changes.
        """

        operation = str(dataset.get("operation") or "dashboard_stats")
        # The gRPC request already contains the canonical JSON payload.  Hash
        # it directly to avoid serializing a large dataset a second time.
        fingerprint = (
            hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
            if payload_json is not None
            else payload_fingerprint(dataset)
        )
        cache_key = f"{operation}:{fingerprint}"
        if operation == "dashboard_stats":
            cached = self.dashboard_cache.get(cache_key)
            if cached is not None:
                return cached, True

        result = self.workers.run(_analyze_dataset, dataset)
        if operation == "dashboard_stats":
            self.dashboard_cache.set(cache_key, result)
        return result, False

    def clear(self) -> None:
        self.dashboard_cache.clear()

    def stats(self) -> dict[str, Any]:
        return {
            "dashboard": self.dashboard_cache.stats(),
            "workers": {
                "count": self.workers.workers,
                "queueSize": self.workers.queue_size,
                "mode": self.workers.mode,
            },
        }

    def shutdown(self) -> None:
        self.workers.shutdown()


def _analyze_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    # Local import avoids a module cycle and keeps this policy module usable in
    # lightweight unit tests without importing the gRPC transport.
    from . import analytics, who

    # Process-pool children import this function lazily. Warm the immutable
    # lookup tables once in each child before handling its first dataset.
    who.preload_reference_tables()
    return analytics.analyze_dataset(dataset)
