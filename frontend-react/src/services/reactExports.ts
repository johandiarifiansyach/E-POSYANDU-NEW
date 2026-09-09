// Export adapters kept outside the page components so the normal table and
// dashboard bundles do not need to know the spreadsheet details.  The
// existing export builders are shared with the legacy implementation, which
// keeps column order, value mapping, and location-aware filenames identical
// during the React migration.
// @ts-nocheck

import { ensureXlsx, createSafeWorksheet } from "../compat/services/xlsx";
import {
  TABLE_EXPORT_HEADERS,
  SIGIZI_MEASUREMENT_HEADERS,
  SIGIZI_IDENTITY_HEADERS,
  MPASI_EXPORT_HEADERS,
  PMT_EXPORT_HEADERS,
  buildSigiziMeasurementExportItems,
  fetchExportChildren,
  fetchExportDocuments,
  filterChildrenByAgeGroup,
  getMpasiExportRows,
  getPmtExportRows,
  getSelectedMonthRange,
  getSigiziIdentityRows,
  getSigiziMeasurementRows,
  getTableExportRows,
  latestMpasiLogsByChild,
  getScopedExportFilename,
} from "../compat/services/exportService";
import { getSigiziMeasurementExport } from "../compat/api/measurementApi";
import { getChildrenPage } from "../api/childrenApi";
import { getDocsForExport } from "../compat/api/exportApi";
import { collection, query, where } from "../api/syncApi";

function exportContext({ db, appId, user, roles, desa, posyandu }) {
  return {
    db,
    appId,
    user,
    roles,
    viewDesa: desa,
    viewPosyandu: posyandu,
    collection,
    query,
    where,
    getDocsForExport,
  };
}

function monthName(month: number) {
  return new Intl.DateTimeFormat("id-ID", { month: "long" }).format(
    new Date(2020, month - 1, 1),
  );
}

export async function exportChildrenTable({
  activeView,
  scope,
  user,
  db,
  appId,
  roles,
}: any) {
  const xlsx = await ensureXlsx();
  const { start, end } = getSelectedMonthRange(scope.month, scope.year);
  const previous = new Date(scope.year, scope.month - 2, 1);
  const previousStart = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-01`;
  const previousEnd = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-${new Date(previous.getFullYear(), previous.getMonth() + 1, 0).getDate()}`;
  const view = activeView === "data" ? "data" : activeView;
  const childrenById = new Map();
  const measurementsByChild = {};
  const pageSize = 100;
  for (let page = 1; page <= 200; page += 1) {
    const response = await getChildrenPage({
      asOf: end,
      ageGroup: scope.ageGroup,
      historyStart: "1900-01-01",
      measurementStart: start,
      measurementEnd: end,
      previousMonthStart: previousStart,
      previousMonthEnd: previousEnd,
      page,
      size: pageSize,
      sort: "recent",
      view,
      village: scope.desa || undefined,
      posyandu: scope.posyandu || undefined,
    });
    for (const item of response.items || []) {
      childrenById.set(item.id, { id: item.id, ...(item.data || item) });
    }
    for (const item of response.measurements || []) {
      const measurement = { id: item.id, ...(item.data || item) };
      const childId = measurement.childId || measurement.child_id;
      if (childId) measurementsByChild[childId] = measurement;
    }
    if ((response.items || []).length < pageSize || childrenById.size >= response.total) break;
  }
  const children = [...childrenById.values()];
  const rows = getTableExportRows({
    activeTab: activeView,
    children,
    measurementsByChild,
    referenceDate: new Date(scope.year, scope.month, 0),
    pythonStatuses: measurementsByChild,
    pythonFiltered: true,
  });
  const worksheet = createSafeWorksheet(xlsx, [TABLE_EXPORT_HEADERS, ...rows]);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Data Balita");
  const prefix = activeView === "problem_underweight"
    ? "Balita_Underweight"
    : activeView === "problem_stunting"
      ? "Balita_Stunting"
      : activeView === "problem_wasting"
        ? "Balita_Wasting"
        : activeView === "problem_tidak_naik"
          ? "Balita_Tidak_Naik"
          : "Data_Balita";
  xlsx.writeFile(workbook, getScopedExportFilename({
    prefix,
    month: monthName(scope.month),
    year: scope.year,
    desa: scope.desa,
    posyandu: scope.posyandu,
  }));
}

