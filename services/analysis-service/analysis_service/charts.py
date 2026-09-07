"""Server-side WHO growth chart renderer.

The renderer deliberately uses only the Python standard library.  It creates
an accessible SVG from the exact LMS tables consumed by :mod:`who`, so the
browser does not need a second copy of the anthropometry calculation.  The
layout follows the familiar WHO reference-chart conventions (SD curves,
centred title, grid, axes, and plotted child measurements); it is not a copy
of the WHO emblem or a claim of WHO endorsement.
"""

from __future__ import annotations

import html
import math
import os
import re
from typing import Any

from . import ml, who
from .runtime import TtlLruCache, payload_fingerprint


WIDTH = 1200
HEIGHT = 760
MARGIN_LEFT = 92
MARGIN_RIGHT = 34
MARGIN_TOP = 92
MARGIN_BOTTOM = 82
CURVE_Z = (-3, -2, 0, 2, 3)
CURVE_Z_WITH_INNER = (-3, -2, -1, 0, 1, 2, 3)
INNER_CURVE_TYPES = {"bbtb", "imtu", "lilau", "lku"}
SEX_COLORS = {
    "L": "#2563eb",
    "P": "#d45f97",
}
CURVE_COLORS = {
    -3: "#262626",
    -2: "#e3343d",
    -1: "#f2c94c",
    0: "#198754",
    1: "#f2c94c",
    2: "#e3343d",
    3: "#262626",
}
CHART_TYPES = ("bbu", "tbu", "bbtb", "imtu", "lilau", "lku")


def _cache_size() -> int:
    try:
        value = int(os.environ.get("ANALYSIS_GRAPH_CACHE_SIZE", "256"))
    except (TypeError, ValueError):
        value = 256
    return max(1, min(2_000, value))


def _cache_ttl() -> float:
    try:
        value = float(os.environ.get("ANALYSIS_GRAPH_CACHE_TTL_SECONDS", "900"))
    except (TypeError, ValueError):
        value = 900.0
    return max(0.0, value)


# A chart is deterministic for the complete request payload and the checked-in
# WHO standards. Keep a bounded, process-local cache so reopening a chart does
# not rerender all LMS curves. It is deliberately volatile (no health data is
# written to disk) and the key includes every point, sex, chart type, language,
# and displayed name to prevent cross-input reuse.
_GRAPH_CACHE: TtlLruCache[str] = TtlLruCache(_cache_size(), _cache_ttl())


def clear_graph_cache() -> None:
    """Clear rendered chart SVGs after a standards or release change."""

    _GRAPH_CACHE.clear()


def graph_cache_stats() -> dict[str, int]:
    """Expose bounded, non-sensitive chart-cache counters for diagnostics."""

    return _GRAPH_CACHE.stats()


def _escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _inverse_lms(z: float, reference: list[float] | tuple[float, float, float]) -> float:
    l, median, spread = reference
    if l == 0:
        return median * math.exp(spread * z)
    return median * max(0.0, 1 + l * spread * z) ** (1 / l)


def _nice_step(span: float, ticks: int = 8) -> float:
    if span <= 0 or not math.isfinite(span):
        return 1.0
    rough = span / ticks
    power = 10 ** math.floor(math.log10(rough))
    fraction = rough / power
    return power * (1 if fraction <= 1 else 2 if fraction <= 2 else 5 if fraction <= 5 else 10)


def _grid_step(span: float, target_lines: int = 16) -> float:
    """Pick the dense major grid interval used by the WHO-style chart."""

    if span <= 0 or not math.isfinite(span):
        return 1.0
    rough = span / max(1, target_lines)
    power = 10 ** math.floor(math.log10(rough))
    fraction = rough / power
    # WHO reference sheets normally label every second unit and draw a
    # lighter half-step between labels.  Keeping 2 as a candidate prevents a
    # 0–30 kg chart from becoming a sparse 5 kg grid.
    if fraction <= 1.25:
        multiplier = 1
    elif fraction <= 2.75:
        multiplier = 2
    elif fraction <= 4.0:
        multiplier = 2.5
    elif fraction <= 7.5:
        multiplier = 5
    else:
        multiplier = 10
    return multiplier * power


