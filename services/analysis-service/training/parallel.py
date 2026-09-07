"""Small bounded helpers for offline-only batch parallelism.

The online gRPC service deliberately does not create a process pool.  Training
and large cohort parsing are isolated jobs, where a bounded ProcessPoolExecutor
can use multiple CPU cores without holding the request path or the database
worker hostage.
"""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from typing import Callable, Iterable, TypeVar


T = TypeVar("T")
R = TypeVar("R")


def map_processes(function: Callable[[T], R], values: Iterable[T], workers: int = 1) -> list[R]:
    """Map an offline batch with a bounded process pool when requested."""

    batch = list(values)
    worker_count = max(1, min(8, int(workers or 1)))
    if worker_count == 1 or len(batch) < 2:
        return [function(value) for value in batch]
    chunksize = max(1, len(batch) // (worker_count * 4))
    with ProcessPoolExecutor(max_workers=worker_count) as pool:
        return list(pool.map(function, batch, chunksize=chunksize))
