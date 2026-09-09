/** React-facing canonical age cohort contract. */
export const AGE_GROUP_OPTIONS = [
  { value: '0-59', label: '0-59 Bulan' },
  { value: 'newborn', label: 'Bayi Baru Lahir' },
  { value: 'newborn_premature', label: 'Bayi Baru Lahir Prematur' },
  { value: '0-5', label: '0-5 Bulan' },
  { value: '6', label: '6 Bulan' },
  { value: '0-11', label: '0-11 Bulan' },
  { value: '0-23', label: '0-23 Bulan' },
  { value: '6-11', label: '6-11 Bulan' },
  { value: '6-23', label: '6-23 Bulan' },
  { value: '12-23', label: '12-23 Bulan' },
  { value: '6-59', label: '6-59 Bulan' },
  { value: '12-59', label: '12-59 Bulan' },
  { value: '24-59', label: '24-59 Bulan' }
] as const;

export type AgeGroup = typeof AGE_GROUP_OPTIONS[number]['value'];
export const DEFAULT_AGE_GROUP: AgeGroup = '0-59';
export const EXCLUSIVE_BREASTFEEDING_AGE_GROUP_OPTIONS = AGE_GROUP_OPTIONS.filter((option) => option.value === '0-5' || option.value === '6');
export const MPASI_AGE_GROUP_OPTIONS = AGE_GROUP_OPTIONS.filter((option) => option.value === '6-23');

export function ageGroupOptionsForTab(tab: unknown) {
  if (tab === 'asi_eksklusif') return EXCLUSIVE_BREASTFEEDING_AGE_GROUP_OPTIONS;
  if (tab === 'mpasi') return MPASI_AGE_GROUP_OPTIONS;
  return AGE_GROUP_OPTIONS;
}

export function normalizeAgeGroupForTab(value: unknown, tab: unknown): AgeGroup {
  const options = ageGroupOptionsForTab(tab);
  return options.some((option) => option.value === value) ? value as AgeGroup : options[0]?.value || DEFAULT_AGE_GROUP;
}

export function isAgeGroup(value: unknown): value is AgeGroup {
  return AGE_GROUP_OPTIONS.some((option) => option.value === value);
}

export function ageGroupLabel(value: unknown): string {
  return AGE_GROUP_OPTIONS.find((option) => option.value === value)?.label || AGE_GROUP_OPTIONS[0].label;
}

function ageInMonths(child: Record<string, unknown>, referenceDate: Date): number | null {
  const birthValue = child.tglLahir || child.birth_date || child.birthDate;
  if (!birthValue) return null;
  const [year, month, day] = String(birthValue).slice(0, 10).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const birth = new Date(year, month - 1, day);
  if (birth > referenceDate) return null;
  let age = (referenceDate.getFullYear() - year) * 12 + (referenceDate.getMonth() + 1 - month);
  if (referenceDate.getDate() < day) age -= 1;
  return Math.max(0, age);
}

function isNewborn(child: Record<string, unknown>, referenceDate: Date): boolean {
  const birthValue = child.tglLahir || child.birth_date || child.birthDate;
  if (!birthValue) return false;
  const born = new Date(`${String(birthValue).slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(born.getTime()) || born > referenceDate) return false;
  const days = Math.floor((referenceDate.getTime() - born.getTime()) / 86_400_000);
  return days >= 0 && days <= 28;
}

function isPremature(child: Record<string, unknown>): boolean {
  const raw = child.usiaKehamilan ?? child.gestational_age_weeks ?? child.gestationalAgeWeeks;
  const weeks = Number(String(raw ?? '').replace(',', '.'));
  return Number.isFinite(weeks) && weeks > 0 && weeks < 37;
}

export function matchesAgeGroup(child: Record<string, unknown>, group: unknown, referenceDate: Date): boolean {
  const selected = isAgeGroup(group) ? group : DEFAULT_AGE_GROUP;
  if (selected === 'newborn') return isNewborn(child, referenceDate);
  if (selected === 'newborn_premature') return isNewborn(child, referenceDate) && isPremature(child);
  const age = ageInMonths(child, referenceDate);
  if (age === null || age < 0 || age > 59) return false;
  if (selected === '0-59') return true;
  if (selected === '6') return age === 6;
  const [min, max] = selected.split('-').map(Number);
  return age >= min && age <= max;
}
