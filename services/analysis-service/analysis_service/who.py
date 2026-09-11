"""Deterministic WHO Child Growth Standards calculator.

The LMS tables are the same checked-in tables used by the existing backend and
are loaded locally so no child data leaves the private service.  Optional risk,
graph-trend, and anomaly analysis lives in :mod:`analysis_service.ml`, keeping
the WHO calculation itself deterministic and independently testable.
"""

from __future__ import annotations

import json
import math
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

try:  # Optional in lightweight local/test environments.
    import numpy as np
except ImportError:  # pragma: no cover - exercised in the stdlib-only image
    np = None  # type: ignore[assignment]


MAX_BATCH_ITEMS = 10_000
STANDARDS_VERSION = "WHO-2006-2007-LMS"
LMS_CACHE_SIZE = 131_072
VECTORIZE_MIN_BATCH = 8


def numpy_enabled() -> bool:
    """Return whether the optional numerical accelerator is enabled."""

    return os.environ.get("ANALYSIS_NUMPY_ENABLED", "true").strip().casefold() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _standards_path() -> Path:
    configured = os.environ.get("WHO_STANDARDS_PATH", "").strip()
    if configured:
        return Path(configured)
    packaged = Path(__file__).resolve().parents[1] / "data" / "anthropometry.json"
    if packaged.exists():
        return packaged
    return _repository_root() / "services" / "analysis-service" / "data" / "anthropometry.json"


def _circumference_source_path() -> Path:
    configured = os.environ.get("WHO_CIRCUMFERENCE_PATH", "").strip()
    if configured:
        return Path(configured)
    packaged = Path(__file__).resolve().parents[1] / "data" / "whoGrowthLms.ts"
    if packaged.exists():
        return packaged
    return _repository_root() / "frontend-react" / "src" / "compat" / "data" / "whoGrowthLms.ts"


@lru_cache(maxsize=1)
def standards() -> dict[str, dict[str, list[list[float]]]]:
    with _standards_path().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _parse_circumference_typescript(text: str) -> dict[str, dict[str, list[list[float]]]]:
    """Parse the checked-in TypeScript LMS table without a JS runtime."""

    result: dict[str, dict[str, list[list[float]]]] = {}
    number = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)"
    for indicator in ("lila", "lk"):
        match = re.search(
            rf"\b{indicator}:\s*\{{\s*L:\s*\[(.*?)\],\s*P:\s*\[(.*?)\]\s*,?\s*\}}",
            text,
            re.DOTALL,
        )
        if not match:
            continue
        result[indicator] = {}
        # The two capture groups are fixed by the parser above.  Keep this
        # compatible with the Python system runtime used by local tooling
        # (some distributions still ship Python 3.9, before zip(strict=...)).
        for sex, block in zip(("L", "P"), match.groups()):
            rows = [
                [float(month), float(l), float(median), float(spread)]
                for month, l, median, spread in re.findall(
                    rf"\[\s*({number})\s*,\s*({number})\s*,\s*({number})\s*,\s*({number})\s*\]",
                    block,
                )
            ]
            result[indicator][sex] = rows
    return result


@lru_cache(maxsize=1)
def circumference_standards() -> dict[str, dict[str, list[list[float]]]]:
    path = _circumference_source_path()
    if not path.exists():
        return {}
    return _parse_circumference_typescript(path.read_text(encoding="utf-8"))


def preload_reference_tables() -> None:
    """Warm the immutable WHO reference tables for the current worker.

    The parsers are still protected by one-entry ``lru_cache`` decorators,
    so this function is safe to call from each service entrypoint (and from a
    process-pool child).  Subsequent requests reuse the same in-memory tables
    instead of reopening or reparsing the files.
    """

    standards()
    circumference_standards()


@lru_cache(maxsize=LMS_CACHE_SIZE)
def _lms_z_score_cached(value: float, l: float, median: float, spread: float) -> float:
    if l == 0.0:
        return math.log(value / median) / spread
    return ((value / median) ** l - 1.0) / (l * spread)


