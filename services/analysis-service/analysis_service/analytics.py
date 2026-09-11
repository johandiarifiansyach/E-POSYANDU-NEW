"""Dataset-level analytics owned by the Python analysis service.

This module is deliberately separate from the transport layer.  It accepts
raw child and measurement rows, applies the same WHO/longitudinal rules as
``who`` and ``ml``, and returns dashboard aggregates. PostgreSQL/Rust may
perform scope filtering, projection, and non-clinical row counts, but Python
remains the authority for every status, N/T/O/B, ASI, risk, education, and
clinical aggregate.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
import os
from typing import Any
from zoneinfo import ZoneInfo

from . import ml, who
from .runtime import TtlLruCache, payload_fingerprint


def _cache_size(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(1, value)


def _cache_ttl(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(0.0, value)


# Assessments contain only derived values, not raw identity fields.  This
# cache is shared by dashboard and table requests so an unchanged child is
# classified once per cache lifetime, even when the UI requests another page.
_ASSESSMENT_CACHE: TtlLruCache[dict[str, Any]] = TtlLruCache(
    _cache_size("ANALYSIS_ASSESSMENT_CACHE_SIZE", 20_000),
    _cache_ttl("ANALYSIS_ASSESSMENT_CACHE_TTL_SECONDS", 300.0),
)

AGE_GROUPS = {
    "0-59", "newborn", "newborn_premature", "0-5", "6", "0-11",
    "0-23", "6-11", "6-23", "12-23", "6-59", "12-59", "24-59",
}
REPORT_TIMEZONE = ZoneInfo("Asia/Jakarta")


def _text(value: Any) -> str:
    return str(value or "").strip()


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def _date_key(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value:
            return _text(value)[:10]
    return ""


def _local_date_key(row: dict[str, Any], *keys: str) -> str:
    """Return a report-local date for timestamptz values.

    PostgreSQL dashboard aggregation uses Asia/Jakarta boundaries.  Parsing
    the timestamp here prevents a child created near midnight UTC from being
    assigned to a different report month by Python's string slicing.
    """

    for key in keys:
        value = row.get(key)
        if not value:
            continue
        text = _text(value)
        if "T" not in text:
            return text[:10]
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return text[:10]
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(REPORT_TIMEZONE).date().isoformat()
    return ""


def _month(value: str) -> int | None:
    try:
        parsed = date.fromisoformat(value[:10])
    except (TypeError, ValueError):
        return None
    return parsed.year * 12 + parsed.month


def _in_range(value: str, start: str, end: str) -> bool:
    return bool(value) and start <= value <= end


def _matches_age_group(child: dict[str, Any], group: str, reference: str) -> bool:
    """Apply the shared age cohorts consistently for every Python operation."""

    group = group if group in AGE_GROUPS else "0-59"
    birth = _date_key(child, "birth_date", "tglLahir", "birthDate")
    age = _child_age(child, reference)
    if not birth or age is None or age < 0 or age > 59:
        return False
    try:
        born = date.fromisoformat(birth)
        at = date.fromisoformat(reference[:10])
    except (TypeError, ValueError):
        return False
    if born > at:
        return False
    newborn = 0 <= (at - born).days <= 28
    if group == "newborn":
        return newborn
    if group == "newborn_premature":
        weeks = _number(child.get("gestational_age_weeks", child.get("gestationalAgeWeeks", child.get("usiaKehamilan"))))
        return newborn and weeks is not None and 0 < weeks < 37
    if group == "0-59":
        return True
    if group == "6":
        return age == 6
    minimum, maximum = (int(part) for part in group.split("-", 1))
    return minimum <= age <= maximum


def _child_id(row: dict[str, Any]) -> str:
    return _text(row.get("id") or row.get("child_id") or row.get("childId"))


def _measurement_child_id(row: dict[str, Any]) -> str:
    return _text(row.get("child_id") or row.get("childId") or row.get("legacy_child_id"))


def _measurement_sort_key(row: dict[str, Any]) -> tuple[str, str, str]:
    """Match PostgreSQL's latest-measurement ordering exactly.

    The native read projection resolves a duplicate measurement date with
    ``created_at`` and then the stable row id.  Using the same three keys in
    Python prevents dashboard aggregates from selecting a different row than
    the table when a child has more than one entry on a day.
    """

    return (
        _date_key(row, "measurement_date", "tglUkur", "measurementDate"),
        _text(row.get("created_at") or row.get("createdAt")),
        _text(row.get("id")),
    )


def _measurement_for_analysis(child: dict[str, Any], row: dict[str, Any]) -> dict[str, Any] | None:
    birth_date = _date_key(child, "birth_date", "tglLahir", "birthDate")
    measured_date = _date_key(row, "measurement_date", "tglUkur", "measurementDate")
    age = row.get("age_in_months", row.get("ageInMonths"))
    if age is None and birth_date and measured_date:
        try:
            birth = date.fromisoformat(birth_date)
            measured = date.fromisoformat(measured_date)
            age = max(0, (measured.year - birth.year) * 12 + measured.month - birth.month - (measured.day < birth.day))
        except ValueError:
            age = None
    if age is None:
        return None
    try:
        age = int(round(float(age)))
    except (TypeError, ValueError):
        return None
    if not 0 <= age <= 60:
        return None
    sex = _text(child.get("sex") or child.get("jk")).upper()
    if sex not in {"L", "P"}:
        return None
    return {
        "weight_kg": _number(row.get("weight_kg", row.get("bb"))),
        "height_cm": _number(row.get("height_cm", row.get("tb"))),
        "lila_cm": _number(row.get("mid_upper_arm_circumference_cm", row.get("lila_cm", row.get("lila")))),
        "head_circumference_cm": _number(row.get("head_circumference_cm", row.get("lk"))),
        "age_months": age,
        "sex": sex,
        "measurement_method": row.get("measurement_method", row.get("caraUkur")) or "",
        "measurement_date": measured_date,
        "exclusive_breastfeeding": row.get("exclusive_breastfeeding", row.get("asi")),
        "record_id": _text(row.get("id")),
    }


def _assess_item_cached(
    child: dict[str, Any],
    item: dict[str, Any],
    history: list[dict[str, Any]],
) -> dict[str, Any]:
    """Reuse a derived assessment when the child's raw analysis inputs match."""

    # Only include fields that affect age/sex conversion and the analysis
    # inputs.  The cache key never stores or exposes names, NIKs, or addresses.
    context = {
        "childId": _child_id(child),
        "birthDate": _date_key(child, "birth_date", "tglLahir", "birthDate"),
        "sex": _text(child.get("sex") or child.get("jk")).upper(),
        "item": item,
        "history": history,
    }
    key = payload_fingerprint(context)
    cached = _ASSESSMENT_CACHE.get(key)
    if cached is not None:
        return cached
    assessed = ml.analyze_item({**item, "history": history}, history)
    _ASSESSMENT_CACHE.set(key, assessed)
    return assessed


