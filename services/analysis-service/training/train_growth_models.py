"""Train offline growth-status screening models from an anonymised XLSX export.

This script is deliberately separate from the production analysis image.  The
production service keeps the WHO LMS calculation deterministic and lightweight;
the artifacts produced here are candidates for review and are not loaded by the
running service automatically.

The workbook export contains current WHO classifications, not prospective
clinical outcomes.  Consequently the targets below mean "current problem
classification", not a diagnosis or a validated future-risk outcome.  Guidance
documents are recorded as provenance only; they are not treated as labels.
Exclusive breastfeeding is intentionally excluded from this baseline.  The
model is kept generic for anthropometry-first Sigizi exports; ASI can be
reintroduced later only after a validated, consistently keyed dataset exists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from pypdf import PdfReader
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    classification_report,
    roc_auc_score,
)
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer


RANDOM_STATE = 20260831
MODEL_VERSION = "growth-status-hgb-v1-candidate"

FEATURE_COLUMNS = [
    "age_months",
    "sex_l",
    "weight_kg",
    "height_cm",
    "lila_cm",
    "birth_weight_kg",
    "birth_length_cm",
    "measurement_standing",
    "weight_gain_not_rising",
    "mbg_yes",
]

TARGET_DEFINITIONS = {
    "underweight_problem": {
        "column": "BB/U",
        "positive": ["Kurang", "Sangat Kurang"],
        "ignore": ["Outlier"],
    },
    "stunting_problem": {
        "column": "TB/U",
        "positive": ["Pendek", "Sangat Pendek"],
        "ignore": ["Outlier"],
    },
    "wasting_problem": {
        "column": "BB/TB",
        "positive": ["Gizi Kurang", "Gizi Buruk"],
        "ignore": ["Outlier"],
    },
    "overweight_problem": {
        "column": "BB/TB",
        "positive": ["Gizi Lebih", "Obesitas"],
        "ignore": ["Outlier"],
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_weight(series: pd.Series) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    # Exports sometimes contain grams alongside kilograms.  Convert only
    # unambiguously large values; leave plausible kg values untouched.
    values = values.where(values <= 60, values / 1000.0)
    return values.where(values.between(0.1, 60), np.nan)


def normalize_birth_weight(series: pd.Series) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    values = values.where(values <= 20, values / 1000.0)
    return values.where(values.between(0.2, 8), np.nan)


def normalize_length(series: pd.Series) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    # A few exports contain millimetres/decimal-shifted values (for example
    # 511 for 51.1 cm).  Convert only values that cannot be child heights.
    values = values.where(values <= 220, values / 10.0)
    return values.where(values.between(10, 220), np.nan)


def normalize_birth_length(series: pd.Series) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    values = values.where(values <= 120, values / 10.0)
    return values.where(values.between(20, 80), np.nan)


def normalize_lila(series: pd.Series) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    values = values.where(values <= 50, values / 100.0)
    return values.where(values.between(5, 50), np.nan)


def _header_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")


def asi_source_columns(frame: pd.DataFrame) -> list[str]:
    """Find direct or month-by-month ASI fields without assuming a schema."""

    direct_keys = {
        "asi",
        "asi_eksklusif",
        "asi_eksklusif_0_6_bln",
        "exclusive_breastfeeding",
        "exclusive_breastfeeding_0_6_months",
    }
    # Sigizi exports use both ``asi_bulan_0`` and the shorter ``Bulan 0``
    # headings.  Accept either form while limiting the period to 0--6 months.
    monthly_pattern = re.compile(r"^(?:asi_)?(?:bulan_)?([0-6])$")
    found: list[str] = []
    for column in frame.columns:
        key = _header_key(column)
        if key in direct_keys or monthly_pattern.match(key):
            found.append(column)
    return found


def _asi_numeric(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    normalized = str(value).strip().casefold()
    if normalized in {"ya", "yes", "true", "1"}:
        return 1.0
    if normalized in {"tidak", "no", "false", "0"}:
        return 0.0
    return np.nan


def normalize_exclusive_breastfeeding(frame: pd.DataFrame) -> tuple[pd.Series, list[str]]:
    """Convert an optional ASI history field to a conservative binary signal.

    For month-by-month fields, a complete set of recorded ``Ya`` answers is
    needed to call the history exclusive; any ``Tidak`` makes it non-exclusive.
    Incomplete or unknown histories remain missing rather than being guessed.
    """

    columns = asi_source_columns(frame)
    if not columns:
        return pd.Series(np.nan, index=frame.index, dtype=float), []

    monthly_pattern = re.compile(r"^(?:asi_)?(?:bulan_)?[0-6]$")
    direct = [column for column in columns if not monthly_pattern.match(_header_key(column))]
    monthly = [column for column in columns if column not in direct]
    result = pd.Series(np.nan, index=frame.index, dtype=float)
    if direct:
        values = frame[direct].map(_asi_numeric)
        for column in direct:
            result = result.fillna(values[column])
    if monthly:
        values = frame[monthly].map(_asi_numeric)
        known = values.notna().sum(axis=1)
        has_no = values.eq(0).any(axis=1)
        all_yes = known.eq(len(monthly)) & values.eq(1).all(axis=1)
        monthly_result = pd.Series(np.nan, index=frame.index, dtype=float)
        monthly_result.loc[has_no] = 0.0
        monthly_result.loc[all_yes] = 1.0
        result = result.fillna(monthly_result)
    return result, columns


def age_months(frame: pd.DataFrame) -> pd.Series:
    birth = pd.to_datetime(frame["Tgl Lahir"], errors="coerce")
    measured = pd.to_datetime(frame["Tanggal Pengukuran"], errors="coerce")
    months = (measured - birth).dt.days / 30.4375
    return months.where(months.between(0, 60), np.nan)


def binary_yes(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.lower().eq("ya").astype(float)


def build_features(frame: pd.DataFrame) -> pd.DataFrame:
    features = pd.DataFrame(index=frame.index)
    features["age_months"] = age_months(frame)
    features["sex_l"] = frame["JK"].astype(str).str.strip().eq("L").astype(float)
    features["weight_kg"] = normalize_weight(frame["Berat"])
    features["height_cm"] = normalize_length(frame["Tinggi"])
    features["lila_cm"] = normalize_lila(frame["LiLA"])
    # Birth measurements are useful context but are not present in every
    # Sigizi export (for example, the dedicated six-month ASI export).
    features["birth_weight_kg"] = (
        normalize_birth_weight(frame["BB Lahir"])
        if "BB Lahir" in frame.columns
        else pd.Series(np.nan, index=frame.index, dtype=float)
    )
    features["birth_length_cm"] = (
        normalize_birth_length(frame["TB Lahir"])
        if "TB Lahir" in frame.columns
        else pd.Series(np.nan, index=frame.index, dtype=float)
    )
    features["measurement_standing"] = frame["Cara Ukur"].astype(str).str.strip().eq("Berdiri").astype(float)
    features["weight_gain_not_rising"] = frame["Naik Berat Badan"].astype(str).str.strip().eq("T").astype(float)
    features["mbg_yes"] = binary_yes(frame["MBG"])
    return features[FEATURE_COLUMNS]


def target_series(frame: pd.DataFrame, definition: dict[str, Any]) -> pd.Series:
    values = frame[definition["column"]].astype(str).str.strip()
    valid = ~values.isin(definition["ignore"])
    target = values.isin(definition["positive"]).astype(float)
    target[~valid] = np.nan
    return target


def pseudo_groups(frame: pd.DataFrame) -> pd.Series:
    # NIK and name are intentionally anonymised in the supplied export.  A
    # conservative birth-date+sex group prevents repeated observations of the
    # same child from being split between train and test when possible.
    birth = pd.to_datetime(frame["Tgl Lahir"], errors="coerce").dt.strftime("%Y-%m-%d")
    return birth.fillna("missing") + "|" + frame["JK"].astype(str).str.strip()


def guideline_manifest(paths: list[Path]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for path in paths:
        entry: dict[str, Any] = {"file": str(path), "sha256": sha256_file(path)}
        try:
            reader = PdfReader(str(path))
            text_chars = sum(len(page.extract_text() or "") for page in reader.pages)
            entry.update({"pages": len(reader.pages), "extractableTextChars": text_chars})
        except Exception as exc:  # provenance must not block model training
            entry["readError"] = type(exc).__name__
        result.append(entry)
    return result


def extract_guideline_chunks(paths: list[Path]) -> list[dict[str, Any]]:
    """Extract page-level passages for safe retrieval of approved guidance.

    This is a retrieval index, not a generative medical model.  Keeping the
    source page with every passage makes it possible for a nutritionist to
    review the exact material before it is exposed in the application.
    """

    chunks: list[dict[str, Any]] = []
    for path in paths:
        try:
            reader = PdfReader(str(path))
        except Exception:
            continue
        for page_number, page in enumerate(reader.pages, 1):
            text = " ".join((page.extract_text() or "").split())
            if len(text) < 40:
                continue
            chunks.append(
                {
                    "source": str(path),
                    "page": page_number,
                    "text": text,
                }
            )
    return chunks


def extract_guideline_text_chunks(paths: list[Path]) -> list[dict[str, Any]]:
    """Read OCR text files using ``===== PAGE N =====`` page markers."""

    chunks: list[dict[str, Any]] = []
    marker = re.compile(r"^===== PAGE (\d+) =====$", re.MULTILINE)
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        matches = list(marker.finditer(text))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            page_text = " ".join(text[match.end() : end].split())
            if len(page_text) < 40:
                continue
            chunks.append({"source": str(path), "page": int(match.group(1)), "text": page_text})
    return chunks


def safe_metrics(y_true: np.ndarray, probabilities: np.ndarray, threshold: float = 0.5) -> dict[str, Any]:
    predictions = (probabilities >= threshold).astype(int)
    metrics: dict[str, Any] = {
        "support": int(len(y_true)),
        "positive": int(y_true.sum()),
        "negative": int((1 - y_true).sum()),
        "balancedAccuracy": round(float(balanced_accuracy_score(y_true, predictions)), 4),
        "classificationReport": classification_report(
            y_true,
            predictions,
            labels=[0, 1],
            target_names=["normal_or_other", "problem"],
            output_dict=True,
            zero_division=0,
        ),
    }
    if len(np.unique(y_true)) == 2:
        metrics["rocAuc"] = round(float(roc_auc_score(y_true, probabilities)), 4)
        metrics["averagePrecision"] = round(float(average_precision_score(y_true, probabilities)), 4)
    else:
        metrics["rocAuc"] = None
        metrics["averagePrecision"] = None
    return metrics


def train(args: argparse.Namespace) -> dict[str, Any]:
    source = Path(args.xlsx).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    frame = pd.read_excel(source, header=1)
    required = {"JK", "Tgl Lahir", "Tanggal Pengukuran", "Berat", "Tinggi", "LiLA", "Cara Ukur", "Naik Berat Badan", "MBG", *[item["column"] for item in TARGET_DEFINITIONS.values()]}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"Kolom wajib tidak ditemukan: {', '.join(missing)}")

    features = build_features(frame)
    groups = pseudo_groups(frame)
    splitter = GroupShuffleSplit(n_splits=1, test_size=args.test_size, random_state=RANDOM_STATE)
    train_idx, test_idx = next(splitter.split(features, groups=groups))

    models: dict[str, Any] = {}
    metrics: dict[str, Any] = {}
    rows_used: dict[str, int] = {}
    for name, definition in TARGET_DEFINITIONS.items():
        target = target_series(frame, definition)
        usable = target.notna().to_numpy()
        train_mask = usable[train_idx]
        test_mask = usable[test_idx]
        if int(train_mask.sum()) < 20 or int(test_mask.sum()) < 10:
            raise ValueError(f"Data target {name} terlalu sedikit setelah pembersihan")
        x_train = features.iloc[train_idx][train_mask]
        y_train = target.iloc[train_idx][train_mask].astype(int)
        x_test = features.iloc[test_idx][test_mask]
        y_test = target.iloc[test_idx][test_mask].astype(int)
        if y_train.nunique() < 2 or y_test.nunique() < 2:
            raise ValueError(f"Target {name} tidak memiliki dua kelas pada split group")

        model = Pipeline(
            [
                ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                (
                    "classifier",
                    HistGradientBoostingClassifier(
                        max_iter=180,
                        learning_rate=0.06,
                        max_leaf_nodes=15,
                        min_samples_leaf=12,
                        l2_regularization=1.0,
                        class_weight="balanced",
                        random_state=RANDOM_STATE,
                    ),
                ),
            ]
        )
        model.fit(x_train, y_train)
        probabilities = model.predict_proba(x_test)[:, 1]
        models[name] = model
        metrics[name] = {
            "target": definition,
            "train": {"support": int(len(y_train)), "positive": int(y_train.sum())},
            "test": safe_metrics(y_test.to_numpy(), probabilities),
        }
        rows_used[name] = int(usable.sum())

    guideline_paths = [Path(item).expanduser().resolve() for item in args.guideline]
    guideline_text_paths = [Path(item).expanduser().resolve() for item in args.guideline_text]
    guidance_chunks = extract_guideline_chunks(guideline_paths) + extract_guideline_text_chunks(guideline_text_paths)

    artifact = {
        "modelVersion": MODEL_VERSION,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "featureColumns": FEATURE_COLUMNS,
        "targetDefinitions": TARGET_DEFINITIONS,
        "models": models,
        "provenance": {
            "dataset": {"file": str(source), "sha256": sha256_file(source), "rows": int(len(frame)), "columns": list(frame.columns)},
            "guidelines": guideline_manifest(guideline_paths),
            "guidelineTextSources": [{"file": str(path), "sha256": sha256_file(path)} for path in guideline_text_paths],
            "split": {"strategy": "GroupShuffleSplit", "testSize": args.test_size, "randomState": RANDOM_STATE, "groupKey": "birthDate|sex (NIK/name anonymised)"},
            "targetsAreCurrentClassifications": True,
            "notForDiagnosis": True,
            "featurePolicy": {
                "anthropometryFirst": True,
                "excludedFeatures": ["exclusive_breastfeeding"],
                "note": "ASI eksklusif dinonaktifkan sementara dari pipeline training generik ini.",
            },
        },
    }
    if guidance_chunks:
        vectorizer = TfidfVectorizer(
            lowercase=True,
            strip_accents="unicode",
            ngram_range=(1, 2),
            sublinear_tf=True,
            max_features=50_000,
        )
        matrix = vectorizer.fit_transform([chunk["text"] for chunk in guidance_chunks])
        joblib.dump(
            {"vectorizer": vectorizer, "matrix": matrix, "chunks": guidance_chunks},
            output_dir / "guidance_index.joblib",
            compress=3,
        )
    joblib.dump(artifact, output_dir / "growth_status_models.joblib", compress=3)
    metadata = {key: value for key, value in artifact.items() if key != "models"}
    metadata["rowsUsedByTarget"] = rows_used
    metadata["guidanceIndex"] = {
        "file": str(output_dir / "guidance_index.joblib") if guidance_chunks else None,
        "chunks": len(guidance_chunks),
        "retrievalOnly": True,
        "requiresNutritionistReview": True,
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    (output_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    return {"outputDir": str(output_dir), "metadata": metadata, "metrics": metrics}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xlsx", required=True, help="Anonymised workbook export")
    parser.add_argument("--output-dir", required=True, help="Directory for local model artifacts")
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--guideline", action="append", default=[], help="Guideline PDF to record as provenance; may be repeated")
    parser.add_argument("--guideline-text", action="append", default=[], help="OCR text file with page markers; may be repeated")
    return parser.parse_args()


if __name__ == "__main__":
    result = train(parse_args())
    print(json.dumps({"outputDir": result["outputDir"], "metrics": result["metrics"]}, ensure_ascii=False, indent=2, default=str))
