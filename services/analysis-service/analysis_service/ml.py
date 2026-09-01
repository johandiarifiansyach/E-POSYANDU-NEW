"""Lightweight, private growth-risk and anomaly analysis.

The WHO indicators remain deterministic LMS calculations in :mod:`who`.  This
module adds small, explainable logistic baselines for *risk screening* and
growth-trend analysis plus data-quality rules.  It deliberately uses the
Python standard library so the analysis container stays small and suitable
for the single Oracle host.

The result is not a diagnosis.  A health worker must review the original
measurement whenever an anomaly or elevated risk is reported.
"""

from __future__ import annotations

import math
import re
from statistics import median
from typing import Any


MODEL_VERSION = "growth-risk-logistic-v1"
ANOMALY_VERSION = "growth-quality-rules-v1"
GRAPH_MODEL_VERSION = "growth-trend-logistic-v1"


# A child who already meets a WHO problem classification needs an actionable
# care message, not another probability label.  "Risiko" classifications are
# intentionally excluded: those remain screening signals until a problem is
# confirmed by the WHO indicator itself.
_NUTRITION_PROBLEM_STATUSES = {
    "Berat Sangat Kurang",
    "Berat Kurang",
    "Sangat Pendek",
    "Pendek",
    "Gizi Buruk",
    "Gizi Kurang",
    "Gizi Lebih",
    "Obesitas",
    "LILA Sangat Rendah",
    "LILA Rendah",
    "Mikrosefali Berat",
    "Mikrosefali",
    "Makrosefali",
}
_SEVERE_NUTRITION_STATUSES = {
    "Berat Sangat Kurang",
    "Gizi Buruk",
    "LILA Sangat Rendah",
    "Mikrosefali Berat",
}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _date_key(item: dict[str, Any]) -> str:
    value = item.get("measurement_date") or item.get("measurementDate") or item.get("tglUkur") or ""
    return str(value).strip()[:10]


def _field(item: dict[str, Any], name: str) -> Any:
    """Read the snake_case keys used internally and frontend camelCase keys."""

    if name in item:
        return item[name]
    if name == "exclusive_breastfeeding":
        return item.get("exclusiveBreastfeeding", item.get("asi"))
    aliases = {
        "weight_kg": "weightKg",
        "height_cm": "heightCm",
        "lila_cm": "lilaCm",
        "head_circumference_cm": "headCircumferenceCm",
        "measurement_method": "measurementMethod",
        "weight_gain_status": "weightGainStatus",
    }
    return item.get(aliases.get(name, name))


def _normalized_asi(value: Any) -> str | None:
    """Normalize the recorded exclusive-breastfeeding answer without guessing."""

    if isinstance(value, bool):
        return "Ya" if value else "Tidak"
    if value is None:
        return None
    normalized = str(value).strip().casefold()
    if normalized in {"ya", "yes", "true", "1"}:
        return "Ya"
    if normalized in {"tidak", "no", "false", "0"}:
        return "Tidak"
    return None


def _age_months(item: dict[str, Any]) -> float | None:
    value = item.get("age_months", item.get("ageMonths"))
    if isinstance(value, str):
        try:
            value = float(value.strip().replace(",", "."))
        except ValueError:
            return None
    return _number(value)


