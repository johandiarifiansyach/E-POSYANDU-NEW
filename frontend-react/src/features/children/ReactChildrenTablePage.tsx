import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getChildrenPage,
  type ChildrenPageRequest,
  type ChildrenPageResponse,
} from "../../api/childrenApi";
import { DEFAULT_AGE_GROUP, type AgeGroup } from "../../config/ageFilters";
import { isFullAccessRole, MONTHS, ROLES } from "../../config/dashboard";
import { formatIndoDate, getCompletedAgeInMonths } from "../../shared/formatters";
import { errorMessage, type PageState } from "../../shared/pageState";
import type { DashboardUser } from "../../types";
import {
  AppButton,
  Badge,
  Card,
  DataTable,
  Pagination,
  SkeletonBlock,
  StatusBadge,
  KenaikanBadge,
} from "../../components/base";
import {
  doc,
  serverTimestamp,
  syncPendingMutations,
  updateDoc,
} from "../../api/syncApi";
import { appId, db } from "../../app/session";
import DeleteChildModal from "./DeleteChildModal";
import {
  ChevronDown,
  FileDown,
  FileText,
  FileUp,
  Filter,
  Gift,
  Pencil,
  Plus,
  Ruler,
  RotateCcw,
  Search,
  Trash2,
  Utensils,
  X,
} from "../../ui/icons";
import { hasUsableAnalysis } from "../../api/analysisApi";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";

type Scope = {
  month: number;
  year: number;
  ageGroup: AgeGroup;
  desa?: string | null;
  posyandu?: string | null;
};

const PAGE_SIZE = 10;
type ChildView = NonNullable<ChildrenPageRequest["view"]>;
const EMPTY_MEASUREMENT: Record<string, unknown> = {};
const EMPTY_MEASUREMENT_MAP = new Map<string, Record<string, unknown>>();

/** Keep the page heading identical to the legacy table, including the
 * programme context shown for each problem tab.  The tab labels are short,
 * while the legacy heading is deliberately descriptive for printed/exported
 * views. */
function pageHeading(view: ChildView, month: number, year: number) {
  if (view === "recycle") return "Daftar Sampah (Recycle Bin)";
  if (view === "recent") return `Balita Baru (${MONTHS[month - 1]} ${year})`;
  if (view === "problem_underweight") return "Daftar Balita Underweight (BB/U)";
  if (view === "problem_stunting") return "Daftar Balita Stunting (TB/U)";
  if (view === "problem_wasting") return "Daftar Balita Wasting (BB/TB)";
  if (view === "problem_tidak_naik") return "Daftar Balita Tidak Naik (T)";
  return "Data Balita Lengkap";
}

function dateStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function dateEnd(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
}

function previousRange(year: number, month: number) {
  const previous = new Date(year, month - 2, 1);
  return { year: previous.getFullYear(), month: previous.getMonth() + 1 };
}

function toRequest(
  scope: Scope,
  user: DashboardUser,
  page: number,
  search: string,
  sort: string,
  view: ChildView,
): ChildrenPageRequest {
  const previous = previousRange(scope.year, scope.month);
  const village = isFullAccessRole(user.role)
    ? scope.desa || undefined
    : user.desa || undefined;
  const posyandu =
    user.role === "Kader Posyandu"
      ? user.posyandu || undefined
      : scope.posyandu || undefined;
  return {
    asOf: dateEnd(scope.year, scope.month),
    ageGroup: scope.ageGroup,
    measurementStart: dateStart(scope.year, scope.month),
    measurementEnd: dateEnd(scope.year, scope.month),
    previousMonthStart: dateStart(previous.year, previous.month),
    previousMonthEnd: dateEnd(previous.year, previous.month),
    historyStart: "1900-01-01",
    page,
    size: PAGE_SIZE,
    sort,
    view,
    search: search || undefined,
    village,
    posyandu,
  };
}

function value(
  data: Record<string, unknown>,
  ...keys: string[]
): string | number {
  for (const key of keys) {
    const current = data[key];
    if (current !== null && current !== undefined && current !== "") {
      if (typeof current === "string" || typeof current === "number")
        return current;
      if (typeof current === "boolean") return current ? "Ya" : "Tidak";
      try {
        return JSON.stringify(current) || "-";
      } catch {
        return String(current);
      }
    }
  }
  return "-";
}

