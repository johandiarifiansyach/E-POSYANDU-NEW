// @ts-nocheck
import { DATA_WILAYAH, ROLES } from '../../config/dashboard';
import {
  formatChildName,
  normalizeDecimalInput,
  parseLocaleNumberForRange
} from '../../shared/dashboardUtils';

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

const RANDOM_TEMPORARY_POSYANDU_CODES = new Set(['61', '98', '99']);

function getPosyanduNumber(posyandu) {
  const text = String(posyandu || '').trim();
  return text.match(/(\d+)\s*$/)?.[1]
    || text.match(/\d+/)?.[0]
    || '';
}

function getTemporaryPosyanduCode(posyandu) {
  const number = getPosyanduNumber(posyandu);
  return number ? String(Number(number) % 100).padStart(2, '0') : '00';
}

function randomTemporaryPosyanduCode() {
  return String(10 + Math.floor(Math.random() * 51)).padStart(2, '0');
}

function getExistingNiks(allChildren, currentId) {
  return new Set((Array.isArray(allChildren) ? allChildren : [])
    .filter((child) => currentId == null || String(child?.id ?? '') !== String(currentId))
    .map((child) => child?.nik ?? child?.national_id ?? child?.nationalId)
    .map((nik) => String(nik || '').trim())
    .filter((nik) => /^\d{16}$/.test(nik)));
}

export function generateTemporaryNik(data, allChildren = []) {
  const [year = '', month = '', day = ''] = String(data?.tglLahir || '').split('-');
  const birthDate = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)
    ? `${day}${month}${year.slice(-2)}`
    : randomDigits(6);
  const posyanduCode = getTemporaryPosyanduCode(data?.posyandu);
  const randomize = RANDOM_TEMPORARY_POSYANDU_CODES.has(posyanduCode);
  const prefix = `350904${birthDate}00`;
  const existingNiks = getExistingNiks(allChildren, data?.id);
  const deterministicNik = `${prefix}${posyanduCode}`;

  // SALAK 61/98/99 use a random 10–60 suffix. For every other Posyandu,
  // retain the Posyandu code unless that complete temporary NIK is already in
  // use; a collision then receives the same random 10–60 fallback.
  if (!randomize && !existingNiks.has(deterministicNik)) return deterministicNik;

  const attempts = new Set();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = randomTemporaryPosyanduCode();
    if (attempts.has(suffix)) continue;
    attempts.add(suffix);
    const candidate = `${prefix}${suffix}`;
    if (!existingNiks.has(candidate)) return candidate;
  }

  // Make the result unique whenever at least one slot in the 10–60 range is
  // still available, even if a random source repeatedly returns the same value.
  for (let suffix = 10; suffix <= 60; suffix += 1) {
    const candidate = `${prefix}${String(suffix).padStart(2, '0')}`;
    if (!existingNiks.has(candidate)) return candidate;
  }

  // All 51 slots are occupied; preserve the requested random range as the
  // only possible fallback and let the server report any subsequent conflict.
  return `${prefix}${randomTemporaryPosyanduCode()}`;
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

export function getPmtCategoryForTab(activeTab) {
  if (activeTab === 'problem_wasting') return 'Wasting';
  if (activeTab === 'problem_underweight') return 'Underweight';
  if (activeTab === 'problem_tidak_naik') return 'TidakNaik';
  return 'Wasting';
}

export { formatChildName };
