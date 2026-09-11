// @ts-nocheck
import {
  normalizeDecimalInput,
  parseLocaleNumber,
  parseLocaleNumberForRange,
} from '../../shared/dashboardUtils';

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

/** WHO convention: 0-23 months recumbent, 24-59 months standing. */
export function measurementMethodForAge(ageInMonths) {
  const age = Number(ageInMonths);
  return Number.isFinite(age) && age >= 24 ? 'Berdiri' : 'Terlentang';
}

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

/** @deprecated Classification is returned by the Python analysis service. */
export function calculateWhoLmsValue() { return null; }

/** @deprecated Classification is returned by the Python analysis service. */
export function calculateCircumferenceZScore() { return null; }

/** @deprecated Classification is returned by the Python analysis service. */
export function getCircumferenceStatus() { return '-'; }

/** @deprecated Classification is returned by the Python analysis service. */
export function getMeasurementStatuses(measurement, child, referenceDate = new Date()) {
  return {
    age: null,
    statusBbu: '-',
    statusTbu: '-',
    statusBbtb: '-',
    statusImtu: '-',
    statusLilau: '-',
    statusLku: '-',
    zScoreBbu: null,
    zScoreTbu: null,
    zScoreBbtb: null,
    zScoreImtu: null,
    zScoreLilau: null,
    zScoreLku: null,
    pythonRequired: true,
  };
}