export async function exportMeasurements({ scope, user, db, appId, roles }: any) {
  const xlsx = await ensureXlsx();
  const { start, end } = getSelectedMonthRange(scope.month, scope.year);
  let items;
  try {
    items = (await getSigiziMeasurementExport({
      ageGroup: scope.ageGroup,
      monthStart: start,
      monthEnd: end,
      village: scope.desa || undefined,
      posyandu: scope.posyandu || undefined,
    })).items;
  } catch {
    const children = await fetchExportChildren({
      ageGroup: scope.ageGroup,
      currentFilterDate: new Date(scope.year, scope.month, 0),
      ...exportContext({ db, appId, user, roles, desa: scope.desa, posyandu: scope.posyandu }),
    });
    const measurements = await fetchExportDocuments({
      resource: "measurements",
      dateField: "tglUkur",
      start,
      end,
      ...exportContext({ db, appId, user, roles, desa: scope.desa, posyandu: scope.posyandu }),
    });
    items = buildSigiziMeasurementExportItems(children, measurements, start, end);
  }
  const worksheet = createSafeWorksheet(xlsx, [SIGIZI_MEASUREMENT_HEADERS, ...getSigiziMeasurementRows(items)]);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Data Pengukuran");
  xlsx.writeFile(workbook, getScopedExportFilename({
    prefix: "Pengukuran",
    month: monthName(scope.month),
    year: scope.year,
    desa: scope.desa,
    posyandu: scope.posyandu,
  }));
}

export async function exportRecentIdentities({ scope, user, db, appId, roles }: any) {
  const xlsx = await ensureXlsx();
  const { start, end } = getSelectedMonthRange(scope.month, scope.year);
  const children = await fetchExportChildren({
    ageGroup: scope.ageGroup,
    currentFilterDate: new Date(scope.year, scope.month, 0),
    ...exportContext({ db, appId, user, roles, desa: scope.desa, posyandu: scope.posyandu }),
  });
  const worksheet = createSafeWorksheet(xlsx, [SIGIZI_IDENTITY_HEADERS, ...getSigiziIdentityRows(children, scope.month, scope.year)]);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Data Balita");
  xlsx.writeFile(workbook, getScopedExportFilename({
    prefix: "Identitas-Balita-Baru",
    month: monthName(scope.month),
    year: scope.year,
    desa: scope.desa,
    posyandu: scope.posyandu,
  }));
}

export async function exportMpasi({ scope, user, db, appId, roles }: any) {
  const xlsx = await ensureXlsx();
  const { start, end } = getSelectedMonthRange(scope.month, scope.year);
  const context = exportContext({ db, appId, user, roles, desa: scope.desa, posyandu: scope.posyandu });
  const [allChildren, logs] = await Promise.all([
    fetchExportChildren({ ageGroup: "6-23", currentFilterDate: new Date(scope.year, scope.month, 0), ...context }),
    fetchExportDocuments({ resource: "mpasi_logs", dateField: "tglMonitoring", start, end, ...context }),
  ]);
  const children = filterChildrenByAgeGroup(allChildren, "6-23", new Date(scope.year, scope.month, 0));
  const ids = new Set(children.map((child) => child.id));
  const logsByChild = latestMpasiLogsByChild(logs.filter((log) => ids.has(log.childId || log.child_id || log.balitaId)));
  const worksheet = createSafeWorksheet(xlsx, [MPASI_EXPORT_HEADERS, ...getMpasiExportRows(children, logsByChild)]);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Data MPASI");
  xlsx.writeFile(workbook, getScopedExportFilename({
    prefix: "Laporan_MPASI",
    month: monthName(scope.month),
    year: scope.year,
    desa: scope.desa,
    posyandu: scope.posyandu,
  }));
}

export async function exportPmt({ scope, user, db, appId, roles }: any) {
  const xlsx = await ensureXlsx();
  const context = exportContext({ db, appId, user, roles, desa: scope.desa, posyandu: scope.posyandu });
  const [children, programs] = await Promise.all([
    fetchExportChildren({ ageGroup: "6-23", currentFilterDate: new Date(scope.year, scope.month, 0), ...context }),
    fetchExportDocuments({ resource: "pmt_programs", ...context }),
  ]);
  const childById = new Map(children.filter((child) => child.id).map((child) => [child.id, child]));
  const workbook = xlsx.utils.book_new();
  for (const category of ["Wasting", "Underweight", "TidakNaik"]) {
    const worksheet = createSafeWorksheet(xlsx, [PMT_EXPORT_HEADERS, ...getPmtExportRows(category, programs, childById)]);
    xlsx.utils.book_append_sheet(workbook, worksheet, category === "TidakNaik" ? "Tidak Naik" : category);
  }
  xlsx.writeFile(workbook, getScopedExportFilename({
    prefix: "Laporan_PMT_Lengkap",
    month: monthName(scope.month),
    year: scope.year,
    desa: scope.desa,
    posyandu: scope.posyandu,
  }));
}
