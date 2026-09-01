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


MAX_BATCH_ITEMS = 10_000
STANDARDS_VERSION = "WHO-2006-2007-LMS"


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
    return _repository_root() / "frontend" / "src" / "data" / "whoGrowthLms.ts"


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
        for sex, block in zip(("L", "P"), match.groups(), strict=True):
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


def lms_z_score(value: float, reference: list[float] | tuple[float, float, float]) -> float:
    l, median, spread = reference
    if l == 0.0:
        return math.log(value / median) / spread
    return ((value / median) ** l - 1.0) / (l * spread)


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
            return "LILA Sangat Rendah"
        if score < -2:
            return "LILA Rendah"
        if score <= 2:
            return "LILA Normal"
        return "LILA Tinggi"
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


def calculate_batch(items: list[dict[str, Any]]) -> dict[str, Any]:
    from . import ml

    if len(items) > MAX_BATCH_ITEMS:
        raise ValueError("Jumlah item melebihi batas 10.000 per batch.")
    assessments = []
    for index, item in enumerate(items):
        validate_item(item, index)
        history = item.get("history")
        if not isinstance(history, list):
            history = []
        assessments.append(ml.analyze_item(item, history))
    return {
        "underweight": sum(item["bbu_status"] in ("Berat Sangat Kurang", "Berat Kurang") for item in assessments),
        "stunting": sum(item["tbu_status"] in ("Sangat Pendek", "Pendek") for item in assessments),
        "wasting": sum(item["bbtb_status"] in ("Gizi Buruk", "Gizi Kurang") for item in assessments),
        "total": len(assessments),
        "items": assessments,
        "standards_version": STANDARDS_VERSION,
        "calculator": "python-deterministic-lms",
    }