def lms_z_score(value: float, reference: list[float] | tuple[float, float, float]) -> float:
    """Calculate an LMS z-score using a bounded numeric cache.

    LMS rows are immutable and reused across thousands of children. Caching
    the primitive calculation removes repeated logarithm/power work without
    retaining any child identity or measurement record.
    """

    l, median, spread = (float(part) for part in reference)
    return _lms_z_score_cached(float(value), l, median, spread)


def adjusted_length_height(value: float, age_months: int, method: str) -> float:
    if age_months <= 24 and method == "Berdiri":
        return value + 0.7
    if age_months > 24 and method == "Terlentang":
        return value - 0.7
    return value


def _half_up(value: float) -> int:
    # Rust's f64::round rounds halfway cases away from zero. Heights here are
    # positive, so floor(x + 0.5) matches it without Python's bankers rounding.
    return math.floor(value + 0.5)


def z_score(
    value: float,
    growth_type: str,
    age_months: int,
    sex: str,
    secondary: float | None,
    method: str,
    reference: dict[str, dict[str, list[list[float]]]],
) -> float | None:
    if value <= 0 or not 0 <= age_months <= 60 or sex not in ("L", "P"):
        return None
    age = age_months
    if growth_type == "BBU":
        rows = reference.get("weightForAge", {}).get(sex, [])
        return lms_z_score(value, rows[age]) if age < len(rows) else None
    if growth_type == "TBU":
        rows = reference.get("lengthHeightForAge", {}).get(sex, [])
        adjusted = adjusted_length_height(value, age_months, method)
        return lms_z_score(adjusted, rows[age]) if age < len(rows) else None
    if secondary is None or secondary <= 0:
        return None
    adjusted = adjusted_length_height(secondary, age_months, method)
    if growth_type == "IMTU":
        rows = reference.get("bmiForAge", {}).get(sex, [])
        bmi = value / (adjusted / 100.0) ** 2
        return lms_z_score(bmi, rows[age]) if age < len(rows) else None
    if growth_type == "BBTB":
        minimum = 45.0 if age_months <= 24 else 65.0
        key = "weightForLength" if age_months <= 24 else "weightForHeight"
        rows = reference.get(key, {}).get(sex, [])
        index = _half_up((adjusted - minimum) * 2.0)
        return lms_z_score(value, rows[index]) if 0 <= index < len(rows) else None
    return None


@lru_cache(maxsize=32_768)
def circumference_z_score(
    value: float | None,
    indicator: str,
    age_months: int,
    sex: str,
) -> float | None:
    if value is None or value <= 0 or not 0 <= age_months <= 60 or sex not in ("L", "P"):
        return None
    if indicator == "lila" and age_months < 3:
        return None
    rows = circumference_standards().get(indicator, {}).get(sex, [])
    for row in rows:
        if int(row[0]) == age_months:
            return lms_z_score(value, row[1:])
    return None


def cache_stats() -> dict[str, Any]:
    """Return bounded WHO-cache counters for local/operational diagnostics."""

    return {
        "lms": _lms_z_score_cached.cache_info()._asdict(),
        "circumference": circumference_z_score.cache_info()._asdict(),
        "standardsLoaded": standards.cache_info().currsize,
        "circumferenceStandardsLoaded": circumference_standards.cache_info().currsize,
        "numpyAvailable": np is not None,
        "numpyEnabled": numpy_enabled(),
        "vectorizeMinBatch": VECTORIZE_MIN_BATCH,
    }


