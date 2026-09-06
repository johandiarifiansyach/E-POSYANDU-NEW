"""Asynchronous PostgreSQL projection owned by the Python analysis service.

Raw writes are deliberately not coupled to this worker: Rust commits the
source row first and the database trigger places a child in ``analysis_outbox``.
This worker claims one job at a time, calculates every WHO/ML/longitudinal
field in Python, and stores the derived result for fast Rust/Redis reads.  The
module is optional in local unit tests; production enables it explicitly.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
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
    return (os.environ.get("ANALYSIS_DATABASE_URL") or os.environ.get("ORACLE_DATABASE_URL") or "").strip()


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


def _notify_interval() -> float:
    """Throttle realtime/cache notifications during a large backfill."""

    try:
        configured = float(os.environ.get("ANALYSIS_PERSISTENCE_NOTIFY_INTERVAL_SECONDS", "2"))
    except ValueError:
        configured = 2.0
    return max(0.25, configured)


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


class AnalysisPersistenceWorker:
    """Small bounded poller; PostgreSQL owns the durable queue.

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
    ) -> None:
        self.dsn = (dsn or _dsn()).strip()
        self.interval = interval if interval is not None else _interval()
        self.workers = max(1, min(8, int(workers or _workers())))
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._counter_lock = threading.Lock()
        self._notify_lock = threading.Lock()
        self._last_notify = 0.0
        self.notify_interval = _notify_interval()
        self.processed = 0
        self.failed = 0

    @classmethod
    def from_env(cls) -> "AnalysisPersistenceWorker | None":
        if not _enabled() or not _dsn():
            return None
        if psycopg is None:
            LOGGER.error("ANALYSIS_PERSISTENCE_ENABLED aktif tetapi psycopg belum terpasang")
            return None
        return cls(workers=_workers())

    def start(self) -> None:
        if self._threads:
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
        for thread in self._threads:
            thread.start()
        LOGGER.info(
            "worker persistence Python aktif; workers=%s interval=%ss",
            self.workers,
            self.interval,
        )

    def stop(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5)
        self._threads = []

    def stats(self) -> dict[str, int]:
        return {"processed": self.processed, "failed": self.failed, "workers": self.workers}

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
            job = None
            try:
                job = self._claim_one()
                if job is None:
                    self._stop.wait(self.interval)
                    continue
                self._process(job)
                with self._counter_lock:
                    self.processed += 1
            except Exception as error:  # a bad row must not kill the long-lived worker
                with self._counter_lock:
                    self.failed += 1
                LOGGER.exception("job analisis Python gagal")
                if job is not None:
                    self._fail(int(job["id"]), str(error))
                self._stop.wait(self.interval)

    def _fail(self, job_id: int, message: str) -> None:
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        update public.analysis_outbox
                        set status = case when attempts >= 5 then 'failed' else 'pending' end,
                            available_at = timezone('utc', now()) + interval '5 seconds',
                            last_error = left(%s, 1000), updated_at = timezone('utc', now())
                        where id = %s
                        """,
                        (message, job_id),
                    )
        except Exception:
            LOGGER.exception("job analisis tidak dapat ditandai gagal")

    def _connect(self):
        if psycopg is None:  # pragma: no cover
            raise RuntimeError("psycopg tidak tersedia")
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def _claim_one(self) -> dict[str, Any] | None:
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
        # Rebuild the complete child projection atomically for every queued
        # child job.  This also removes a previously stored result when a
        # measurement is deleted or becomes incomplete, preventing stale WHO
        # or N/T/O/B values from surviving a raw-data edit.
        cur.execute("delete from public.measurement_analysis where child_id = %s", (child["id"],))
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
        for row, item, history in prepared:
            result = ml.analyze_item(item, history)
            result["analysisScopeVersion"] = scope_version
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
            fingerprint = payload_fingerprint({"child": child["id"], "measurement": row, "history": history})
            cur.execute(
                """
                insert into public.measurement_analysis(
                  measurement_id, child_id, bbu_status, tbu_status, bbtb_status,
                  imtu_status, lila_status, lk_status, bbu_z_score, tbu_z_score,
                  bbtb_z_score, imtu_z_score, lila_z_score, lk_z_score,
                  weight_gain_status, weight_gain_minimum_grams,
                  exclusive_breastfeeding_status, result_json, source_fingerprint,
                  source_updated_at, analysis_version, calculated_at
                ) values (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s::jsonb, %s, %s,
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
                  source_updated_at = excluded.source_updated_at, analysis_version = excluded.analysis_version,
                  calculated_at = excluded.calculated_at
                """,
                (
                    row["id"], child["id"], result.get("bbu_status"), result.get("tbu_status"),
                    result.get("bbtb_status"), result.get("imtu_status"), result.get("lila_status"),
                    result.get("lk_status"), result.get("bbu_z_score"), result.get("tbu_z_score"),
                    result.get("bbtb_z_score"), result.get("imtu_z_score"), result.get("lila_z_score"),
                    result.get("lk_z_score"), result.get("weight_gain_status"),
                    result.get("weight_gain_minimum_grams"), result.get("exclusive_breastfeeding_status"),
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")), fingerprint,
                    _updated_at(row),
                ),
            )


def start_persistence_worker() -> AnalysisPersistenceWorker | None:
    worker = AnalysisPersistenceWorker.from_env()
    if worker is not None:
        worker.start()
    return worker