def clear_analysis_caches() -> None:
    """Clear process-local derived assessment state (used by maintenance/tests)."""

    _ASSESSMENT_CACHE.clear()


def analysis_cache_stats() -> dict[str, int]:
    """Expose non-sensitive cache counters for local diagnostics."""

    return _ASSESSMENT_CACHE.stats()


def _status_counts(assessments: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "underweight": sum(item.get("bbu_status") in {"Berat Sangat Kurang", "Berat Kurang"} for item in assessments),
        "stunting": sum(item.get("tbu_status") in {"Sangat Pendek", "Pendek"} for item in assessments),
        "wasting": sum(item.get("bbtb_status") in {"Gizi Buruk", "Gizi Kurang"} for item in assessments),
    }


def _percent(part: int, whole: int) -> str:
    return str(round(part * 100 / whole, 1)) if whole else "0"


def dashboard_stats(dataset: dict[str, Any]) -> dict[str, Any]:
    """Aggregate an authenticated raw dataset into the SKDN dashboard shape."""

    children = [row for row in dataset.get("children", []) if isinstance(row, dict)]
    measurements = [row for row in dataset.get("measurements", []) if isinstance(row, dict)]
    month_start = _text(dataset.get("monthStart"))[:10]
    month_end = _text(dataset.get("monthEnd"))[:10]
    previous_start = _text(dataset.get("previousMonthStart"))[:10]
    previous_end = _text(dataset.get("previousMonthEnd"))[:10]
    scope_village = _text(dataset.get("scopeVillage"))
    scope_posyandu = _text(dataset.get("scopePosyandu"))
    requested_village = _text(dataset.get("village"))
    requested_posyandu = _text(dataset.get("posyandu"))
    age_group = _text(dataset.get("ageGroup")) or "0-59"
    role = _text(dataset.get("role"))

    active: list[dict[str, Any]] = []
    for child in children:
        if child.get("deleted_at") or child.get("deletedAt"):
            continue
        birth = _date_key(child, "birth_date", "tglLahir", "birthDate")
        if not birth or (month_end and birth > month_end):
            continue
        if month_end:
            age_at_end = _child_age(child, month_end)
            if age_at_end is None or age_at_end > 59:
                continue
        if not _matches_age_group(child, age_group, month_end):
            continue
        if requested_village and _text(child.get("village") or child.get("desa")) != requested_village:
            continue
        if requested_posyandu and _text(child.get("posyandu")) != requested_posyandu:
            continue
        # Defense in depth: scope is applied again in Python even though the
        # Rust data boundary already restricts the database query.
        if role != "Ahli Gizi" and scope_village and _text(child.get("village") or child.get("desa")) != scope_village:
            continue
        if role == "Kader Posyandu" and scope_posyandu and _text(child.get("posyandu")) != scope_posyandu:
            continue
        active.append(child)

    by_child: dict[str, list[dict[str, Any]]] = {}
    for row in measurements:
        child_id = _measurement_child_id(row)
        if child_id:
            by_child.setdefault(child_id, []).append(row)
    for rows in by_child.values():
        rows.sort(key=_measurement_sort_key)

    # The dashboard projection includes a compact all-history ASI stream for
    # the six-month cohort. Older deployments do not provide this field, so
    # the current/previous measurement stream remains a safe compatibility
    # fallback.
    asi_rows = dataset.get("asiMeasurements")
    if not isinstance(asi_rows, list) or (not asi_rows and measurements):
        asi_rows = measurements
    by_child_asi: dict[str, list[dict[str, Any]]] = {}
    for row in asi_rows:
        if not isinstance(row, dict):
            continue
        child_id = _measurement_child_id(row)
        if child_id:
            by_child_asi.setdefault(child_id, []).append(row)
    for rows in by_child_asi.values():
        rows.sort(key=_measurement_sort_key)

    assessments: list[dict[str, Any]] = []
    measured = 0
    naik = tidak_naik = 0
    no_previous = 0
    created = 0
    for child in active:
        child_id = _child_id(child)
        rows = by_child.get(child_id, [])
        current_rows = [row for row in rows if _in_range(_date_key(row, "measurement_date", "tglUkur", "measurementDate"), month_start, month_end)]
        previous_rows = [row for row in rows if _in_range(_date_key(row, "measurement_date", "tglUkur", "measurementDate"), previous_start, previous_end)]
        created_at = _local_date_key(child, "created_at", "createdAt")
        if month_start and created_at.startswith(month_start[:7]):
            created += 1
        if not current_rows:
            continue
        current_row = current_rows[-1]
        # O (Tidak Ditimbang) is a status of the current measurement cohort:
        # a child without a current valid weight is not present in the table's
        # status column and must not inflate the dashboard O counter.
        current_weight = _number(current_row.get("weight_kg", current_row.get("bb")))
        if current_weight is None or current_weight <= 0:
            continue
        measured += 1
        if not previous_rows:
            no_previous += 1
        item = _measurement_for_analysis(child, current_row)
        if not item:
            # Keep D/O aligned with the table even when a malformed row cannot
            # be classified clinically (for example a missing sex value).
            continue
        history = []
        for row in rows:
            if row is current_row:
                continue
            historical = _measurement_for_analysis(child, row)
            if historical and (
                historical.get("weight_kg") is not None
                or historical.get("exclusive_breastfeeding") is not None
            ):
                history.append(historical)
        item["history"] = history
        assessed = _assess_item_cached(child, item, history)
        assessments.append(assessed)
        gain = assessed.get("weight_gain_status")
        if gain == "N":
            naik += 1
        elif gain == "T":
            tidak_naik += 1

    # ASI coverage has a different denominator from D (Ditimbang).  S for
    # this indicator is every active child who is exactly six completed months
    # old at the report date, including children without a weight/height row
    # in the selected month.  The numerator is derived by the same progressive
    # 0–6-month classifier used by measurement analysis; a single affirmative
    # answer at month six fills the preceding months, while missing answers
    # remain unclassified.
    # The SQL projection supplies an independent six-month cohort so the ASI
    # denominator remains S = all scoped children at exactly six months even
    # when the dashboard's selected age filter is, for example, 0-5 or
    # 12-23.  During a rolling migration older projections omit this field;
    # falling back to ``active`` preserves the previous behaviour safely.
    asi_children = dataset.get("asiChildren")
    if not isinstance(asi_children, list) or (not asi_children and active):
        asi_children = active

    asi_target = 0
    asi_exclusive = 0
    for child in asi_children:
        if _child_age(child, month_end) != 6:
            continue
        asi_target += 1
        rows = by_child_asi.get(_child_id(child), [])
        eligible_rows = [
            row for row in rows
            if _date_key(row, "measurement_date", "tglUkur", "measurementDate") <= month_end
        ]
        if not eligible_rows:
            continue
        latest = eligible_rows[-1]
        item = _measurement_for_analysis(child, latest)
        if not item:
            continue
        history = []
        for row in eligible_rows:
            if row is latest:
                continue
            historical = _measurement_for_analysis(child, row)
            if historical:
                history.append(historical)
        if ml._asi_context(item, history).get("status") == "Ya":
            asi_exclusive += 1

    counts = _status_counts(assessments)
    total = len(active)
    result = {
        "S": total,
        "D": measured,
        "N": naik,
        "T": tidak_naik,
        "B": created,
        "O": no_previous,
        "asiEksklusif": asi_exclusive,
        "asiTarget": asi_target,
        **counts,
        "perD": _percent(measured, total),
        "perN": _percent(naik, measured),
        "perT": _percent(tidak_naik, measured),
        "perAsiEksklusif": _percent(asi_exclusive, asi_target),
        "perUnderweight": _percent(counts["underweight"], measured),
        "perStunting": _percent(counts["stunting"], measured),
        "perWasting": _percent(counts["wasting"], measured),
        "calculator": "python-deterministic-lms",
        "analytics": "python-dashboard-analytics-v1",
        "standardsVersion": who.STANDARDS_VERSION,
        "pipeline": "postgresql-technical-rust-scope-python-clinical-v1",
        "inputSummary": dataset.get("technical") if isinstance(dataset.get("technical"), dict) else {},
    }
    return result


