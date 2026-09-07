"""Small, transport-free bridge used by the Rust/PyO3 analysis worker.

The public gRPC contract is implemented by the Rust service in
``services/analysis-worker``.  These functions deliberately accept and return
JSON so the Python modules remain reusable and the PyO3 boundary stays small.
Python still owns all WHO, longitudinal, education, chart, and persistence
logic; Rust only validates transport/authentication and schedules calls.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from . import analytics, charts, who
from .runtime import AnalysisRuntime

LOGGER = logging.getLogger("eposyandu.analysis.embedded")

_persistence_lock = threading.Lock()
_persistence_worker = None
_runtime_lock = threading.Lock()
_runtime = None


def _json_object(value: str, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} tidak valid: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} harus berupa objek JSON.")
    return parsed


def calculate_batch_json(payload_json: str) -> str:
    """Run the deterministic WHO/ML batch calculator and return JSON."""

    payload = _json_object(payload_json, "Permintaan batch")
    items = payload.get("items", [])
    if not isinstance(items, list):
        raise ValueError("items harus berupa array.")
    result = who.calculate_batch(items)
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def analyze_dataset_json(payload_json: str) -> str:
    """Run Python-owned dataset statistics/education aggregation."""

    dataset = _json_object(payload_json, "Dataset analisis")
    global _runtime
    if _runtime is None:
        with _runtime_lock:
            if _runtime is None:
                _runtime = AnalysisRuntime.from_env()
    result, _cache_hit = _runtime.analyze_dataset(dataset, payload_json=payload_json)
    persistence = _get_persistence_worker()
    if str(dataset.get("operation") or "dashboard_stats") == "dashboard_stats" and persistence is not None:
        # Dashboard materialization remains off the request path, exactly as
        # in the legacy Python gRPC server. Rust receives the response now and
        # the bounded Python writer stores the snapshot asynchronously.
        persistence.enqueue_dashboard(dataset, result)
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def render_growth_chart_json(payload_json: str) -> str:
    """Render a WHO chart through the existing Python SVG renderer."""

    request = _json_object(payload_json, "Permintaan grafik")
    chart_type = str(request.get("chart_type") or "")
    sex = str(request.get("sex") or "")
    points = request.get("points", [])
    if not isinstance(points, list):
        raise ValueError("points harus berupa array.")
    svg = charts.render_growth_chart(
        chart_type,
        sex,
        points,
        child_name=str(request.get("child_name") or ""),
        language=str(request.get("language") or "id"),
    )
    return json.dumps(
        {
            "chart_type": chart_type,
            "svg": svg,
            "standards_version": who.STANDARDS_VERSION,
            "renderer": "python-svg-who-lms-v1-pyo3",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _get_persistence_worker():
    """Create the durable outbox worker once per embedded Python runtime."""

    global _persistence_worker
    if _persistence_worker is not None:
        return _persistence_worker
    with _persistence_lock:
        if _persistence_worker is None:
            from .persistence import AnalysisPersistenceWorker

            _persistence_worker = AnalysisPersistenceWorker.from_env()
            if _persistence_worker is not None:
                # Rust owns outbox scheduling in PyO3 mode.  Start only the
                # non-blocking dashboard snapshot writers so materialized
                # aggregates are persisted without a second poller.
                _persistence_worker.start_dashboard_writers()
    return _persistence_worker


def process_outbox_once_json(_payload_json: str = "{}") -> str:
    """Claim and process at most one durable analysis job.

    The Rust worker owns the scheduling loop, while this one-shot function
    keeps PostgreSQL writes and retry semantics in the existing Python
    persistence implementation.  Returning a result instead of raising for a
    bad row prevents one malformed child from stopping the service loop.
    """

    worker = _get_persistence_worker()
    if worker is None:
        return json.dumps({"processed": False, "reason": "disabled"}, separators=(",", ":"))
    job = worker._claim_one()
    if job is None:
        return json.dumps({"processed": False}, separators=(",", ":"))
    job_id = int(job["id"])
    try:
        worker._process(job)
    except Exception as error:  # pragma: no cover - exercised against PostgreSQL
        LOGGER.exception("job analisis Python gagal")
        worker._fail(job_id, str(error))
        return json.dumps(
            {"processed": True, "failed": True, "jobId": job_id, "error": str(error)[:1000]},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return json.dumps({"processed": True, "jobId": job_id}, separators=(",", ":"))
