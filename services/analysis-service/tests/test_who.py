import math
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))

from analysis_service import analytics, charts, guidance, ml, who
from analysis_service.runtime import AnalysisRuntime


class WhoCalculatorTests(unittest.TestCase):
    @unittest.skipUnless(who.np is not None, "NumPy optional accelerator is not installed")
    def test_vectorized_assessments_match_scalar_lms(self):
        items = [
            {
                "weight_kg": 4.5 + index * 0.2,
                "height_cm": 52.0 + index * 2.1,
                "age_months": index,
                "sex": "L" if index % 2 == 0 else "P",
                "measurement_method": "Terlentang" if index < 5 else "Berdiri",
                "lila_cm": 10.5 + index * 0.35,
                "head_circumference_cm": 35.0 + index * 0.8,
                "row_number": index + 1,
                "record_id": f"vectorized-{index}",
            }
            for index in range(8)
        ]
        for index, item in enumerate(items):
            who.validate_item(item, index)
        vectorized = who.vectorized_assess_items(items)
        self.assertIsNotNone(vectorized)
        for item, actual in zip(items, vectorized):
            expected = who.assess_item(item)
            for key in ("bbu_z_score", "tbu_z_score", "bbtb_z_score", "imtu_z_score", "lila_z_score", "lk_z_score"):
                if expected[key] is None:
                    self.assertIsNone(actual[key], msg=key)
                else:
                    self.assertAlmostEqual(actual[key], expected[key], places=10, msg=key)
            for key in ("bbu_status", "tbu_status", "bbtb_status", "imtu_status", "lila_status", "lk_status"):
                self.assertEqual(actual[key], expected[key], msg=key)

    def test_python_children_page_owns_status_filter(self):
        child = {
            "id": "child-1",
            "name": "Balita Uji",
            "national_id": "123",
            "birth_date": "2025-01-01",
            "sex": "L",
            "village": "Desa Uji",
            "posyandu": "Posyandu Uji",
        }
        result = analytics.children_page({
            "operation": "children_page",
            "asOf": "2026-08-31",
            "measurementStart": "2026-08-01",
            "measurementEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "view": "problem_tidak_naik",
            "page": 1,
            "size": 10,
            "children": [child],
            "measurements": [
                {"id": "old", "child_id": "child-1", "measurement_date": "2026-07-01", "weight_kg": 10.0, "height_cm": 80.0},
                {"id": "current", "child_id": "child-1", "measurement_date": "2026-08-01", "weight_kg": 10.1, "height_cm": 80.5},
            ],
        })
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["analytics"], "python-table-filter-v1")
        measurement = result["measurements"][0]["data"]
        self.assertIn("bbuStatus", measurement)
        self.assertEqual(measurement["weightGainStatus"], "T")

    def test_python_table_marks_gap_as_o_from_full_history(self):
        child = {
            "id": "child-gap",
            "name": "Balita Gap",
            "birth_date": "2025-01-01",
            "sex": "L",
        }
        result = analytics.children_page({
            "operation": "children_page",
            "asOf": "2026-08-31",
            "measurementStart": "2026-08-01",
            "measurementEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "view": "data",
            "page": 1,
            "size": 10,
            "children": [child],
            "measurements": [
                {"id": "old", "child_id": "child-gap", "measurement_date": "2026-01-01", "weight_kg": 10.0, "height_cm": 80.0},
                {"id": "current", "child_id": "child-gap", "measurement_date": "2026-08-01", "weight_kg": 10.5, "height_cm": 80.5},
            ],
        })
        self.assertEqual(result["measurements"][0]["data"]["weightGainStatus"], "O")

    def test_python_page_limited_does_not_slice_native_page_again(self):
        child = {
            "id": "child-page-2",
            "name": "Balita Halaman Dua",
            "birth_date": "2025-01-01",
            "sex": "L",
        }
        result = analytics.children_page({
            "operation": "children_page",
            "asOf": "2026-08-31",
            "measurementStart": "2026-08-01",
            "measurementEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "view": "data",
            "page": 2,
            "size": 10,
            "pageLimited": True,
            "totalHint": 11,
            "children": [child],
            "measurements": [
                {"id": "current", "child_id": "child-page-2", "measurement_date": "2026-08-01", "weight_kg": 10.0, "height_cm": 80.0},
            ],
        })
        self.assertEqual(result["total"], 11)
        self.assertTrue(result["pageLimited"])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["id"], "child-page-2")

    def test_python_asi_page_requires_complete_zero_to_six_series(self):
        child = {
            "id": "child-asi",
            "name": "Bayi ASI",
            "birth_date": "2026-01-01",
            "sex": "P",
        }
        rows = [
            {"id": f"asi-{age}", "child_id": "child-asi", "measurement_date": f"2026-{age + 1:02d}-01", "weight_kg": 3.0 + age * 0.5, "height_cm": 50 + age, "exclusive_breastfeeding": "Ya"}
            for age in range(7)
        ]
        result = analytics.exclusive_breastfeeding_page({
            "operation": "exclusive_breastfeeding_page",
            "measurementStart": "2026-01-01",
            "measurementEnd": "2026-08-31",
            "ageGroup": "6",
            "page": 1,
            "size": 10,
            "children": [child],
            "measurements": rows,
        })
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["analytics"], "python-exclusive-breastfeeding-v1")

    def test_dashboard_aggregation_is_python_owned(self):
        dataset = {
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [
                {"id": "child-1", "name": "A", "birth_date": "2026-01-01", "sex": "L", "created_at": "2026-07-01T00:00:00Z"},
                {"id": "child-2", "name": "B", "birth_date": "2026-02-01", "sex": "P", "created_at": "2026-08-02T00:00:00Z"},
                {"id": "child-3", "name": "C", "birth_date": "2025-01-01", "sex": "L", "deleted_at": "2026-08-03T00:00:00Z"},
            ],
            "measurements": [
                {"id": "m1", "child_id": "child-1", "measurement_date": "2026-07-01", "weight_kg": 4.8, "height_cm": 66, "measurement_method": "Terlentang"},
                {"id": "m2", "child_id": "child-1", "measurement_date": "2026-08-01", "weight_kg": 5.2, "height_cm": 67, "measurement_method": "Terlentang"},
                {"id": "a0", "child_id": "child-2", "measurement_date": "2026-02-01", "weight_kg": 3.5, "height_cm": 52, "exclusive_breastfeeding": "Ya"},
                {"id": "a1", "child_id": "child-2", "measurement_date": "2026-03-01", "weight_kg": 4.2, "height_cm": 55, "exclusive_breastfeeding": "Ya"},
                {"id": "a2", "child_id": "child-2", "measurement_date": "2026-04-01", "weight_kg": 5.0, "height_cm": 58, "exclusive_breastfeeding": "Ya"},
                {"id": "a3", "child_id": "child-2", "measurement_date": "2026-05-01", "weight_kg": 5.7, "height_cm": 61, "exclusive_breastfeeding": "Ya"},
                {"id": "a4", "child_id": "child-2", "measurement_date": "2026-06-01", "weight_kg": 6.3, "height_cm": 63, "exclusive_breastfeeding": "Ya"},
                {"id": "a5", "child_id": "child-2", "measurement_date": "2026-07-01", "weight_kg": 6.8, "height_cm": 65, "exclusive_breastfeeding": "Ya"},
                {"id": "a6", "child_id": "child-2", "measurement_date": "2026-08-01", "weight_kg": 7.2, "height_cm": 67, "exclusive_breastfeeding": "Ya"},
            ],
        }
        result = analytics.dashboard_stats(dataset)
        self.assertEqual(result["S"], 2)
        self.assertEqual(result["D"], 2)
        self.assertEqual(result["N"], 2)
        self.assertEqual(result["B"], 1)
        self.assertEqual(result["asiEksklusif"], 1)
        self.assertEqual(result["asiTarget"], 1)
        self.assertEqual(result["analytics"], "python-dashboard-analytics-v1")
        self.assertEqual(
            result["pipeline"],
            "postgresql-technical-rust-scope-python-clinical-v1",
        )

    def test_dashboard_o_counts_only_current_valid_measurements(self):
        """Dashboard O must match the table's current-row status contract."""

        result = analytics.dashboard_stats({
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [
                {"id": "no-current", "birth_date": "2025-01-01", "sex": "L"},
                {"id": "first-current", "birth_date": "2025-01-01", "sex": "P"},
                {"id": "repeat-current", "birth_date": "2025-01-01", "sex": "L"},
            ],
            "measurements": [
                {
                    "id": "first-current-row",
                    "child_id": "first-current",
                    "measurement_date": "2026-08-10",
                    "weight_kg": 8.0,
                    "height_cm": 72.0,
                },
                {
                    "id": "repeat-previous-row",
                    "child_id": "repeat-current",
                    "measurement_date": "2026-07-10",
                    "weight_kg": 7.5,
                    "height_cm": 71.0,
                },
                {
                    "id": "repeat-current-row",
                    "child_id": "repeat-current",
                    "measurement_date": "2026-08-10",
                    "weight_kg": 7.9,
                    "height_cm": 72.0,
                },
            ],
        })
        self.assertEqual(result["S"], 3)
        self.assertEqual(result["D"], 2)
        self.assertEqual(result["O"], 1)

    def test_dashboard_and_table_choose_same_duplicate_date_row(self):
        """The latest row tie-breakers must be date, created_at, then id."""

        child = {
            "id": "duplicate-date",
            "birth_date": "2025-01-01",
            "sex": "L",
        }
        dataset = {
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [child],
            "measurements": [
                {
                    "id": "older-row",
                    "child_id": "duplicate-date",
                    "measurement_date": "2026-08-10",
                    "created_at": "2026-08-10T08:00:00Z",
                    "weight_kg": 8.0,
                    "height_cm": 72.0,
                },
                {
                    "id": "newer-row",
                    "child_id": "duplicate-date",
                    "measurement_date": "2026-08-10",
                    "created_at": "2026-08-10T09:00:00Z",
                    "weight_kg": 8.5,
                    "height_cm": 72.0,
                },
            ],
        }
        result = analytics.dashboard_stats(dataset)
        self.assertEqual(result["D"], 1)
        table = analytics.children_page({
            **dataset,
            "operation": "children_page",
            "asOf": "2026-08-31",
            "measurementStart": "2026-08-01",
            "measurementEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "view": "data",
            "page": 1,
            "size": 10,
        })
        self.assertEqual(table["measurements"][0]["data"]["bb"], 8.5)

    def test_dashboard_b_uses_jakarta_month_boundary(self):
        result = analytics.dashboard_stats({
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [
                # 31 Jul 17:30 UTC is 1 Aug 00:30 in the report timezone.
                {"id": "jakarta-child", "birth_date": "2025-01-01", "sex": "L", "created_at": "2026-07-31T17:30:00Z"},
            ],
            "measurements": [],
        })
        self.assertEqual(result["B"], 1)

    def test_dashboard_asi_denominator_is_all_six_month_children(self):
        result = analytics.dashboard_stats({
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [
                {"id": "six-yes", "birth_date": "2026-02-01", "sex": "P"},
                {"id": "six-empty", "birth_date": "2026-02-01", "sex": "L"},
            ],
            # The first child has an ASI answer but no anthropometry.  It must
            # still count in the six-month ASI numerator/denominator, while
            # neither child's lack of a weight may inflate D (Ditimbang).
            "measurements": [
                {
                    "id": "six-yes-answer",
                    "child_id": "six-yes",
                    "measurement_date": "2026-08-01",
                    "age_in_months": 6,
                    "sex": "P",
                    "exclusive_breastfeeding": "Ya",
                },
            ],
        })
        self.assertEqual(result["asiEksklusif"], 1)
        self.assertEqual(result["asiTarget"], 2)
        self.assertEqual(result["perAsiEksklusif"], "50.0")
        self.assertEqual(result["D"], 0)

    def test_dashboard_asi_cohort_is_independent_of_selected_age_filter(self):
        result = analytics.dashboard_stats({
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            # The visible dashboard cohort intentionally excludes six-month
            # children. The dedicated SQL cohort must still drive ASI's S.
            "ageGroup": "0-5",
            "role": "Ahli Gizi",
            "children": [
                {"id": "younger", "birth_date": "2026-03-01", "sex": "P"},
            ],
            "asiChildren": [
                {"id": "six-month", "birth_date": "2026-02-01", "sex": "L"},
            ],
            "asiMeasurements": [
                {
                    "id": "six-answer",
                    "child_id": "six-month",
                    "measurement_date": "2026-08-01",
                    "age_in_months": 6,
                    "exclusive_breastfeeding": "Ya",
                },
            ],
            "measurements": [],
        })
        self.assertEqual(result["S"], 1)
        self.assertEqual(result["asiTarget"], 1)
        self.assertEqual(result["asiEksklusif"], 1)
        self.assertEqual(result["perAsiEksklusif"], "100.0")

    def test_dashboard_ignores_postgresql_clinical_count_hints(self):
        dataset = {
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "technical": {
                "activeChildCount": 999,
                "currentMeasurementRowCount": 999,
                "n": 999,
                "statusCounts": {"underweight": 999},
            },
            "children": [
                {"id": "hint-child", "birth_date": "2025-01-01", "sex": "L"},
            ],
            "measurements": [
                {
                    "id": "hint-current",
                    "child_id": "hint-child",
                    "measurement_date": "2026-08-01",
                    "weight_kg": 10.0,
                    "height_cm": 80.0,
                },
            ],
        }
        result = analytics.dashboard_stats(dataset)
        self.assertEqual(result["S"], 1)
        self.assertEqual(result["D"], 1)
        self.assertNotEqual(result["N"], 999)

    def test_incremental_assessment_cache_skips_unchanged_child(self):
        analytics.clear_analysis_caches()
        dataset = {
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [{"id": "cached-child", "birth_date": "2025-01-01", "sex": "L"}],
            "measurements": [
                {"id": "cached-old", "child_id": "cached-child", "measurement_date": "2026-07-01", "weight_kg": 10.0, "height_cm": 80.0},
                {"id": "cached-current", "child_id": "cached-child", "measurement_date": "2026-08-01", "weight_kg": 10.3, "height_cm": 80.5},
            ],
        }
        with patch.object(ml, "analyze_item", wraps=ml.analyze_item) as analyze_item:
            analytics.dashboard_stats(dataset)
            analytics.dashboard_stats(json.loads(json.dumps(dataset)))
        self.assertEqual(analyze_item.call_count, 1)
        self.assertGreaterEqual(analytics.analysis_cache_stats()["hits"], 1)

    def test_dashboard_runtime_cache_invalidates_when_dataset_changes(self):
        runtime = AnalysisRuntime(worker_count=1, queue_size=1, dashboard_cache_ttl=60)
        dataset = {
            "operation": "dashboard_stats",
            "monthStart": "2026-08-01",
            "monthEnd": "2026-08-31",
            "previousMonthStart": "2026-07-01",
            "previousMonthEnd": "2026-07-31",
            "role": "Ahli Gizi",
            "children": [{"id": "runtime-child", "birth_date": "2025-01-01", "sex": "P"}],
            "measurements": [
                {"id": "runtime-old", "child_id": "runtime-child", "measurement_date": "2026-07-01", "weight_kg": 8.0, "height_cm": 75.0},
                {"id": "runtime-current", "child_id": "runtime-child", "measurement_date": "2026-08-01", "weight_kg": 8.3, "height_cm": 75.5},
            ],
        }
        try:
            _first, first_hit = runtime.analyze_dataset(dataset)
            _second, second_hit = runtime.analyze_dataset(json.loads(json.dumps(dataset)))
            changed = json.loads(json.dumps(dataset))
            changed["measurements"][-1]["weight_kg"] = 8.4
            _third, changed_hit = runtime.analyze_dataset(changed)
            self.assertFalse(first_hit)
            self.assertTrue(second_hit)
            self.assertFalse(changed_hit)
            self.assertEqual(runtime.stats()["dashboard"]["hits"], 1)
        finally:
            runtime.shutdown()

    def test_python_weight_gain_thresholds_by_age(self):
        expected = {
            1: 800,
            2: 900,
            3: 800,
            4: 600,
            5: 500,
            6: 400,
            7: 400,
            8: 300,
            11: 300,
            12: 200,
            60: 200,
        }
        for age, grams in expected.items():
            self.assertEqual(ml.minimum_weight_gain_grams(age), grams)

    def test_python_calculates_n_or_t_from_gain_not_persisted_label(self):
        previous = {
            "weight_kg": 4.0,
            "age_months": 1,
            "measurement_date": "2026-01-01",
        }
        # At two months the required gain is 900 g. The old label says N, but
        # Python must classify this 800 g gain as T.
        current = {
            "weight_kg": 4.8,
            "age_months": 2,
            "measurement_date": "2026-02-01",
            "statusNaik": "N",
        }
        self.assertEqual(ml.calculate_weight_gain_status(current, previous), "T")
        self.assertEqual(
            ml.calculate_weight_gain_status({**current, "weight_kg": 4.9}, previous),
            "N",
        )
        self.assertEqual(ml.calculate_weight_gain_status(previous), "B")

    def test_asi_is_exclusive_only_when_all_zero_to_six_answers_are_yes(self):
        complete = [
            {"age_months": age, "exclusiveBreastfeeding": "Ya", "measurement_date": f"2026-0{age + 1}-01"}
            for age in range(7)
        ]
        self.assertEqual(ml._asi_context(complete[-1], complete[:-1])["status"], "Ya")
        incomplete = complete[:-1]
        self.assertEqual(ml._asi_context(incomplete[-1], incomplete[:-1])["status"], "Belum lengkap")

    def test_asi_later_yes_infers_previous_months_and_newborn_defaults_yes(self):
        month_three = {
            "age_months": 3,
            "exclusiveBreastfeeding": "Ya",
            "measurement_date": "2026-04-01",
        }
        context = ml._asi_context(month_three, [])
        self.assertEqual(context["status"], "Belum lengkap")
        self.assertEqual(context["inferredAges"], [0, 1, 2])
        self.assertEqual(context["observedAges"], [0, 1, 2, 3])

        newborn = ml._asi_context({"age_months": 0, "measurement_date": "2026-01-01"}, [])
        self.assertEqual(newborn["status"], "Belum lengkap")
        self.assertEqual(newborn["observedAges"], [0])
        self.assertIn(0, newborn["inferredAges"])

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

    def test_who_renderer_uses_sex_frame_and_requested_sd_palette(self):
        boys = charts.render_growth_chart(
            "bbu",
            "L",
            [{"age_months": 12, "weight_kg": 9.0, "measurement_date": "2026-08-01"}],
        )
        girls = charts.render_growth_chart(
            "bbu",
            "P",
            [{"age_months": 12, "weight_kg": 8.5, "measurement_date": "2026-08-01"}],
        )
        self.assertIn('fill="#2563eb"', boys)
        self.assertIn('fill="#d45f97"', girls)
        self.assertIn('stroke="#198754"', boys)
        self.assertIn('stroke="#e3343d"', boys)
        self.assertIn('stroke="#262626"', boys)
        self.assertIn('>0</text>', boys)
        # The mirrored right-axis values and SD labels occupy separate
        # columns so labels such as "28" and "+3" remain readable.
        self.assertIn('x="1125.00" y="124.00" text-anchor="middle"', boys)
        self.assertIn('x="1055.00" y="127.78" text-anchor="middle"', boys)
        self.assertIn('x="1021" y="120" width="69" height="530" fill="#ffffff"', boys)
        self.assertIn('x1="309.60" y1="120.00" x2="309.60" y2="650.00" stroke="#666666" stroke-width="2.8"', boys)
        self.assertIn('width="1200" height="760" viewBox="0 0 1200 760"', boys)
        # One line per month plus the darker yearly boundaries creates the
        # dense horizontal/vertical WHO-style grid.
        self.assertGreaterEqual(boys.count('y1="120.00"'), 60)
        bbtb = charts.render_growth_chart(
            "bbtb",
            "L",
            [{"age_months": 18, "weight_kg": 10.0, "height_cm": 80.0}],
        )
        self.assertIn('stroke="#f2c94c"', bbtb)
        self.assertIn('>+1</text>', bbtb)
        tbu = charts.render_growth_chart(
            "tbu",
            "L",
            [{"age_months": 24, "height_cm": 86.0, "measurement_method": "Berdiri"}],
        )
        self.assertIn('stroke-dasharray="8 6"', tbu)
        self.assertIn("Transisi PB ke TB pada usia 24 bulan", tbu)
        lilau = charts.render_growth_chart(
            "lilau",
            "P",
            [
                # LILA/U standards start at completed month 3; earlier
                # observations are intentionally outside this chart.
                {"age_months": 2, "lila_cm": 12.0, "measurement_date": "2026-07-01"},
                {"age_months": 18, "lila_cm": 14.0, "measurement_date": "2026-08-01"},
            ],
        )
        self.assertIn('stroke="#f2c94c"', lilau)
        self.assertIn("3 bulan–5 tahun", lilau)
        self.assertNotIn("2026-07-01: 12.00 cm", lilau)
        self.assertIn('stroke-width="2.8"', lilau)

    def test_python_renderer_breaks_child_line_at_missing_month_and_status_o(self):
        svg = charts.render_growth_chart(
            "bbu",
            "P",
            [
                {"age_months": 48, "weight_kg": 12.0, "measurement_date": "2026-01-01", "weight_gain_status": "N"},
                # February has no measurement, so January and March must not connect.
                {"age_months": 50, "weight_kg": 12.4, "measurement_date": "2026-03-01", "weight_gain_status": "N"},
                # An O point is a non-measured month and must stand alone as a marker.
                {"age_months": 51, "weight_kg": 12.5, "measurement_date": "2026-04-01", "weight_gain_status": "O"},
                {"age_months": 52, "weight_kg": 12.7, "measurement_date": "2026-05-01", "weight_gain_status": "N"},
            ],
        )
        # Four isolated trajectory segments: Jan, Mar, Apr (O), and May.
        self.assertEqual(svg.count('stroke="#d45f97"'), 4)

    def test_renderer_rejects_unknown_chart_or_language(self):
        with self.assertRaises(ValueError):
            charts.render_growth_chart("unknown", "L", [])
        with self.assertRaises(ValueError):
            charts.render_growth_chart("bbu", "L", [], language="en")

    def test_lms_medians_are_zero_z_score(self):
        self.assertLess(abs(who.lms_z_score(3.3464, [0.3487, 3.3464, 0.14602])), 1e-10)
        self.assertLess(abs(who.lms_z_score(49.1477, [1.0, 49.1477, 0.0379])), 1e-10)

    def test_lila_uses_requested_nutrition_labels(self):
        expected = {
            -3.1: "Gizi Buruk",
            -2.1: "Gizi Kurang",
            -2.0: "Gizi Baik",
            0.0: "Gizi Baik",
            2.0: "Gizi Baik",
            2.1: "Gizi Lebih",
            3.0: "Gizi Lebih",
            3.1: "Obesitas",
        }
        for score, label in expected.items():
            self.assertEqual(who.nutrition_status(score, "LILA"), label)

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

    def test_more_not_rising_results_raise_screening_signal(self):
        assessment = {"bbu_z_score": 0, "tbu_z_score": 0, "bbtb_z_score": 0}
        one = ml.predict_risks(
            assessment,
            {"detected": False, "items": []},
            {"weightGain": {"statuses": ["T"], "recent": ["T"], "trailingNotRising": 1, "notRisingCount": 1, "notRisingRate": 1.0}},
        )
        many = ml.predict_risks(
            assessment,
            {"detected": False, "items": []},
            {"weightGain": {"statuses": ["T", "T", "T"], "recent": ["T", "T", "T"], "trailingNotRising": 3, "notRisingCount": 3, "notRisingRate": 1.0}},
        )
        self.assertGreater(
            many["predictions"]["underweight"]["probability"],
            one["predictions"]["underweight"]["probability"],
        )

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
        self.assertTrue(any("T–T" in text for text in concern["education"]))
        self.assertTrue(any("tidak naik" in text for text in concern["followUp"]))

    def test_normal_child_gets_kia_education_by_age_and_risk_percentage(self):
        current = {
            "weight_kg": 10.5,
            "height_cm": 82.0,
            "age_months": 20,
            "sex": "L",
            "measurement_date": "2026-08-01",
        }
        result = who.calculate_batch([current])["items"][0]
        education = result["nutrition_education"]
        self.assertIsNotNone(education)
        self.assertEqual(education["ageGroup"], "12–23 bulan")
        self.assertEqual(education["riskLevel"], "rendah")
        self.assertGreaterEqual(education["riskPercentage"], 0)
        self.assertLessEqual(education["riskPercentage"], 100)
        self.assertTrue(any("protein hewani" in text for text in education["education"]))
        self.assertTrue(any("setiap bulan" in text for text in education["followUp"]))
        self.assertEqual(education["sources"][0]["title"], "Buku KIA 2024")
        self.assertEqual(education["posterGuidance"]["ageGroup"], education["ageGroup"])
        self.assertTrue(education["posterGuidance"]["asset"].endswith("isi-piringku-12-23.webp"))
        self.assertTrue(any("protein hewani" in text for text in education["posterGuidance"]["keyPoints"]))
        self.assertTrue(any(source.get("type") == "poster" for source in education["sources"]))

    def test_kia_age_band_limits_asi_to_zero_to_six_months(self):
        infant = guidance.build_normal_education(
            {"age_months": 4, "exclusiveBreastfeeding": "Ya"},
            {"predictions": {"underweight": {"probability": 0.8, "level": "tinggi"}}},
        )
        self.assertEqual(infant["ageGroup"], "0–5 bulan")
        self.assertEqual(infant["exclusiveBreastfeeding"]["status"], "Ya")
        self.assertTrue(any("hanya ASI" in text for text in infant["education"]))
        self.assertTrue(any("8–12 kali" in text for text in infant["education"]))
        self.assertFalse(any(text.startswith("MPASI perlu") for text in infant["education"]))
        self.assertTrue(any(source.get("url", "").endswith("/asi-eksklusif-6-bulan") for source in infant["sources"]))
        self.assertEqual(infant["sources"][1]["type"], "official_web")
        toddler = guidance.build_normal_education(
            {"age_months": 18, "exclusiveBreastfeeding": "Tidak"},
            {"predictions": {"underweight": {"probability": 0.2, "level": "rendah"}}},
        )
        self.assertIsNone(toddler["exclusiveBreastfeeding"])

    def test_problem_status_adds_age_specific_kia_material(self):
        assessment = {
            "bbu_status": "Berat Kurang",
            "tbu_status": "Normal",
            "bbtb_status": "Gizi Baik",
            "imtu_status": "Gizi Baik",
            "lila_status": "-",
            "lk_status": "-",
        }
        concern = ml.nutrition_concern(assessment, {"age_months": 7}, [])
        self.assertEqual(concern["ageGroup"], "6–8 bulan")
        self.assertTrue(any("MPASI" in text for text in concern["education"]))
        self.assertTrue(concern["sources"][0]["pages"])
        self.assertTrue(concern["posterGuidance"]["asset"].endswith("isi-piringku-6-8.webp"))
        self.assertTrue(concern["posterGuidance"]["portionExamples"])

    def test_problem_guidance_selects_gizi_kurang_treatment_material(self):
        assessment = {
            "bbu_status": "Berat Kurang",
            "tbu_status": "Normal",
            "bbtb_status": "Gizi Baik",
            "imtu_status": "Gizi Baik",
            "lila_status": "LILA Normal",
            "lk_status": "Normal",
        }
        concern = ml.nutrition_concern(assessment, {"age_months": 18}, [])
        self.assertEqual([item["id"] for item in concern["matchedGuidance"]], ["gizi_kurang"])
        self.assertTrue(any("PMT lokal" in text for text in concern["education"]))
        self.assertTrue(any("14 hari" in text for text in concern["followUp"]))
        self.assertTrue(any(source.get("type") == "official_guideline" for source in concern["sources"]))

    def test_problem_guidance_selects_stunting_material_and_safe_pkmp_message(self):
        assessment = {
            "bbu_status": "Berat Normal",
            "tbu_status": "Pendek",
            "bbtb_status": "Gizi Baik",
            "imtu_status": "Gizi Baik",
            "lila_status": "LILA Normal",
            "lk_status": "Normal",
        }
        concern = ml.nutrition_concern(assessment, {"age_months": 30}, [])
        self.assertEqual([item["id"] for item in concern["matchedGuidance"]], ["stunting"])
        self.assertTrue(any("Kejar tumbuh" in text for text in concern["education"]))
        self.assertTrue(any("PKMK" in text for text in concern["education"]))
        self.assertTrue(any("riwayat pengukuran" in text for text in concern["followUp"]))

    def test_problem_guidance_selects_severe_wasting_material(self):
        assessment = {
            "bbu_status": "Berat Sangat Kurang",
            "tbu_status": "Sangat Pendek",
            "bbtb_status": "Gizi Buruk",
            "imtu_status": "Gizi Buruk",
            "lila_status": "LILA Sangat Rendah",
            "lk_status": "Normal",
        }
        concern = ml.nutrition_concern(assessment, {"age_months": 22}, [])
        self.assertIn("gizi_buruk", [item["id"] for item in concern["matchedGuidance"]])
        self.assertTrue(any("kondisi serius" in text for text in concern["education"]))
        self.assertTrue(any("tanda bahaya" in text for text in concern["followUp"]))
        self.assertTrue(any(source.get("url", "").endswith("/book/186") for source in concern["sources"]))
