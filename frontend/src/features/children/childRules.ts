// @ts-nocheck
import { DATA_WILAYAH, ROLES } from '../../config/dashboard';
import {
  calculateGiziStatus,
  calculateZScore,
  formatChildName,
  normalizeDecimalInput,
  parseLocaleNumberForRange
} from '../../shared/dashboardUtils';
import { calculateCircumferenceZScore, getCircumferenceStatus } from '../measurements/measurementRules';

export const CHILD_BIRTH_DECIMAL_RULES = {
  bbLahir: { minimum: 0.1, maximum: 10, shift: 2 },
  pbLahir: { minimum: 10, maximum: 120, shift: 1 },
  lkLahir: { minimum: 10, maximum: 80, shift: 1 },
};

export const normalizeChildInput = normalizeDecimalInput;
export const parseChildDecimalForRange = parseLocaleNumberForRange;

export function randomDigits(length) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (value) => String(value % 10)).join('');
}

export function generateTemporaryKk() {
  return `350904${randomDigits(10)}`;
}

export function generateTemporaryNik(data, allChildren = []) {
  const [year = '', month = '', day = ''] = String(data?.tglLahir || '').split('-');
  const birthDate = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)
    ? `${day}${month}${year.slice(-2)}`
    : randomDigits(6);
  const existing = new Set((allChildren || []).map((child) => String(child?.nik || '')));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `350904${birthDate}${randomDigits(4)}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `350904${birthDate}${String(Date.now()).slice(-4)}`;
}

export function createInitialChildForm(user) {
  const defaultDesa = user.role === ROLES.KADER || user.role === ROLES.BIDAN
    ? user.desa || Object.keys(DATA_WILAYAH)[0]
    : Object.keys(DATA_WILAYAH)[0];
  const defaultPosyandu = user.role === ROLES.KADER
    ? user.posyandu || DATA_WILAYAH[defaultDesa][0]
    : DATA_WILAYAH[defaultDesa][0];

  return {
    nama: '', nik: '', anakKe: '', tglLahir: '', jk: '', noKK: '', hasKK: true, hasNIK: true,
    usiaKehamilan: '', bbLahir: '', pbLahir: '', lkLahir: '', bukuKIA: '', bukuKIAKecil: '',
    imd: '', namaOrtu: '', nikOrtu: '', noHpOrtu: '', alamat: '', rt: '', rw: '',
    desa: defaultDesa, posyandu: defaultPosyandu,
  };
}

export function validateChildBirthMeasurements({ bbLahir, pbLahir, lkLahir }) {
  const values = {
    bbLahir: parseChildDecimalForRange(bbLahir, CHILD_BIRTH_DECIMAL_RULES.bbLahir.minimum, CHILD_BIRTH_DECIMAL_RULES.bbLahir.maximum, CHILD_BIRTH_DECIMAL_RULES.bbLahir.shift),
    pbLahir: parseChildDecimalForRange(pbLahir, CHILD_BIRTH_DECIMAL_RULES.pbLahir.minimum, CHILD_BIRTH_DECIMAL_RULES.pbLahir.maximum, CHILD_BIRTH_DECIMAL_RULES.pbLahir.shift),
    lkLahir: parseChildDecimalForRange(lkLahir, CHILD_BIRTH_DECIMAL_RULES.lkLahir.minimum, CHILD_BIRTH_DECIMAL_RULES.lkLahir.maximum, CHILD_BIRTH_DECIMAL_RULES.lkLahir.shift),
  };
  const messages = {
    bbLahir: 'Berat lahir harus diisi dalam kilogram, misalnya 3,2 kg. Jangan masukkan 3200 gram.',
    pbLahir: 'Panjang lahir harus diisi desimal yang valid, misalnya 49,5 cm.',
    lkLahir: 'Lingkar kepala lahir harus diisi desimal yang valid, misalnya 33,2 cm.',
  };
  for (const key of Object.keys(values)) {
    if (values[key] === null) return { ok: false, message: messages[key] };
  }
  return { ok: true, data: values };
}

export function getBirthGrowthStatuses({ bbLahir, pbLahir, lkLahir, jk }) {
  const sex = jk === 'L' || jk === 'P' ? jk : null;
  const weight = parseChildDecimalForRange(
    bbLahir,
    CHILD_BIRTH_DECIMAL_RULES.bbLahir.minimum,
    CHILD_BIRTH_DECIMAL_RULES.bbLahir.maximum,
    CHILD_BIRTH_DECIMAL_RULES.bbLahir.shift
  );
  const length = parseChildDecimalForRange(
    pbLahir,
    CHILD_BIRTH_DECIMAL_RULES.pbLahir.minimum,
    CHILD_BIRTH_DECIMAL_RULES.pbLahir.maximum,
    CHILD_BIRTH_DECIMAL_RULES.pbLahir.shift
  );
  const headCircumference = parseChildDecimalForRange(
    lkLahir,
    CHILD_BIRTH_DECIMAL_RULES.lkLahir.minimum,
    CHILD_BIRTH_DECIMAL_RULES.lkLahir.maximum,
    CHILD_BIRTH_DECIMAL_RULES.lkLahir.shift
  );

  if (!sex) {
    return {
      statusBbu: '-', statusPbu: '-', statusBbpb: '-', statusImtu: '-', statusLku: '-',
      zScoreBbu: null, zScorePbu: null, zScoreBbpb: null, zScoreImtu: null, zScoreLku: null
    };
  }

  return {
    statusBbu: calculateGiziStatus(weight, 'BBU', 0, sex),
    statusPbu: calculateGiziStatus(length, 'TBU', 0, sex, null, 'Terlentang'),
    statusBbpb: calculateGiziStatus(weight, 'BBTB', 0, sex, length, 'Terlentang'),
    statusImtu: calculateGiziStatus(weight, 'IMTU', 0, sex, length, 'Terlentang'),
    statusLku: getCircumferenceStatus(headCircumference, 'lk', 0, sex),
    zScoreBbu: calculateZScore(weight, 'BBU', 0, sex),
    zScorePbu: calculateZScore(length, 'TBU', 0, sex, null, 'Terlentang'),
    zScoreBbpb: calculateZScore(weight, 'BBTB', 0, sex, length, 'Terlentang'),
    zScoreImtu: calculateZScore(weight, 'IMTU', 0, sex, length, 'Terlentang'),
    zScoreLku: calculateCircumferenceZScore(headCircumference, 'lk', 0, sex)
  };
}

export function getPmtCategoryForTab(activeTab) {
  if (activeTab === 'problem_wasting') return 'Wasting';
  if (activeTab === 'problem_underweight') return 'Underweight';
  if (activeTab === 'problem_tidak_naik') return 'TidakNaik';
  return 'Wasting';
}

export { formatChildName };
