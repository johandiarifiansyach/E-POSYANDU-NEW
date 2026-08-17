// @ts-nocheck
import {
  calculateGiziStatus,
  calculateZScore,
  getAgeInMonths,
  getKBM,
  normalizeDecimalInput,
  parseLocaleNumber,
  parseLocaleNumberForRange,
} from '../../shared/dashboardUtils';
import { WHO_GROWTH_LMS } from '../../data/whoGrowthLms';

export const MEASUREMENT_DECIMAL_RULES = {
  bb: {
    minimum: 0.1,
    maximum: 60,
    shift: 2,
    message: 'Berat badan harus diisi dalam kilogram, misalnya 3,2 kg. Jangan masukkan 3200 gram.',
  },
  tb: {
    minimum: 10,
    maximum: 220,
    shift: 1,
    message: 'Tinggi badan harus diisi desimal yang valid, misalnya 78,5 cm.',
  },
  lila: {
    minimum: 0.1,
    maximum: 50,
    shift: 1,
    message: 'LiLa harus diisi desimal yang valid, misalnya 13,2 cm.',
  },
  lk: {
    minimum: 0.1,
    maximum: 80,
    shift: 1,
    message: 'Lingkar kepala harus diisi desimal yang valid, misalnya 45,5 cm.',
  },
};

export const normalizeMeasurementInput = normalizeDecimalInput;
export const parseMeasurementDecimal = parseLocaleNumber;
export const parseMeasurementDecimalForRange = parseLocaleNumberForRange;

export function validateMeasurementForm({ date, bb, tb, lila, lk, ageInMonths = null }) {
  const measurementDate = String(date ?? '').slice(0, 10);
  const parsedDate = new Date(`${measurementDate}T00:00:00`);
  if (!measurementDate || Number.isNaN(parsedDate.getTime())) {
    return { ok: false, message: 'Tanggal pengukuran belum valid.' };
  }

  const shouldMeasureLila = ageInMonths === null || Number(ageInMonths) >= 3;
  const values = {
    bb: parseMeasurementDecimalForRange(bb, MEASUREMENT_DECIMAL_RULES.bb.minimum, MEASUREMENT_DECIMAL_RULES.bb.maximum, MEASUREMENT_DECIMAL_RULES.bb.shift),
    tb: parseMeasurementDecimalForRange(tb, MEASUREMENT_DECIMAL_RULES.tb.minimum, MEASUREMENT_DECIMAL_RULES.tb.maximum, MEASUREMENT_DECIMAL_RULES.tb.shift),
    lila: shouldMeasureLila
      ? parseMeasurementDecimalForRange(lila, MEASUREMENT_DECIMAL_RULES.lila.minimum, MEASUREMENT_DECIMAL_RULES.lila.maximum, MEASUREMENT_DECIMAL_RULES.lila.shift)
      : null,
    lk: parseMeasurementDecimalForRange(lk, MEASUREMENT_DECIMAL_RULES.lk.minimum, MEASUREMENT_DECIMAL_RULES.lk.maximum, MEASUREMENT_DECIMAL_RULES.lk.shift),
  };

  const requiredFields = shouldMeasureLila ? ['bb', 'tb', 'lila', 'lk'] : ['bb', 'tb', 'lk'];
  for (const key of requiredFields) {
    if (values[key] === null) {
      return { ok: false, message: MEASUREMENT_DECIMAL_RULES[key].message };
    }
  }

  return { ok: true, data: { measurementDate, ...values } };
}

function normalizeSex(gender) {
  return String(gender || '').toUpperCase() === 'P' ? 'P' : 'L';
}

export function calculateWhoLmsValue(zScore, lms) {
  if (!lms) return null;
  const [l, m, s] = lms;
  if (![l, m, s, zScore].every(Number.isFinite)) return null;
  if (l === 0) return m * Math.exp(s * zScore);
  const base = 1 + l * s * zScore;
  return base > 0 ? m * Math.pow(base, 1 / l) : null;
}