def _child_age(child: dict[str, Any], reference: str) -> int | None:
    birth = _date_key(child, "birth_date", "tglLahir", "birthDate")
    if not birth or not reference:
        return None
    try:
        born = date.fromisoformat(birth)
        at = date.fromisoformat(reference[:10])
    except ValueError:
        return None
    return max(0, (at.year - born.year) * 12 + at.month - born.month - (at.day < born.day))


def _public_child(row: dict[str, Any]) -> dict[str, Any]:
    """Expose the legacy camelCase document shape without calculating status."""

    data = dict(row)
    aliases = {
        "nama": ("name", "nama"),
        "nik": ("national_id", "nik"),
        "anakKe": ("child_order", "anakKe"),
        "tglLahir": ("birth_date", "tglLahir"),
        "jk": ("sex", "jk"),
        "noKK": ("family_card_number", "noKK"),
        "namaOrtu": ("parent_name", "namaOrtu"),
        "nikOrtu": ("parent_national_id", "nikOrtu"),
        "noHpOrtu": ("parent_phone", "noHpOrtu"),
        "hasNIK": ("has_national_id", "hasNIK"),
        "alamat": ("address", "alamat"),
        "desa": ("village", "desa"),
        "posyandu": ("posyandu",),
        "createdAt": ("created_at", "createdAt"),
        "updatedAt": ("updated_at", "updatedAt"),
        "deletedAt": ("deleted_at", "deletedAt"),
        "lastMeasurementDate": ("last_measurement_date", "lastMeasurementDate"),
    }
    for target, keys in aliases.items():
        for key in keys:
            if row.get(key) is not None:
                data[target] = row[key]
                break
    return data