function dataOf(
  item: { data?: Record<string, unknown> } & Record<string, unknown>,
) {
  return (
    item.data && typeof item.data === "object" ? item.data : item
  ) as Record<string, unknown>;
}

function measurementMap(response: ChildrenPageResponse) {
  const result = new Map<string, Record<string, unknown>>();
  for (const item of response.measurements || []) {
    const data = dataOf(item);
    const childId = String(value(data, "childId", "child_id"));
    if (!childId || childId === "-") continue;
    const current = result.get(childId);
    const currentDate = new Date(
      String(value(data, "tglUkur", "measurementDate", "date")),
    ).getTime();
    const previousDate = current
      ? new Date(
          String(value(current, "tglUkur", "measurementDate", "date")),
        ).getTime()
      : -1;
    if (
      !current ||
      (Number.isFinite(currentDate) && currentDate >= previousDate)
    )
      result.set(childId, data);
  }
  return result;
}

function pageHasPendingAnalysis(response: ChildrenPageResponse | undefined) {
  return Boolean(
    response?.measurements?.some((item) => {
      const measurement = item.data || {};
      return Boolean(
        (measurement.analysisPending || measurement.analysis_pending) &&
          !hasUsableAnalysis(measurement),
      );
    }),
  );
}

function TableSkeleton({
  rows = 6,
  columns = 12,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden="true">
          {Array.from({ length: columns }, (_, column) => (
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

type ChildTableRowProps = {
  item: ChildrenPageResponse["items"][number];
  index: number;
  page: number;
  view: ChildView;
  asOf: string;
  measurement: Record<string, unknown>;
  showDesa: boolean;
  showPosyandu: boolean;
  isReadOnly: boolean;
  onOpenMeasurement?: (child: Record<string, unknown>) => void;
  onEditChild?: (child: Record<string, unknown>) => void;
  onOpenPmt?: (child: Record<string, unknown>, category: string) => void;
  onRestoreChild?: (child: Record<string, unknown>) => void;
  onPermanentDelete?: (child: Record<string, unknown>) => void;
  onDelete: (child: Record<string, unknown>) => void;
};

/**
 * A table row is intentionally isolated from the paginated page component.
 * The page can re-render when filters, dialogs, or realtime state change,
 * while rows whose source objects did not change are skipped by React.memo.
 */
const ChildTableRow = memo(function ChildTableRow({
  item,
  index,
  page,
  view,
  asOf,
  measurement,
  showDesa,
  showPosyandu,
  isReadOnly,
  onOpenMeasurement,
  onEditChild,
  onOpenPmt,
  onRestoreChild,
  onPermanentDelete,
  onDelete,
}: ChildTableRowProps) {
  const child = dataOf(item);
  const id = String(item.id || value(child, "id"));
  // Keep the document id with the flattened row data. The API returns ids
  // beside `data`, but every action needs the id to address the same child.
  const childRecord = { ...child, id };
  const storedAge = value(child, "ageInMonths", "usiaBulan");
  const storedAgeNumber = Number(storedAge);
  const measurementAge = value(measurement, "ageInMonths", "usiaBulan");
  const measurementAgeNumber = Number(measurementAge);
  // Age is a property of the child and report period, not of whether the
  // latest measurement has finished Python analysis. Prefer the deterministic
  // birth-date calculation so rows without a measurement still show an age.
  const birthDate = value(child, "tglLahir", "birthDate", "birth_date");
  const ageInMonths =
    getCompletedAgeInMonths(birthDate, asOf) ??
    (storedAge !== "-" && Number.isFinite(storedAgeNumber)
      ? Math.trunc(storedAgeNumber)
      : measurementAge !== "-" && Number.isFinite(measurementAgeNumber)
        ? Math.trunc(measurementAgeNumber)
        : null);
  const status = (key: string, ...aliases: string[]) =>
    value(measurement, key, ...aliases);
  const analysisLoading = Boolean(
    (measurement.analysisPending || measurement.analysis_pending) &&
      !hasUsableAnalysis(measurement),
  );
  const analysisBadge = (statusValue: string) =>
    analysisLoading ? (
      <SkeletonBlock className="table-analysis-skeleton table-analysis-skeleton-badge" />
    ) : (
      <StatusBadge status={statusValue} />
    );

  return (
    <tr className="ios-data-row text-xs">
      <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-center text-slate-500 md:sticky md:left-0 md:z-10 md:bg-white">
        {(page - 1) * PAGE_SIZE + index + 1}
      </td>
      <td className="min-w-[12rem] whitespace-normal border-r border-slate-100 px-4 py-3 md:sticky md:left-[48px] md:z-10 md:bg-white md:shadow-lg">
        <p className="break-words font-bold text-slate-900">
          {value(child, "nama", "name")}
        </p>
        <p
          className={`break-all font-mono text-[10px] ${
            child.hasNIK === true
              ? "text-slate-500"
              : "font-bold text-red-600"
          }`}
        >
          {value(child, "nik", "national_id")}
        </p>
        <div className="mt-1 flex items-center gap-1">
          <Badge color={value(child, "jk", "gender") === "L" ? "blue" : "pink"}>
            {value(child, "jk", "gender") === "L" ? "L" : "P"}
          </Badge>
          <span className="text-[10px] text-slate-400">
            {formatIndoDate(String(birthDate))}{" "}
            ({ageInMonths === null ? "-" : ageInMonths} Bln)
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-slate-700">
        {value(child, "namaOrtu", "parentName")}
      </td>
      {view === "recycle" ? (
        <td className="min-w-[11rem] border-r border-slate-100 bg-rose-50/30 px-4 py-3 font-semibold text-rose-700">
          {value(child, "deleteReason", "alasanDihapus")}
        </td>
      ) : null}
      {showDesa ? (
        <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-slate-600">
          {value(child, "desa", "village")}
        </td>
      ) : null}
      {showPosyandu ? (
        <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-slate-600">
          {value(child, "posyandu")}
        </td>
      ) : null}
      <td className="border-r border-slate-100 bg-blue-50/10 px-2 py-3 text-center font-mono">
        {value(measurement, "bb", "weight")}
      </td>
      <td className="border-r border-slate-100 bg-blue-50/10 px-2 py-3 text-center font-mono">
        {value(measurement, "tb", "pb", "height")}
      </td>
      <td className="border-r border-slate-100 bg-blue-50/10 px-2 py-3 text-center font-mono">
        {value(measurement, "lila", "muac")}
      </td>
      <td className="border-r border-slate-100 bg-blue-50/10 px-2 py-3 text-center font-mono">
        {value(measurement, "lk", "headCircumference")}
      </td>
      <td className="border-r border-slate-100 bg-indigo-50/10 px-2 py-3 text-center">
        {analysisLoading ? (
          <SkeletonBlock className="table-analysis-skeleton table-analysis-skeleton-badge" />
        ) : (
          <KenaikanBadge
            status={String(status("weightGainStatus", "statusNaik"))}
          />
        )}
      </td>
      <td className="border-r border-slate-100 bg-emerald-50/10 px-2 py-3 text-center">
        {analysisBadge(String(status("bbuStatus", "statusBbu")))}
      </td>
      <td className="border-r border-slate-100 bg-emerald-50/10 px-2 py-3 text-center">
        {analysisBadge(String(status("tbuStatus", "statusTbu")))}
      </td>
      <td className="border-r border-slate-100 bg-emerald-50/10 px-2 py-3 text-center">
        {analysisBadge(String(status("bbtbStatus", "statusBbtb")))}
      </td>
      <td className="border-r border-slate-100 bg-emerald-50/10 px-2 py-3 text-center">
        {analysisBadge(String(status("imtuStatus", "statusImtu")))}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-center">
        <div className="flex justify-center gap-1">
          {isReadOnly ? (
            <span className="text-xs font-semibold text-slate-400">Hanya baca</span>
          ) : view === "recycle" ? (
            <>
              <button
                type="button"
                className="apple-button table-action-button table-action-green"
                title="Pulihkan"
                aria-label="Pulihkan balita"
                onClick={() => onRestoreChild?.(childRecord)}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="apple-button table-action-button table-action-red"
                title="Hapus Permanen"
                aria-label="Hapus permanen"
                onClick={() => onPermanentDelete?.(childRecord)}
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              {onOpenPmt &&
              ["problem_wasting", "problem_underweight", "problem_tidak_naik"].includes(
                view,
              ) ? (
                <button
                  type="button"
                  onClick={() => onOpenPmt(childRecord, view)}
                  className="apple-button table-action-button table-action-pmt"
                  title="Beri PMT"
                  aria-label="Beri PMT"
                >
                  <Gift className="h-4 w-4" />
                </button>
              ) : null}
              {onEditChild ? (
                <button
                  type="button"
                  onClick={() => onEditChild(childRecord)}
                  className="apple-button table-action-button table-action-blue"
                  title="Edit Identitas"
                  aria-label="Edit Identitas"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              ) : null}
              {onOpenMeasurement ? (
                <button
                  type="button"
                  onClick={() => onOpenMeasurement(childRecord)}
                  className="apple-button table-action-button table-action-cyan"
                  title="Pengukuran Balita"
                  aria-label="Pengukuran Balita"
                >
                  <Ruler className="h-4 w-4" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onDelete(childRecord)}
                className="apple-button table-action-button table-action-red"
                title="Hapus Balita"
                aria-label="Hapus Balita"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
});

export type ReactChildrenTablePageProps = {
  user: DashboardUser;
  scope: Scope;
  onOpenMeasurement?: (child: Record<string, unknown>) => void;
  /**
   * When the table is opened from a dedicated sidebar item, start on that
   * server-side view instead of making the user select it a second time.
   */
  initialView?: ChildView;
  onOpenAddChild?: () => void;
  onEditChild?: (child: Record<string, unknown>) => void;
  onOpenPmt?: (child: Record<string, unknown>, category: string) => void;
  onRestoreChild?: (child: Record<string, unknown>) => void;
  onPermanentDelete?: (child: Record<string, unknown>) => void;
  onExportTable?: () => void;
  onExportMeasurement?: () => void;
  onExportSigizi?: () => void;
  onImportIdentitas?: () => void;
};

/**
 * Server-paged React child table. Reads use the Rust/Redis/PostgreSQL result
 * path; mutations are handled by the strict React add/measurement workflows.
 */
export default function ReactChildrenTablePage({
  user,
  scope,
  onOpenMeasurement,
  initialView = "data",
  onOpenAddChild,
  onEditChild,
  onOpenPmt,
  onRestoreChild,
  onPermanentDelete,
  onExportTable,
  onExportMeasurement,
  onExportSigizi,
  onImportIdentitas,
}: ReactChildrenTablePageProps) {
  const [page, setPage] = useState(1);
  const [view, setView] = useState<ChildView>(initialView);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const debouncedSearch = useDebouncedValue(search);
  const request = useMemo(
    () => toRequest(scope, user, page, debouncedSearch, sort, view),
    [debouncedSearch, page, sort, scope, user, view],
  );
  const queryClient = useQueryClient();
  const pageQuery = useQuery({
    queryKey: ["children-page", request],
    queryFn: () => getChildrenPage(request),
    // Do not render a previous page while a new filter/page is loading.  The
    // server response for this exact request is authoritative; showing old
    // rows would make totals appear inconsistent with the dashboard.
    staleTime: 0,
    // Python writes the authoritative projection asynchronously.  Keep
    // refreshing only while this page contains an actually pending row so a
    // recovered worker replaces skeleton badges automatically, without
    // polling every page forever or generating extra mobile traffic.
    refetchInterval: (query) =>
      pageHasPendingAnalysis(query.state.data as ChildrenPageResponse | undefined)
        ? 2_000
        : false,
    refetchOnWindowFocus: true,
  });
  const [childToDelete, setChildToDelete] = useState<Record<
    string,
    any
  > | null>(null);

  useEffect(() => {
    setPage(1);
  }, [
    scope.ageGroup,
    scope.month,
    scope.year,
    scope.desa,
    scope.posyandu,
    view,
  ]);

  useEffect(() => {
    setView(initialView);
    setPage(1);
  }, [initialView]);

  const state: PageState<ChildrenPageResponse> = pageQuery.data
    ? { status: "success", data: pageQuery.data }
    : pageQuery.error
      ? {
          status: "error",
          message: errorMessage(
            pageQuery.error,
            "Data balita belum dapat dimuat.",
          ),
        }
      : { status: "loading" };
  const response = state.status === "success" ? state.data : null;
  const items = response?.items || [];
  const measurements = useMemo(
    () => (response ? measurementMap(response) : EMPTY_MEASUREMENT_MAP),
    [response],
  );
  const total = response?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isReadOnly = user.accessMode === "read";
  const showDesa = isFullAccessRole(user.role);
  const showPosyandu = user.role === ROLES.BIDAN || isFullAccessRole(user.role);
  const tableColumnCount =
    13 +
    (view === "recycle" ? 1 : 0) +
    (showDesa ? 1 : 0) +
    (showPosyandu ? 1 : 0);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  };
  const clearSearch = () => {
    setSearchDraft("");
    setSearch("");
    setPage(1);
  };
  const handleDeleteRequest = useCallback(
    (child: Record<string, unknown>) => setChildToDelete(child),
    [],
  );

  const confirmDelete = async (id: string, payload: Record<string, string>) => {
    await updateDoc(
      doc(db, "artifacts", appId, "public", "data", "children", id),
      {
        ...payload,
        deletedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { deferSync: true },
    );
    await syncPendingMutations();
    setChildToDelete(null);
    await queryClient.invalidateQueries({ queryKey: ["children-page"] });
  };

  const title = pageHeading(view, scope.month, scope.year);
  return (
    <div className="apple-page space-y-6" data-react-children-page="true">
      {childToDelete ? (
        <DeleteChildModal
          child={childToDelete}
          onClose={() => setChildToDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="apple-page-title">{title}</h2>
          <p className="text-sm text-slate-500">
            {view === "mpasi"
              ? `Menampilkan ${total} balita usia 6-23 bulan untuk pemantauan MPASI.`
              : `Menampilkan ${total} data balita · ${MONTHS[scope.month - 1]} ${scope.year}`}
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:flex-row xl:w-auto">
          <form className="flex w-full sm:w-72" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="react-child-search">
              Cari Nama / NIK
            </label>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="react-child-search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Cari Nama / NIK..."
                className="min-h-11 w-full rounded-l-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm outline-none shadow-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
              {search ? (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400"
                  aria-label="Hapus pencarian"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <AppButton
              type="submit"
              variant="primary"
              className="rounded-l-none px-3"
              title="Cari data balita"
            >
              <Search className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline">Cari</span>
            </AppButton>
          </form>
          <div className="relative w-full sm:w-48">
            <label className="sr-only" htmlFor="react-child-sort">
              Urutkan data
            </label>
            <select
              id="react-child-sort"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
              className="min-h-11 w-full appearance-none rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm outline-none shadow-sm focus:border-emerald-500"
            >
              <option value="recent">Terbaru Ditambahkan</option>
              <option value="oldest_input">Awal Diinput</option>
              <option value="name_asc">Nama (A-Z)</option>
              <option value="name_desc">Nama (Z-A)</option>
              <option value="age_oldest">Umur Tertua</option>
              <option value="age_youngest">Umur Termuda</option>
            </select>
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
          </div>
          <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1 sm:pb-0">
            {view !== "recycle" ? (
              <AppButton
                type="button"
                variant="primary"
                className="ios-toolbar-button icon-only-mobile whitespace-nowrap bg-teal-600 hover:bg-teal-700"
                title="Export tabel balita"
                onClick={onExportTable}
              >
                <span className="ios-button-symbol" aria-hidden="true">
                  <FileText className="h-4 w-4" />
                </span>
                <span className="hidden sm:inline">Export Tabel</span>
              </AppButton>
            ) : null}
            {view !== "recycle" && view !== "recent" ? (
              <AppButton
                type="button"
                variant="primary"
                className="ios-toolbar-button icon-only-mobile whitespace-nowrap bg-emerald-600 hover:bg-emerald-700"
                title="Export pengukuran"
                onClick={onExportMeasurement}
              >
                <span className="ios-button-symbol" aria-hidden="true">
                  <FileDown className="h-4 w-4" />
                </span>
                <span className="hidden sm:inline">Export Pengukuran</span>
              </AppButton>
            ) : null}
            {view === "recent" ? (
              <>
                {!isReadOnly ? (
                  <AppButton
                    type="button"
                    variant="primary"
                    className="ios-toolbar-button icon-only-mobile whitespace-nowrap bg-indigo-600 hover:bg-indigo-700"
                    title="Import identitas"
                    onClick={onImportIdentitas}
                  >
                    <span className="ios-button-symbol" aria-hidden="true">
                      <FileUp className="h-4 w-4" />
                    </span>
                    <span className="hidden sm:inline">Import</span>
                  </AppButton>
                ) : null}
                <AppButton
                  type="button"
                  variant="primary"
                  className="ios-toolbar-button icon-only-mobile whitespace-nowrap bg-blue-600 hover:bg-blue-700"
                  title="Export identitas Sigizi"
                  onClick={onExportSigizi}
                >
                  <span className="ios-button-symbol" aria-hidden="true">
                    <FileDown className="h-4 w-4" />
                  </span>
                  <span className="hidden sm:inline">Export Sigizi</span>
                </AppButton>
              </>
            ) : null}
            {onOpenAddChild &&
            view !== "recycle" &&
            !isReadOnly ? (
              <AppButton
                type="button"
                onClick={onOpenAddChild}
                variant="primary"
                className="ios-toolbar-button icon-only-mobile whitespace-nowrap"
                title="Tambah balita"
              >
                <span className="ios-button-symbol" aria-hidden="true">
                  <Plus className="h-4 w-4" />
                </span>
                <span className="hidden sm:inline">Tambah</span>
              </AppButton>
            ) : null}
          </div>
        </div>
      </div>
      {state.status === "error" ? (
        <div
          role="alert"
          className="ios-inline-notification ios-inline-notification-error"
        >
          Gagal memuat data balita: {state.message}
        </div>
      ) : null}
      <Card className="ios-table-card overflow-hidden">
        <DataTable ariaLabel="Daftar balita React">
          <table className="ios-data-table ios-children-table min-w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500 md:sticky md:left-0 md:z-20 md:bg-slate-50">
                  No
                </th>
                <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500 md:sticky md:left-[48px] md:z-20 md:bg-slate-50 md:shadow-lg">
                  Identitas
                </th>
                <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Ortu
                </th>
                {view === "recycle" ? (
                  <th className="border-r border-slate-200 bg-rose-50/60 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-rose-600">
                    Alasan Dihapus
                  </th>
                ) : null}
                {showDesa ? (
                  <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Desa
                  </th>
                ) : null}
                {showPosyandu ? (
                  <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Posyandu
                  </th>
                ) : null}
                <th className="border-r border-slate-200 bg-blue-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  BB
                  <br />
                  (kg)
                </th>
                <th className="border-r border-slate-200 bg-blue-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  PB/TB
                  <br />
                  (cm)
                </th>
                <th className="border-r border-slate-200 bg-blue-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  LILA
                  <br />
                  (cm)
                </th>
                <th className="border-r border-slate-200 bg-blue-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  LK
                  <br />
                  (cm)
                </th>
                <th className="border-r border-slate-200 bg-indigo-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Status
                  <br />
                  Kenaikan
                </th>
                <th className="border-r border-slate-200 bg-emerald-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Status
                  <br />
                  BB/U
                </th>
                <th className="border-r border-slate-200 bg-emerald-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Status
                  <br />
                  PB/TB-U
                </th>
                <th className="border-r border-slate-200 bg-emerald-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Status
                  <br />
                  BB/PB atau BB/TB
                </th>
                <th className="border-r border-slate-200 bg-emerald-50/50 px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Status
                  <br />
                  IMT/U
                </th>
                <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.status === "loading" ? (
                <TableSkeleton columns={tableColumnCount} />
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={tableColumnCount}
                    className="px-6 py-12 text-center text-slate-400"
                  >
                    Tidak ada data ditemukan
                  </td>
                </tr>
              ) : (
                items.map((item, index) => {
                  const id = String(item.id || value(dataOf(item), "id"));
                  return (
                    <ChildTableRow
                      key={id || index}
                      item={item}
                      index={index}
                      page={page}
                      view={view}
                      asOf={request.asOf}
                      measurement={measurements.get(id) || EMPTY_MEASUREMENT}
                      showDesa={showDesa}
                      showPosyandu={showPosyandu}
                      isReadOnly={isReadOnly}
                      onOpenMeasurement={onOpenMeasurement}
                      onEditChild={onEditChild}
                      onOpenPmt={onOpenPmt}
                      onRestoreChild={onRestoreChild}
                      onPermanentDelete={onPermanentDelete}
                      onDelete={handleDeleteRequest}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </DataTable>
        <div className="ios-table-footer flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="text-xs font-medium text-slate-500">
            Menampilkan {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1} -{" "}
            {Math.min(page * PAGE_SIZE, total)} dari {total} data
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
