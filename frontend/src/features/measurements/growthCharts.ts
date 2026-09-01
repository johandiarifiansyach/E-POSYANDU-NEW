// @ts-nocheck
import { WHO_0_TO_5 } from '../../data/anthropometry';
import { WHO_GROWTH_LMS } from '../../data/whoGrowthLms';
import { getAgeInMonths, parseLocaleNumber } from '../../shared/dashboardUtils';
import { calculateWhoLmsValue } from './measurementRules';

export const GROWTH_CHART_TYPES = ['bbu', 'tbu', 'bbtb', 'imtu', 'lilau', 'lku'] as const;

export const GROWTH_CHART_LABELS = {
  bbu: 'BB/U',
  tbu: 'PB atau TB/U',
  bbtb: 'BB/PB atau BB/TB',
  imtu: 'IMT/U',
  lilau: 'LILA/U',
  lku: 'LK/U',
};

const CURVE_Z_SCORES = [-3, -2, 0, 2, 3];
const CURVE_COLORS = {
  '-3': '#d92d20',
  '-2': '#f79009',
  '0': '#039855',
  '2': '#f79009',
  '3': '#d92d20',
};

function numeric(value) {
  const parsed = parseLocaleNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSex(value) {
  return String(value || '').toUpperCase() === 'P' ? 'P' : 'L';
}

function adjustedLengthHeight(value, age, method) {
  if (value === null) return null;
  if (age <= 24 && method === 'Berdiri') return value + 0.7;
  if (age > 24 && method === 'Terlentang') return value - 0.7;
  return value;
}

function calendarMonthIndex(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return Number.isInteger(year) && month >= 1 && month <= 12 ? year * 12 + month - 1 : null;
}

function chronologicalMeasurements(history, child) {
  const measurements = (history || [])
    .filter((item) => item?.tglUkur)
    .map((item) => ({ ...item, age: getAgeInMonths(child?.tglLahir, new Date(item.tglUkur)) }))
    .filter((item) => item.age >= 0 && item.age <= 60)
    .sort((left, right) => new Date(left.tglUkur).getTime() - new Date(right.tglUkur).getTime());

  return measurements.map((item, index) => {
    if (index === 0) return { ...item, breakBefore: false, anomaly: null };
    const previous = measurements[index - 1];
    const currentMonth = calendarMonthIndex(item.tglUkur);
    const previousMonth = calendarMonthIndex(previous.tglUkur);
    const missedPreviousMonth = currentMonth !== null && previousMonth !== null && currentMonth - previousMonth > 1;
    const previousNotWeighed = String(previous.statusNaik || '').toUpperCase() === 'O';
    const currentHeight = numeric(item.tb);
    const previousHeight = numeric(previous.tb);
    const heightDecreased = currentHeight !== null && previousHeight !== null && currentHeight < previousHeight - 0.1;
    return {
      ...item,
      // Do not imply a continuous trajectory across an unmeasured month or a
      // record explicitly marked O (tidak ditimbang).  Break before the O
      // record as well as before the next record after it, so neither side is
      // rendered as a connecting segment.
      breakBefore: missedPreviousMonth || previousNotWeighed || String(item.statusNaik || '').toUpperCase() === 'O',
      anomaly: heightDecreased ? {
        code: 'height_decreased',
        message: 'Tinggi/panjang badan lebih rendah dari pengukuran sebelumnya',
      } : null,
    };
  });
}

function ageStandard(rows) {
  return rows.map((lms, month) => ({ x: month, lms }));
}

function circumferenceStandard(rows) {
  return rows.map(([month, l, m, s]) => ({ x: month, lms: [l, m, s] }));
}

function weightLengthHeightStandard(rows, minimum) {
  return rows.map((lms, index) => ({ x: minimum + index * 0.5, lms }));
}

function createModel({ type, title, xLabel, yLabel, unit, standard, measurements, pointForMeasurement, note }) {
  const curves = CURVE_Z_SCORES.map((zScore) => ({
    zScore,
    color: CURVE_COLORS[String(zScore)],
    points: standard
      .map(({ x, lms }) => ({ x, y: calculateWhoLmsValue(zScore, lms) }))
      .filter((point) => Number.isFinite(point.y)),
  }));
  const childPoints = [];
  let skippedMeasurementSinceLastPoint = false;
  measurements.forEach((measurement) => {
    const point = pointForMeasurement(measurement);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      if (childPoints.length > 0) skippedMeasurementSinceLastPoint = true;
      return;
    }
    childPoints.push({
      ...point,
      anomaly: measurement.anomaly,
      breakBefore: childPoints.length > 0 && (skippedMeasurementSinceLastPoint || measurement.breakBefore === true),
    });
    skippedMeasurementSinceLastPoint = false;
  });

  return { type, title, xLabel, yLabel, unit, curves, childPoints, note };
}