def _public_measurement(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    aliases = {
        "childId": ("legacy_child_id", "child_id", "childId"),
        "childName": ("legacy_child_name", "childName"),
        "desa": ("legacy_village", "village", "desa"),
        "posyandu": ("legacy_posyandu", "posyandu"),
        "tglUkur": ("measurement_date", "tglUkur"),
        "bb": ("weight_kg", "bb"),
        "tb": ("height_cm", "tb"),
        "lila": ("mid_upper_arm_circumference_cm", "lila"),
        "lk": ("head_circumference_cm", "lk"),
        "caraUkur": ("measurement_method", "caraUkur"),
        "statusNaik": ("weight_gain_status", "statusNaik"),
        "ageInMonths": ("age_in_months", "ageInMonths"),
        "asi": ("exclusive_breastfeeding", "asi"),
    }
    for target, keys in aliases.items():
        for key in keys:
            if row.get(key) is not None:
                data[target] = row[key]
                break
    return data


def _public_assessment(assessment: dict[str, Any] | None) -> dict[str, Any]:
    """Expose the Python assessment fields consumed by all table clients."""

    if not assessment:
        return {}
    return {
        "bbuStatus": assessment.get("bbu_status"),
        "tbuStatus": assessment.get("tbu_status"),
        "bbtbStatus": assessment.get("bbtb_status"),
        "imtuStatus": assessment.get("imtu_status"),
        "lilaStatus": assessment.get("lila_status"),
        "lkStatus": assessment.get("lk_status"),
        "bbuZScore": assessment.get("bbu_z_score"),
        "tbuZScore": assessment.get("tbu_z_score"),
        "bbtbZScore": assessment.get("bbtb_z_score"),
        "imtuZScore": assessment.get("imtu_z_score"),
        "lilaZScore": assessment.get("lila_z_score"),
        "lkZScore": assessment.get("lk_z_score"),
        "weightGainStatus": assessment.get("weight_gain_status"),
        "weightGainMinimumGrams": assessment.get("weight_gain_minimum_grams"),
        "exclusiveBreastfeedingStatus": assessment.get("exclusive_breastfeeding_status"),
        "analysis": {
            "anomaly": assessment.get("anomaly", {}),
            "risk": assessment.get("risk", {}),
            "nutritionConcern": assessment.get("nutrition_concern"),
            "nutritionEducation": assessment.get("nutrition_education"),
            "historySignals": assessment.get("history_signals", {}),
        },
    }


def children_page(dataset: dict[str, Any]) -> dict[str, Any]:
    """Filter, classify, sort, and paginate the child table in Python."""

    children = [row for row in dataset.get("children", []) if isinstance(row, dict)]
    measurements = [row for row in dataset.get("measurements", []) if isinstance(row, dict)]
    mpasi_logs = [row for row in dataset.get("mpasiLogs", []) if isinstance(row, dict)]
    view = _text(dataset.get("view")) or "data"
    start = _text(dataset.get("measurementStart"))[:10]
    end = _text(dataset.get("measurementEnd"))[:10]
    as_of = _text(dataset.get("asOf"))[:10] or end
    previous_start = _text(dataset.get("previousMonthStart"))[:10]
    previous_end = _text(dataset.get("previousMonthEnd"))[:10]
    search = _text(dataset.get("search")).casefold()
    village = _text(dataset.get("village"))
    posyandu = _text(dataset.get("posyandu"))
    age_group = _text(dataset.get("ageGroup")) or "0-59"
    # MPASI is a programme-specific 6–23-month cohort. Keep this invariant in
    # Python as well as the UI/API so a direct worker call cannot broaden it.
    if view == "mpasi":
        age_group = "6-23"
    scope_village = _text(dataset.get("scopeVillage"))
    scope_posyandu = _text(dataset.get("scopePosyandu"))
    role = _text(dataset.get("role"))
    page = max(1, int(_number(dataset.get("page")) or 1))
    size = min(50, max(1, int(_number(dataset.get("size")) or 10)))
    sort = _text(dataset.get("sort")) or "recent"
    # For regular table views Rust has already applied scope, search, sort,
    # and pagination in PostgreSQL.  Python must still classify every row in
    # that bounded page, but must not sort/slice it a second time (which would
    # make page 2+ empty and would report the page size as the total count).
    page_limited = bool(dataset.get("pageLimited"))
    total_hint = _number(dataset.get("totalHint"))

    by_child: dict[str, list[dict[str, Any]]] = {}
    for row in measurements:
        child_id = _measurement_child_id(row)
        if child_id:
            by_child.setdefault(child_id, []).append(row)
    for rows in by_child.values():
        rows.sort(key=_measurement_sort_key)

    selected: list[tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]] = []
    for child in children:
        child_id = _child_id(child)
        deleted = bool(child.get("deleted_at") or child.get("deletedAt"))
        if view == "recycle":
            if not deleted:
                continue
        elif deleted:
            continue
        birth = _date_key(child, "birth_date", "tglLahir", "birthDate")
        if birth and as_of and birth > as_of:
            continue
        if view != "recycle":
            age_at_as_of = _child_age(child, as_of)
            if age_at_as_of is None or age_at_as_of > 59:
                continue
        if not _matches_age_group(child, age_group, as_of):
            continue
        child_village = _text(child.get("village") or child.get("desa"))
        child_posyandu = _text(child.get("posyandu"))
        if village and child_village != village:
            continue
        if posyandu and child_posyandu != posyandu:
            continue
        if role != "Ahli Gizi" and scope_village and child_village != scope_village:
            continue
        if role == "Kader Posyandu" and scope_posyandu and child_posyandu != scope_posyandu:
            continue
        if search and search not in " ".join((_text(child.get("name") or child.get("nama")), _text(child.get("national_id") or child.get("nik")))).casefold():
            continue
        created = _date_key(child, "created_at", "createdAt")
        if view == "recent" and not _in_range(created, start, end):
            continue
        age = _child_age(child, as_of)
        if view == "mpasi" and (age is None or not 6 <= age <= 23):
            continue

        rows = by_child.get(child_id, [])
        current_rows = [row for row in rows if _in_range(_date_key(row, "measurement_date", "tglUkur", "measurementDate"), start, end)]
        previous_rows = [row for row in rows if _in_range(_date_key(row, "measurement_date", "tglUkur", "measurementDate"), previous_start, previous_end)]
        current = current_rows[-1] if current_rows else None
        assessed = None
        if current:
            item = _measurement_for_analysis(child, current)
            if item and item.get("weight_kg") is not None:
                history = []
                for row in rows:
                    if row is current:
                        continue
                    historical = _measurement_for_analysis(child, row)
                    if historical and (historical.get("weight_kg") is not None or historical.get("exclusive_breastfeeding") is not None):
                        history.append(historical)
                assessed = _assess_item_cached(child, item, history)
                # Keep the resolved age alongside the status fields so every
                # table renderer can display it without re-deriving dates.
                assessed["age_months"] = item.get("age_months")
        if view.startswith("problem_"):
            if not assessed:
                continue
            if view == "problem_underweight" and assessed.get("bbu_status") not in {"Berat Sangat Kurang", "Berat Kurang"}:
                continue
            if view == "problem_stunting" and assessed.get("tbu_status") not in {"Sangat Pendek", "Pendek"}:
                continue
            if view == "problem_wasting" and assessed.get("bbtb_status") not in {"Gizi Buruk", "Gizi Kurang"}:
                continue
            if view == "problem_tidak_naik" and assessed.get("weight_gain_status") != "T":
                continue
        selected.append((child, current, assessed))

    def sort_key(entry: tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]) -> Any:
        child, current, _assessed = entry
        name = _text(child.get("name") or child.get("nama")).casefold()
        created = _date_key(child, "created_at", "createdAt")
        age = _child_age(child, as_of) or 0
        if sort == "name_asc":
            return (name, created)
        if sort == "name_desc":
            return (name, created)
        if sort == "age_oldest":
            return (-age, name)
        if sort == "age_youngest":
            return (age, name)
        measurement_date = _date_key(current or {}, "measurement_date", "tglUkur", "measurementDate")
        return (measurement_date or created, name)

    if page_limited:
        # The native selector is intentionally not trusted for any derived
        # value.  Its rows are already in the requested order and represent
        # exactly this page; Python remains authoritative for status, N/T/O/B,
        # ASI, risk, and education.
        total = int(total_hint) if total_hint is not None else len(selected)
        page_items = selected
    else:
        selected.sort(key=sort_key, reverse=sort in {"recent", "name_desc"})
        total = len(selected)
        page_items = selected[(page - 1) * size : page * size]
    output_children = []
    output_measurements = []
    output_ids = set()
    for child, current, assessed in page_items:
        child_id = _child_id(child)
        output_ids.add(child_id)
        output_children.append({"id": child_id, "data": _public_child(child)})
        if current:
            measurement_id = _text(current.get("id"))
            measurement_data = _public_measurement(current)
            if assessed:
                measurement_data.update({
                    "ageInMonths": assessed.get("age_months"),
                    "statusNaik": assessed.get("weight_gain_status"),
                    **_public_assessment(assessed),
                })
            output_measurements.append({"id": measurement_id, "data": measurement_data})
    output_mpasi = [
        {"id": _text(row.get("id")), "data": dict(row)}
        for row in mpasi_logs
        if _measurement_child_id(row) in output_ids
        and _in_range(_date_key(row, "monitoring_date", "tglMonitoring"), start, end)
    ]
    return {
        "items": output_children,
        "measurements": output_measurements,
        "mpasiLogs": output_mpasi,
        "total": total,
        "pageLimited": page_limited,
        "calculator": "python-deterministic-lms",
        "analytics": "python-table-filter-v1",
        "standardsVersion": who.STANDARDS_VERSION,
    }


