import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))

from analysis_service import embedded


class EmbeddedBridgeTests(unittest.TestCase):
    def test_calculate_batch_json_matches_python_calculator_contract(self):
        payload = {
            "items": [
                {
                    "weight_kg": 6.0,
                    "height_cm": 60.0,
                    "age_months": 3,
                    "sex": "L",
                    "row_number": 1,
                    "record_id": "measurement-1",
                    "nik": "",
                    "history": [],
                }
            ]
        }
        result = json.loads(embedded.calculate_batch_json(json.dumps(payload)))
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["record_id"], "measurement-1")
        self.assertEqual(result["standards_version"], "WHO-2006-2007-LMS")

    def test_chart_json_returns_svg_and_standards_metadata(self):
        payload = {
            "chart_type": "bbu",
            "sex": "P",
            "points": [{"age_months": 6, "weight_kg": 6.5, "measurement_date": "2026-08-01"}],
            "language": "id",
        }
        result = json.loads(embedded.render_growth_chart_json(json.dumps(payload)))
        self.assertTrue(result["svg"].startswith("<svg"))
        self.assertEqual(result["standards_version"], "WHO-2006-2007-LMS")
        self.assertEqual(result["renderer"], "python-svg-who-lms-v1-pyo3")


if __name__ == "__main__":
    unittest.main()
