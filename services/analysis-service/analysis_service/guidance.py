"""Auditable age- and status-aware feeding and care education.

The WHO classification remains deterministic in :mod:`who`; this module only
selects short, age-appropriate education from the reviewed Buku KIA corpus.
Risk percentages are screening scores, not clinical probabilities.  Status
specific care sections are reviewed material only; they never prescribe
clinical therapy. Keeping the corpus in JSON makes every sentence and source
page reviewable by the nutritionist before it is exposed in the application.
"""

from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


def _corpus_path() -> Path:
    configured = os.environ.get("KIA_GUIDANCE_PATH", "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / "data" / "kia_2024_feeding_guidance.json"


@lru_cache(maxsize=1)
def corpus() -> dict[str, Any]:
    with _corpus_path().open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("Korpus edukasi Buku KIA harus berupa objek JSON.")
    return value


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def age_band(age_months: Any) -> dict[str, Any]:
    """Return the Buku KIA feeding band for a 0–60 month child."""

    age = _number(age_months)
    if age is not None:
        for band in corpus().get("ageBands", []):
            if band.get("minMonths", 0) <= age <= band.get("maxMonths", 60):
                return band
    return {
        "id": "unknown",
        "label": "sesuai usia",
        "sourcePages": [],
        "education": [],
        "followUp": ["Lengkapi usia anak agar edukasi pemberian makan dapat disesuaikan dengan tepat."],
    }


def _risk_summary(risk: dict[str, Any] | None) -> dict[str, Any]:
    risk = risk if isinstance(risk, dict) else {}
    predictions = risk.get("predictions")
    if not isinstance(predictions, dict):
        predictions = {}
    values: dict[str, dict[str, Any]] = {}
    for name, prediction in predictions.items():
        if not isinstance(prediction, dict):
            continue
        probability = _number(prediction.get("probability"))
        if probability is None:
            continue
        probability = min(1.0, max(0.0, probability))
        values[str(name)] = {
            "condition": str(name),
            "probability": round(probability, 4),
            "percentage": round(probability * 100),
            "level": str(prediction.get("level") or "rendah"),
            "explanation": str(prediction.get("explanation") or "").strip(),
        }
    highest = max(values.values(), key=lambda value: value["probability"], default=None)
    if highest is None:
        return {
            "highest": None,
            "percentages": {},
            "level": "rendah",
            "percentage": 0,
        }
    return {
        "highest": highest,
        "percentages": {key: value["percentage"] for key, value in values.items()},
        "level": highest["level"] if highest["level"] in {"rendah", "sedang", "tinggi"} else "rendah",
        "percentage": highest["percentage"],
    }


def _risk_tier(level: str, percentage: int) -> dict[str, Any]:
    tiers = corpus().get("riskTiers", [])
    for tier in tiers:
        if tier.get("label") == level and tier.get("minProbability", 0) <= percentage / 100 <= tier.get("maxProbability", 1):
            return tier
    for tier in tiers:
        if tier.get("minProbability", 0) <= percentage / 100 <= tier.get("maxProbability", 1):
            return tier
    return {
        "id": "low",
        "label": "rendah",
        "education": "Pertahankan pola makan sesuai usia dan lanjutkan pemantauan pertumbuhan bulanan.",
    }


def _source_pages(*parts: dict[str, Any]) -> list[int]:
    pages: set[int] = set()
    for part in parts:
        for page in part.get("sourcePages", []) or []:
            try:
                pages.add(int(page))
            except (TypeError, ValueError):
                continue
    return sorted(pages)


def _source_references(band: dict[str, Any], universal: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build auditable KIA and official web references for an age band."""

    references: list[dict[str, Any]] = [{
        "title": corpus().get("source", {}).get("title", "Buku KIA 2024"),
        "pages": _source_pages(band, *universal),
    }]
    for source in band.get("webSources", []) or []:
        if not isinstance(source, dict) or not str(source.get("url") or "").strip():
            continue
        reference = {
            "title": str(source.get("title") or "Sumber resmi Kemenkes").strip(),
            "publisher": str(source.get("publisher") or "").strip() or None,
            "url": str(source["url"]).strip(),
            "type": "official_web",
        }
        for key in ("published", "accessed"):
            value = str(source.get(key) or "").strip()
            if value:
                reference[key] = value
        references.append(reference)
    return references


def _poster_guidance(band: dict[str, Any]) -> dict[str, Any] | None:
    """Return the reviewed age-matched Isi Piringku poster metadata.

    Poster text is kept as structured retrieval material rather than being
    inferred by the model.  The asset path is bundled with the frontend and
    the source filename remains visible to reviewers in the API response.
    """

    poster = band.get("poster") if isinstance(band, dict) else None
    if not isinstance(poster, dict):
        return None
    key_points = [str(value).strip() for value in poster.get("keyPoints", []) or [] if str(value).strip()]
    portions = [str(value).strip() for value in poster.get("portionExamples", []) or [] if str(value).strip()]
    asset = str(poster.get("asset") or "").strip()
    title = str(poster.get("title") or "Isi Piringku sesuai usia").strip()
    if not asset or not (key_points or portions):
        return None
    return {
        "title": title,
        "ageGroup": str(band.get("label") or "sesuai usia"),
        "asset": asset,
        "keyPoints": key_points,
        "portionExamples": portions,
        "sourceFile": str(poster.get("sourceFile") or "").strip() or None,
        "reviewRequired": bool(poster.get("reviewRequired", True)),
    }


def _history_signals(context: dict[str, Any] | None) -> tuple[list[str], list[str]]:
    context = context if isinstance(context, dict) else {}
    education: list[str] = []
    follow_up: list[str] = []
    gain = context.get("weightGain") if isinstance(context.get("weightGain"), dict) else {}
    not_rising_count = int(
        gain.get("notRisingCount", gain.get("trailingNotRising", 0)) or 0
    )
    if not_rising_count:
        education.append(
            f"Terdapat {not_rising_count} pengukuran berstatus T (berat tidak naik); pastikan cara ukur, jadwal makan, dan kehadiran penimbangan tercatat dengan benar."
        )
        if not_rising_count >= 2:
            follow_up.append(
                "Beberapa pengukuran berstatus T; kader mengarahkan keluarga untuk meninjau asupan, memeriksa cara ukur, dan berkonsultasi dengan tenaga kesehatan bila pola berlanjut."
            )
        else:
            follow_up.append(
                "Satu pengukuran berstatus T; jadwalkan penimbangan berikutnya dan pantau pola makan tanpa menyimpulkan diagnosis dari satu hasil."
            )
    recent = [str(value) for value in gain.get("recent", []) or []]
    if recent:
        education.append("Pola kenaikan berat terakhir: " + "–".join(recent) + " (N = naik, T = tidak naik).")
    z_scores = context.get("zScores") if isinstance(context.get("zScores"), dict) else {}
    decreasing = {
        "bbu": "BB/U",
        "tbu": "PB/TB/U",
        "bbtb": "BB/PB atau BB/TB",
    }
    for key, label in decreasing.items():
        trend = z_scores.get(key) if isinstance(z_scores.get(key), dict) else {}
        if trend.get("direction") == "decreasing":
            follow_up.append(f"Z-score {label} menurun dibanding riwayat; ulangi pengukuran dan lakukan pemantauan lebih dekat.")
    return education, follow_up


def _asi_context(item: dict[str, Any]) -> dict[str, Any] | None:
    """Read only the recorded 0–6 month ASI signal for young infants."""

    # The analysis service supplies this precomputed context after evaluating
    # every 0–6 month answer. Do not reduce a complete-series question to the
    # single answer attached to the current measurement.
    provided = item.get("_exclusive_breastfeeding_context")
    if isinstance(provided, dict):
        return provided

    age = _number(item.get("age_months", item.get("ageMonths")))
    if age is None or age > 6:
        return None
    value = item.get("exclusive_breastfeeding", item.get("exclusiveBreastfeeding", item.get("asi")))
    # The month-zero form is affirmative by default; an explicitly supplied
    # answer still takes precedence.
    if age is not None and int(round(age)) == 0 and value is None:
        value = "Ya"
    if value is None:
        status = "Belum tercatat"
    else:
        normalized = str(value).strip().casefold()
        status = "Ya" if normalized in {"ya", "yes", "true", "1"} else "Tidak" if normalized in {"tidak", "no", "false", "0"} else "Belum tercatat"
    return {"status": status, "period": "0-6 bulan", "inferredAges": [0] if age is not None and int(round(age)) == 0 and value == "Ya" else []}


def build_normal_education(
    item: dict[str, Any],
    risk: dict[str, Any] | None,
    history_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create maintenance education for normal/uncategorised children.

    The caller must only use this when no confirmed WHO nutrition problem is
    present.  It deliberately uses the highest screening percentage only to
    choose emphasis; it never labels a child with a disease.
    """

    band = age_band(item.get("age_months", item.get("ageMonths")))
    summary = _risk_summary(risk)
    tier = _risk_tier(summary["level"], summary["percentage"])
    education = list(band.get("education", []) or [])
    universal = corpus().get("universalPrinciples", [])
    # The age-band cards already cover the age-specific quantity and texture;
    # these two principles are useful in every normal-child response.
    universal_ids = {"safe", "responsive", "monitoring"}
    # The adequate-MPASI principle is intentionally omitted before six
    # months, when the age-band guidance is exclusive breastfeeding.
    if band.get("id") != "0_5":
        universal_ids.add("adequate")
    for principle in universal:
        if principle.get("id") in universal_ids:
            text = str(principle.get("text") or "").strip()
            if text and text not in education:
                education.append(text)

    if tier.get("education"):
        education.insert(0, str(tier["education"]))
    history_education, history_follow_up = _history_signals(history_context)
    education.extend(history_education)
    follow_up = list(band.get("followUp", []) or []) + history_follow_up
    asi = _asi_context(item)
    if asi is not None:
        if asi["status"] == "Tidak":
            education.append("Catatan ASI 0–6 bulan menunjukkan jawaban tidak eksklusif; bahas hambatan menyusui dan asupan bayi secara suportif bersama tenaga kesehatan.")
        elif asi["status"] == "Belum tercatat":
            follow_up.append("Lengkapi catatan ASI eksklusif 0–6 bulan; data kosong tidak boleh dianggap Ya atau Tidak.")

    highest = summary.get("highest")
    if highest:
        risk_text = f"Sinyal skrining tertinggi: {highest['condition']} {highest['percentage']}% ({summary['level']})."
    else:
        risk_text = "Belum ada persentase risiko yang dapat dihitung dari data saat ini."
    if not follow_up:
        follow_up.append("Lanjutkan pemantauan pertumbuhan bulanan dan konsultasikan bila ada perubahan pola makan atau pertumbuhan.")

    sources = _source_references(band, universal)
    poster = _poster_guidance(band)
    if poster and poster.get("sourceFile"):
        sources.append({
            "title": poster["title"],
            "file": poster["sourceFile"],
            "type": "poster",
        })
    return {
        "detected": False,
        "title": "Edukasi mempertahankan pertumbuhan",
        "summary": f"{risk_text} Status WHO terbaru tetap menjadi patokan utama; edukasi ini membantu mempertahankan pertumbuhan sesuai usia.",
        "ageGroup": band.get("label", "sesuai usia"),
        "riskLevel": summary["level"],
        "riskPercentage": summary["percentage"],
        "riskPercentages": summary["percentages"],
        "education": education,
        "recommendations": follow_up,
        # Backwards-compatible alias for older frontend builds. New clients
        # must display the Indonesian `recommendations` field instead.
        "followUp": follow_up,
        "exclusiveBreastfeeding": asi,
        "posterGuidance": poster,
        "sources": sources,
        "disclaimer": corpus().get("disclaimer", "Edukasi bukan diagnosis atau pengganti pemeriksaan tenaga kesehatan."),
    }


def feeding_guidance_for_problem(item: dict[str, Any]) -> dict[str, Any]:
    """Return age-specific feeding material to append to problem education."""

    band = age_band(item.get("age_months", item.get("ageMonths")))
    universal = corpus().get("universalPrinciples", [])
    poster = _poster_guidance(band)
    sources = _source_references(band, universal)
    if poster and poster.get("sourceFile"):
        sources.append({"title": poster["title"], "file": poster["sourceFile"], "type": "poster"})
    return {
        "ageGroup": band.get("label", "sesuai usia"),
        "education": list(band.get("education", []) or []),
        "recommendations": list(band.get("followUp", []) or []),
        "followUp": list(band.get("followUp", []) or []),
        "posterGuidance": poster,
        "sources": sources,
    }


def problem_guidance_for_statuses(statuses: list[str] | set[str] | tuple[str, ...]) -> dict[str, Any]:
    """Select reviewed, status-specific care education.

    WHO status labels are deterministic inputs.  This function only selects
    the nutritionist-reviewed guidance section that matches those labels; it
    does not infer a diagnosis, prescribe treatment, or calculate risk.
    Returning the source metadata with each match keeps the mapping auditable
    when the response is displayed or logged.
    """

    normalized = {str(status).strip() for status in statuses if str(status).strip()}
    matched: list[dict[str, Any]] = []
    education: list[str] = []
    follow_up: list[str] = []
    sources: list[dict[str, Any]] = []

    for section in corpus().get("problemGuidance", []) or []:
        if not isinstance(section, dict):
            continue
        status_matches = {str(value).strip() for value in section.get("statusMatches", []) or []}
        if not normalized.intersection(status_matches):
            continue
        matched.append({
            "id": str(section.get("id") or "").strip(),
            "title": str(section.get("title") or "Edukasi status gizi").strip(),
            "statuses": sorted(normalized.intersection(status_matches)),
        })
        for value in section.get("education", []) or []:
            text = str(value).strip()
            if text and text not in education:
                education.append(text)
        for value in section.get("followUp", []) or []:
            text = str(value).strip()
            if text and text not in follow_up:
                follow_up.append(text)
        for source in section.get("sources", []) or []:
            if not isinstance(source, dict):
                continue
            cleaned = {key: value for key, value in source.items() if value not in (None, "")}
            if cleaned and cleaned not in sources:
                sources.append(cleaned)

    return {
        "matched": matched,
        "education": education,
        "followUp": follow_up,
        "sources": sources,
    }