def nutrition_status(score: float | None, growth_type: str) -> str:
    if score is None or not math.isfinite(score):
        return "-"
    if growth_type == "BBU":
        if score < -3:
            return "Berat Sangat Kurang"
        if score < -2:
            return "Berat Kurang"
        if score <= 1:
            return "Berat Normal"
        return "Risiko Berat Lebih"
    if growth_type == "TBU":
        if score < -3:
            return "Sangat Pendek"
        if score < -2:
            return "Pendek"
        if score <= 3:
            return "Normal"
        return "Tinggi"
    if growth_type == "LILA":
        if score < -3:
            return "Gizi Buruk"
        if score < -2:
            return "Gizi Kurang"
        if score <= 2:
            return "Gizi Baik"
        if score <= 3:
            return "Gizi Lebih"
        return "Obesitas"
    if growth_type == "LK":
        if score < -3:
            return "Mikrosefali Berat"
        if score < -2:
            return "Mikrosefali"
        if score <= 2:
            return "Normal"
        return "Makrosefali"
    if score < -3:
        return "Gizi Buruk"
    if score < -2:
        return "Gizi Kurang"
    if score <= 1:
        return "Gizi Baik"
    if score <= 2:
        return "Risiko Gizi Lebih"
    if score <= 3:
        return "Gizi Lebih"
    return "Obesitas"


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_item(item: dict[str, Any], index: int) -> None:
    weight = item.get("weight_kg")
    if not _finite(weight) or not 0.1 <= weight <= 60:
        raise ValueError(f"items[{index}].weight_kg harus antara 0,1 dan 60 kg.")
    height = item.get("height_cm")
    if height is not None and (not _finite(height) or not 10 <= height <= 220):
        raise ValueError(f"items[{index}].height_cm harus antara 10 dan 220 cm.")
    age = item.get("age_months")
    if not isinstance(age, int) or isinstance(age, bool) or not 0 <= age <= 60:
        raise ValueError(f"items[{index}].age_months harus antara 0 dan 60.")
    if item.get("sex") not in ("L", "P"):
        raise ValueError(f"items[{index}].sex harus L atau P.")
    for key, maximum in (("lila_cm", 50), ("head_circumference_cm", 80)):
        value = item.get(key)
        if value is not None and (not _finite(value) or not 0.1 <= value <= maximum):
            raise ValueError(f"items[{index}].{key} berada di luar rentang yang diizinkan.")


def assess_item(item: dict[str, Any]) -> dict[str, Any]:
    reference = standards()
    method = item.get("measurement_method") or ""
    weight = item["weight_kg"]
    height = item.get("height_cm")
    age = item["age_months"]
    sex = item["sex"]
    bbu = z_score(weight, "BBU", age, sex, None, method, reference)
    tbu = z_score(height, "TBU", age, sex, None, method, reference) if height is not None else None
    bbtb = z_score(weight, "BBTB", age, sex, height, method, reference) if height is not None else None
    imtu = z_score(weight, "IMTU", age, sex, height, method, reference) if height is not None else None
    lila = circumference_z_score(item.get("lila_cm"), "lila", age, sex)
    lk = circumference_z_score(item.get("head_circumference_cm"), "lk", age, sex)
    return {
        "row_number": item.get("row_number", 0),
        "record_id": item.get("record_id", ""),
        "nik": item.get("nik", ""),
        "bbu_status": nutrition_status(bbu, "BBU"),
        "tbu_status": nutrition_status(tbu, "TBU"),
        "bbtb_status": nutrition_status(bbtb, "BBTB"),
        "imtu_status": nutrition_status(imtu, "IMTU"),
        "lila_status": nutrition_status(lila, "LILA"),
        "lk_status": nutrition_status(lk, "LK"),
        "bbu_z_score": bbu,
        "tbu_z_score": tbu,
        "bbtb_z_score": bbtb,
        "imtu_z_score": imtu,
        "lila_z_score": lila,
        "lk_z_score": lk,
    }