def _bounds(values: list[float], minimum: float | None = None, maximum: float | None = None) -> tuple[float, float, float]:
    clean = [value for value in values if math.isfinite(value)]
    if not clean:
        clean = [0.0, 1.0]
    low = min(clean) if minimum is None else minimum
    high = max(clean) if maximum is None else maximum
    if high <= low:
        high = low + 1.0
    step = _nice_step(high - low)
    pad = step * 0.6
    return math.floor((low - pad) / step) * step, math.ceil((high + pad) / step) * step, step


def _path(points: list[tuple[float, float]]) -> str:
    return " ".join(("M" if index == 0 else "L") + f" {x:.2f} {y:.2f}" for index, (x, y) in enumerate(points))


def _age_months(point: dict[str, Any]) -> float | None:
    value = _number(point.get("age_months", point.get("ageMonths")))
    return value if value is not None and 0 <= value <= 60 else None


def _value(point: dict[str, Any], key: str) -> float | None:
    return _number(point.get(key, point.get({
        "weight": "weight_kg",
        "height": "height_cm",
        "lila": "lila_cm",
        "head": "head_circumference_cm",
    }.get(key, key))))


def _positive_value(point: dict[str, Any], key: str) -> float | None:
    value = _value(point, key)
    return value if value is not None and value > 0 else None


def _measurement_date(point: dict[str, Any]) -> str:
    return str(point.get("measurement_date", point.get("measurementDate", "")) or "")


def _weight_gain_status(point: dict[str, Any]) -> str:
    computed = point.get("_python_weight_gain_status")
    if computed:
        return str(computed).strip().upper()
    value = point.get("weight_gain_status")
    if value is None:
        value = point.get("weightGainStatus", point.get("statusNaik", point.get("status_naik", "")))
    return str(value or "").strip().upper()


