// @ts-nocheck

export { ensureXlsx } from './xlsx';
export { getDocsForExport } from '../api/exportApi';
export { getSigiziMeasurementExport } from '../api/measurementApi';

import { calculateGiziStatus, getAgeInMonths } from '../shared/dashboardUtils';
import { maxWeeksForCategory } from '../features/pmt/pmtRules';

export function getSelectedMonthRange(month, year) {
  const numericMonth = Number(month);
  const monthValue = String(numericMonth).padStart(2, '0');
  const start = `${year}-${monthValue}-01`;
  const lastDay = new Date(Number(year), numericMonth, 0).getDate();
  const end = `${year}-${monthValue}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

export function toDateValue(value) {
  const date = value instanceof Date
    ? value
    : value && typeof value.toDate === 'function'
      ? value.toDate()
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createdAtValue(value) {
  return toDateValue(value?.createdAt || value?.created_at || value?.tglUkur || value?.tglPemberian)?.getTime() || 0;
}

export function latestMeasurementsByChild(measurements) {
  return (measurements || []).reduce((result, measurement) => {
    const key = measurement.childId || measurement.child_id || measurement.balitaId;
    if (!key) return result;
    const previous = result[key];
    const measurementDate = String(measurement.tglUkur || '');
    const previousDate = String(previous?.tglUkur || '');
    if (!previous || measurementDate > previousDate || (measurementDate === previousDate && createdAtValue(measurement) > createdAtValue(previous))) {
      result[key] = measurement;
    }
    return result;
  }, {});
}

export function latestMpasiLogsByChild(logs) {
  return (logs || []).reduce((result, log) => {
    const key = log.childId || log.child_id || log.balitaId;
    if (!key) return result;
    const previous = result[key];
    const logDate = String(log.tglMonitoring || '');
    const previousDate = String(previous?.tglMonitoring || '');
    if (!previous || logDate > previousDate || (logDate === previousDate && createdAtValue(log) > createdAtValue(previous))) {
      result[key] = log;
    }
    return result;
  }, {});
}

export function filterChildrenByAgeRange(children, minimumAge, maximumAge, referenceDate) {
  return (children || []).filter((child) => {
    if (child?.deletedAt) return false;
    const age = getAgeInMonths(child?.tglLahir, referenceDate);
    return age >= minimumAge && age <= maximumAge;
  });
}

export async function fetchExportDocuments({
  resource,
  dateField,
  start,
  end,
  options = {},
  db,
  appId,
  user,
  roles,
  viewDesa,
  viewPosyandu,
  collection,
  query,
  where,
  getDocsForExport,
}) {
  const constraints = [];
  if (dateField && start) constraints.push(where(dateField, '>=', start));
  if (dateField && end) constraints.push(where(dateField, '<=', end));

  if (!options.allLocations) {
    const scopedDesa = user?.role === roles.GIZI ? viewDesa : user?.desa;
    const scopedPosyandu = user?.role === roles.KADER ? user.posyandu : viewPosyandu;
    if (scopedDesa) constraints.push(where('desa', '==', scopedDesa));
    if (scopedPosyandu) constraints.push(where('posyandu', '==', scopedPosyandu));
  }

  const source = collection(db, 'artifacts', appId, 'public', 'data', resource);
  const snapshot = await getDocsForExport(query(source, ...constraints));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function fetchExportChildren({ currentFilterDate, options = {}, ...context }) {
  const children = await fetchExportDocuments({ resource: 'children', options, ...context });
  return filterChildrenByAgeRange(children, 0, 59, currentFilterDate);
}

export function getMeasurementStatusesForExport(child, measurement, referenceDate) {
  const date = measurement?.tglUkur ? new Date(measurement.tglUkur) : referenceDate;
  const age = getAgeInMonths(child?.tglLahir, date);
  return {
    age,
    statusBbu: calculateGiziStatus(measurement?.bb, 'BBU', age, child?.jk),
    statusTbu: calculateGiziStatus(measurement?.tb, 'TBU', age, child?.jk, null, measurement?.caraUkur),
    statusBbtb: calculateGiziStatus(measurement?.bb, 'BBTB', age, child?.jk, measurement?.tb, measurement?.caraUkur),
    statusImtu: calculateGiziStatus(measurement?.bb, 'IMTU', age, child?.jk, measurement?.tb, measurement?.caraUkur),
  };
}

export function filterChildrenForExportTab(activeTab, children, measurementsByChild, referenceDate) {
  if (activeTab === 'problem_tidak_naik') return (children || []).filter((child) => measurementsByChild[child.id]?.statusNaik === 'T');
  const criteria = {
    problem_underweight: ['BBU', ['Berat Sangat Kurang', 'Berat Kurang']],
    problem_stunting: ['TBU', ['Sangat Pendek', 'Pendek']],
    problem_wasting: ['BBTB', ['Gizi Buruk', 'Gizi Kurang']],
  }[activeTab];
  if (!criteria) return children || [];
  const [type, labels] = criteria;
  return (children || []).filter((child) => {
    const measurement = measurementsByChild[child.id];
    if (type === 'BBU' && !measurement?.bb) return false;
    if (type === 'TBU' && !measurement?.tb) return false;
    if (type === 'BBTB' && (!measurement?.bb || !measurement?.tb)) return false;
    const { age } = getMeasurementStatusesForExport(child, measurement, referenceDate);
    const statusValue = type === 'TBU' ? measurement.tb : measurement.bb;
    const status = calculateGiziStatus(statusValue, type, age, child.jk, type === 'BBTB' ? measurement.tb : null, measurement.caraUkur);
    return labels.includes(status);
  });
}

export function toExportBinary(value) {
  return value === 'Ya' || (Array.isArray(value) && value[0] === 'Ya') ? 1 : 0;
}

export const PMT_EXPORT_HEADERS = [
  'nik', 'nama', 'tanggal_pemberian_pertama', 'siklus_ke', 'jenis_pmt', 'sumber_anggaran',
  'mitra', 'mitra_lain', 'pmt_sesuai_juknis', 'alasan_pemberian', 'minggu_ke',
  'tanggal_pemantauan', 'hari_1', 'hari_2', 'hari_3', 'hari_4', 'hari_5', 'hari_6',
  'hari_7', 'bb', 'tb', 'cara_ukur', 'pemantauan_kesehatan', 'tindak_lanjut',
];

export const SIGIZI_IDENTITY_HEADERS = [
  'No', 'anak_ke', 'tgl_lahir', 'jenis_kelamin', 'nomor_KK', 'NIK', 'nama_anak',
  'usia_hamil', 'berat_lahir', 'panjang_lahir', 'lingkar_kepala_lahir', 'kia',
  'kia_bayi_kecil', 'imd', 'nama_ortu', 'nik_ortu', 'hp_ortu', 'alamat', 'rt', 'rw',
  'hapus', 'pindah',
];

export function getSigiziIdentityRows(children, filterMonth, filterYear) {
  return (children || [])
    .filter((child) => {
      const createdAt = toDateValue(child.createdAt);
      return createdAt && createdAt.getMonth() + 1 === Number(filterMonth) && createdAt.getFullYear() === Number(filterYear);
    })
    .map((child, index) => [
      index + 1,
      child.anakKe,
      child.tglLahir,
      child.jk === 'L' ? 'Laki-laki' : 'Perempuan',
      child.noKK,
      child.nik,
      child.nama,
      child.usiaKehamilan,
      child.bbLahir,
      child.pbLahir,
      child.lkLahir,
      child.bukuKIA,
      child.bukuKIAKecil,
      child.imd,
      child.namaOrtu,
      child.nikOrtu,
      child.noHpOrtu || '-',
      child.alamat || '',
      child.rt,
      child.rw,
      '',
      '',
    ]);
}

export const SIGIZI_MEASUREMENT_HEADERS = [
  'No', 'NIK', 'nama_anak', 'TANGGALUKUR', 'BERAT', 'TINGGI', 'LILA', 'lingkar_kepala',
  'Pitting_edema', 'CARAUKUR', 'vita', 'asi_bulan_0', 'asi_bulan_1', 'asi_bulan_2',
  'asi_bulan_3', 'asi_bulan_4', 'asi_bulan_5', 'asi_bulan_6', 'kelas_ibu_balita', 'mbg',
];

export function buildSigiziMeasurementExportItems(children, measurements, monthStart, monthEnd) {
  const measurementsByChild = new Map();
  (measurements || []).forEach((measurement) => {
    const childId = measurement?.childId || measurement?.child_id || measurement?.balitaId;
    if (!childId) return;
    const items = measurementsByChild.get(String(childId)) || [];
    items.push(measurement);
    measurementsByChild.set(String(childId), items);
  });

  return (children || [])
    .filter((child) => child?.id && !child.deletedAt)
    .sort((left, right) => String(left.nama || '').localeCompare(String(right.nama || ''), 'id'))
    .map((child) => {
      const childMeasurements = (measurementsByChild.get(String(child.id)) || [])
        .filter((measurement) => measurement?.tglUkur && String(measurement.tglUkur) <= monthEnd)
        .sort((left, right) => {
          const dateComparison = String(right.tglUkur).localeCompare(String(left.tglUkur));
          return dateComparison || createdAtValue(right) - createdAtValue(left);
        });
      const current = childMeasurements.find((measurement) => String(measurement.tglUkur) >= monthStart) || null;
      const asiByAge = new Map();
      childMeasurements.forEach((measurement) => {
        const age = getAgeInMonths(child.tglLahir, new Date(`${String(measurement.tglUkur).slice(0, 10)}T00:00:00`));
        if (age < 0 || age > 6 || asiByAge.has(age)) return;
        asiByAge.set(age, measurement.asi || '');
      });

      return {
        nik: child.nik || '',
        nama: child.nama || '',
        tglUkur: current?.tglUkur || null,
        bb: current?.bb ?? null,
        tb: current?.tb ?? null,
        lila: current?.lila ?? null,
        lk: current?.lk ?? null,
        edema: current?.edema || '',
        caraUkur: current?.caraUkur || '',
        vitA: current?.vitA || '',
        asiBulan0: asiByAge.get(0) || '',
        asiBulan1: asiByAge.get(1) || '',
        asiBulan2: asiByAge.get(2) || '',
        asiBulan3: asiByAge.get(3) || '',
        asiBulan4: asiByAge.get(4) || '',
        asiBulan5: asiByAge.get(5) || '',
        asiBulan6: asiByAge.get(6) || '',
        kelasIbu: current?.kelasIbu || '',
        mbg: current?.mbg || '',
      };
    });
}

export function getSigiziMeasurementRows(items) {
  return (items || []).map((row, index) => {
    let edemaValue = '';
    if (row.edema === 'Tidak') edemaValue = 'tidak';
    else if (row.edema?.includes?.('+1')) edemaValue = '1';
    else if (row.edema?.includes?.('+2')) edemaValue = '2';
    else if (row.edema?.includes?.('+3')) edemaValue = '3';

    const asiColumns = [row.asiBulan0, row.asiBulan1, row.asiBulan2, row.asiBulan3, row.asiBulan4, row.asiBulan5, row.asiBulan6]
      .map((value) => value === 'Ya' ? 'ya' : value === 'Tidak' ? 'tidak' : '');

    return [
      index + 1,
      row.nik,
      row.nama,
      row.tglUkur || '',
      row.bb ?? '',
      row.tb ?? '',
      row.lila ?? '',
      row.lk ?? '',
      edemaValue,
      String(row.caraUkur || '').toLowerCase(),
      String(row.vitA || '').toLowerCase(),
      ...asiColumns,
      String(row.kelasIbu || '').toLowerCase(),
      String(row.mbg || '').toLowerCase(),
    ];
  });
}

export const TABLE_EXPORT_HEADERS = [
  'No', 'Nama', 'NIK', 'Jenis Kelamin', 'Tgl Lahir', 'Usia (Bln)', 'Nama Ortu', 'Desa',
  'Posyandu', 'BB (kg)', 'PB/TB (cm)', 'LILA (cm)', 'LK (cm)', 'Status Naik', 'Status BB/U',
  'Status PB/TB-U', 'Status BB/PB atau BB/TB', 'Status IMT/U',
];

export function getTableExportRows({ activeTab, children, measurementsByChild, referenceDate, sortData = (items) => items }) {
  const exportChildren = filterChildrenForExportTab(activeTab, children, measurementsByChild, referenceDate);
  return sortData(exportChildren).map((child, index) => {
    if (!child?.id) return [];
    const measurement = measurementsByChild[child.id];
    const statuses = getMeasurementStatusesForExport(child, measurement, referenceDate);
    return [
      index + 1,
      child.nama,
      child.nik,
      child.jk === 'L' ? 'Laki-laki' : 'Perempuan',
      child.tglLahir,
      statuses.age,
      child.namaOrtu,
      child.desa,
      child.posyandu,
      measurement?.bb || '-',
      measurement?.tb || '-',
      measurement?.lila || '-',
      measurement?.lk || '-',
      measurement?.statusNaik || '-',
      statuses.statusBbu,
      statuses.statusTbu,
      statuses.statusBbtb,
      statuses.statusImtu,
    ];
  });
}

export const MPASI_EXPORT_HEADERS = [
  'No', 'NIK', 'Nama', 'tgl_monitoring', 'asi', 'sereal', 'kacang', 'susu', 'daging/unggas',
  'telur', 'buah_sayur_vita', 'buah_sayur_lain', 'dapat_intervensi',
];

export function getMpasiExportRows(children, logsByChild) {
  return (children || []).map((child, index) => {
    const log = child?.id ? logsByChild[child.id] : null;
    const hasLog = Boolean(log);
    return [
      index + 1,
      child.nik,
      child.nama,
      hasLog ? log.tglMonitoring : '-',
      hasLog ? toExportBinary(log.asi) : 0,
      hasLog ? toExportBinary(log.makananPokok) : 0,
      hasLog ? toExportBinary(log.kacang) : 0,
      hasLog ? toExportBinary(log.susu) : 0,
      hasLog ? toExportBinary(log.daging) : 0,
      hasLog ? toExportBinary(log.telur) : 0,
      hasLog ? toExportBinary(log.sayurVitA) : 0,
      hasLog ? toExportBinary(log.sayurLain) : 0,
      hasLog ? toExportBinary(log.intervensiGizi) : 0,
    ];
  });
}

const mapJenisPmt = (value) => value === 'Pabrikan' ? 1 : 2;
const mapSumberAnggaran = (value) => ({ 'DAK Non Fisik': 1, APBD: 2, Mitra: 3, 'Dana Desa': 4 }[value] || 0);
const mapAlasan = (value) => ({ Wasting: 1, Underweight: 2, TidakNaik: 3 }[value] || 0);
const mapCaraUkur = (value) => value === 'Berdiri' ? 1 : 2;
const mapKesehatan = (value) => value === 'Ada' ? 1 : 0;
const mapTindakLanjut = (value) => ({ Dilanjutkan: 1, Selesai: 2, 'Rujuk RS': 3 }[value] || 0);
const mapSesuaiJuknis = (value) => value === 'Ya' ? 1 : 0;

const getProgramCategory = (program) => program?.category ?? program?.kategori;
const getChildById = (childById, id) => childById instanceof Map ? childById.get(id) : childById?.[id];
const getMonitoringForWeek = (program, week) => {
  const monitorings = program?.monitorings ?? program?.pemantauan;
  if (Array.isArray(monitorings)) {
    return monitorings.find((item) => Number(item?.week ?? item?.minggu) === week) || monitorings[week] || null;
  }
  return monitorings?.[week] ?? monitorings?.[String(week)] ?? null;
};

export function getPmtExportRows(category, programs, childById) {
  return (programs || [])
    .filter((program) => category === 'Semua' || getProgramCategory(program) === category)
    .flatMap((program) => {
      const child = getChildById(childById, program.childId || program.child_id) || {};
      const programCategory = getProgramCategory(program);
      return Array.from({ length: maxWeeksForCategory(programCategory) }, (_, index) => {
        const week = index + 1;
        const monitoring = getMonitoringForWeek(program, week);
        const days = monitoring?.days || [];
        return [
          child.nik || '', child.nama || '', program.tglPemberian || '', program.siklusKe || 1,
          mapJenisPmt(program.jenisPmt), mapSumberAnggaran(program.sumberAnggaran), program.mitra || '',
          program.mitraLain || '', mapSesuaiJuknis(program.pmtSesuaiJuknis), mapAlasan(programCategory), week,
          monitoring?.tgl || '', ...Array.from({ length: 7 }, (_, day) => days[day] ? 1 : 0),
          monitoring?.bb || '', monitoring?.tb || '', monitoring ? mapCaraUkur(monitoring.caraUkur) : '',
          monitoring ? mapKesehatan(monitoring.pemantauanKesehatan ?? monitoring.statusKesehatan) : '',
          monitoring ? mapTindakLanjut(monitoring.tindakLanjut) : '',
        ];
      });
    });
}
