/** Shared presentation formatters owned by the React boundary. */
export function formatChildName(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

/** WHO classification is returned by Python; these compatibility values never calculate locally. */
export const getKBM = (_ageInMonths: number): null => null;
export const calculateZScore = (): null => null;
export const calculateGiziStatus = (): '-' => '-';

export function generateRandomDigits(length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) result += Math.floor(Math.random() * 10);
  return result;
}

export function formatDate(date: unknown): string {
  if (!date) return '';
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(date as string | number | Date);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

export function formatIndoDate(dateString: unknown): string {
  if (!dateString) return '-';
  const date = new Date(dateString as string | number | Date);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatIndoDateTime(timestamp: unknown): string {
  if (!timestamp) return '-';
  const candidate = timestamp as { toDate?: () => Date };
  const date = typeof candidate.toDate === 'function' ? candidate.toDate() : new Date(timestamp as string | number | Date);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function getAgeInMonths(birthDateString: unknown, refDate = new Date()): number {
  if (!birthDateString) return 0;
  const [year, month, day] = String(birthDateString).slice(0, 10).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return 0;
  let months = (refDate.getFullYear() - year) * 12 + (refDate.getMonth() - (month - 1));
  if (refDate.getDate() < day) months -= 1;
  return Math.max(months, 0);
}

/**
 * Calculate completed months without conflating an invalid/missing birth date
 * with a newborn.  The table read model does not persist age on the child
 * row, so list pages use this helper against the selected report date.
 */
export function getCompletedAgeInMonths(
  birthDateValue: unknown,
  referenceDateValue: unknown = new Date(),
): number | null {
  const birthMatch = String(birthDateValue ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!birthMatch) return null;
  const birthYear = Number(birthMatch[1]);
  const birthMonth = Number(birthMatch[2]);
  const birthDay = Number(birthMatch[3]);
  const birth = new Date(birthYear, birthMonth - 1, birthDay);
  if (
    !Number.isFinite(birth.getTime()) ||
    birth.getFullYear() !== birthYear ||
    birth.getMonth() !== birthMonth - 1 ||
    birth.getDate() !== birthDay
  ) {
    return null;
  }

  const reference =
    referenceDateValue instanceof Date
      ? new Date(referenceDateValue.getTime())
      : (() => {
          const match = String(referenceDateValue ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!match) return new Date(Number.NaN);
          return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        })();
  if (!Number.isFinite(reference.getTime()) || birth > reference) return null;

  let months =
    (reference.getFullYear() - birthYear) * 12 +
    reference.getMonth() - (birthMonth - 1);
  if (reference.getDate() < birthDay) months -= 1;
  return Math.max(0, months);
}

export function normalizeDecimalInput(value: unknown): string {
  const raw = String(value ?? '').trim();
  let result = '';
  let hasSeparator = false;
  for (const char of raw) {
    if (char >= '0' && char <= '9') result += char;
    else if (!hasSeparator && char.trim() !== '') { result += '.'; hasSeparator = true; }
  }
  return result;
}

export function parseLocaleNumber(value: unknown): number | null {
  const normalized = normalizeDecimalInput(value).trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseLocaleNumberForRange(value: unknown, minimum: number, maximum: number, decimalShiftLimit = 2): number | null {
  const normalized = normalizeDecimalInput(value).trim();
  if (!normalized) return null;
  const direct = Number(normalized);
  if (Number.isFinite(direct) && direct >= minimum && direct <= maximum) return direct;
  if (!normalized.includes('.')) {
    for (let shift = 1; shift <= decimalShiftLimit; shift += 1) {
      const candidate = Number(normalized) / 10 ** shift;
      if (Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum) return candidate;
    }
  }
  return null;
}