def _with_python_weight_status(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Annotate chart points with Python's chronological N/T/O/B result."""

    ordered = sorted(
        (point for point in points if isinstance(point, dict)),
        key=lambda point: (_measurement_date(point), _age_months(point) or 0),
    )
    enriched: list[dict[str, Any]] = []
    previous: dict[str, Any] | None = None
    for point in ordered:
        copy = dict(point)
        age = _age_months(point)
        weight = _positive_value(point, "weight")
        if weight is not None:
            # O explicitly marks a non-measured month in imported chart data;
            # retain that marker so the renderer can intentionally break the
            # trajectory. N/T/B are always recomputed from raw weights below.
            supplied = _weight_gain_status(point)
            copy["_python_weight_gain_status"] = (
                "O" if supplied == "O" else ml.calculate_weight_gain_status(point, previous, age)
            )
            previous = point
        else:
            copy["_python_weight_gain_status"] = None
        enriched.append(copy)
    return enriched


def _month_index(value: Any) -> int | None:
    match = re.match(r"^(\d{4})-(\d{2})", str(value or ""))
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    if not 1 <= month <= 12:
        return None
    return year * 12 + month


def _child_segments(ordered: list[tuple[float, float, str, str]]) -> list[list[tuple[float, float, str, str]]]:
    """Split the child trajectory at missing months and non-measured (O) points."""

    segments: list[list[tuple[float, float, str, str]]] = []
    segment: list[tuple[float, float, str, str]] = []
    previous: tuple[float, float, str, str] | None = None
    for point in ordered:
        if segment and previous is not None:
            previous_month = _month_index(previous[2])
            current_month = _month_index(point[2])
            month_gap = (
                previous_month is not None
                and current_month is not None
                and current_month - previous_month > 1
            )
            status_break = previous[3] == "O" or point[3] == "O"
            if month_gap or status_break:
                segments.append(segment)
                segment = []
        segment.append(point)
        previous = point
    if segment:
        segments.append(segment)
    return segments


def _chart_spec(chart_type: str, sex: str, points: list[dict[str, Any]]) -> tuple[str, str, str, str, list[tuple[float, list[float]]], list[tuple[float, float, str, str]]]:
    points = _with_python_weight_status(points)
    reference = who.standards()
    normalized_sex = "P" if str(sex).upper() == "P" else "L"
    if chart_type == "bbu":
        return "Berat Badan menurut Umur (BB/U)", "Umur (bulan dan tahun selesai)", "Berat badan (kg)", "kg", [(float(i), row) for i, row in enumerate(reference["weightForAge"][normalized_sex])], [(float(_age_months(p)), _positive_value(p, "weight"), _measurement_date(p), _weight_gain_status(p)) for p in points if _age_months(p) is not None and _positive_value(p, "weight") is not None]
    if chart_type == "tbu":
        chart_points = []
        for point in points:
            age, height = _age_months(point), _positive_value(point, "height")
            if age is None or height is None:
                continue
            method = str(point.get("measurement_method", point.get("measurementMethod", "")) or "")
            chart_points.append(
                (
                    age,
                    who.adjusted_length_height(height, int(round(age)), method),
                    _measurement_date(point),
                    _weight_gain_status(point),
                )
            )
        return "Panjang/Tinggi Badan menurut Umur (PB atau TB/U)", "Umur (bulan dan tahun selesai)", "Panjang/tinggi badan (cm)", "cm", [(float(i), row) for i, row in enumerate(reference["lengthHeightForAge"][normalized_sex])], chart_points
    if chart_type == "imtu":
        rows = [(float(i), row) for i, row in enumerate(reference["bmiForAge"][normalized_sex])]
        chart_points = []
        for point in points:
            age, weight, height = _age_months(point), _value(point, "weight"), _value(point, "height")
            if age is not None and weight is not None and weight > 0 and height is not None and height > 0:
                adjusted = who.adjusted_length_height(height, int(round(age)), str(point.get("measurement_method", point.get("measurementMethod", "")) or ""))
                if adjusted > 0:
                    chart_points.append((age, weight / (adjusted / 100) ** 2, _measurement_date(point), _weight_gain_status(point)))
        return "Indeks Massa Tubuh menurut Umur (IMT/U)", "Umur (bulan dan tahun selesai)", "IMT (kg/m²)", "kg/m²", rows, chart_points
    if chart_type in ("lilau", "lku"):
        indicator = "lila" if chart_type == "lilau" else "lk"
        value_key = "lila" if chart_type == "lilau" else "head"
        label = "Lingkar Lengan Atas menurut Umur (LILA/U)" if chart_type == "lilau" else "Lingkar Kepala menurut Umur (LK/U)"
        y_label = "Lingkar lengan atas (cm)" if chart_type == "lilau" else "Lingkar kepala (cm)"
        rows = [(float(row[0]), row[1:]) for row in who.circumference_standards().get(indicator, {}).get(normalized_sex, [])]
        chart_points = [
            (float(_age_months(p)), _positive_value(p, value_key), _measurement_date(p), _weight_gain_status(p))
            for p in points
            if _age_months(p) is not None
            and (chart_type != "lilau" or _age_months(p) >= 3)
            and _positive_value(p, value_key) is not None
        ]
        return label, "Umur (bulan dan tahun selesai)", y_label, "cm", rows, chart_points
    if chart_type == "bbtb":
        ages = [_age_months(p) for p in points if _age_months(p) is not None]
        use_length = not ages or max(ages) <= 24
        key = "weightForLength" if use_length else "weightForHeight"
        minimum = 45.0 if use_length else 65.0
        rows = [(minimum + i * 0.5, row) for i, row in enumerate(reference[key][normalized_sex])]
        chart_points = []
        for point in points:
            age, weight, height = _age_months(point), _value(point, "weight"), _value(point, "height")
            if age is None or weight is None or weight <= 0 or height is None or height <= 0:
                continue
            # WHO publishes separate BB/PB (0–24 months) and BB/TB
            # (24–60 months) references. Do not place a point on the wrong
            # reference when one history spans both age ranges.
            if (use_length and age > 24) or (not use_length and age <= 24):
                continue
            adjusted = who.adjusted_length_height(height, int(round(age)), str(point.get("measurement_method", point.get("measurementMethod", "")) or ""))
            if adjusted >= minimum and adjusted <= rows[-1][0]:
                chart_points.append((adjusted, weight, _measurement_date(point), _weight_gain_status(point)))
        return ("Berat Badan menurut Panjang Badan (BB/PB)" if use_length else "Berat Badan menurut Tinggi Badan (BB/TB)"), ("Panjang badan (cm)" if use_length else "Tinggi badan (cm)"), "Berat badan (kg)", "kg", rows, chart_points
    raise ValueError("Jenis grafik pertumbuhan tidak didukung.")


def _render_growth_chart_uncached(
    chart_type: str,
    sex: str,
    points: list[dict[str, Any]],
    child_name: str = "",
    language: str = "id",
) -> str:
    """Return an Indonesian WHO-style chart with a dense reference grid.

    The LMS values are exactly the same values used by ``who.py``.  The
    presentation follows the supplied WHO sheets: a sex-coloured frame and
    title, fine horizontal/vertical grid lines, darker year/major lines, solid
    curves at -3/-2/0/+2/+3 SD (with -1/+1 added for BB/PB, BB/TB, IMT/U,
    LILA/U, and LK/U), and a sex-coloured child trajectory.
    """

    if chart_type not in CHART_TYPES:
        raise ValueError("Jenis grafik pertumbuhan tidak didukung.")
    if language and language.lower() not in ("id", "id-id", "indonesian"):
        raise ValueError("Bahasa grafik yang tersedia saat ini adalah Indonesia.")
    normalized_sex = "P" if str(sex).upper() == "P" else "L"
    sex_label = "Perempuan" if normalized_sex == "P" else "Laki-laki"
    sex_color = SEX_COLORS[normalized_sex]
    title, x_label, y_label, unit, reference, child_points = _chart_spec(chart_type, normalized_sex, points)
    curve_z = CURVE_Z_WITH_INNER if chart_type in INNER_CURVE_TYPES else CURVE_Z
    curve_values = [_inverse_lms(z, lms) for _, lms in reference for z in curve_z]
    point_values = [value for _, value, _, _ in child_points]
    all_y_values = [value for value in curve_values + point_values if math.isfinite(value)]
    if not all_y_values:
        all_y_values = [0.0, 1.0]
    raw_y_min, raw_y_max = min(all_y_values), max(all_y_values)
    y_step = _grid_step(raw_y_max - raw_y_min)
    y_min = math.floor(raw_y_min / y_step) * y_step
    y_max = math.ceil(raw_y_max / y_step) * y_step
    age_axis = chart_type in {"bbu", "tbu", "imtu", "lilau", "lku"}
    # WHO LILA/U standards begin at 3 completed months. Starting that chart
    # at month 3 keeps every SD curve anchored to the plot border instead of
    # leaving a visually cut-off segment between birth and the first standard.
    x_min, x_max = (
        (3.0, 60.0) if chart_type == "lilau" else (0.0, 60.0)
    ) if age_axis else (reference[0][0], reference[-1][0])

    # The coloured frame leaves the plot white, like the supplied WHO sheets.
    panel_left, panel_top = 72.0, 96.0
    panel_right, panel_bottom = WIDTH - 40.0, 704.0
    plot_left, plot_top = 132.0, 120.0
    plot_right, plot_bottom = WIDTH - 180.0, 650.0
    plot_width = plot_right - plot_left
    plot_height = plot_bottom - plot_top
    # Reserve a white strip for the coloured SD labels, then a separate
    # coloured strip for the mirrored numeric y-axis ticks. This reproduces
    # the spacing in the supplied WHO sheets and prevents labels from
    # colliding with values such as 22/23.
    sd_strip_right = plot_right + 70.0
    right_axis_x = sd_strip_right + (panel_right - sd_strip_right) / 2.0

    def sx(value: float) -> float:
        return plot_left + (value - x_min) / max(1e-9, x_max - x_min) * plot_width

    def sy(value: float) -> float:
        return plot_top + (y_max - value) / max(1e-9, y_max - y_min) * plot_height

    curve_description = ", ".join("0" if z == 0 else f"{z:+d}" for z in curve_z)
    parts = [
        # Explicit dimensions preserve the viewBox aspect ratio in Safari and
        # other browsers when CSS sets the responsive width and height:auto.
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{_escape(title)}</title>',
        f'<desc id="desc">Grafik standar pertumbuhan WHO {"3 bulan sampai 5 tahun" if chart_type == "lilau" else "lahir sampai 5 tahun"} untuk {sex_label}, dengan kurva {curve_description} SD dan titik pengukuran balita.</desc>',
        f'<rect width="{WIDTH}" height="{HEIGHT}" fill="#ffffff"/>',
        f'<rect x="{panel_left:.0f}" y="{panel_top:.0f}" width="{panel_right - panel_left:.0f}" height="{panel_bottom - panel_top:.0f}" rx="2" fill="{sex_color}"/>',
        f'<rect x="{plot_right + 1:.0f}" y="{plot_top:.0f}" width="{sd_strip_right - plot_right - 1:.0f}" height="{plot_height:.0f}" fill="#ffffff"/>',
        f'<rect x="{plot_left:.0f}" y="{plot_top:.0f}" width="{plot_width:.0f}" height="{plot_height:.0f}" fill="#ffffff" stroke="#4b4b4b" stroke-width="1.4"/>',
        f'<text x="{WIDTH / 2:.0f}" y="44" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="{sex_color}">{_escape(title)}</text>',
        f'<text x="{WIDTH / 2:.0f}" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#252525">{_escape(sex_label)} • Standar Pertumbuhan Anak WHO {"3 bulan–5 tahun" if chart_type == "lilau" else "lahir–5 tahun"}{(" • " + _escape(child_name)) if child_name else ""}</text>',
        f'<text x="{panel_left + 26:.0f}" y="{plot_top - 10:.0f}" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">{_escape(y_label)}</text>',
    ]

    # Dense horizontal grid: lighter half-step lines and darker labelled
    # major lines.  Labels are placed in both coloured side bands as in WHO.
    y_minor = y_step / 2
    y_value = y_min
    y_count = 0
    while y_value <= y_max + y_minor * 0.01 and y_count < 500:
        y = sy(y_value)
        major = abs((y_value / y_step) - round(y_value / y_step)) < 1e-6
        parts.append(f'<line x1="{plot_left:.2f}" y1="{y:.2f}" x2="{plot_right:.2f}" y2="{y:.2f}" stroke="{("#666666" if major else "#a7a7a7")}" stroke-width="{("1.35" if major else "0.72")}"/>')
        if major:
            label = f"{y_value:g}"
            parts.append(f'<text x="{panel_left + 43:.2f}" y="{y + 4:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">{label}</text>')
            parts.append(f'<text x="{right_axis_x:.2f}" y="{y + 4:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">{label}</text>')
        y_value += y_minor
        y_count += 1

    # Dense vertical grid.  Age charts use monthly lines and darker yearly
    # boundaries; size-based BB/PB and BB/TB use centimetres with 5-unit major
    # intervals.  PB/TB-U also marks the WHO measurement-method transition at
    # 24 completed months with a dashed annual-grid boundary.
    x_minor = 1.0 if age_axis else 1.0
    x_major = 12.0 if age_axis else (5.0 if x_max - x_min <= 40 else 10.0)
    x_value = x_min
    x_count = 0
    while x_value <= x_max + x_minor * 0.01 and x_count < 500:
        x = sx(x_value)
        # Age grids are anchored to the real month number.  This matters for
        # LILA/U, whose standards begin at month 3: yearly boundaries must
        # still land at 12, 24, 36, 48, and 60 rather than at 15, 27, ... .
        x_origin = 0.0 if age_axis else x_min
        major = abs(((x_value - x_origin) / x_major) - round((x_value - x_origin) / x_major)) < 1e-6
        # WHO sheets use a clearly heavier boundary for each completed year;
        # keep monthly lines light while making the annual structure visible
        # on both the screen chart and the downloaded image/PDF.
        major_width = "2.8" if age_axis and major else "1.35" if major else "0.72"
        transition = chart_type == "tbu" and abs(x_value - 24.0) < 1e-6
        dash = ' stroke-dasharray="8 6"' if transition else ""
        title = '<title>Transisi PB ke TB pada usia 24 bulan</title>' if transition else ""
        parts.append(f'<line x1="{x:.2f}" y1="{plot_top:.2f}" x2="{x:.2f}" y2="{plot_bottom:.2f}" stroke="{("#666666" if major else "#a7a7a7")}" stroke-width="{major_width}"{dash}>{title}</line>')
        if age_axis:
            month = int(round(x_value))
            if month == 0 and not major:
                label = "Lahir"
            elif month % 2 == 0 and not major:
                label = str(month)
            else:
                label = ""
            if label:
                parts.append(f'<text x="{x:.2f}" y="{plot_bottom + 18:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#ffffff">{label}</text>')
            if major:
                year = int(round(x_value / 12))
                year_label = "Lahir" if year == 0 else f"{year} tahun"
                parts.append(f'<text x="{x:.2f}" y="{plot_bottom + 39:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">{year_label}</text>')
        elif major:
            parts.append(f'<text x="{x:.2f}" y="{plot_bottom + 24:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#ffffff">{x_value:g}</text>')
        x_value += x_minor
        x_count += 1

    parts.append(f'<clipPath id="plot-clip"><rect x="{plot_left:.0f}" y="{plot_top:.0f}" width="{plot_width:.0f}" height="{plot_height:.0f}"/></clipPath>')
    parts.append('<g clip-path="url(#plot-clip)">')
    # WHO curves are solid and use black at ±3 SD, red at ±2 SD, yellow at
    # ±1 SD, and green at the median (0 SD), matching the requested reference.
    for z in curve_z:
        curve = [(sx(x_value), sy(_inverse_lms(z, lms))) for x_value, lms in reference]
        parts.append(f'<path d="{_path(curve)}" fill="none" stroke="{CURVE_COLORS[z]}" stroke-width="{2.8 if z == 0 else 1.9}" stroke-linejoin="round"><title>{"median (0 SD)" if z == 0 else f"{z:+d} SD"}</title></path>')
    # Child observations are joined chronologically per contiguous segment.
    ordered = sorted(child_points, key=lambda item: (item[0], str(item[2])))
    if ordered:
        for segment in _child_segments(ordered):
            parts.append(f'<path d="{_path([(sx(x_value), sy(value)) for x_value, value, _, _ in segment])}" fill="none" stroke="{sex_color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>')
        for x_value, value, date, _ in ordered:
            parts.append(f'<circle cx="{sx(x_value):.2f}" cy="{sy(value):.2f}" r="5" fill="{sex_color}" stroke="#ffffff" stroke-width="2"><title>{_escape(date)}: {value:.2f} {unit}</title></circle>')
    else:
        parts.append(f'<text x="{plot_left + plot_width / 2:.2f}" y="{plot_top + plot_height / 2:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#4b4b4b">Belum ada titik pengukuran yang dapat diplot</text>')
    parts.append('</g>')

    # SD labels sit in the white strip immediately to the right of the plot.
    # Mirrored numeric y-axis ticks remain in the coloured strip beyond it,
    # matching the spacing in the supplied WHO sheets and avoiding collisions
    # such as a tick value "23" touching the "+3" SD label.
    label_x, label_lms = reference[-1]
    sd_label_x = plot_right + (sd_strip_right - plot_right) / 2.0
    for z in curve_z:
        label_y = sy(_inverse_lms(z, label_lms))
        label = "0" if z == 0 else f"{z:+d}"
        parts.append(f'<text x="{sd_label_x:.2f}" y="{label_y + 5:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="{CURVE_COLORS[z]}">{label}</text>')
    parts.extend([
        f'<text x="{plot_left + plot_width / 2:.2f}" y="{HEIGHT - 24}" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#252525">{_escape(x_label)}</text>',
        f'<text x="{panel_left + 13:.2f}" y="{plot_top + plot_height / 2:.2f}" transform="rotate(-90 {panel_left + 13:.2f} {plot_top + plot_height / 2:.2f})" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#ffffff">{_escape(y_label)}</text>',
        '<text x="1160" y="742" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#64748b">Perhitungan LMS deterministik • grafik untuk pemantauan, bukan diagnosis</text>',
        '</svg>',
    ])
    return "".join(parts)


def render_growth_chart(
    chart_type: str,
    sex: str,
    points: list[dict[str, Any]],
    child_name: str = "",
    language: str = "id",
) -> str:
    """Render a chart, reusing an identical deterministic SVG when possible."""

    cache_key = payload_fingerprint(
        {
            "standardsVersion": who.STANDARDS_VERSION,
            "chartType": chart_type,
            "sex": sex,
            "points": points,
            "childName": child_name,
            "language": language,
        }
    )
    cached = _GRAPH_CACHE.get(cache_key)
    if cached is not None:
        return cached
    svg = _render_growth_chart_uncached(chart_type, sex, points, child_name, language)
    _GRAPH_CACHE.set(cache_key, svg)
    return svg