export function getGrowthChartModels(history, child) {
  const sex = normalizeSex(child?.jk);
  const measurements = chronologicalMeasurements(history, child);
  const latestWithHeight = [...measurements].reverse().find((item) => numeric(item.tb) !== null);
  const useLength = !latestWithHeight || latestWithHeight.age <= 24;
  const weightForSizeRows = useLength ? WHO_0_TO_5.weightForLength[sex] : WHO_0_TO_5.weightForHeight[sex];
  const sizeMinimum = useLength ? 45 : 65;
  const sizeMaximumAge = useLength ? 24 : 60;
  const sizeMinimumAge = useLength ? 0 : 25;
  const sexLabel = sex === 'P' ? 'Perempuan' : 'Laki-laki';
  const commonNote = `Standar Pertumbuhan Anak WHO 0–5 tahun • ${sexLabel}`;

  return {
    bbu: createModel({
      type: 'bbu',
      title: 'Berat Badan menurut Umur (BB/U)',
      xLabel: 'Umur (bulan)',
      yLabel: 'Berat badan (kg)',
      unit: 'kg',
      standard: ageStandard(WHO_0_TO_5.weightForAge[sex]),
      measurements,
      pointForMeasurement: (item) => {
        const value = numeric(item.bb);
        return value === null ? null : { x: item.age, y: value, date: item.tglUkur };
      },
      note: commonNote,
    }),
    tbu: createModel({
      type: 'tbu',
      title: 'Panjang/Tinggi Badan menurut Umur (PB atau TB/U)',
      xLabel: 'Umur (bulan)',
      yLabel: 'Panjang/tinggi badan (cm)',
      unit: 'cm',
      standard: ageStandard(WHO_0_TO_5.lengthHeightForAge[sex]),
      measurements,
      pointForMeasurement: (item) => {
        const value = adjustedLengthHeight(numeric(item.tb), item.age, item.caraUkur);
        return value === null ? null : { x: item.age, y: value, date: item.tglUkur };
      },
      note: `${commonNote} • dikoreksi sesuai cara ukur`,
    }),
    bbtb: createModel({
      type: 'bbtb',
      title: useLength ? 'Berat Badan menurut Panjang Badan (BB/PB)' : 'Berat Badan menurut Tinggi Badan (BB/TB)',
      xLabel: useLength ? 'Panjang badan (cm)' : 'Tinggi badan (cm)',
      yLabel: 'Berat badan (kg)',
      unit: 'kg',
      standard: weightLengthHeightStandard(weightForSizeRows, sizeMinimum),
      measurements: measurements.filter((item) => item.age >= sizeMinimumAge && item.age <= sizeMaximumAge),
      pointForMeasurement: (item) => {
        const weight = numeric(item.bb);
        const size = adjustedLengthHeight(numeric(item.tb), item.age, item.caraUkur);
        return weight === null || size === null ? null : { x: size, y: weight, date: item.tglUkur };
      },
      note: `${commonNote} • grafik ${useLength ? 'PB usia 0–24 bulan' : 'TB usia 25–60 bulan'}`,
    }),
    imtu: createModel({
      type: 'imtu',
      title: 'Indeks Massa Tubuh menurut Umur (IMT/U)',
      xLabel: 'Umur (bulan)',
      yLabel: 'IMT (kg/m²)',
      unit: 'kg/m²',
      standard: ageStandard(WHO_0_TO_5.bmiForAge[sex]),
      measurements,
      pointForMeasurement: (item) => {
        const weight = numeric(item.bb);
        const size = adjustedLengthHeight(numeric(item.tb), item.age, item.caraUkur);
        return weight === null || size === null ? null : { x: item.age, y: weight / Math.pow(size / 100, 2), date: item.tglUkur };
      },
      note: commonNote,
    }),
    lilau: createModel({
      type: 'lilau',
      title: 'Lingkar Lengan Atas menurut Umur (LILA/U)',
      xLabel: 'Umur (bulan)',
      yLabel: 'Lingkar lengan atas (cm)',
      unit: 'cm',
      standard: circumferenceStandard(WHO_GROWTH_LMS.lila[sex]),
      measurements: measurements.filter((item) => item.age >= 3),
      pointForMeasurement: (item) => {
        const value = numeric(item.lila);
        return value === null ? null : { x: item.age, y: value, date: item.tglUkur };
      },
      note: `${commonNote} • mulai usia 3 bulan`,
    }),
    lku: createModel({
      type: 'lku',
      title: 'Lingkar Kepala menurut Umur (LK/U)',
      xLabel: 'Umur (bulan)',
      yLabel: 'Lingkar kepala (cm)',
      unit: 'cm',
      standard: circumferenceStandard(WHO_GROWTH_LMS.lk[sex]),
      measurements,
      pointForMeasurement: (item) => {
        const value = numeric(item.lk);
        return value === null ? null : { x: item.age, y: value, date: item.tglUkur };
      },
      note: commonNote,
    }),
  };
}

