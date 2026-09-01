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
import re
from typing import Any

from . import who


WIDTH = 1200
HEIGHT = 760
MARGIN_LEFT = 92
MARGIN_RIGHT = 34
MARGIN_TOP = 92
MARGIN_BOTTOM = 82
CURVE_Z = (-3, -2, 0, 2, 3)
CURVE_COLORS = {
    -3: "#c62828",
    -2: "#ef8c00",
    0: "#14804a",
    2: "#ef8c00",
    3: "#c62828",
}
CHART_TYPES = ("bbu", "tbu", "bbtb", "imtu", "lilau", "lku")


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
    value = point.get("weight_gain_status")
    if value is None:
        value = point.get("weightGainStatus", point.get("statusNaik", point.get("status_naik", "")))
    return str(value or "").strip().upper()


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
    reference = who.standards()
    normalized_sex = "P" if str(sex).upper() == "P" else "L"
    if chart_type == "bbu":
        return "Berat Badan menurut Umur (BB/U)", "Umur (bulan)", "Berat badan (kg)", "kg", [(float(i), row) for i, row in enumerate(reference["weightForAge"][normalized_sex])], [(float(_age_months(p)), _positive_value(p, "weight"), _measurement_date(p), _weight_gain_status(p)) for p in points if _age_months(p) is not None and _positive_value(p, "weight") is not None]
    if chart_type == "tbu":
        return "Panjang/Tinggi Badan menurut Umur (PB atau TB/U)", "Umur (bulan)", "Panjang/tinggi badan (cm)", "cm", [(float(i), row) for i, row in enumerate(reference["lengthHeightForAge"][normalized_sex])], [(float(_age_months(p)), _positive_value(p, "height"), _measurement_date(p), _weight_gain_status(p)) for p in points if _age_months(p) is not None and _positive_value(p, "height") is not None]
    if chart_type == "imtu":
        rows = [(float(i), row) for i, row in enumerate(reference["bmiForAge"][normalized_sex])]
        chart_points = []
        for point in points:
            age, weight, height = _age_months(point), _value(point, "weight"), _value(point, "height")
            if age is not None and weight is not None and weight > 0 and height is not None and height > 0:
                adjusted = who.adjusted_length_height(height, int(round(age)), str(point.get("measurement_method", point.get("measurementMethod", "")) or ""))
                if adjusted > 0:
                    chart_points.append((age, weight / (adjusted / 100) ** 2, _measurement_date(point), _weight_gain_status(point)))
        return "Indeks Massa Tubuh menurut Umur (IMT/U)", "Umur (bulan)", "IMT (kg/m²)", "kg/m²", rows, chart_points
    if chart_type in ("lilau", "lku"):
        indicator = "lila" if chart_type == "lilau" else "lk"
        value_key = "lila" if chart_type == "lilau" else "head"
        label = "Lingkar Lengan Atas menurut Umur (LILA/U)" if chart_type == "lilau" else "Lingkar Kepala menurut Umur (LK/U)"
        y_label = "Lingkar lengan atas (cm)" if chart_type == "lilau" else "Lingkar kepala (cm)"
        rows = [(float(row[0]), row[1:]) for row in who.circumference_standards().get(indicator, {}).get(normalized_sex, [])]
        chart_points = [(float(_age_months(p)), _positive_value(p, value_key), _measurement_date(p), _weight_gain_status(p)) for p in points if _age_months(p) is not None and _positive_value(p, value_key) is not None]
        return label, "Umur (bulan)", y_label, "cm", rows, chart_points
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