def exclusive_breastfeeding_page(dataset: dict[str, Any]) -> dict[str, Any]:
    """Return the ASI list from the same Python ASI classifier used in analysis."""

    children = [row for row in dataset.get("children", []) if isinstance(row, dict)]
    measurements = [row for row in dataset.get("measurements", []) if isinstance(row, dict)]
    start = _text(dataset.get("measurementStart"))[:10]
    end = _text(dataset.get("measurementEnd"))[:10]
    age_group = _text(dataset.get("ageGroup")) or "0-5"
    village = _text(dataset.get("village"))
    posyandu = _text(dataset.get("posyandu"))
    scope_village = _text(dataset.get("scopeVillage"))
    scope_posyandu = _text(dataset.get("scopePosyandu"))
    role = _text(dataset.get("role"))
    page = max(1, int(_number(dataset.get("page")) or 1))
    size = min(50, max(1, int(_number(dataset.get("size")) or 10)))

    by_child: dict[str, list[dict[str, Any]]] = {}
    for row in measurements:
        child_id = _measurement_child_id(row)
        # Keep the complete history here.  The selected period is applied
        # below only when choosing the current record; ASI classification
        # needs the 0–6-month answers from prior measurements as context.
        if child_id:
            by_child.setdefault(child_id, []).append(row)
    for rows in by_child.values():
        rows.sort(key=_measurement_sort_key)

    selected: list[dict[str, Any]] = []
    for child in children:
        if child.get("deleted_at") or child.get("deletedAt"):
            continue
        child_id = _child_id(child)
        child_village = _text(child.get("village") or child.get("desa"))
        child_posyandu = _text(child.get("posyandu"))
        if village and child_village != village:
            continue
        if posyandu and child_posyandu != posyandu:
            continue
        if role != "Ahli Gizi" and scope_village and child_village != scope_village:
            continue
        if role == "Kader Posyandu" and scope_posyandu and child_posyandu != scope_posyandu:
            continue
        rows = by_child.get(child_id, [])
        current_rows = [
            row for row in rows
            if _in_range(_date_key(row, "measurement_date", "tglUkur", "measurementDate"), start, end)
        ]
        if not current_rows:
            continue
        latest = current_rows[-1]
        item = _measurement_for_analysis(child, latest)
        if not item:
            continue
        history = []
        for row in rows:
            if row is latest:
                continue
            historical = _measurement_for_analysis(child, row)
            if historical:
                history.append(historical)
        asi = ml._asi_context(item, history)
        if asi.get("status") != "Ya":
            continue
        age = item.get("age_months")
        if not _matches_age_group(child, age_group, _text(item.get("measurement_date"))[:10]):
            continue
        data = _public_child(child)
        has_nik = child.get("has_national_id", child.get("hasNIK"))
        if has_nik is None:
            has_nik = bool(_text(child.get("national_id") or child.get("nik")))
        data.update({
            "hasNIK": bool(has_nik),
            "tglUkur": item.get("measurement_date"),
            "ageInMonths": age,
            "asiStatus": "Ya",
        })
        selected.append({"id": child_id, "data": data})

    selected.sort(key=lambda entry: (_text(entry["data"].get("nama")).casefold(), entry["id"]))
    total = len(selected)
    return {
        "items": selected[(page - 1) * size : page * size],
        "total": total,
        "calculator": "python-asi-context-v1",
        "analytics": "python-exclusive-breastfeeding-v1",
        "standardsVersion": who.STANDARDS_VERSION,
    }


def analyze_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    operation = _text(dataset.get("operation")) or "dashboard_stats"
    if operation == "dashboard_stats":
        return dashboard_stats(dataset)
    if operation == "children_page":
        return children_page(dataset)
    if operation == "exclusive_breastfeeding_page":
        return exclusive_breastfeeding_page(dataset)
    raise ValueError(f"Operasi dataset tidak didukung: {operation}")
