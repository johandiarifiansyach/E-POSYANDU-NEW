// Child measurement reads that remain available through the authenticated
// Supabase fallback when the edge API is temporarily unavailable.
// @ts-nocheck
import { getChildrenPage } from '../api/childrenApi';

export { getDashboardStats, getMonitoringStatus } from '../api/dashboardApi';
export { getSigiziMeasurementExport } from '../api/measurementApi';

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function previousDate(value) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() - 1);
  return dateOnly(date);
}

export async function fetchChildMeasurementHistory(child, referenceDate = new Date(), readPage = getChildrenPage) {
  const birthDate = String(child?.tglLahir || '').slice(0, 10);
  const asOf = dateOnly(referenceDate);
  if (!child?.id || !birthDate || !asOf) return [];

  const history = [];
  const measurementIds = new Set();
  let measurementEnd = String(child.lastMeasurementDate || asOf).slice(0, 10);

  // Each page request returns the latest measurement inside the requested
  // range. Moving the end date backwards retrieves the complete chronology
  // with one request per recorded weighing, instead of one request per month.
  for (let attempt = 0; attempt < 72 && measurementEnd >= birthDate; attempt += 1) {
    const response = await readPage({
      asOf,
      measurementStart: birthDate,
      measurementEnd,
      page: 1,
      size: 50,
      sort: 'name_asc',
      view: 'data',
      search: child.nama || undefined,
      village: child.desa || undefined,
      posyandu: child.posyandu || undefined,
    });
    const candidates = (response.measurements || [])
      .filter((document) => String(document?.data?.childId || '') === String(child.id))
      .sort((left, right) => String(right.data?.tglUkur || '').localeCompare(String(left.data?.tglUkur || '')));
    const latest = candidates[0];
    if (!latest?.data?.tglUkur) break;

    if (!measurementIds.has(latest.id)) {
      measurementIds.add(latest.id);
      history.push({ id: latest.id, ...latest.data });
    }
    const nextEnd = previousDate(latest.data.tglUkur);
    if (!nextEnd || nextEnd >= measurementEnd) break;
    measurementEnd = nextEnd;
  }

  return history.sort((left, right) => String(right.tglUkur || '').localeCompare(String(left.tglUkur || '')));
}
