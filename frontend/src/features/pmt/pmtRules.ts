// @ts-nocheck
import { calculateGiziStatus, getAgeInMonths } from '../../shared/dashboardUtils';

export const CATEGORY_OPTIONS = [
  { value: 'Semua', label: 'Semua PMT', shortLabel: 'Semua' },
  { value: 'Underweight', label: 'Underweight (BB Kurang/Sangat Kurang)', shortLabel: 'Underweight' },
  { value: 'Wasting', label: 'Wasting (Gizi Kurang/Buruk)', shortLabel: 'Wasting' },
  { value: 'TidakNaik', label: 'BB Tidak Naik (N/T)', shortLabel: 'Tidak Naik' },
];

export function maxWeeksForCategory(category) {
  if (category === 'Wasting') return 8;
  if (category === 'Underweight') return 4;
  return 2;
}

export function categoryLabel(category) {
  if (category === 'TidakNaik') return 'BB Tidak Naik';
  return category || '-';
}

export function categoryMetric(category) {
  if (category === 'Wasting') return 'BB/TB';
  if (category === 'Underweight') return 'BB/U';
  return 'N/T';
}

export function numericValue(value) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getMonitoringForWeek(program, week) {
  const monitorings = program?.monitorings ?? program?.pemantauan;
  if (Array.isArray(monitorings)) {
    return monitorings.find((item) => Number(item?.week ?? item?.minggu) === Number(week))
      || monitorings[Number(week)]
      || null;
  }
  return monitorings?.[week] ?? monitorings?.[String(week)] ?? null;
}

export function baselineForProgram(program, child) {
  const initialDate = program?.initialMeasurementDate || program?.tanggalAwalPengukuran || program?.tglPemberian;
  return {
    date: initialDate || child?.lastMeasurementDate,
    weight: numericValue(program.initialBB ?? program.bbAwal) ?? numericValue(child?.currentBB) ?? numericValue(child?.bbLahir),
    height: numericValue(program.initialTB ?? program.tbAwal) ?? numericValue(child?.currentTB) ?? numericValue(child?.pbLahir),
  };
}

export function monitoringStatus(program, child, monitoring, week, baseline) {
  const category = program?.category ?? program?.kategori;
  if (category === 'TidakNaik') {
    if (week === 0 && !monitoring) return 'T';
    if (!monitoring) return '-';
    if (monitoring.statusNaik === 'N' || monitoring.statusNaik === 'T') return monitoring.statusNaik;
    const monitorings = Array.isArray(program?.monitorings) ? program.monitorings : [];
    const previousMonitoring = week > 1
      ? monitorings.find((item) => Number(item?.week ?? item?.minggu) === week - 1) || monitorings[week - 1]
      : null;
    const previousWeight = numericValue(previousMonitoring?.bb) ?? baseline?.weight;
    const currentWeight = numericValue(monitoring.bb);
    if (currentWeight === null || previousWeight === null) return '-';
    return currentWeight > previousWeight ? 'N' : 'T';
  }

  const currentWeight = week === 0 ? baseline.weight : numericValue(monitoring?.bb);
  const currentHeight = week === 0 ? baseline.height : numericValue(monitoring?.tb);
  if (!currentWeight || !child?.tglLahir || !child?.jk) return '-';

  const date = week === 0 ? new Date(baseline.date || program.tglPemberian) : new Date(monitoring?.tgl);
  const age = getAgeInMonths(child.tglLahir, date);
  if (category === 'Wasting' && !currentHeight) return '-';
  return calculateGiziStatus(
    currentWeight,
    category === 'Wasting' ? 'BBTB' : 'BBU',
    age,
    child.jk,
    category === 'Wasting' ? currentHeight : null,
    monitoring?.caraUkur,
  ) || '-';
}