def render_growth_chart(chart_type: str, sex: str, points: list[dict[str, Any]], child_name: str = "", language: str = "id") -> str:
    """Return a self-contained Indonesian SVG for one WHO indicator."""

    if chart_type not in CHART_TYPES:
        raise ValueError("Jenis grafik pertumbuhan tidak didukung.")
    if language and language.lower() not in ("id", "id-id", "indonesian"):
        raise ValueError("Bahasa grafik yang tersedia saat ini adalah Indonesia.")
    title, x_label, y_label, unit, reference, child_points = _chart_spec(chart_type, sex, points)
    curve_values = [_inverse_lms(z, lms) for _, lms in reference for z in CURVE_Z]
    point_values = [value for _, value, _, _ in child_points]
    y_min, y_max, y_step = _bounds(curve_values + point_values)
    x_min, x_max = reference[0][0], reference[-1][0]
    plot_left, plot_top = MARGIN_LEFT, MARGIN_TOP
    plot_width = WIDTH - MARGIN_LEFT - MARGIN_RIGHT
    plot_height = HEIGHT - MARGIN_TOP - MARGIN_BOTTOM

    def sx(value: float) -> float:
        return plot_left + (value - x_min) / max(1e-9, x_max - x_min) * plot_width

    def sy(value: float) -> float:
        return plot_top + (y_max - value) / max(1e-9, y_max - y_min) * plot_height

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{_escape(title)}</title>',
        f'<desc id="desc">Grafik standar pertumbuhan anak WHO 0 sampai 60 bulan dengan titik pengukuran balita.</desc>',
        '<rect width="1200" height="760" fill="#ffffff"/>',
        f'<text x="{WIDTH / 2:.0f}" y="34" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700">{_escape(title)}</text>',
        f'<text x="{WIDTH / 2:.0f}" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#475569">Standar Pertumbuhan Anak WHO 0–5 tahun • {"Perempuan" if str(sex).upper() == "P" else "Laki-laki"}{(" • " + _escape(child_name)) if child_name else ""}</text>',
    ]
    # Grid and y-axis labels.
    value = y_min
    while value <= y_max + y_step * 0.01:
        y = sy(value)
        parts.append(f'<line x1="{plot_left:.2f}" y1="{y:.2f}" x2="{plot_left + plot_width:.2f}" y2="{y:.2f}" stroke="#e2e8f0" stroke-width="1"/>')
        parts.append(f'<text x="{plot_left - 12:.2f}" y="{y + 5:.2f}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="#475569">{value:g}</text>')
        value += y_step
    x_step = 6 if x_max - x_min > 30 else 2
    x = x_min
    while x <= x_max + 0.01:
        px = sx(x)
        parts.append(f'<line x1="{px:.2f}" y1="{plot_top:.2f}" x2="{px:.2f}" y2="{plot_top + plot_height:.2f}" stroke="#f1f5f9" stroke-width="1"/>')
        parts.append(f'<text x="{px:.2f}" y="{plot_top + plot_height + 24:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#475569">{x:g}</text>')
        x += x_step
    # WHO SD curves.
    for z in CURVE_Z:
        curve = [(sx(x_value), sy(_inverse_lms(z, lms))) for x_value, lms in reference]
        parts.append(f'<path d="{_path(curve)}" fill="none" stroke="{CURVE_COLORS[z]}" stroke-width="{2.8 if z == 0 else 2}" stroke-linejoin="round"/>')
        label_x, label_lms = reference[-1]
        label_y = sy(_inverse_lms(z, label_lms))
        parts.append(f'<text x="{sx(label_x) - 4:.2f}" y="{label_y - 5:.2f}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="{CURVE_COLORS[z]}">{"median" if z == 0 else f"{z:+d} SD"}</text>')
    # Child observations are joined chronologically for the growth trajectory.
    ordered = sorted(child_points, key=lambda item: (item[0], str(item[2])))
    if ordered:
        for segment in _child_segments(ordered):
            parts.append(f'<path d="{_path([(sx(x_value), sy(value)) for x_value, value, _, _ in segment])}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>')
        for x_value, value, date, _ in ordered:
            parts.append(f'<circle cx="{sx(x_value):.2f}" cy="{sy(value):.2f}" r="5" fill="#2563eb" stroke="#ffffff" stroke-width="2"><title>{_escape(date)}: {value:.2f} {unit}</title></circle>')
    else:
        parts.append(f'<text x="{plot_left + plot_width / 2:.2f}" y="{plot_top + plot_height / 2:.2f}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#64748b">Belum ada titik pengukuran yang dapat diplot</text>')
    parts.extend([
        f'<line x1="{plot_left}" y1="{plot_top + plot_height}" x2="{plot_left + plot_width}" y2="{plot_top + plot_height}" stroke="#334155" stroke-width="2"/>',
        f'<line x1="{plot_left}" y1="{plot_top}" x2="{plot_left}" y2="{plot_top + plot_height}" stroke="#334155" stroke-width="2"/>',
        f'<text x="{plot_left + plot_width / 2:.2f}" y="{HEIGHT - 22}" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#334155">{_escape(x_label)}</text>',
        f'<text x="20" y="{plot_top + plot_height / 2:.2f}" transform="rotate(-90 20 {plot_top + plot_height / 2:.2f})" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#334155">{_escape(y_label)}</text>',
        '<text x="1160" y="742" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#64748b">Perhitungan LMS deterministik • grafik untuk pemantauan, bukan diagnosis</text>',
        '</svg>',
    ])
    return "".join(parts)
