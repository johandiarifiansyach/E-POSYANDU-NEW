"""Asynchronous PostgreSQL projection owned by the Python analysis service.

Raw writes are deliberately not coupled to this worker: Rust commits the
source row first and the database trigger places a child in ``analysis_outbox``.
This worker claims bounded batches, calculates every WHO/ML/longitudinal field
in Python, and stores the derived result for fast Rust/Redis reads. Production
uses a Rust scheduler that is woken by PostgreSQL LISTEN/NOTIFY with polling as
a safety-net; the module is optional in local unit tests.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from . import analytics, ml
from .runtime import payload_fingerprint

LOGGER = logging.getLogger("eposyandu.analysis.persistence")

try:  # psycopg is kept out of lightweight calculator tests.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - exercised only in minimal test images
    psycopg = None  # type: ignore[assignment]
    dict_row = None  # type: ignore[assignment]


def _enabled() -> bool:
    return os.environ.get("ANALYSIS_PERSISTENCE_ENABLED", "false").strip().casefold() in {
        "1", "true", "yes", "on"
    }


def _dsn() -> str:
    # Keep the dedicated names as the production contract, but accept the
    # conventional DATABASE_URL as a safe fallback.  This is important during
    # rolling deployments where the Vault env file may still expose the
    # generic PostgreSQL name while the analysis container is restarted.
    return (
        os.environ.get("ANALYSIS_DATABASE_URL")
        or os.environ.get("ORACLE_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
        or ""
    ).strip()


def _requeue_failed_on_start() -> bool:
    """Whether one-time dead-letter recovery is enabled for this process."""

    return os.environ.get("ANALYSIS_REQUEUE_FAILED_ON_START", "true").strip().casefold() not in {
        "0", "false", "no", "off"
    }


def _interval() -> float:
    try:
        return max(0.25, float(os.environ.get("ANALYSIS_PERSISTENCE_INTERVAL_SECONDS", "1")))
    except ValueError:
        return 1.0


def _workers() -> int:
    """Return a conservative number of DB-backed persistence workers.

    The value is deliberately bounded.  Each worker opens one short-lived
    PostgreSQL connection and recomputes one child's projection, so a small
    amount of parallelism removes the backfill bottleneck without allowing a
    slow host to exhaust its connection or CPU budget.
    """

    try:
        configured = int(os.environ.get("ANALYSIS_PERSISTENCE_WORKERS", "2"))
    except ValueError:
        configured = 2
    return max(1, min(8, configured))


def _batch_size() -> int:
    """Return the bounded number of outbox jobs handled per scheduler wake."""

    try:
        configured = int(os.environ.get("ANALYSIS_PERSISTENCE_BATCH_SIZE", "8"))
    except ValueError:
        configured = 8
    return max(1, min(32, configured))


def _retry_backoff_base_seconds() -> float:
    try:
        configured = float(
            os.environ.get("ANALYSIS_PERSISTENCE_RETRY_BASE_SECONDS", "2")
        )
    except ValueError:
        configured = 2.0
    return max(0.25, min(60.0, configured))


def _retry_backoff_max_seconds() -> float:
    try:
        configured = float(
            os.environ.get("ANALYSIS_PERSISTENCE_RETRY_MAX_SECONDS", "300")
        )
    except ValueError:
        configured = 300.0
    return max(1.0, min(3600.0, configured))


def _notify_interval() -> float:
    """Throttle realtime/cache notifications during a large backfill."""

    try:
        configured = float(os.environ.get("ANALYSIS_PERSISTENCE_NOTIFY_INTERVAL_SECONDS", "2"))
    except ValueError:
        configured = 2.0
    return max(0.25, configured)


def _dashboard_workers() -> int:
    """Return the number of short dashboard-snapshot writer threads.

    Snapshot writes are intentionally kept separate from child projection
    workers.  One writer is normally enough because each write is a small
    aggregate row; the upper bound prevents a busy dashboard from consuming
    all PostgreSQL connections on a constrained host.
    """

    try:
        configured = int(os.environ.get("ANALYSIS_DASHBOARD_WRITE_WORKERS", "1"))
    except ValueError:
        configured = 1
    return max(1, min(4, configured))


def _dashboard_queue_size() -> int:
    """Return a bounded queue capacity for non-blocking snapshot writes."""

    try:
        configured = int(os.environ.get("ANALYSIS_DASHBOARD_WRITE_QUEUE_SIZE", "32"))
    except ValueError:
        configured = 32
    return max(1, min(256, configured))


def _scope_key(child: dict[str, Any] | None) -> str:
    if not child:
        return "global"
    village = str(child.get("village") or "").strip() or "-"
    posyandu = str(child.get("posyandu") or "").strip() or "-"
    return f"{village}/{posyandu}"


def dashboard_scope_key(dataset: dict[str, Any]) -> str:
    village = str(dataset.get("village") or "").strip()
    posyandu = str(dataset.get("posyandu") or "").strip()
    if not village and not posyandu:
        return "global"
    return f"{village or '-'}/{posyandu or '-'}"


def dashboard_cache_key(dataset: dict[str, Any]) -> str:
    # Bump the persisted snapshot namespace whenever dashboard semantics
    # change. This invalidates older aggregates without deleting them and
    # keeps Rust's read key in lockstep with the Python writer.
    return "dashboard:v3|{}|{}|{}|{}|{}|age:{}".format(
        dashboard_scope_key(dataset),
        str(dataset.get("monthStart") or "")[:10],
        str(dataset.get("monthEnd") or "")[:10],
        str(dataset.get("previousMonthStart") or "")[:10],
        str(dataset.get("previousMonthEnd") or "")[:10],
        str(dataset.get("ageGroup") or "0-59"),
    )


def _updated_at(row: dict[str, Any]) -> Any:
    value = row.get("updated_at")
    if value is not None:
        return value
    return datetime.now(timezone.utc)


def _as_measurement(child: dict[str, Any], row: dict[str, Any]) -> dict[str, Any] | None:
    return analytics._measurement_for_analysis(child, row)


def _row_version(row: dict[str, Any] | None) -> int:
    """Read the monotonic source version added by the sync-versioning schema."""

    if not row:
        return 0
    try:
        value = int(row.get("version") or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, value)


def _source_version(
    child: dict[str, Any],
    measurements: list[dict[str, Any]],
    source_context: dict[str, Any] | None,
) -> int:
    """Return the newest raw version participating in one child projection.

    The version is scoped to the child rather than the global dashboard.  A
    write for another child therefore cannot invalidate this child's rows.
    The input hash below remains the source of truth for deciding whether a
    calculation can be reused; this version is persisted for observability,
    replay diagnostics, and idempotent writes.
    """

    versions = [_row_version(child)]
    versions.extend(_row_version(row) for row in measurements)
    for key in ("mpasi", "pmtPrograms", "pmtMonitorings"):
        versions.extend(_row_version(row) for row in (source_context or {}).get(key, []))
    return max(1, max(versions, default=0))


def _source_context_hash(source_context: dict[str, Any] | None) -> str:
    """Fingerprint child-scoped ASI/MPASI/PMT inputs once per worker job."""

    if not source_context:
        return payload_fingerprint({})
    # Keep the full child-scoped rows in the hash so a changed MPASI/PMT
    # answer invalidates the projection even when its row count is unchanged.
    return payload_fingerprint(source_context)


def _analysis_input_hash(
    child: dict[str, Any],
    item: dict[str, Any],
    history: list[dict[str, Any]],
    source_context_hash: str,
) -> str:
    """Build the deterministic, non-identifying input key for one result."""

    child_context = {
        "id": child.get("id"),
        "birthDate": child.get("birth_date", child.get("birthDate", child.get("tglLahir"))),
        "sex": child.get("sex", child.get("jk")),
        "gestationalAgeWeeks": child.get(
            "gestational_age_weeks",
            child.get("gestationalAgeWeeks", child.get("usiaKehamilan")),
        ),
    }
    return payload_fingerprint(
        {
            "child": child_context,
            "measurement": item,
            "history": history,
            "sourceContext": source_context_hash,
        }
    )


class AnalysisPersistenceWorker:
    """Bounded outbox worker; PostgreSQL owns the durable queue.

    A child job rebuilds that child's complete materialized projection.  The
    queue is therefore safe to consume with a small number of independent
    workers: PostgreSQL's ``FOR UPDATE SKIP LOCKED`` claim makes each job
    exclusive, while the coalescing pass below removes redundant pending
    measurement jobs left by the initial backfill.
    """

    def __init__(
        self,
        *,
        dsn: str | None = None,
        interval: float | None = None,
        workers: int | None = None,
        batch_size: int | None = None,
        dashboard_workers: int | None = None,
        dashboard_queue_size: int | None = None,
    ) -> None:
        self.dsn = (dsn or _dsn()).strip()
        self.interval = interval if interval is not None else _interval()
        self.workers = max(1, min(8, int(workers or _workers())))
        self.batch_size = max(1, min(32, int(batch_size or _batch_size())))
        self.retry_backoff_base_seconds = _retry_backoff_base_seconds()
        self.retry_backoff_max_seconds = max(
            self.retry_backoff_base_seconds, _retry_backoff_max_seconds()
        )
        self.dashboard_workers = max(
            1,
            min(4, int(dashboard_workers if dashboard_workers is not None else _dashboard_workers())),
        )
        self.dashboard_queue_size = max(
            1,
            min(
                256,
                int(
                    dashboard_queue_size
                    if dashboard_queue_size is not None
                    else _dashboard_queue_size()
                ),
            ),
        )
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._dashboard_threads: list[threading.Thread] = []
        self._dashboard_queue: queue.Queue[tuple[dict[str, Any], dict[str, Any]]] = queue.Queue(
            maxsize=self.dashboard_queue_size
        )
        self._counter_lock = threading.Lock()
        self._requeue_lock = threading.Lock()
        self._failed_jobs_requeued = False
        self._missing_projections_reconciled = False
        self._notify_lock = threading.Lock()
        self._last_notify = 0.0
        self.notify_interval = _notify_interval()
        self.processed = 0
        self.failed = 0
        self.dashboard_enqueued = 0
        self.dashboard_dropped = 0
        self.dashboard_failed = 0

    @classmethod
    def from_env(cls) -> "AnalysisPersistenceWorker | None":
        if not _enabled():
            return None
        if not _dsn():
            LOGGER.error(
                "ANALYSIS_PERSISTENCE_ENABLED aktif tetapi URL PostgreSQL tidak ditemukan "
                "(ANALYSIS_DATABASE_URL/ORACLE_DATABASE_URL/DATABASE_URL)"
            )
            return None
        if psycopg is None:
            LOGGER.error("ANALYSIS_PERSISTENCE_ENABLED aktif tetapi psycopg belum terpasang")
            return None
        return cls(workers=_workers())

    def start(self) -> None:
        if self._threads or self._dashboard_threads:
            return
        self._stop.clear()
        self._threads = [
            threading.Thread(
                target=self._run,
                name=f"analysis-persistence-{index}",
                daemon=True,
            )
            for index in range(1, self.workers + 1)
        ]
        self.start_dashboard_writers()
        for thread in self._threads:
            thread.start()
        LOGGER.info(
            "worker persistence Python aktif; workers=%s interval=%ss batch=%s dashboard_writers=%s dashboard_queue=%s",
            self.workers,
            self.interval,
            self.batch_size,
            self.dashboard_workers,
            self.dashboard_queue_size,
        )

    def start_dashboard_writers(self) -> None:
        """Start only dashboard snapshot writers for the embedded PyO3 mode.

        In the Rust/PyO3 deployment Rust owns the durable outbox polling loop;
        starting the full Python worker here would create a second scheduler
        competing for the same jobs.  Dashboard snapshots still need a
        background writer, so the embedded bridge starts this smaller subset.
        """

        if self._dashboard_threads:
            return
        self._stop.clear()
        self._dashboard_threads = [
            threading.Thread(
                target=self._dashboard_run,
                name=f"analysis-dashboard-writer-{index}",
                daemon=True,
            )
            for index in range(1, self.dashboard_workers + 1)
        ]
        for thread in self._dashboard_threads:
            thread.start()

    def stop(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5)
        for thread in self._dashboard_threads:
            thread.join(timeout=5)
        if not self._dashboard_queue.empty():
            LOGGER.warning(
                "%s snapshot dashboard masih berada di antrean saat worker dihentikan",
                self._dashboard_queue.qsize(),
            )
        self._threads = []
        self._dashboard_threads = []

    def stats(self) -> dict[str, int]:
        return {
            "processed": self.processed,
            "failed": self.failed,
            "workers": self.workers,
            "batchSize": self.batch_size,
            "dashboardWorkers": self.dashboard_workers,
            "dashboardQueueSize": self.dashboard_queue_size,
            "dashboardQueueDepth": self._dashboard_queue.qsize(),
            "dashboardEnqueued": self.dashboard_enqueued,
            "dashboardDropped": self.dashboard_dropped,
            "dashboardFailed": self.dashboard_failed,
        }

    def enqueue_dashboard(self, dataset: dict[str, Any], result: dict[str, Any]) -> bool:
        """Queue a dashboard snapshot without delaying the gRPC response.

        Only the metadata needed by ``persist_dashboard`` is copied.  The
        potentially large child/measurement arrays are therefore released as
        soon as the request returns instead of being retained by a background
        task.  A full queue is treated as a soft failure: the calculated
        response remains valid and a later request can enqueue a fresh
        snapshot.
        """

        if not self._dashboard_threads:
            LOGGER.warning("worker snapshot dashboard belum dimulai")
            with self._counter_lock:
                self.dashboard_dropped += 1
            return False
        snapshot_dataset = {
            key: dataset.get(key)
            for key in (
                "village",
                "posyandu",
                "monthStart",
                "monthEnd",
                "previousMonthStart",
                "previousMonthEnd",
                "ageGroup",
            )
        }
        try:
            self._dashboard_queue.put_nowait((snapshot_dataset, deepcopy(result)))
        except queue.Full:
            with self._counter_lock:
                self.dashboard_dropped += 1
            LOGGER.warning(
                "antrean snapshot dashboard penuh; hasil tetap dikirim tanpa menunggu penulisan PostgreSQL"
            )
            return False
        with self._counter_lock:
            self.dashboard_enqueued += 1
        return True

    def persist_dashboard(self, dataset: dict[str, Any], result: dict[str, Any]) -> None:
        """Store a Python dashboard response for direct Rust reads."""

        scope = dashboard_scope_key(dataset)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("select version from public.analysis_scope_versions where scope_key = %s", (scope,))
                version_row = cur.fetchone()
                if version_row is None:
                    cur.execute(
                        "insert into public.analysis_scope_versions(scope_key) values (%s) on conflict do nothing",
                        (scope,),
                    )
                    cur.execute("select version from public.analysis_scope_versions where scope_key = %s", (scope,))
                    version_row = cur.fetchone()
                version = int(version_row["version"] if version_row else 1)
                cur.execute(
                    """
                    insert into public.dashboard_analysis(
                      cache_key, scope_key, month_start, month_end,
                      previous_month_start, previous_month_end, village, posyandu,
                      result_json, source_scope_version
                    ) values (%s, %s, %s::date, %s::date, %s::date, %s::date, %s, %s, %s::jsonb, %s)
                    on conflict (cache_key) do update set
                      result_json = excluded.result_json,
                      source_scope_version = excluded.source_scope_version,
                      calculated_at = timezone('utc', now())
                    """,
                    (
                        dashboard_cache_key(dataset), scope,
                        str(dataset.get("monthStart") or "")[:10], str(dataset.get("monthEnd") or "")[:10],
                        str(dataset.get("previousMonthStart") or "")[:10], str(dataset.get("previousMonthEnd") or "")[:10],
                        dataset.get("village") or None, dataset.get("posyandu") or None,
                        json.dumps(result, ensure_ascii=False, separators=(",", ":")), version,
                    ),
                )

    def _dashboard_run(self) -> None:
        """Drain queued dashboard snapshots in the background.

        The queue is drained after the stop event is set so a normal process
        shutdown does not discard snapshots that were already accepted.  A
        short, bounded retry handles transient database/network failures while
        keeping the request path completely non-blocking.
        """

        while not self._stop.is_set() or not self._dashboard_queue.empty():
            try:
                dataset, result = self._dashboard_queue.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                for attempt in range(1, 4):
                    try:
                        self.persist_dashboard(dataset, result)
                        break
                    except Exception:
                        if attempt >= 3:
                            with self._counter_lock:
                                self.dashboard_failed += 1
                            LOGGER.exception(
                                "snapshot dashboard Python tidak dapat disimpan setelah %s percobaan",
                                attempt,
                            )
                            break
                        LOGGER.warning(
                            "snapshot dashboard gagal (percobaan %s/3), mencoba lagi",
                            attempt,
                            exc_info=True,
                        )
                        self._stop.wait(0.25 * attempt)
            finally:
                self._dashboard_queue.task_done()

    def _notify_analysis_updated(self, cur, child: dict[str, Any] | None) -> None:
        """Tell Rust/browser readers that a Python projection became fresh.

        Raw writes already invalidate Redis through Rust.  Materialized writes
        happen in this private worker, so a throttled PostgreSQL notification
        prevents a cached skeleton from surviving for its full TTL while also
        avoiding one SSE refresh per child during a backfill.
        """

        now = time.monotonic()
        with self._notify_lock:
            if now - self._last_notify < self.notify_interval:
                return
            self._last_notify = now
        payload = json.dumps(
            {
                "id": str(uuid.uuid4()),
                "resource": "measurements",
                "operation": "analysis_updated",
                "changedAt": datetime.now(timezone.utc).isoformat(),
                "village": child.get("village") if child else None,
                "posyandu": child.get("posyandu") if child else None,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        cur.execute("select pg_notify(%s, %s)", ("e_posyandu_realtime", payload))

    def _run(self) -> None:
        while not self._stop.is_set():
            processed = 0
            try:
                result = self.process_batch()
                processed = int(result["processedCount"])
                if not result["processed"]:
                    self._stop.wait(self.interval)
                    continue
            except Exception as error:  # a bad row must not kill the long-lived worker
                with self._counter_lock:
                    self.failed += 1
                LOGGER.exception("job analisis Python gagal")
                self._stop.wait(self.interval)
            else:
                with self._counter_lock:
                    self.processed += processed

    def process_batch(self, limit: int | None = None) -> dict[str, int | bool]:
        """Process a bounded batch of child jobs after one scheduler wake.

        Claiming remains exclusive in PostgreSQL, while batching the Python
        boundary avoids one PyO3/JSON call for every outbox row during mass
        input.  A failed child is requeued with backoff and does not prevent
        the remaining jobs in this batch from being attempted.
        """

        batch_limit = max(1, min(32, int(limit or self.batch_size)))
        processed = 0
        failed = 0
        for _ in range(batch_limit):
            job = self._claim_one()
            if job is None:
                break
            try:
                self._process(job)
                processed += 1
            except Exception as error:
                failed += 1
                LOGGER.exception("job analisis Python gagal; melanjutkan batch")
                self._fail(int(job["id"]), str(error))
        if failed:
            with self._counter_lock:
                self.failed += failed
        return {
            "processed": processed > 0,
            "processedCount": processed,
            "failedCount": failed,
            "failed": failed > 0,
        }

    def _fail(self, job_id: int, message: str) -> None:
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        update public.analysis_outbox
                        set status = case when attempts >= 5 then 'failed' else 'pending' end,
                            available_at = timezone('utc', now()) + least(
                                %s * power(2::double precision, greatest(attempts - 1, 0)::double precision),
                                %s
                            ) * interval '1 second',
                            last_error = left(%s, 1000), updated_at = timezone('utc', now())
                        where id = %s
                        """,
                        (
                            self.retry_backoff_base_seconds,
                            self.retry_backoff_max_seconds,
                            message,
                            job_id,
                        ),
                    )
        except Exception:
            LOGGER.exception("job analisis tidak dapat ditandai gagal")

    def _connect(self):
        if psycopg is None:  # pragma: no cover
            raise RuntimeError("psycopg tidak tersedia")
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def _claim_one(self) -> dict[str, Any] | None:
        # A previous worker deliberately dead-letters a job after five
        # attempts.  That is useful for malformed input, but it also strands
        # every job when a transient deployment issue (missing migration,
        # unavailable database, or stale image) is repaired later.  Requeue
        # failed child jobs once per process start so a healthy worker can
        # recover without an operator having to run SQL manually.  A job that
        # fails again still remains failed until the next controlled restart,
        # avoiding an endless hot loop for genuinely bad data.
        if (
            (_requeue_failed_on_start() and not self._failed_jobs_requeued)
            or not self._missing_projections_reconciled
        ):
            with self._requeue_lock:
                if _requeue_failed_on_start() and not self._failed_jobs_requeued:
                    self._requeue_failed_jobs()
                if not self._missing_projections_reconciled:
                    self._reconcile_missing_projections()

        with self._connect() as conn:
            with conn.cursor() as cur:
                # The original migration queued both every measurement and
                # every child.  Since a child job rebuilds the complete
                # projection, retaining all of those pending measurement
                # jobs can multiply the backlog by an order of magnitude.
                # Collapse pending jobs for a child to the newest one.  Do
                # not collapse while that child is actively being processed:
                # a write that arrived during processing still needs one
                # follow-up calculation.
                cur.execute(
                    """
                    with pending as (
                      select q.id, q.child_id,
                             row_number() over (
                               partition by q.child_id order by q.id desc
                             ) as position
                      from public.analysis_outbox q
                      where q.status = 'pending' and q.child_id is not null
                    )
                    update public.analysis_outbox q
                    set status = 'done',
                        last_error = 'coalesced: newer child analysis job retained',
                        updated_at = timezone('utc', now())
                    from pending p
                    where q.id = p.id
                      and p.position > 1
                      and not exists (
                        select 1
                        from public.analysis_outbox active
                        where active.status = 'processing'
                          and active.child_id = p.child_id
                      )
                    """
                )
                # A process restart must not strand a job claimed by a
                # previous worker forever.  Requeue only old claims; active
                # workers refresh ``updated_at`` when they finish the same
                # short transaction.
                cur.execute(
                    """
                    update public.analysis_outbox
                    set status = 'pending', available_at = timezone('utc', now()),
                        updated_at = timezone('utc', now())
                    where status = 'processing'
                      and updated_at < timezone('utc', now()) - interval '5 minutes'
                    """
                )
                cur.execute(
                    """
                    update public.analysis_outbox as target
                    set status = 'processing', attempts = attempts + 1,
                        updated_at = timezone('utc', now())
                    where target.id = (
                      select candidate.id from public.analysis_outbox candidate
                      where candidate.status = 'pending'
                        and candidate.available_at <= timezone('utc', now())
                        and not exists (
                          select 1
                          from public.analysis_outbox active
                          where active.status = 'processing'
                            and active.child_id = candidate.child_id
                        )
                      order by candidate.id
                      for update skip locked limit 1
                    )
                    returning target.id, target.entity_type, target.entity_id,
                              target.child_id, target.operation
                    """
                )
                return cur.fetchone()

    def _requeue_failed_jobs(self) -> None:
        """Move old failed child jobs back to the durable pending queue once."""

        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        update public.analysis_outbox
                        set status = 'pending', attempts = 0,
                            available_at = timezone('utc', now()),
                            last_error = null, updated_at = timezone('utc', now())
                        where status = 'failed'
                          and child_id is not null
                          and updated_at < timezone('utc', now()) - interval '30 seconds'
                        """
                    )
                    recovered = cur.rowcount
            self._failed_jobs_requeued = True
            if recovered:
                LOGGER.warning(
                    "%s job analisis gagal dipulihkan ke antrean pending setelah worker dimulai",
                    recovered,
                )
        except Exception:
            # Do not mark recovery complete when PostgreSQL is still
            # unavailable.  The next scheduler tick retries this lightweight
            # operation after the connection comes back.
            LOGGER.exception("job analisis gagal tidak dapat dipulihkan")

    def _reconcile_missing_projections(self) -> None:
        """Queue children that have usable measurements but no projection.

        This covers an interrupted first backfill or a deployment that marked
        an outbox row done before its transaction committed.  The query is
        deliberately run once per process start; normal writes continue to
        use the table triggers and therefore do not cause a full-database
        scan on every scheduler tick.
        """

        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        insert into public.analysis_outbox(entity_type, entity_id, child_id, operation)
                        select 'children', c.id, c.id, 'insert'
                        from public.children c
                        where c.deleted_at is null
                          and exists (
                            select 1
                            from public.measurements m
                            left join public.measurement_analysis a on a.measurement_id = m.id
                            where coalesce(m.child_id, nullif(m.legacy_child_id, '')) = c.id
                              and m.weight_kg is not null
                              and a.measurement_id is null
                          )
                          and not exists (
                            select 1
                            from public.analysis_outbox q
                            where q.child_id = c.id
                              and q.status in ('pending', 'processing')
                          )
                        """
                    )
                    queued = cur.rowcount
            self._missing_projections_reconciled = True
            if queued:
                LOGGER.warning(
                    "%s child dibuatkan job analisis karena proyeksi measurement_analysis belum ada",
                    queued,
                )
        except Exception:
            # Keep the flag false so a temporary database outage can recover
            # on the next scheduler tick.  Once successful this path never
            # scans the complete child population again until restart.
            LOGGER.exception("rekonsiliasi proyeksi analisis gagal")

    def _process(self, job: dict[str, Any]) -> None:
        entity_type = str(job["entity_type"])
        entity_id = str(job["entity_id"])
        child_id = job.get("child_id")
        with self._connect() as conn:
            with conn.cursor() as cur:
                child = None
                if child_id:
                    cur.execute("select * from public.children where id = %s", (child_id,))
                    child = cur.fetchone()
                if entity_type == "children" and not child and job["operation"] == "delete":
                    cur.execute("delete from public.measurement_analysis where child_id = %s", (child_id,))
                elif child:
                    cur.execute(
                        """
                        select * from public.measurements
                        where coalesce(child_id, nullif(legacy_child_id, '')) = %s
                        order by measurement_date, created_at, id
                        """,
                        (child_id,),
                    )
                    measurements = list(cur.fetchall())
                    cur.execute(
                        "select * from public.mpasi_logs where coalesce(child_id, nullif(legacy_child_id, '')) = %s order by monitoring_date, id",
                        (child_id,),
                    )
                    mpasi = list(cur.fetchall())
                    cur.execute(
                        """
                        select * from public.pmt_programs
                        where coalesce(child_id, nullif(legacy_child_id, '')) = %s
                        order by distribution_date, id
                        """,
                        (child_id,),
                    )
                    pmt_programs = list(cur.fetchall())
                    pmt_monitorings: list[dict[str, Any]] = []
                    if pmt_programs:
                        cur.execute(
                            """
                            select m.* from public.pmt_monitorings m
                            join public.pmt_programs p on p.id = m.program_id
                            where coalesce(p.child_id, nullif(p.legacy_child_id, '')) = %s
                            order by m.monitoring_date, m.program_id, m.week_number
                            """,
                            (child_id,),
                        )
                        pmt_monitorings = list(cur.fetchall())
                    self._write_child_results(
                        cur,
                        child,
                        measurements,
                        {
                            "mpasi": mpasi,
                            "pmtPrograms": pmt_programs,
                            "pmtMonitorings": pmt_monitorings,
                        },
                    )
                    self._notify_analysis_updated(cur, child)

                cur.execute(
                    """
                    update public.analysis_outbox
                    set status = 'done', last_error = null, updated_at = timezone('utc', now())
                    where id = %s
                    """,
                    (job["id"],),
                )

    def _write_child_results(
        self,
        cur,
        child: dict[str, Any],
        measurements: list[dict[str, Any]],
        source_context: dict[str, Any] | None = None,
    ) -> None:
        # Normalize each historical row once.  The old implementation called
        # ``_as_measurement`` once for every pair of rows, which made a child
        # with a long history needlessly quadratic before WHO calculation even
        # started.  History lists are still passed in full so ASI and trend
        # semantics remain unchanged.
        normalized = [
            (row, _as_measurement(child, row))
            for row in measurements
        ]
        history_rows = [
            (row["id"], historical)
            for row, historical in normalized
            if historical
            and (
                historical.get("weight_kg") is not None
                or historical.get("exclusive_breastfeeding") is not None
            )
        ]
        prepared: list[tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]] = []
        for row, item in normalized:
            if not item or item.get("weight_kg") is None:
                continue
            history = [
                historical
                for measurement_id, historical in history_rows
                if measurement_id != row["id"]
            ]
            prepared.append((row, item, history))

        scope = _scope_key(child)
        cur.execute(
            "insert into public.analysis_scope_versions(scope_key) values (%s) on conflict do nothing",
            (scope,),
        )
        cur.execute("select version from public.analysis_scope_versions where scope_key = %s", (scope,))
        scope_version = (cur.fetchone() or {"version": 1})["version"]

        # Read the existing projection before writing.  A replayed outbox job
        # now becomes a cheap comparison instead of deleting and recalculating
        # every historical row for the child.  ``source_fingerprint`` is kept
        # as a compatibility fallback for rows created before input_hash was
        # introduced by migration 043.
        cur.execute(
            """
            select measurement_id, input_hash, source_fingerprint,
                   source_version, analysis_version
            from public.measurement_analysis
            where child_id = %s
            """,
            (child["id"],),
        )
        existing = {
            str(result["measurement_id"]): result
            for result in cur.fetchall()
        }
        source_version = _source_version(child, measurements, source_context)
        source_context_hash = _source_context_hash(source_context)
        current_ids: set[str] = set()
        for row, item, history in prepared:
            measurement_id = str(row["id"])
            current_ids.add(measurement_id)
            fingerprint = _analysis_input_hash(child, item, history, source_context_hash)
            previous = existing.get(measurement_id)
            previous_hash = (previous or {}).get("input_hash") or (previous or {}).get("source_fingerprint")

            if previous is not None and previous_hash == fingerprint:
                # The raw source version may move because a non-clinical field
                # changed. Keep the projection's version metadata current but
                # preserve analysis_version and, most importantly, skip the
                # WHO/ML calculation entirely.
                if (previous.get("source_version") or 0) != source_version:
                    cur.execute(
                        """
                        update public.measurement_analysis
                        set source_version = %s, source_updated_at = %s
                        where measurement_id = %s and child_id = %s
                        """,
                        (source_version, _updated_at(row), row["id"], child["id"]),
                    )
                continue

            result = ml.analyze_item(item, history)
            result["analysisScopeVersion"] = scope_version
            result["analysisSourceVersion"] = source_version
            # MPASI/PMT and change-history writes trigger the same child job.
            # Keep a compact, non-identifying context marker with the derived
            # result so downstream education/ML versions can consume it
            # without another full-table read.
            if source_context:
                result["sourceContext"] = {
                    "mpasiRows": len(source_context.get("mpasi", [])),
                    "pmtPrograms": len(source_context.get("pmtPrograms", [])),
                    "pmtMonitorings": len(source_context.get("pmtMonitorings", [])),
                }
            cur.execute(
                """
                insert into public.measurement_analysis(
                  measurement_id, child_id, bbu_status, tbu_status, bbtb_status,
                  imtu_status, lila_status, lk_status, bbu_z_score, tbu_z_score,
                  bbtb_z_score, imtu_z_score, lila_z_score, lk_z_score,
                  weight_gain_status, weight_gain_minimum_grams,
                  exclusive_breastfeeding_status, result_json, source_fingerprint,
                  input_hash, source_version, source_updated_at,
                  analysis_version, calculated_at
                ) values (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s::jsonb, %s, %s, %s, %s,
                  nextval('public.analysis_result_version_seq'), timezone('utc', now())
                )
                on conflict (measurement_id) do update set
                  child_id = excluded.child_id, bbu_status = excluded.bbu_status,
                  tbu_status = excluded.tbu_status, bbtb_status = excluded.bbtb_status,
                  imtu_status = excluded.imtu_status, lila_status = excluded.lila_status,
                  lk_status = excluded.lk_status, bbu_z_score = excluded.bbu_z_score,
                  tbu_z_score = excluded.tbu_z_score, bbtb_z_score = excluded.bbtb_z_score,
                  imtu_z_score = excluded.imtu_z_score, lila_z_score = excluded.lila_z_score,
                  lk_z_score = excluded.lk_z_score, weight_gain_status = excluded.weight_gain_status,
                  weight_gain_minimum_grams = excluded.weight_gain_minimum_grams,
                  exclusive_breastfeeding_status = excluded.exclusive_breastfeeding_status,
                  result_json = excluded.result_json, source_fingerprint = excluded.source_fingerprint,
                  input_hash = excluded.input_hash, source_version = excluded.source_version,
                  source_updated_at = excluded.source_updated_at,
                  analysis_version = excluded.analysis_version, calculated_at = excluded.calculated_at
                """,
                (
                    row["id"], child["id"], result.get("bbu_status"), result.get("tbu_status"),
                    result.get("bbtb_status"), result.get("imtu_status"), result.get("lila_status"),
                    result.get("lk_status"), result.get("bbu_z_score"), result.get("tbu_z_score"),
                    result.get("bbtb_z_score"), result.get("imtu_z_score"), result.get("lila_z_score"),
                    result.get("lk_z_score"), result.get("weight_gain_status"),
                    result.get("weight_gain_minimum_grams"), result.get("exclusive_breastfeeding_status"),
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")), fingerprint,
                    fingerprint, source_version, _updated_at(row),
                ),
            )

        # Remove projections for deleted/incomplete measurements, but leave
        # unchanged valid rows untouched. This keeps the materialized table
        # exact without the previous delete-and-rebuild write amplification.
        if current_ids:
            cur.execute(
                """
                delete from public.measurement_analysis
                where child_id = %s
                  and not (measurement_id = any(%s::text[]))
                """,
                (child["id"], list(current_ids)),
            )
        else:
            cur.execute("delete from public.measurement_analysis where child_id = %s", (child["id"],))


def start_persistence_worker() -> AnalysisPersistenceWorker | None:
    worker = AnalysisPersistenceWorker.from_env()
    if worker is not None:
        worker.start()
    return worker