def _asi_context(item: dict[str, Any], history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Summarize only recorded ASI answers from the 0–6 month period.

    A missing answer remains missing.  A ``Tidak konsisten`` result is kept
    explicit so the caregiver is not given a false binary conclusion.
    """

    observations: list[dict[str, Any]] = []
    records = [record for record in (history or []) if isinstance(record, dict)] + [item]
    for index, record in enumerate(records):
        value = _normalized_asi(_field(record, "exclusive_breastfeeding"))
        if value is None:
            continue
        age = _age_months(record)
        if age is not None and age > 6:
            continue
        observations.append({"value": value, "date": _date_key(record), "order": index})

    observations.sort(key=lambda value: (value["date"], value["order"]))
    values = {value["value"] for value in observations}
    if values == {"Ya"}:
        status = "Ya"
    elif values == {"Tidak"}:
        status = "Tidak"
    elif values == {"Ya", "Tidak"}:
        status = "Tidak konsisten"
    else:
        status = "Belum tercatat"
    return {
        "status": status,
        "observations": len(observations),
        "period": "0-6 bulan",
    }


def _previous_measurements(item: dict[str, Any], history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    current_date = _date_key(item)
    records = [record for record in history if isinstance(record, dict)]
    if current_date:
        records = [record for record in records if _date_key(record) and _date_key(record) < current_date]
    return sorted(records, key=_date_key)


def _anomaly(
    code: str,
    severity: str,
    field: str,
    message: str,
    *,
    current_value: float | None = None,
    previous_value: float | None = None,
    delta: float | None = None,
    detection: str = "rule",
) -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "field": field,
        "message": message,
        "currentValue": current_value,
        "previousValue": previous_value,
        "delta": delta,
        "detection": detection,
    }


def detect_anomalies(item: dict[str, Any], history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Detect impossible or suspicious changes against the child's history.

    A negative height delta is always surfaced (with a tiny 0.1 cm tolerance
    for decimal/rounding noise): a child's length/height cannot decrease.
    Other measurements use a robust median/MAD check when at least three prior
    observations exist, avoiding a fragile normal-distribution assumption.
    """

    previous_records = _previous_measurements(item, history or [])
    previous = previous_records[-1] if previous_records else None
    anomalies: list[dict[str, Any]] = []
    current_height = _number(_field(item, "height_cm"))
    previous_height = _number(_field(previous, "height_cm")) if previous else None

    if current_height is not None and previous_height is not None:
        height_delta = current_height - previous_height
        if height_delta < -0.1:
            anomalies.append(
                _anomaly(
                    "height_decreased",
                    "high",
                    "height_cm",
                    "Tinggi/panjang badan lebih rendah dari pengukuran sebelumnya. Periksa ulang alat, cara ukur, dan satuan; tinggi badan tidak mungkin turun.",
                    current_value=current_height,
                    previous_value=previous_height,
                    delta=height_delta,
                )
            )

    current_date = _date_key(item)
    if current_date and any(_date_key(record) == current_date for record in history or []):
        anomalies.append(
            _anomaly(
                "duplicate_measurement_date",
                "medium",
                "measurement_date",
                "Sudah ada pengukuran lain pada tanggal yang sama; pastikan ini bukan duplikasi pencatatan.",
            )
        )

    # Robust outlier detection for the last six observations.  The fallback
    # scale keeps the rule useful when the values are nearly identical.
    fields = (
        ("weight_kg", "berat badan", 0.3),
        ("height_cm", "tinggi/panjang badan", 0.5),
        ("lila_cm", "LILA", 1.0),
        ("head_circumference_cm", "lingkar kepala", 1.0),
    )
    for field, label, minimum_scale in fields:
        current = _number(_field(item, field))
        values = [_number(_field(record, field)) for record in previous_records[-6:]]
        values = [value for value in values if value is not None]
        if current is None or len(values) < 3:
            continue
        center = median(values)
        deviations = [abs(value - center) for value in values]
        scale = max(1.4826 * median(deviations), minimum_scale)
        if abs(current - center) > 3.0 * scale:
            anomalies.append(
                _anomaly(
                    "robust_outlier",
                    "medium",
                    field,
                    f"Nilai {label} berbeda jauh dari pola pengukuran sebelumnya. Periksa kembali data dan alat ukur.",
                    current_value=current,
                    previous_value=center,
                    delta=current - center,
                    detection="median_mad",
                )
            )

    severity_rank = {"low": 1, "medium": 2, "high": 3}
    highest = max((severity_rank.get(str(value["severity"]), 0) for value in anomalies), default=0)
    severity = next((name for name, rank in severity_rank.items() if rank == highest), "none")
    return {
        "detected": bool(anomalies),
        "count": len(anomalies),
        "severity": severity,
        "version": ANOMALY_VERSION,
        "items": anomalies,
    }


def _sigmoid(value: float) -> float:
    value = max(-30.0, min(30.0, value))
    return 1.0 / (1.0 + math.exp(-value))


def _risk_level(probability: float) -> str:
    if probability >= 0.75:
        return "tinggi"
    if probability >= 0.45:
        return "sedang"
    return "rendah"


def _risk_prediction(name: str, score: float, explanation: str) -> dict[str, Any]:
    probability = round(_sigmoid(score), 4)
    return {
        "probability": probability,
        "level": _risk_level(probability),
        "explanation": explanation,
        "model": MODEL_VERSION,
    }


def _weight_gain_status(item: dict[str, Any]) -> str | None:
    """Read a recorded N/T label without treating unknown values as T.

    Older records use ``statusNaik`` while the analysis payload uses
    ``weightGainStatus``.  ``B`` (first/baseline), ``O`` (out of sequence),
    and empty values are deliberately left unknown; they must not be counted
    as a failed weight gain.
    """

    value = (
        item.get("weight_gain_status")
        if "weight_gain_status" in item
        else item.get("weightGainStatus", item.get("statusNaik", item.get("status_naik")))
    )
    if value is None:
        return None
    normalized = str(value).strip().casefold()
    if normalized in {"n", "naik", "increasing", "increase"}:
        return "N"
    if normalized in {"t", "tidak naik", "tidak_naik", "not increasing", "not_increasing"}:
        return "T"
    return None


def _history_age(record: dict[str, Any], current: dict[str, Any], current_date: str) -> int | None:
    """Return an integer age, inferring it from dates when legacy rows omit it."""

    age = _age_months(record)
    if age is not None:
        return int(round(age))
    current_age = _age_months(current)
    if current_age is None:
        return None
    record_month = _month_index(_date_key(record))
    current_month = _month_index(current_date)
    if record_month is None or current_month is None:
        return None
    return int(round(current_age - (current_month - record_month)))


def _history_context(
    item: dict[str, Any],
    history: list[dict[str, Any]] | None,
    assessment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Derive transparent longitudinal signals from raw measurements.

    WHO status and z-scores are recomputed from each usable historical row,
    keeping the current deterministic calculator as the source of truth even
    when a browser sends only raw measurements.  This context is intentionally
    descriptive: it is used to explain screening risk, not to replace the
    official classification.
    """

    from .who import assess_item

    current_date = _date_key(item)
    records = [record for record in (history or []) if isinstance(record, dict)] + [item]
    ordered = sorted(enumerate(records), key=lambda pair: (_date_key(pair[1]), pair[0]))
    points: list[dict[str, Any]] = []
    previous_weight: float | None = None
    for order, record in ordered:
        weight = _number(_field(record, "weight_kg"))
        if weight is None or not 0.1 <= weight <= 60:
            continue
        age = _history_age(record, item, current_date)
        sex = str(record.get("sex", item.get("sex", ""))).strip().upper()
        height = _number(_field(record, "height_cm"))
        lila = _number(_field(record, "lila_cm"))
        head = _number(_field(record, "head_circumference_cm"))
        if age is None or not 0 <= age <= 60 or sex not in {"L", "P"}:
            continue
        if height is not None and not 10 <= height <= 220:
            height = None
        if lila is not None and not 0.1 <= lila <= 50:
            lila = None
        if head is not None and not 0.1 <= head <= 80:
            head = None
        who_item = {
            "weight_kg": weight,
            "height_cm": height,
            "age_months": age,
            "sex": sex,
            "measurement_method": _field(record, "measurement_method") or "",
            "lila_cm": lila,
            "head_circumference_cm": head,
        }
        try:
            row_assessment = assessment if record is item and assessment is not None else assess_item(who_item)
        except (TypeError, ValueError, KeyError, IndexError, OverflowError):
            continue
        explicit_gain = _weight_gain_status(record)
        inferred_gain = None
        if explicit_gain is not None:
            inferred_gain = explicit_gain
        elif previous_weight is not None:
            inferred_gain = "N" if weight > previous_weight else "T"
        points.append(
            {
                "date": _date_key(record),
                "order": order,
                "isCurrent": record is item,
                "weight": weight,
                "assessment": row_assessment,
                "weightGainStatus": inferred_gain,
            }
        )
        previous_weight = weight

    points.sort(key=lambda point: (point["date"], point["order"]))
    current_point = next((point for point in reversed(points) if point["isCurrent"]), None)
    prior_points = [point for point in points if not point["isCurrent"]]

    def z_trend(key: str) -> dict[str, Any]:
        values = [
            _number(point["assessment"].get(key))
            for point in points
            if _number(point["assessment"].get(key)) is not None
        ]
        if len(values) < 2:
            return {"first": values[0] if values else None, "latest": values[-1] if values else None, "delta": None, "direction": "insufficient_data"}
        delta = values[-1] - values[0]
        direction = "decreasing" if delta < -0.25 else "increasing" if delta > 0.25 else "stable"
        return {
            "first": round(values[0], 3),
            "latest": round(values[-1], 3),
            "delta": round(delta, 3),
            "direction": direction,
        }

    statuses = []
    for point in prior_points:
        row = point["assessment"]
        statuses.append(
            {
                "date": point["date"],
                "bbu": row.get("bbu_status"),
                "tbu": row.get("tbu_status"),
                "bbtb": row.get("bbtb_status"),
                "weightGainStatus": point.get("weightGainStatus"),
            }
        )
    historical_problems = {
        "bbu": [row for row in statuses if row.get("bbu") in {"Berat Sangat Kurang", "Berat Kurang"}],
        "tbu": [row for row in statuses if row.get("tbu") in {"Sangat Pendek", "Pendek"}],
        "bbtb": [row for row in statuses if row.get("bbtb") in {"Gizi Buruk", "Gizi Kurang"}],
    }
    gain_statuses = [point["weightGainStatus"] for point in points if point.get("weightGainStatus") in {"N", "T"}]
    recent_gain_statuses = gain_statuses[-3:]
    trailing_not_rising = 0
    for status in reversed(gain_statuses):
        if status != "T":
            break
        trailing_not_rising += 1
    return {
        "points": len(points),
        "previousPoints": len(prior_points),
        "currentPoint": current_point,
        "zScores": {
            "bbu": z_trend("bbu_z_score"),
            "tbu": z_trend("tbu_z_score"),
            "bbtb": z_trend("bbtb_z_score"),
        },
        "statuses": statuses,
        "historicalProblems": historical_problems,
        "latestPreviousStatuses": statuses[-1] if statuses else None,
        "weightGain": {
            "statuses": gain_statuses,
            "recent": recent_gain_statuses,
            "trailingNotRising": trailing_not_rising,
        },
    }


def _history_summary_for_education(context: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Turn longitudinal signals into concise, non-diagnostic guidance."""

    education: list[str] = []
    follow_up: list[str] = []
    previous = context.get("previousPoints", 0)
    if not previous:
        follow_up.append("Riwayat status gizi belum cukup untuk membaca arah perubahan; lanjutkan pengukuran bulanan.")
        return education, follow_up

    latest = context.get("latestPreviousStatuses") or {}
    labels = []
    for key, label in (("bbu", "BB/U"), ("tbu", "PB/TB/U"), ("bbtb", "BB/PB atau BB/TB")):
        status = latest.get(key)
        if status:
            labels.append(f"{label}: {status}")
    if labels:
        education.append("Riwayat terakhir: " + "; ".join(labels) + ". Gunakan perubahan antarbulan untuk menilai arah pertumbuhan, bukan satu angka saja.")

    gain = context.get("weightGain", {})
    recent = gain.get("recent", [])
    if recent:
        education.append("Kenaikan berat pada pengukuran berurutan: " + "–".join(recent) + " (N = naik, T = tidak naik).")
    if gain.get("trailingNotRising", 0) >= 2:
        follow_up.append("Berat tidak naik pada sedikitnya dua pengukuran terakhir; verifikasi cara ukur, telaah asupan dan penyakit, lalu konsultasikan ke kader/bidan/Ahli Gizi.")
    for key, label in (("bbu", "BB/U"), ("tbu", "PB/TB/U"), ("bbtb", "BB/PB atau BB/TB")):
        trend = (context.get("zScores") or {}).get(key, {})
        if trend.get("direction") == "decreasing":
            follow_up.append(f"Z-score {label} menurun dibanding riwayat; ulangi pengukuran dan lakukan pemantauan lebih dekat.")
    return education, follow_up


def nutrition_concern(
    assessment: dict[str, Any],
    item: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    history_context: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Return short education/follow-up guidance for confirmed WHO problems.

    This deliberately does not diagnose or prescribe treatment.  It gives the
    caregiver a concise next action and directs severe findings to the
    Puskesmas.  Returning ``None`` keeps the probabilistic screening model for
    children whose indicators are normal or only in a risk band.
    """

    fields = (
        ("BB/U", "bbu_status"),
        ("PB/TB/U", "tbu_status"),
        ("BB/PB atau BB/TB", "bbtb_status"),
        ("IMT/U", "imtu_status"),
        ("LILA/U", "lila_status"),
        ("LK/U", "lk_status"),
    )
    findings = [
        {"indicator": label, "status": assessment.get(key)}
        for label, key in fields
        if assessment.get(key) in _NUTRITION_PROBLEM_STATUSES
    ]
    if not findings:
        return None

    item = item or {}
    context = history_context or _history_context(item, history, assessment)
    asi = _asi_context(item, history)
    statuses = {item["status"] for item in findings}
    severe = bool(statuses & _SEVERE_NUTRITION_STATUSES)
    wasting = bool(statuses & {"Gizi Buruk", "Gizi Kurang", "LILA Sangat Rendah"})
    growth = bool(statuses & {"Sangat Pendek", "Pendek"})
    excess = bool(statuses & {"Gizi Lebih", "Obesitas"})
    head = bool(statuses & {"Mikrosefali Berat", "Mikrosefali", "Makrosefali"})

    education: list[str] = []
    follow_up: list[str] = []
    if wasting or "Berat Sangat Kurang" in statuses or "Berat Kurang" in statuses:
        education.append(
            "Berikan makan beragam 3 kali sehari dan 2 kali selingan sesuai usia, dengan protein hewani setiap hari bila tersedia."
        )
        follow_up.append(
            "Bawa hasil pengukuran ke Puskesmas/Ahli Gizi untuk penilaian penyebab dan rencana makan yang sesuai."
        )
    if growth:
        education.append(
            "Lengkapi makanan bergizi, imunisasi, kebersihan, serta stimulasi bermain dan komunikasi sesuai usia."
        )
        follow_up.append(
            "Pantau berat dan panjang/tinggi badan setiap bulan; minta evaluasi tenaga kesehatan bila tidak naik atau tetap pendek."
        )
    if excess:
        education.append(
            "Utamakan makanan rumah beragam, batasi minuman manis dan makanan ultra-proses, serta ajak anak aktif bergerak setiap hari."
        )
        follow_up.append("Konsultasikan pola makan dan aktivitas dengan tenaga kesehatan; jangan melakukan diet ketat sendiri.")
    if head:
        education.append("Catat perkembangan gerak, bicara, dan interaksi anak; segera sampaikan perubahan yang mengkhawatirkan.")
        follow_up.append("Minta pemeriksaan dan pemantauan perkembangan oleh tenaga kesehatan.")
    if asi["status"] == "Tidak":
        education.append(
            "Riwayat ASI eksklusif 0–6 bulan tercatat tidak eksklusif; bahas hambatan menyusui dan pola pemberian makan secara suportif tanpa menyalahkan pengasuh."
        )
        follow_up.append("Tinjau riwayat ASI, PMBA, dan asupan saat ini bersama bidan atau Ahli Gizi untuk menyusun tindak lanjut yang sesuai.")
    elif asi["status"] == "Ya":
        education.append("Pertahankan pemberian ASI sesuai usia dan lanjutkan PMBA yang beragam setelah usia 6 bulan.")
    elif asi["status"] == "Tidak konsisten":
        follow_up.append("Riwayat ASI memiliki jawaban yang berbeda; verifikasi kembali catatan 0–6 bulan bersama tenaga kesehatan.")
    else:
        follow_up.append("Lengkapi riwayat ASI eksklusif 0–6 bulan; status yang kosong tidak boleh disimpulkan sebagai Ya atau Tidak.")

    history_education, history_follow_up = _history_summary_for_education(context)
    education.extend(history_education)
    follow_up.extend(history_follow_up)
    if severe:
        follow_up.insert(0, "Temuan berat memerlukan kunjungan segera ke Puskesmas; bila anak tampak sangat lemas, sulit bernapas, atau tidak mau minum, cari pertolongan darurat.")
    if not education:
        education.append("Gunakan menu beragam sesuai usia dan lanjutkan pemantauan pertumbuhan secara teratur.")
    if not follow_up:
        follow_up.append("Jadwalkan tindak lanjut dengan kader/bidan/Ahli Gizi dan ulangi pengukuran sesuai jadwal.")

    return {
        "detected": True,
        "title": "Edukasi singkat dan tindak lanjut",
        "summary": "Status gizi menunjukkan masalah yang sudah teridentifikasi; bagian prediksi risiko tidak ditampilkan.",
        "findings": findings,
        "historySummary": {
            "previousPoints": context.get("previousPoints", 0),
            "latestStatuses": context.get("latestPreviousStatuses"),
            "zScores": context.get("zScores", {}),
            "weightGain": context.get("weightGain", {}),
            "historicalProblems": context.get("historicalProblems", {}),
        },
        "exclusiveBreastfeeding": asi,
        "education": education,
        "followUp": follow_up,
        "urgency": "segera" if severe else "terjadwal",
        "disclaimer": "Informasi edukasi ini bukan diagnosis atau pengganti pemeriksaan tenaga kesehatan.",
    }


def predict_risks(
    assessment: dict[str, Any],
    anomaly_result: dict[str, Any],
    history_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run an explainable, CPU-light logistic screening model.

    Coefficients are intentionally checked in and versioned.  They are a
    conservative screening baseline, not a replacement for WHO classification
    or clinical judgement.
    """

    bbu = _number(assessment.get("bbu_z_score"))
    tbu = _number(assessment.get("tbu_z_score"))
    bbtb = _number(assessment.get("bbtb_z_score"))
    anomaly_bonus = 0.8 if anomaly_result.get("detected") else 0.0
    height_drop_bonus = 1.6 if any(
        value.get("code") == "height_decreased" for value in anomaly_result.get("items", [])
    ) else 0.0

    underweight_signal = max(0.0, -((bbu if bbu is not None else 0.0) + 1.5))
    stunting_signal = max(0.0, -((tbu if tbu is not None else 0.0) + 1.5))
    wasting_signal = max(0.0, -((bbtb if bbtb is not None else 0.0) + 1.5))

    context = history_context or {}
    z_scores = context.get("zScores", {})
    gain = context.get("weightGain", {})
    historical_problems = context.get("historicalProblems", {})
    trailing_t = int(gain.get("trailingNotRising", 0) or 0)
    recent_gain = list(gain.get("recent", []) or [])

    def trend_bonus(key: str) -> float:
        trend = z_scores.get(key, {}) or {}
        direction = trend.get("direction")
        if direction != "decreasing":
            return 0.0
        delta = _number(trend.get("delta")) or 0.0
        return min(0.8, 0.25 + max(0.0, -delta - 0.25) * 0.35)

    # Repeated T is a longitudinal warning only.  A single T can be normal
    # measurement variation, so it receives a smaller bounded contribution.
    gain_bonus = 0.45 if trailing_t >= 2 else 0.22 if recent_gain and recent_gain[-1] == "T" else 0.0
    underweight_history_bonus = trend_bonus("bbu") + gain_bonus
    stunting_history_bonus = trend_bonus("tbu")
    wasting_history_bonus = trend_bonus("bbtb") + gain_bonus

    def prior_problem_bonus(key: str) -> float:
        count = len(historical_problems.get(key, []) or [])
        return 0.35 if count >= 2 else 0.2 if count == 1 else 0.0

    underweight_history_bonus += prior_problem_bonus("bbu")
    stunting_history_bonus += prior_problem_bonus("tbu")
    wasting_history_bonus += prior_problem_bonus("bbtb")

    def explanation(base: str, key: str, label: str, *, include_gain: bool = False) -> str:
        messages = [base]
        trend = z_scores.get(key, {}) or {}
        if trend.get("direction") == "decreasing":
            messages.append(f"Riwayat z-score {label} menunjukkan kecenderungan menurun.")
        if include_gain and gain_bonus:
            if trailing_t >= 2:
                messages.append("Dua atau lebih kenaikan berat terakhir berstatus T (tidak naik).")
            elif recent_gain and recent_gain[-1] == "T":
                messages.append("Pengukuran berat terakhir berstatus T (tidak naik).")
        if historical_problems.get(key):
            messages.append("Status indikator ini pernah bermasalah pada riwayat sebelumnya.")
        if context.get("previousPoints", 0):
            messages.append("Riwayat digunakan sebagai sinyal tambahan; status WHO terbaru tetap menjadi patokan utama.")
        return " ".join(messages)

    underweight = _risk_prediction(
        "underweight",
        -2.7 + 1.15 * underweight_signal + 0.25 * anomaly_bonus + underweight_history_bonus,
        explanation("Risiko meningkat bila skor BB/U berada di bawah pola rujukan WHO.", "bbu", "BB/U", include_gain=True),
    )
    stunting = _risk_prediction(
        "stunting",
        -2.7 + 1.25 * stunting_signal + 0.35 * anomaly_bonus + 0.4 * height_drop_bonus + stunting_history_bonus,
        explanation("Risiko meningkat bila skor PB/TB/U rendah atau terdapat perubahan tinggi yang tidak masuk akal.", "tbu", "PB/TB/U"),
    )
    wasting = _risk_prediction(
        "wasting",
        -2.8 + 1.2 * wasting_signal + 0.25 * anomaly_bonus + wasting_history_bonus,
        explanation("Risiko meningkat bila skor BB terhadap PB/TB berada di bawah pola rujukan WHO.", "bbtb", "BB/PB atau BB/TB", include_gain=True),
    )
    predictions = {"underweight": underweight, "stunting": stunting, "wasting": wasting}
    highest = max(predictions.values(), key=lambda value: value["probability"])
    return {
        "model": MODEL_VERSION,
        "predictions": predictions,
        "history": {
            "previousPoints": context.get("previousPoints", 0),
            "zScores": z_scores,
            "weightGain": gain,
            "historicalProblems": historical_problems,
        },
        "overall": {
            "level": highest["level"],
            "probability": highest["probability"],
            "condition": next(name for name, value in predictions.items() if value is highest),
        },
        "disclaimer": "Skrining otomatis, bukan diagnosis. Konfirmasi oleh tenaga kesehatan.",
    }


def _month_index(value: str) -> int | None:
    """Return a sortable calendar-month index for an ISO date."""

    match = re.match(r"^(\d{4})-(\d{1,2})", str(value or "").strip())
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    if not 1 <= month <= 12:
        return None
    return year * 12 + month - 1


def _history_points(item: dict[str, Any], history: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Build the chronological points used by the graph analysis.

    The current observation is added to the history because the queue payload
    intentionally sends only prior observations in ``history``.  Records with
    no date or no usable measurement are retained only when another indicator
    has a valid value, allowing partially completed forms to be explained
    without making up a date.
    """

    records = [record for record in (history or []) if isinstance(record, dict)] + [item]
    points: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        date = _date_key(record)
        month = _month_index(date)
        if month is None:
            continue
        points.append({
            "date": date,
            "month": month,
            "order": index,
            "weight": _number(_field(record, "weight_kg")),
            "height": _number(_field(record, "height_cm")),
            "lila": _number(_field(record, "lila_cm")),
            "headCircumference": _number(_field(record, "head_circumference_cm")),
        })
    points.sort(key=lambda value: (value["month"], value["order"]))
    return points


def _trend_indicator(
    points: list[dict[str, Any]],
    key: str,
    label: str,
    unit: str,
    *,
    stable_threshold: float,
    minimum_points: int = 2,
) -> dict[str, Any]:
    observations = [point for point in points if point.get(key) is not None]
    if len(observations) < minimum_points:
        return {
            "key": key,
            "label": label,
            "unit": unit,
            "trend": "insufficient_data",
            "trendLabel": "Belum cukup data",
            "points": len(observations),
            "firstValue": observations[0][key] if observations else None,
            "latestValue": observations[-1][key] if observations else None,
            "delta": None,
            "slopePerMonth": None,
            "score": None,
            "explanation": "Minimal dua pengukuran bertanggal diperlukan untuk membaca arah grafik.",
        }

    first, latest = observations[0], observations[-1]
    delta = float(latest[key] - first[key])
    elapsed_months = max(1, int(latest["month"] - first["month"]))
    slope = delta / elapsed_months
    if key == "height" and delta < -0.1:
        trend, trend_label = "decreasing_anomaly", "Menurun (anomali)"
    elif abs(slope) <= stable_threshold:
        trend, trend_label = "stable", "Stabil"
    elif slope > 0:
        trend, trend_label = "increasing", "Meningkat"
    else:
        trend, trend_label = "decreasing", "Menurun"

    # This is an intentionally transparent logistic-style confidence score,
    # not a clinical probability.  More regular observations increase
    # confidence while a negative trend reduces it.
    signal = 0.55 * min(1.0, len(observations) / 6.0)
    signal += 0.35 if slope > stable_threshold else -0.35 if slope < -stable_threshold else 0.0
    if trend == "decreasing_anomaly":
        signal -= 0.55
    score = round(_sigmoid((signal - 0.35) * 4.0), 4)
    if trend == "decreasing_anomaly":
        explanation = "Nilai terbaru lebih rendah dari pengukuran sebelumnya; ulangi pengukuran dan periksa alat."
    elif trend == "increasing":
        explanation = f"Grafik menunjukkan kenaikan rata-rata {abs(slope):.2f} {unit} per bulan."
    elif trend == "decreasing":
        explanation = f"Grafik menunjukkan penurunan rata-rata {abs(slope):.2f} {unit} per bulan; perlu ditinjau."
    else:
        explanation = "Perubahan rata-rata antarbulan masih relatif stabil."
    return {
        "key": key,
        "label": label,
        "unit": unit,
        "trend": trend,
        "trendLabel": trend_label,
        "points": len(observations),
        "firstValue": round(first[key], 3),
        "latestValue": round(latest[key], 3),
        "delta": round(delta, 3),
        "slopePerMonth": round(slope, 4),
        "score": score,
        "explanation": explanation,
    }


def analyze_growth_graph(
    item: dict[str, Any],
    history: list[dict[str, Any]] | None,
    assessment: dict[str, Any],
    anomaly_result: dict[str, Any],
) -> dict[str, Any]:
    """Summarize the growth graph in Python using an explainable ML baseline.

    The browser remains responsible for rendering the WHO curves.  This
    function reads the same chronological points and returns the interpretation
    shown next to that graph.  It intentionally avoids a heavyweight training
    dependency: the logistic-style coefficients are versioned and transparent,
    while the official WHO classification remains the deterministic LMS result.
    """

    points = _history_points(item, history)
    indicators = [
        _trend_indicator(points, "weight", "Berat badan", "kg", stable_threshold=0.05),
        _trend_indicator(points, "height", "Panjang/tinggi badan", "cm", stable_threshold=0.05),
        _trend_indicator(points, "lila", "LILA", "cm", stable_threshold=0.05),
        _trend_indicator(points, "headCircumference", "Lingkar kepala", "cm", stable_threshold=0.05),
    ]
    usable = [indicator for indicator in indicators if indicator["trend"] != "insufficient_data"]
    anomaly_items = anomaly_result.get("items", [])
    conclusions: list[str] = []
    recommendations: list[str] = []

    height_anomaly = any(value.get("code") == "height_decreased" for value in anomaly_items)
    if height_anomaly:
        conclusions.append("Terdapat penurunan tinggi/panjang badan pada grafik yang tidak sesuai pola pertumbuhan.")
        recommendations.append("Ulangi pengukuran tinggi/panjang badan dengan alat dan posisi yang benar.")
    if any(value.get("trend") == "decreasing" for value in usable):
        conclusions.append("Satu atau lebih indikator menunjukkan tren menurun sehingga perlu pemantauan lebih dekat.")
        recommendations.append("Bandingkan pengukuran bulan berikutnya dan tinjau bersama Ahli Gizi bila tren berlanjut.")
    if not conclusions:
        conclusions.append("Arah indikator yang memiliki minimal dua titik masih stabil atau meningkat.")
    status_messages = [
        (assessment.get("bbu_status"), "BB/U"),
        (assessment.get("tbu_status"), "PB/TB/U"),
        (assessment.get("bbtb_status"), "BB/PB atau BB/TB"),
    ]
    for status, label in status_messages:
        if status in {"Berat Sangat Kurang", "Berat Kurang", "Sangat Pendek", "Pendek", "Gizi Buruk", "Gizi Kurang"}:
            conclusions.append(f"Status {label} terbaru perlu ditindaklanjuti sesuai hasil WHO dan pemeriksaan tenaga kesehatan.")
    if not recommendations:
        recommendations.append("Lanjutkan penimbangan bulanan dengan alat dan cara ukur yang konsisten.")
    recommendations.append("Hasil ini adalah skrining berbasis data, bukan diagnosis; konfirmasi oleh tenaga kesehatan.")

    confidence = round(min(0.95, 0.3 + (0.1 * len(points)) + (0.05 * len(usable))), 4)
    context = _history_context(item, history, assessment)
    concern = nutrition_concern(assessment, item, history, context)
    if len(points) < 2:
        summary = "Belum cukup riwayat untuk menyimpulkan arah grafik pertumbuhan."
    elif height_anomaly or any(value.get("trend") == "decreasing" for value in usable):
        summary = "Grafik menunjukkan sinyal yang perlu ditinjau; periksa anomali dan pantau pengukuran berikutnya."
    else:
        summary = "Grafik menunjukkan pola pertumbuhan yang stabil atau meningkat pada indikator yang tersedia."
    return {
        "model": GRAPH_MODEL_VERSION,
        "summary": summary,
        "points": len(points),
        "confidence": confidence,
        "indicators": indicators,
        "conclusions": conclusions,
        "recommendations": recommendations,
        "anomalies": anomaly_items,
        "nutritionConcern": concern,
        "historySignals": {
            "previousPoints": context.get("previousPoints", 0),
            "zScores": context.get("zScores", {}),
            "weightGain": context.get("weightGain", {}),
            "historicalProblems": context.get("historicalProblems", {}),
        },
        "disclaimer": "Model tren ringan yang dapat dijelaskan untuk skrining; bukan diagnosis klinis dan bukan pengganti standar WHO.",
    }


def analyze_item(item: dict[str, Any], history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    from .who import assess_item

    assessment = assess_item(item)
    anomaly_result = detect_anomalies(item, history)
    context = _history_context(item, history, assessment)
    concern = nutrition_concern(assessment, item, history, context)
    return {
        **assessment,
        "anomaly": anomaly_result,
        "risk": predict_risks(assessment, anomaly_result, context) if concern is None else {
            "suppressed": True,
            "reason": "Status gizi sudah menunjukkan masalah; fokus dialihkan ke edukasi dan tindak lanjut.",
        },
        "nutrition_concern": concern,
        "history_signals": {
            "previousPoints": context.get("previousPoints", 0),
            "zScores": context.get("zScores", {}),
            "weightGain": context.get("weightGain", {}),
            "historicalProblems": context.get("historicalProblems", {}),
        },
        "graph_analysis": analyze_growth_graph(item, history, assessment, anomaly_result),
    }
