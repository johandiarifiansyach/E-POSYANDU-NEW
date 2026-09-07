import unittest
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))

from analysis_service.persistence import (
    _analysis_input_hash,
    _source_context_hash,
    _source_version,
)


class IncrementalAnalysisInputTests(unittest.TestCase):
    def setUp(self):
        self.child = {
            "id": "child-1",
            "birth_date": "2024-01-01",
            "sex": "L",
            "version": 3,
        }
        self.item = {
            "record_id": "measurement-1",
            "weight_kg": 8.2,
            "height_cm": 72.0,
            "age_months": 12,
            "sex": "L",
        }
        self.history = [self.item]

    def test_source_version_is_scoped_to_inputs(self):
        context = {
            "mpasi": [{"id": "mpasi-1", "version": 5}],
            "pmtPrograms": [{"id": "pmt-1", "version": 2}],
            "pmtMonitorings": [],
        }
        self.assertEqual(
            _source_version(self.child, [{"id": "measurement-1", "version": 4}], context),
            5,
        )
        self.assertEqual(_source_version({"id": "child-2"}, [], None), 1)

    def test_context_hash_changes_when_same_count_row_changes(self):
        first = {"mpasi": [{"id": "mpasi-1", "answer": "Ya"}]}
        changed = {"mpasi": [{"id": "mpasi-1", "answer": "Tidak"}]}
        self.assertNotEqual(_source_context_hash(first), _source_context_hash(changed))

    def test_input_hash_is_stable_and_detects_relevant_changes(self):
        context_hash = _source_context_hash({"mpasi": []})
        first = _analysis_input_hash(self.child, self.item, self.history, context_hash)
        again = _analysis_input_hash(self.child, dict(self.item), list(self.history), context_hash)
        changed = _analysis_input_hash(
            self.child,
            {**self.item, "weight_kg": 8.3},
            self.history,
            context_hash,
        )
        self.assertEqual(first, again)
        self.assertNotEqual(first, changed)

    def test_input_hash_excludes_unrelated_child_identity_fields(self):
        context_hash = _source_context_hash({"mpasi": []})
        first = _analysis_input_hash(self.child, self.item, self.history, context_hash)
        changed_name = {**self.child, "name": "Nama baru", "national_id": "NIK baru"}
        self.assertEqual(
            first,
            _analysis_input_hash(changed_name, self.item, self.history, context_hash),
        )


class _ProjectionCursor:
    """Minimal cursor double for the incremental projection decision."""

    def __init__(self, existing):
        self.existing = existing
        self.calls = []
        self._next = None

    def execute(self, statement, params=()):
        self.calls.append((statement, params))
        normalized = " ".join(statement.split()).lower()
        if normalized.startswith("select version from public.analysis_scope_versions"):
            self._next = {"version": 1}
        elif normalized.startswith("select measurement_id, input_hash"):
            self._next = self.existing
        else:
            self._next = None

    def fetchone(self):
        value = self._next
        self._next = None
        if isinstance(value, list):
            return value[0] if value else None
        return value

    def fetchall(self):
        value = self._next
        self._next = None
        return value if isinstance(value, list) else []


class IncrementalProjectionTests(unittest.TestCase):
    def test_replay_with_same_hash_skips_ml_and_preserves_existing_version(self):
        from analysis_service import persistence

        child = {
            "id": "child-1",
            "birth_date": "2024-01-01",
            "sex": "L",
            "version": 2,
            "village": "Desa Uji",
            "posyandu": "Pos 1",
        }
        row = {
            "id": "measurement-1",
            "measurement_date": "2025-01-01",
            "weight_kg": 8.2,
            "height_cm": 72.0,
            "version": 2,
        }
        item = persistence._as_measurement(child, row)
        self.assertIsNotNone(item)
        expected_hash = persistence._analysis_input_hash(
            child,
            item,
            [],
            persistence._source_context_hash({"mpasi": [], "pmtPrograms": [], "pmtMonitorings": []}),
        )
        cursor = _ProjectionCursor([
            {
                "measurement_id": "measurement-1",
                "input_hash": expected_hash,
                "source_fingerprint": expected_hash,
                "source_version": 2,
                "analysis_version": 91,
            }
        ])
        worker = persistence.AnalysisPersistenceWorker(dsn="postgresql://unused")
        with patch.object(persistence.ml, "analyze_item", side_effect=AssertionError("must be skipped")):
            worker._write_child_results(
                cursor,
                child,
                [row],
                {"mpasi": [], "pmtPrograms": [], "pmtMonitorings": []},
            )
        statements = [" ".join(statement.split()).lower() for statement, _ in cursor.calls]
        self.assertFalse(any(statement.startswith("insert into public.measurement_analysis") for statement in statements))
        self.assertTrue(any(statement.startswith("delete from public.measurement_analysis") for statement in statements))

    def test_changed_hash_recalculates_only_that_row(self):
        from analysis_service import persistence

        child = {"id": "child-1", "birth_date": "2024-01-01", "sex": "L", "version": 1}
        row = {
            "id": "measurement-1",
            "measurement_date": "2025-01-01",
            "weight_kg": 8.2,
            "height_cm": 72.0,
            "version": 2,
        }
        cursor = _ProjectionCursor([
            {
                "measurement_id": "measurement-1",
                "input_hash": "old-hash",
                "source_fingerprint": "old-hash",
                "source_version": 1,
                "analysis_version": 91,
            }
        ])
        worker = persistence.AnalysisPersistenceWorker(dsn="postgresql://unused")
        with patch.object(persistence.ml, "analyze_item", return_value={"bbu_status": "Berat Normal"}) as analyze:
            worker._write_child_results(
                cursor,
                child,
                [row],
                {"mpasi": [], "pmtPrograms": [], "pmtMonitorings": []},
            )
        analyze.assert_called_once()
        statements = [" ".join(statement.split()).lower() for statement, _ in cursor.calls]
        self.assertTrue(any(statement.startswith("insert into public.measurement_analysis") for statement in statements))


if __name__ == "__main__":
    unittest.main()
