import threading
import time
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[1]))

from analysis_service.persistence import AnalysisPersistenceWorker, _dsn


class DashboardPersistenceQueueTests(unittest.TestCase):
    def test_database_url_is_a_safe_rotation_fallback(self):
        with patch.dict(
            "os.environ",
            {
                "ANALYSIS_DATABASE_URL": "",
                "ORACLE_DATABASE_URL": "",
                "DATABASE_URL": "postgresql://fallback/db",
            },
            clear=False,
        ):
            self.assertEqual(_dsn(), "postgresql://fallback/db")

    def _worker_with_dashboard_thread(self, **kwargs):
        worker = AnalysisPersistenceWorker(**kwargs)
        # Starting the complete outbox poller would require a live PostgreSQL
        # connection.  The dashboard writer is independent, so these tests
        # start only that bounded queue consumer.
        thread = threading.Thread(target=worker._dashboard_run, daemon=True)
        worker._dashboard_threads = [thread]
        thread.start()
        return worker

    def test_enqueue_copies_small_snapshot_not_large_dataset(self):
        worker = AnalysisPersistenceWorker(dashboard_queue_size=1)
        worker._dashboard_threads = [object()]
        dataset = {
            "village": "Desa Uji",
            "monthStart": "2026-08-01",
            "children": [{"id": "child-1"}],
        }
        result = {"D": 1}

        self.assertTrue(worker.enqueue_dashboard(dataset, result))
        dataset["village"] = "Desa Berubah"
        result["D"] = 99
        queued_dataset, queued_result = worker._dashboard_queue.get_nowait()
        worker._dashboard_queue.task_done()

        self.assertEqual(queued_dataset["village"], "Desa Uji")
        self.assertNotIn("children", queued_dataset)
        self.assertEqual(queued_result["D"], 1)

    def test_full_queue_is_non_blocking_and_reported(self):
        worker = AnalysisPersistenceWorker(dashboard_queue_size=1)
        worker._dashboard_threads = [object()]
        dataset = {"monthStart": "2026-08-01", "monthEnd": "2026-08-31"}

        self.assertTrue(worker.enqueue_dashboard(dataset, {"D": 1}))
        started = time.monotonic()
        with self.assertLogs("eposyandu.analysis.persistence", level="WARNING") as logs:
            self.assertFalse(worker.enqueue_dashboard(dataset, {"D": 2}))
        self.assertLess(time.monotonic() - started, 0.1)
        self.assertTrue(any("antrean snapshot dashboard penuh" in message for message in logs.output))
        self.assertEqual(worker.stats()["dashboardDropped"], 1)

    def test_background_writer_drains_queue_and_retries_transient_failure(self):
        worker = self._worker_with_dashboard_thread(dashboard_queue_size=2)
        calls = []
        completed = threading.Event()

        def persist(dataset, result):
            calls.append((dataset, result))
            if len(calls) == 1:
                raise RuntimeError("database sementara tidak tersedia")
            completed.set()

        worker.persist_dashboard = persist
        try:
            with self.assertLogs("eposyandu.analysis.persistence", level="WARNING") as logs:
                self.assertTrue(worker.enqueue_dashboard({"monthStart": "2026-08-01"}, {"D": 1}))
                self.assertTrue(completed.wait(timeout=2))
            self.assertEqual(len(calls), 2)
            self.assertTrue(any("mencoba lagi" in message for message in logs.output))
            self.assertEqual(worker.stats()["dashboardFailed"], 0)
        finally:
            worker.stop()

    def test_process_batch_is_bounded_and_continues_after_failed_child(self):
        worker = AnalysisPersistenceWorker(dsn="postgresql://unused", batch_size=2)
        jobs = [{"id": 1}, {"id": 2}, {"id": 3}]
        worker._claim_one = Mock(side_effect=jobs)
        worker._process = Mock(side_effect=[None, RuntimeError("bad child")])
        worker._fail = Mock()

        with self.assertLogs("eposyandu.analysis.persistence", level="ERROR"):
            result = worker.process_batch()

        self.assertEqual(result["processedCount"], 1)
        self.assertEqual(result["failedCount"], 1)
        self.assertTrue(result["processed"])
        self.assertTrue(result["failed"])
        self.assertEqual(worker._claim_one.call_count, 2)
        worker._fail.assert_called_once_with(2, "bad child")


if __name__ == "__main__":
    unittest.main()