def vectorized_assess_items(
    items: list[dict[str, Any]],
    reference: dict[str, dict[str, list[list[float]]]] | None = None,
) -> list[dict[str, Any]] | None:
    """Calculate WHO z-scores for a batch with NumPy when it is available.

    The grouping keys (sex, age, and LMS reference row) are intentionally
    resolved in Python, while the expensive logarithm/power operations run on
    contiguous ``float64`` arrays.  Returning ``None`` keeps the deterministic
    scalar implementation as a safe fallback for small batches or images that
    do not install NumPy.  No clinical rule or threshold is moved out of
    Python; this is only a numerical execution strategy.
    """

    if np is None or not numpy_enabled() or len(items) < VECTORIZE_MIN_BATCH:
        return None
    reference = reference or standards()
    size = len(items)
    ages = np.asarray([item["age_months"] for item in items], dtype=np.int64)
    weights = np.asarray([item["weight_kg"] for item in items], dtype=np.float64)
    heights = np.asarray(
        [item.get("height_cm") if item.get("height_cm") is not None else np.nan for item in items],
        dtype=np.float64,
    )
    lila_values = np.asarray(
        [item.get("lila_cm") if item.get("lila_cm") is not None else np.nan for item in items],
        dtype=np.float64,
    )
    head_values = np.asarray(
        [
            item.get("head_circumference_cm")
            if item.get("head_circumference_cm") is not None
            else np.nan
            for item in items
        ],
        dtype=np.float64,
    )
    methods = np.asarray([item.get("measurement_method") or "" for item in items], dtype=object)
    adjusted_heights = heights.copy()
    valid_height = np.isfinite(adjusted_heights)
    standing = valid_height & (ages <= 24) & (methods == "Berdiri")
    recumbent = valid_height & (ages > 24) & (methods == "Terlentang")
    adjusted_heights[standing] += 0.7
    adjusted_heights[recumbent] -= 0.7

    scores = {name: np.full(size, np.nan, dtype=np.float64) for name in ("bbu", "tbu", "bbtb", "imtu", "lila", "lk")}

    def grouped(keys: list[tuple[Any, ...]]) -> dict[tuple[Any, ...], list[int]]:
        groups: dict[tuple[Any, ...], list[int]] = {}
        for index, key in enumerate(keys):
            groups.setdefault(key, []).append(index)
        return groups

    def batch_lms(values: Any, rows: list[list[float]] | list[tuple[float, ...]]) -> Any:
        values = np.asarray(values, dtype=np.float64)
        refs = np.asarray(rows, dtype=np.float64)
        lms_l, medians, spreads = refs[:, 0], refs[:, 1], refs[:, 2]
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            return np.where(
                lms_l == 0.0,
                np.log(values / medians) / spreads,
                ((values / medians) ** lms_l - 1.0) / (lms_l * spreads),
            )

    def fill_age_indicator(name: str, values: Any, table_name: str, valid: Any) -> None:
        keys = [(str(items[index]["sex"]), int(ages[index])) for index in range(size) if valid[index]]
        positions = [index for index in range(size) if valid[index]]
        for key_positions in grouped(keys).values():
            actual = [positions[position] for position in key_positions]
            sex, age = str(items[actual[0]]["sex"]), int(ages[actual[0]])
            rows = reference.get(table_name, {}).get(sex, [])
            if age >= len(rows):
                continue
            scores[name][actual] = batch_lms(values[actual], [rows[age]] * len(actual))

    fill_age_indicator("bbu", weights, "weightForAge", np.isfinite(weights))
    fill_age_indicator("tbu", adjusted_heights, "lengthHeightForAge", valid_height)

    valid_bmi = np.isfinite(weights) & np.isfinite(adjusted_heights) & (adjusted_heights > 0)
    bmi = np.full(size, np.nan, dtype=np.float64)
    bmi[valid_bmi] = weights[valid_bmi] / (adjusted_heights[valid_bmi] / 100.0) ** 2
    fill_age_indicator("imtu", bmi, "bmiForAge", valid_bmi)

    valid_bbtb = np.isfinite(weights) & np.isfinite(adjusted_heights)
    minimum = np.where(ages <= 24, 45.0, 65.0)
    bbtb_index = np.zeros(size, dtype=np.int64)
    if np.any(valid_bbtb):
        bbtb_index[valid_bbtb] = np.floor(
            (adjusted_heights[valid_bbtb] - minimum[valid_bbtb]) * 2.0 + 0.5
        ).astype(np.int64)
    bbtb_positions = [index for index in range(size) if valid_bbtb[index]]
    bbtb_keys = [
        (
            str(items[index]["sex"]),
            "weightForLength" if ages[index] <= 24 else "weightForHeight",
            int(bbtb_index[index]),
        )
        for index in bbtb_positions
    ]
    for key_positions in grouped(bbtb_keys).values():
        actual = [bbtb_positions[position] for position in key_positions]
        sex = str(items[actual[0]]["sex"])
        table_name = "weightForLength" if ages[actual[0]] <= 24 else "weightForHeight"
        index = int(bbtb_index[actual[0]])
        rows = reference.get(table_name, {}).get(sex, [])
        if 0 <= index < len(rows):
            scores["bbtb"][actual] = batch_lms(weights[actual], [rows[index]] * len(actual))

    circumference = circumference_standards()
    circumference_maps = {
        (indicator, sex, int(row[0])): row[1:]
        for indicator, by_sex in circumference.items()
        for sex, rows in by_sex.items()
        for row in rows
    }
    for name, values, indicator, minimum_age in (
        ("lila", lila_values, "lila", 3),
        ("lk", head_values, "lk", 0),
    ):
        valid = np.isfinite(values) & (ages >= minimum_age)
        positions = [index for index in range(size) if valid[index]]
        keys = [(indicator, str(items[index]["sex"]), int(ages[index])) for index in positions]
        for key_positions in grouped(keys).values():
            actual = [positions[position] for position in key_positions]
            row = circumference_maps.get(keys[key_positions[0]])
            if row is not None:
                scores[name][actual] = batch_lms(values[actual], [row] * len(actual))

    def score(index: int, name: str) -> float | None:
        value = float(scores[name][index])
        return value if math.isfinite(value) else None

    result = []
    for index, item in enumerate(items):
        values = {name: score(index, name) for name in scores}
        result.append(
            {
                "row_number": item.get("row_number", 0),
                "record_id": item.get("record_id", ""),
                "nik": item.get("nik", ""),
                "bbu_status": nutrition_status(values["bbu"], "BBU"),
                "tbu_status": nutrition_status(values["tbu"], "TBU"),
                "bbtb_status": nutrition_status(values["bbtb"], "BBTB"),
                "imtu_status": nutrition_status(values["imtu"], "IMTU"),
                "lila_status": nutrition_status(values["lila"], "LILA"),
                "lk_status": nutrition_status(values["lk"], "LK"),
                "bbu_z_score": values["bbu"],
                "tbu_z_score": values["tbu"],
                "bbtb_z_score": values["bbtb"],
                "imtu_z_score": values["imtu"],
                "lila_z_score": values["lila"],
                "lk_z_score": values["lk"],
            }
        )
    return result


def calculate_batch(items: list[dict[str, Any]]) -> dict[str, Any]:
    from . import ml

    if len(items) > MAX_BATCH_ITEMS:
        raise ValueError("Jumlah item melebihi batas 10.000 per batch.")
    for index, item in enumerate(items):
        validate_item(item, index)
    vectorized = vectorized_assess_items(items)
    assessments = []
    for index, item in enumerate(items):
        history = item.get("history")
        if not isinstance(history, list):
            history = []
        base_assessment = vectorized[index] if vectorized is not None else None
        assessments.append(ml.analyze_item(item, history, assessment=base_assessment))
    return {
        "underweight": sum(item["bbu_status"] in ("Berat Sangat Kurang", "Berat Kurang") for item in assessments),
        "stunting": sum(item["tbu_status"] in ("Sangat Pendek", "Pendek") for item in assessments),
        "wasting": sum(item["bbtb_status"] in ("Gizi Buruk", "Gizi Kurang") for item in assessments),
        "total": len(assessments),
        "items": assessments,
        "standards_version": STANDARDS_VERSION,
        "calculator": "python-deterministic-lms",
    }
