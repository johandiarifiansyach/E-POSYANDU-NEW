/** React-facing measurement history read contract. */
import { getChildrenPage } from '../api/childrenApi';

function dateOnly(value: unknown): string {
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function previousDate(value: unknown): string {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() - 1);
  return dateOnly(date);
}

export async function fetchChildMeasurementHistory(child: Record<string, any>, referenceDate = new Date(), readPage = getChildrenPage, options: { maxRecords?: number } = {}) {
  const birthDate = String(child?.tglLahir || '').slice(0, 10);
  const asOf = dateOnly(referenceDate);
  if (!child?.id || !birthDate || !asOf) return [];
  const history: Array<Record<string, any>> = [];
  const measurementIds = new Set<string>();
  let measurementEnd = String(child.lastMeasurementDate || asOf).slice(0, 10);
  const maxRecords = Number.isFinite(Number(options.maxRecords)) ? Math.max(1, Math.floor(Number(options.maxRecords))) : 72;
  for (let attempt = 0; attempt < 72 && history.length < maxRecords && measurementEnd >= birthDate; attempt += 1) {
    const response = await readPage({ asOf, measurementStart: birthDate, measurementEnd, page: 1, size: 50, sort: 'name_asc', view: 'data', search: child.nama || undefined, village: child.desa || undefined, posyandu: child.posyandu || undefined });
    const candidates = (response.measurements || []).filter((document) => String(document?.data?.childId || '') === String(child.id)).sort((left, right) => String(right.data?.tglUkur || '').localeCompare(String(left.data?.tglUkur || '')));
    const latest = candidates[0];
    if (!latest?.data?.tglUkur) break;
    if (!measurementIds.has(latest.id)) { measurementIds.add(latest.id); history.push({ id: latest.id, ...latest.data }); }
    const nextEnd = previousDate(latest.data.tglUkur);
    if (!nextEnd || nextEnd >= measurementEnd) break;
    measurementEnd = nextEnd;
  }
  return history.sort((left, right) => String(right.tglUkur || '').localeCompare(String(left.tglUkur || '')));
}
