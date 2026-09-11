import { memo, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getExclusiveBreastfeedingPage,
  type ExclusiveBreastfeedingPageResponse,
} from "../../api/childrenApi";
import { isFullAccessRole, MONTHS } from "../../config/dashboard";
import { formatIndoDate } from "../../shared/formatters";
import { errorMessage, type PageState } from "../../shared/pageState";
import { ageGroupLabel, type AgeGroup } from "../../config/ageFilters";
import type { DashboardUser } from "../../types";
import {
  Badge,
  Card,
  DataTable,
  Pagination,
  SkeletonBlock,
} from "../../components/base";
import { Baby, CalendarDays, CheckCircle2 } from "../../ui/icons";

type Scope = {
  month: number;
  year: number;
  ageGroup: AgeGroup;
  desa?: string | null;
  posyandu?: string | null;
};

function dateStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}
function dateEnd(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
}
function display(value: unknown) {
  return value === null || value === undefined || value === ""
    ? "-"
    : String(value);
}
function dataOf(item: Record<string, unknown>) {
  return (
    item.data && typeof item.data === "object" ? item.data : item
  ) as Record<string, unknown>;
}

function TableSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }, (_, row) => (
        <tr key={row} aria-hidden="true">
          {Array.from({ length: 6 }, (_, column) => (
            <td className="px-4 py-4" key={column}>
              <SkeletonBlock
                className={column === 1 ? "h-4 w-40" : "h-4 w-16"}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

type BreastfeedingRowProps = {
  item: ExclusiveBreastfeedingPageResponse["items"][number];
  index: number;
  page: number;
};

const BreastfeedingRow = memo(function BreastfeedingRow({
  item,
  index,
  page,
}: BreastfeedingRowProps) {
  const child = dataOf(item.data ? item : item);
  return (
    <tr className="text-slate-700 hover:bg-slate-50">
      <td className="px-4 py-3 text-center text-slate-500">
        {(page - 1) * 10 + index + 1}
      </td>
      <td className="px-4 py-3">
        <p className="font-semibold text-slate-800">{display(child.nama)}</p>
        <p className={`font-mono text-xs ${child.hasNIK !== true ? "font-bold text-red-600" : "text-slate-500"}`}>
          {display(child.nik || child.national_id)}
        </p>
      </td>
      <td className="px-4 py-3">{display(child.ageInMonths)} bulan</td>
      <td className="px-4 py-3">
        {child.tglUkur ? formatIndoDate(String(child.tglUkur)) : "-"}
      </td>
      <td className="px-4 py-3">
        <p>{display(child.posyandu)}</p>
        <p className="text-xs text-slate-500">{display(child.desa)}</p>
      </td>
      <td className="px-4 py-3 text-center">
        <span className="ios-status-pill ios-status-success inline-flex items-center gap-1.5 text-xs font-bold">
          <CheckCircle2 className="h-4 w-4" />
          Ya
        </span>
      </td>
    </tr>
  );
});

export type ReactExclusiveBreastfeedingPageProps = {
  user: DashboardUser;
  scope: Scope;
};

/** React-owned ASI page. The API returns only the requested 0–5/6-month page. */
export default function ReactExclusiveBreastfeedingPage({
  user,
  scope,
}: ReactExclusiveBreastfeedingPageProps) {
  const [page, setPage] = useState(1);
  const ageGroup = scope.ageGroup === "6" ? "6" : "0-5";
  const village = isFullAccessRole(user.role)
    ? scope.desa || undefined
    : user.desa || undefined;
  const posyandu =
    user.role === "Kader Posyandu"
      ? user.posyandu || undefined
      : scope.posyandu || undefined;
  const request = useMemo(
    () => ({
      ageGroup: ageGroup as AgeGroup,
      historyStart: "1900-01-01",
      measurementStart: dateStart(scope.year, scope.month),
      measurementEnd: dateEnd(scope.year, scope.month),
      page,
      size: 10,
      village,
      posyandu,
    }),
    [
      ageGroup,
      page,
      posyandu,
      scope.month,
      scope.year,
      scope.posyandu,
      scope.desa,
      village,
    ],
  );

  useEffect(() => {
    setPage(1);
  }, [scope.ageGroup, scope.month, scope.year, scope.desa, scope.posyandu]);
  const pageQuery = useQuery({
    queryKey: ["exclusive-breastfeeding-page", request],
    queryFn: () => getExclusiveBreastfeedingPage(request),
    // A cohort or period change must wait for the matching response instead
    // of briefly painting the previous page's rows.
    staleTime: 0,
  });
  const state: PageState<ExclusiveBreastfeedingPageResponse> = pageQuery.data
    ? { status: "success", data: pageQuery.data }
    : pageQuery.error
      ? {
          status: "error",
          message: errorMessage(
            pageQuery.error,
            "Data ASI eksklusif belum dapat dimuat.",
          ),
        }
      : { status: "loading" };

  const items = state.status === "success" ? state.data.items : [];
  const total = state.status === "success" ? state.data.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / 10));
  return (
    <div
      className="apple-page space-y-6"
      data-react-asi-page="true"
      aria-busy={state.status === "loading" ? "true" : "false"}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="apple-page-title">Daftar ASI Eksklusif</h2>
          <p className="text-sm text-slate-500">
            Pengukuran {MONTHS[scope.month - 1]} {scope.year}
          </p>
        </div>
        <p className="text-xs text-slate-500">
          Kelompok umur mengikuti filter umur bersama di bagian atas halaman.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="apple-summary-card apple-summary-blue p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Bayi Mendapat ASI Eksklusif
              </p>
              <p className="mt-1 text-2xl font-bold text-slate-800">
                {state.status === "loading" ? (
                  <SkeletonBlock className="h-8 w-20" />
                ) : (
                  total
                )}{" "}
                <span className="text-base font-medium text-slate-500">
                  bayi
                </span>
              </p>
            </div>
            <span className="apple-symbol-tile apple-symbol-tile-cyan">
              <Baby className="h-5 w-5" />
            </span>
          </div>
        </Card>
        <Card className="apple-summary-card apple-summary-green p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Kelompok Usia
              </p>
              <p className="mt-1 text-2xl font-bold text-slate-800">
                {ageGroupLabel(ageGroup as AgeGroup)}
              </p>
            </div>
            <span className="apple-symbol-tile apple-symbol-tile-green">
              <CalendarDays className="h-5 w-5" />
            </span>
          </div>
        </Card>
      </div>
      {state.status === "error" ? (
        <div
          role="alert"
          className="ios-inline-notification ios-inline-notification-error"
        >
          Gagal memuat data ASI eksklusif: {state.message}
        </div>
      ) : null}
      <Card className="ios-table-card overflow-hidden">
        <DataTable ariaLabel="Daftar ASI eksklusif React">
          <table
            className="ios-data-table ios-asi-table min-w-full text-sm"
            aria-busy={state.status === "loading" ? "true" : "false"}
          >
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wider text-slate-500">
              <tr>
                {[
                  "No.",
                  "Balita",
                  "Usia",
                  "Tanggal Ukur",
                  "Lokasi",
                  "ASI Eksklusif",
                ].map((heading, index) => (
                  <th
                    className={`px-4 py-3 ${index === 0 ? "w-16 text-center" : ""}`}
                    key={heading}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.status === "loading" ? (
                <TableSkeleton />
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-slate-400"
                  >
                    Tidak ada data ASI eksklusif pada kelompok usia ini.
                  </td>
                </tr>
              ) : (
                items.map((item, index) => (
                  <BreastfeedingRow
                    key={String(item.id || index)}
                    item={item}
                    index={index}
                    page={page}
                  />
                ))
              )}
            </tbody>
          </table>
        </DataTable>
        <div className="ios-table-footer flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="text-xs font-medium text-slate-500">
            Menampilkan {total === 0 ? 0 : (page - 1) * 10 + 1} -{" "}
            {Math.min(page * 10, total)} dari {total} data
          </span>
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            disablePrevious={state.status === "loading" || page <= 1}
            disableNext={
              state.status === "loading" || page >= totalPages || total === 0
            }
            onPrevious={() => setPage((current) => Math.max(1, current - 1))}
            onNext={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
          />
        </div>
      </Card>
    </div>
  );
}
