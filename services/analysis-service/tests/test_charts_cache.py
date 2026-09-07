import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[1]))

from analysis_service import charts, who


class GrowthChartCacheTests(unittest.TestCase):
    def setUp(self):
        charts.clear_graph_cache()

    def tearDown(self):
        charts.clear_graph_cache()

    def _points(self):
        return [
            {
                "age_months": 12,
                "weight_kg": 8.2,
                "height_cm": 72.0,
                "measurement_date": "2025-01-01",
            }
        ]

    def test_identical_chart_request_reuses_svg(self):
        first = charts.render_growth_chart("bbu", "L", self._points(), child_name="Anak Uji")
        second = charts.render_growth_chart("bbu", "L", self._points(), child_name="Anak Uji")
        self.assertEqual(first, second)
        stats = charts.graph_cache_stats()
        self.assertEqual(stats["size"], 1)
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["misses"], 1)

    def test_changed_measurement_does_not_reuse_svg(self):
        charts.render_growth_chart("bbu", "L", self._points())
        changed = self._points()
        changed[0]["weight_kg"] = 8.3
        charts.render_growth_chart("bbu", "L", changed)
        self.assertEqual(charts.graph_cache_stats()["size"], 2)

    def test_cache_is_bounded_and_clearable(self):
        original_maxsize = charts._GRAPH_CACHE.maxsize
        charts._GRAPH_CACHE.maxsize = 1
        try:
            charts.render_growth_chart("bbu", "L", self._points())
            charts.render_growth_chart("tbu", "L", self._points())
            self.assertEqual(charts.graph_cache_stats()["size"], 1)
            charts.clear_graph_cache()
            self.assertEqual(charts.graph_cache_stats()["size"], 0)
        finally:
            charts._GRAPH_CACHE.maxsize = original_maxsize


class WhoNumericCacheTests(unittest.TestCase):
    def setUp(self):
        who._lms_z_score_cached.cache_clear()
        who.circumference_z_score.cache_clear()

    def test_repeated_lms_values_hit_numeric_cache(self):
        reference = [0.1, 8.0, 0.1]
        first = who.lms_z_score(8.2, reference)
        second = who.lms_z_score(8.2, reference)
        self.assertEqual(first, second)
        self.assertEqual(who._lms_z_score_cached.cache_info().hits, 1)


if __name__ == "__main__":
    unittest.main()