function niceStep(range, targetTicks = 7) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const rough = range / targetTicks;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const fraction = rough / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

function axisBounds(values, paddingRatio = 0.04) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * paddingRatio, 0.5);
  const step = niceStep(maximum - minimum + padding * 2);
  return {
    minimum: Math.floor((minimum - padding) / step) * step,
    maximum: Math.ceil((maximum + padding) / step) * step,
    step,
  };
}

function horizontalAxisBounds(points) {
  const values = points.map((point) => point.x);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return { minimum, maximum, step: niceStep(maximum - minimum) };
}

function formatAxisValue(value, step) {
  if (step < 1) return value.toFixed(1).replace('.', ',');
  return String(Math.round(value));
}

function roundedRectangle(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

export function drawGrowthChart(canvas, model, options = {}) {
  const width = options.width || 1200;
  const height = options.height || 720;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return canvas;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const margin = { top: 112, right: 92, bottom: 88, left: 94 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allCurvePoints = model.curves.flatMap((curve) => curve.points);
  const allPoints = [...allCurvePoints, ...model.childPoints];
  if (!allPoints.length) return canvas;

  const xBounds = horizontalAxisBounds(allCurvePoints.length ? allCurvePoints : allPoints);
  const yBounds = axisBounds(allPoints.map((point) => point.y), 0.04);
  const mapX = (value) => margin.left + ((value - xBounds.minimum) / (xBounds.maximum - xBounds.minimum)) * plotWidth;
  const mapY = (value) => margin.top + plotHeight - ((value - yBounds.minimum) / (yBounds.maximum - yBounds.minimum)) * plotHeight;

  context.fillStyle = '#101828';
  context.font = '700 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.fillText(model.title, margin.left, 42);
  context.fillStyle = '#667085';
  context.font = '400 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.fillText(model.note, margin.left, 70);

  context.fillStyle = '#f8fafc';
  context.fillRect(margin.left, margin.top, plotWidth, plotHeight);
  context.strokeStyle = '#d0d5dd';
  context.lineWidth = 1;
  context.strokeRect(margin.left, margin.top, plotWidth, plotHeight);

  context.font = '400 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (let value = xBounds.minimum; value <= xBounds.maximum + xBounds.step / 2; value += xBounds.step) {
    const x = mapX(value);
    context.strokeStyle = '#e4e7ec';
    context.beginPath();
    context.moveTo(x, margin.top);
    context.lineTo(x, margin.top + plotHeight);
    context.stroke();
    context.fillStyle = '#475467';
    context.fillText(formatAxisValue(value, xBounds.step), x, margin.top + plotHeight + 11);
  }

  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let value = yBounds.minimum; value <= yBounds.maximum + yBounds.step / 2; value += yBounds.step) {
    const y = mapY(value);
    context.strokeStyle = '#e4e7ec';
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(margin.left + plotWidth, y);
    context.stroke();
    context.fillStyle = '#475467';
    context.fillText(formatAxisValue(value, yBounds.step), margin.left - 12, y);
  }

  context.save();
  context.beginPath();
  context.rect(margin.left, margin.top, plotWidth, plotHeight);
  context.clip();
  model.curves.forEach((curve) => {
    context.strokeStyle = curve.color;
    context.lineWidth = curve.zScore === 0 ? 3 : 2;
    context.setLineDash(Math.abs(curve.zScore) === 3 ? [8, 6] : []);
    context.beginPath();
    curve.points.forEach((point, index) => {
      const x = mapX(point.x);
      const y = mapY(point.y);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  });
  context.setLineDash([]);

  if (model.childPoints.length > 1) {
    context.strokeStyle = '#007aff';
    context.lineWidth = 3.5;
    context.beginPath();
    model.childPoints.forEach((point, index) => {
      if (index === 0 || point.breakBefore) context.moveTo(mapX(point.x), mapY(point.y));
      else context.lineTo(mapX(point.x), mapY(point.y));
    });
    context.stroke();
  }
  model.childPoints.forEach((point) => {
    const anomaly = Boolean(point.anomaly);
    context.fillStyle = anomaly ? '#fff1f0' : '#ffffff';
    context.strokeStyle = anomaly ? '#d92d20' : '#007aff';
    context.lineWidth = 4;
    context.beginPath();
    context.arc(mapX(point.x), mapY(point.y), 7, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });
  context.restore();

  context.fillStyle = '#344054';
  context.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.fillText(model.xLabel, margin.left + plotWidth / 2, height - 22);
  context.save();
  context.translate(24, margin.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(model.yLabel, 0, 0);
  context.restore();

  const legend = [
    ...model.curves.map((curve) => ({ label: `${curve.zScore > 0 ? '+' : ''}${curve.zScore} SD`, color: curve.color, dashed: Math.abs(curve.zScore) === 3 })),
    { label: 'Hasil anak', color: '#007aff' },
  ];
  if (model.childPoints.some((point) => point.anomaly)) {
    legend.push({ label: 'Anomali tinggi', color: '#d92d20' });
  }
  let legendX = margin.left;
  const legendY = 91;
  context.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  legend.forEach((item) => {
    context.strokeStyle = item.color;
    context.lineWidth = 3;
    context.setLineDash(item.dashed ? [6, 4] : []);
    context.beginPath();
    context.moveTo(legendX, legendY);
    context.lineTo(legendX + 22, legendY);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = '#475467';
    context.fillText(item.label, legendX + 28, legendY);
    legendX += context.measureText(item.label).width + 58;
  });

  if (!model.childPoints.length) {
    context.fillStyle = 'rgba(255,255,255,0.92)';
    roundedRectangle(context, margin.left + plotWidth / 2 - 165, margin.top + plotHeight / 2 - 30, 330, 60, 14);
    context.fillStyle = '#667085';
    context.font = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = 'center';
    context.fillText('Belum ada hasil pengukuran untuk grafik ini', margin.left + plotWidth / 2, margin.top + plotHeight / 2);
  }
  return canvas;
}

export function renderGrowthChartCanvas(model, options = {}) {
  const canvas = document.createElement('canvas');
  return drawGrowthChart(canvas, model, options);
}

export function safeChildFileName(child) {
  const name = String(child?.nama || 'balita')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return name || 'balita';
}