export function calculateCircumferenceZScore(value, indicator, ageInMonths, gender) {
  const numericValue = parseMeasurementDecimal(value);
  const age = Math.floor(Number(ageInMonths));
  if (numericValue === null || !Number.isFinite(age) || age < 0 || age > 60) return null;
  if (indicator === 'lila' && age < 3) return null;
  const row = WHO_GROWTH_LMS[indicator]?.[normalizeSex(gender)]?.find((item) => item[0] === age);
  if (!row) return null;
  const [, l, m, s] = row;
  if (l === 0) return Math.log(numericValue / m) / s;
  return (Math.pow(numericValue / m, l) - 1) / (l * s);
}

export function getCircumferenceStatus(value, indicator, ageInMonths, gender) {
  const zScore = calculateCircumferenceZScore(value, indicator, ageInMonths, gender);
  if (zScore === null) return '-';

  if (indicator === 'lila') {
    if (zScore < -3) return 'LILA Sangat Rendah';
    if (zScore < -2) return 'LILA Rendah';
    if (zScore <= 2) return 'LILA Normal';
    return 'LILA Tinggi';
  }

  if (zScore < -3) return 'Mikrosefali Berat';
  if (zScore < -2) return 'Mikrosefali';
  if (zScore <= 2) return 'Normal';
  return 'Makrosefali';
}

export function calculateWeightGainStatus(measurement, previousMeasurement, child) {
  if (!previousMeasurement) return 'B';

  const currentDate = new Date(measurement.tglUkur);
  const previousDate = new Date(previousMeasurement.tglUkur);
  const diffDays = Math.ceil(Math.abs(currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays > 45) return 'O';

  const currentWeight = parseMeasurementDecimal(measurement.bb);
  const previousWeight = parseMeasurementDecimal(previousMeasurement.bb);
  if (currentWeight === null || previousWeight === null) return measurement.statusNaik || 'B';

  const gain = (currentWeight - previousWeight) * 1000;
  return gain >= getKBM(getAgeInMonths(child.tglLahir, currentDate)) ? 'N' : 'T';
}

export function getMeasurementStatuses(measurement, child, referenceDate = new Date()) {
  const date = measurement?.tglUkur ? new Date(measurement.tglUkur) : referenceDate;
  const age = getAgeInMonths(child?.tglLahir, date);
  return {
    age,
    statusBbu: calculateGiziStatus(measurement?.bb, 'BBU', age, child?.jk),
    statusTbu: calculateGiziStatus(measurement?.tb, 'TBU', age, child?.jk, null, measurement?.caraUkur),
    statusBbtb: calculateGiziStatus(measurement?.bb, 'BBTB', age, child?.jk, measurement?.tb, measurement?.caraUkur),
    statusImtu: calculateGiziStatus(measurement?.bb, 'IMTU', age, child?.jk, measurement?.tb, measurement?.caraUkur),
    statusLilau: getCircumferenceStatus(measurement?.lila, 'lila', age, child?.jk),
    statusLku: getCircumferenceStatus(measurement?.lk, 'lk', age, child?.jk),
    zScoreBbu: calculateZScore(measurement?.bb, 'BBU', age, child?.jk),
    zScoreTbu: calculateZScore(measurement?.tb, 'TBU', age, child?.jk, null, measurement?.caraUkur),
    zScoreBbtb: calculateZScore(measurement?.bb, 'BBTB', age, child?.jk, measurement?.tb, measurement?.caraUkur),
    zScoreImtu: calculateZScore(measurement?.bb, 'IMTU', age, child?.jk, measurement?.tb, measurement?.caraUkur),
    zScoreLilau: calculateCircumferenceZScore(measurement?.lila, 'lila', age, child?.jk),
    zScoreLku: calculateCircumferenceZScore(measurement?.lk, 'lk', age, child?.jk),
  };
}
