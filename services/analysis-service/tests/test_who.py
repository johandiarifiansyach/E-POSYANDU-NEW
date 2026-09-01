import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from analysis_service import charts, ml, who


class WhoCalculatorTests(unittest.TestCase):
    def test_python_renderer_uses_same_who_tables_and_indonesian_labels(self):
        svg = charts.render_growth_chart(
            "bbu",
            "P",
            [{"age_months": 6, "weight_kg": 6.8, "measurement_date": "2026-08-01"}],
            child_name="Balita Uji",
        )
        self.assertTrue(svg.startswith("<svg "))
        self.assertIn("Berat Badan menurut Umur", svg)
        self.assertIn("Perempuan", svg)
        self.assertIn("Balita Uji", svg)
        self.assertIn("median", svg)
        self.assertIn("2026-08-01", svg)

    def test_python_renderer_supports_weight_for_length_and_missing_points(self):
        svg = charts.render_growth_chart(
            "bbtb",
            "L",
            [{"age_months": 12, "weight_kg": 8.0, "height_cm": 74.5, "measurement_method": "Terlentang"}],
        )
        self.assertIn("BB/PB", svg)
        self.assertIn("Panjang badan", svg)
        empty = charts.render_growth_chart("lilau", "L", [])
        self.assertIn("Belum ada titik pengukuran", empty)
        missing_weight = charts.render_growth_chart(
            "bbu", "L", [{"age_months": 12, "weight_kg": 0, "measurement_date": "2026-08-01"}]
        )
        self.assertNotIn("2026-08-01: 0.00 kg", missing_weight)

    def test_renderer_rejects_unknown_chart_or_language(self):
        with self.assertRaises(ValueError):
            charts.render_growth_chart("unknown", "L", [])
        with self.assertRaises(ValueError):
            charts.render_growth_chart("bbu", "L", [], language="en")

    def test_lms_medians_are_zero_z_score(self):
        self.assertLess(abs(who.lms_z_score(3.3464, [0.3487, 3.3464, 0.14602])), 1e-10)
        self.assertLess(abs(who.lms_z_score(49.1477, [1.0, 49.1477, 0.0379])), 1e-10)

    def test_newborn_and_circumference_calculation(self):
        result = who.calculate_batch(
            [
                {
                    "weight_kg": 3.2,
                    "height_cm": 49.0,
                    "age_months": 0,
                    "sex": "L",
                    "measurement_method": "Terlentang",
                    "lila_cm": None,
                    "head_circumference_cm": 34.46,
                }
            ]
        )
        item = result["items"][0]
        self.assertEqual(result["underweight"], 0)
        self.assertEqual(result["stunting"], 0)
        self.assertEqual(result["wasting"], 0)
        self.assertEqual(item["lila_status"], "-")
        self.assertIsNotNone(item["lk_z_score"])
        self.assertTrue(math.isfinite(item["lk_z_score"]))
        self.assertEqual(result["calculator"], "python-deterministic-lms")

    def test_rejects_invalid_weight(self):
        item = {"weight_kg": 3200.0, "height_cm": 49.0, "age_months": 0, "sex": "L"}
        with self.assertRaisesRegex(ValueError, "weight_kg"):
            who.calculate_batch([item])

    def test_detects_height_decrease_and_focuses_on_nutrition_follow_up(self):
        current = {
            "weight_kg": 8.0,
            "height_cm": 75.0,
            "age_months": 18,
            "sex": "L",
            "measurement_date": "2026-08-01",
        }
        history = [
            {
                "weight_kg": 7.8,
                "height_cm": 76.0,
                "age_months": 17,
                "sex": "L",
                "measurement_date": "2026-07-01",
            }
        ]
        result = ml.detect_anomalies(current, history)
        self.assertTrue(result["detected"])
        self.assertEqual(result["items"][0]["code"], "height_decreased")
        analyzed = who.calculate_batch([{**current, "history": history}])["items"][0]
        self.assertIn("anomaly", analyzed)
        self.assertIn("risk", analyzed)
        self.assertTrue(analyzed["risk"].get("suppressed"))
        self.assertTrue(analyzed["nutrition_concern"]["detected"])
        self.assertTrue(analyzed["nutrition_concern"]["education"])
        self.assertTrue(analyzed["nutrition_concern"]["followUp"])

    def test_python_reads_history_and_explains_growth_graph(self):
        current = {
            "weight_kg": 8.4,
            "height_cm": 77.5,
            "age_months": 19,
            "sex": "P",
            "measurement_date": "2026-08-01",
            "lila_cm": 14.2,
            "head_circumference_cm": 46.0,
        }
        history = [
            {
                "weight_kg": 7.9,
                "height_cm": 75.5,
                "age_months": 17,
                "sex": "P",
                "measurement_date": "2026-06-01",
                "lila_cm": 13.8,
                "head_circumference_cm": 45.4,
            },
            {
                "weight_kg": 8.1,
                "height_cm": 76.4,
                "age_months": 18,
                "sex": "P",
                "measurement_date": "2026-07-01",
                "lila_cm": 14.0,
                "head_circumference_cm": 45.7,
            },
        ]
        result = who.calculate_batch([{**current, "history": history}])["items"][0]
        graph = result["graph_analysis"]
        self.assertEqual(graph["model"], "growth-trend-logistic-v1")
        self.assertEqual(graph["points"], 3)
        self.assertGreaterEqual(len(graph["indicators"]), 2)
        self.assertTrue(any(item["key"] == "height" and item["trend"] == "increasing" for item in graph["indicators"]))
        self.assertTrue(graph["conclusions"])
        self.assertTrue(graph["recommendations"])

    def test_nutrition_concern_includes_recorded_exclusive_breastfeeding_history(self):
        assessment = {
            "bbu_status": "Berat Kurang",
            "tbu_status": "Normal",
            "bbtb_status": "Gizi Baik",
            "imtu_status": "Normal",
            "lila_status": "Normal",
            "lk_status": "Normal",
        }
        concern = ml.nutrition_concern(
            assessment,
            {"age_months": 18},
            [{"age_months": 6, "exclusiveBreastfeeding": "Tidak", "measurement_date": "2025-12-01"}],
        )
        self.assertIsNotNone(concern)
        self.assertEqual(concern["exclusiveBreastfeeding"]["status"], "Tidak")
        self.assertTrue(any("ASI eksklusif" in text for text in concern["education"]))
        self.assertTrue(any("riwayat ASI" in text for text in concern["followUp"]))

    def test_normal_child_risk_uses_z_score_history_and_weight_gain_status(self):
        current = {
            "weight_kg": 9.2,
            "height_cm": 80.0,
            "age_months": 20,
            "sex": "L",
            "measurement_date": "2026-08-01",
            "statusNaik": "T",
        }
        history = [
            {
                "weight_kg": 9.8,
                "height_cm": 78.0,
                "age_months": 18,
                "sex": "L",
                "measurement_date": "2026-06-01",
                "statusNaik": "N",
            },
            {
                "weight_kg": 9.5,
                "height_cm": 79.0,
                "age_months": 19,
                "sex": "L",
                "measurement_date": "2026-07-01",
                "statusNaik": "T",
            },
        ]
        result = who.calculate_batch([{**current, "history": history}])["items"][0]
        self.assertEqual(result["bbu_status"], "Berat Normal")
        self.assertEqual(result["bbtb_status"], "Gizi Baik")
        self.assertNotIn("suppressed", result["risk"])
        signals = result["history_signals"]
        self.assertEqual(signals["weightGain"]["trailingNotRising"], 2)
        self.assertEqual(signals["zScores"]["bbu"]["direction"], "decreasing")
        explanation = result["risk"]["predictions"]["underweight"]["explanation"]
        self.assertIn("Riwayat z-score BB/U", explanation)
        self.assertIn("berstatus T", explanation)

    def test_problem_status_education_includes_history_summary(self):
        current = {
            "weight_kg": 8.2,
            "height_cm": 79.4,
            "age_months": 20,
            "sex": "L",
            "measurement_date": "2026-08-01",
            "statusNaik": "T",
        }
        history = [
            {
                "weight_kg": 8.8,
                "height_cm": 78.0,
                "age_months": 18,
                "sex": "L",
                "measurement_date": "2026-06-01",
                "statusNaik": "N",
            },
            {
                "weight_kg": 8.5,
                "height_cm": 78.8,
                "age_months": 19,
                "sex": "L",
                "measurement_date": "2026-07-01",
                "statusNaik": "T",
            },
        ]
        result = who.calculate_batch([{**current, "history": history}])["items"][0]
        concern = result["nutrition_concern"]
        self.assertIsNotNone(concern)
        self.assertEqual(concern["historySummary"]["previousPoints"], 2)
        self.assertTrue(any("Riwayat terakhir" in text for text in concern["education"]))
        self.assertTrue(any("N–T–T" in text for text in concern["education"]))
        self.assertTrue(any("tidak naik" in text for text in concern["followUp"]))
