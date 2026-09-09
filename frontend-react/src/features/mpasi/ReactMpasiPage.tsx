import { useEffect, useMemo, useState } from "react";
import {
  getChildrenPage,
  peekCachedChildrenPage,
  type ChildrenPageRequest,
  type ChildrenPageResponse,
} from "../../api/childrenApi";
import { type AgeGroup } from "../../config/ageFilters";
import { isFullAccessRole, MONTHS, ROLES } from "../../config/dashboard";
import { formatIndoDate } from "../../shared/formatters";
import { errorMessage, type PageState } from "../../shared/pageState";
import type { DashboardUser } from "../../types";
import {
  AppButton,
  Badge,
  Card,
  DataTable,
  Pagination,
  SkeletonBlock,
} from "../../components/base";
import MpasiModal from "../breastfeeding/MpasiModal";
import {
  ChevronDown,
  FileDown,
  Filter,
  Pencil,
  Plus,
  Ruler,
  Search,
  Trash2,
  Utensils,
  X,
} from "../../ui/icons";

type Scope = {
  month: number;
  year: number;
  ageGroup: AgeGroup;
  desa?: string | null;
  posyandu?: string | null;
};
const PAGE_SIZE = 10;

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
function dataOf(item: { data?: Record<string, unknown> }) {
  return item.data || {};
}
function hasValue(value: unknown) {
  return Array.isArray(value)
    ? value.length > 0
    : value !== null &&
        value !== undefined &&
        value !== "" &&
        value !== "Tidak";
}
function mpasiMap(response: ChildrenPageResponse) {
  const result = new Map<string, Record<string, unknown>>();
  for (const item of response.mpasiLogs || []) {
    const data = dataOf(item);
    const childId = String(data.childId || data.child_id || "");
    if (!childId) continue;
    const previous = result.get(childId);
    const currentDate = String(data.tglMonitoring || data.date || "");
    const previousDate = String(previous?.tglMonitoring || previous?.date || "");
    if (!previous || currentDate >= previousDate) result.set(childId, data);
  }
  return result;
}
function requestOf(
  scope: Scope,
  user: DashboardUser,
  page: number,
  search: string,
): ChildrenPageRequest {
  const village = isFullAccessRole(user.role)
    ? scope.desa || undefined
    : user.desa || undefined;
  const posyandu =
    user.role === "Kader Posyandu"
      ? user.posyandu || undefined
      : scope.posyandu || undefined;
  return {
    asOf: dateEnd(scope.year, scope.month),
    ageGroup: "6-23",
    measurementStart: dateStart(scope.year, scope.month),
    measurementEnd: dateEnd(scope.year, scope.month),
    page,
    size: PAGE_SIZE,
    sort: "recent",
    view: "mpasi",
    search: search || undefined,
    village,
    posyandu,
  };
}

function TableSkeleton({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 6 }, (_, row) => (
        <tr key={row} aria-hidden="true">
          {Array.from({ length: columns }, (_, column) => (
            <td className="px-3 py-4" key={column}>
              <SkeletonBlock
                className={column === 1 ? "h-4 w-40" : "h-4 w-14"}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export type ReactMpasiPageProps = {
  user: DashboardUser;
  scope: Scope;
  onOpenAddChild?: () => void;
  onOpenMpasi?: (child: Record<string, unknown>) => void;
  onExportMpasi?: () => void;
  onEditChild?: (child: Record<string, unknown>) => void;
  onOpenMeasurement?: (child: Record<string, unknown>) => void;
  onDeleteChild?: (child: Record<string, unknown>) => void;
};

/** Read-only MPASI table. Age is fixed to the programme cohort 6–23 months. */
export default function ReactMpasiPage({
  user,
  scope,
  onOpenAddChild,
  onOpenMpasi,
  onExportMpasi,
  onEditChild,
  onOpenMeasurement,
  onDeleteChild,
}: ReactMpasiPageProps) {
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [selectedChild, setSelectedChild] = useState<Record<
    string,
    any
  > | null>(null);
  const request = useMemo(
    () => ({ ...requestOf(scope, user, page, search), sort }),
    [page, scope, search, sort, user],
  );
  const [state, setState] = useState<PageState<ChildrenPageResponse>>({
    status: "loading",
  });
  useEffect(
    () => setPage(1),
    [scope.month, scope.year, scope.desa, scope.posyandu, search],
  );
  useEffect(() => {
    let active = true;
    const cached = peekCachedChildrenPage(request);
    setState(
      cached ? { status: "success", data: cached } : { status: "loading" },
    );
    void getChildrenPage(request)
      .then((response) => {
        if (active) setState({ status: "success", data: response });
      })
      .catch((cause) => {
        if (active)
          setState({
            status: "error",
            message: errorMessage(cause, "Data MPASI belum dapat dimuat."),
          });
      });
    return () => {
      active = false;
    };
  }, [request]);
  const response = state.status === "success" ? state.data : null;
  const items = response?.items || [];
  const logs = response
    ? mpasiMap(response)
    : new Map<string, Record<string, unknown>>();
  const total = response?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tableColumnCount = 14 +
    (isFullAccessRole(user.role) ? 1 : 0) +
    (user.role === ROLES.BIDAN || isFullAccessRole(user.role) ? 1 : 0);
  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  };

  return (
    <div className="apple-page space-y-6" data-react-mpasi-page="true">
      {selectedChild ? (
        <MpasiModal
          child={selectedChild}
          onClose={() => setSelectedChild(null)}
          onSaved={() => {
            setPage(1);
          }}
        />
      ) : null}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="apple-page-title">Balita MPASI (6-23 Bulan)</h2>
          <p className="text-sm text-slate-500">
            Menampilkan {total} balita usia 6-23 bulan untuk pemantauan MPASI.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:flex-row xl:w-auto">
          <form className="flex w-full sm:w-72" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="react-mpasi-search">
              Cari Nama / NIK
            </label>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="react-mpasi-search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Cari Nama / NIK..."
                className="min-h-11 w-full rounded-l-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm outline-none shadow-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchDraft("");
                    setSearch("");
                    setPage(1);
                  }}
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
              title="Cari data MPASI"
            >
              <Search className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline">Cari</span>
            </AppButton>
          </form>
          <div className="relative w-full sm:w-48">
            <label className="sr-only" htmlFor="react-mpasi-sort">
              Urutkan data
            </label>
            <select
              id="react-mpasi-sort"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
              className="min-h-11 w-full appearance-none rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm outline-none shadow-sm"
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
          <div className="flex gap-2 overflow-x-auto pb-1 sm:pb-0">
            <AppButton
              type="button"
              variant="primary"
              onClick={onExportMpasi}
              className="ios-toolbar-button icon-only-mobile whitespace-nowrap bg-orange-600 hover:bg-orange-700"
              title="Export MPASI ke XLS"
            >
              <span className="ios-button-symbol" aria-hidden="true">
                <FileDown className="h-4 w-4" />
              </span>
              <span className="hidden sm:inline">Export MPASI</span>
            </AppButton>
            {onOpenAddChild && user.accessMode !== "read" ? (
              <AppButton
                type="button"
                variant="primary"
                onClick={onOpenAddChild}
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
          Gagal memuat data MPASI: {state.message}
        </div>
      ) : null}
      <Card className="ios-table-card overflow-hidden">
        <DataTable ariaLabel="Daftar MPASI React">
          <table className="ios-data-table ios-children-table min-w-full">
            <thead className="bg-slate-50 text-left font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">No</th>
                <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">Identitas</th>
                <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">Ortu</th>
                {isFullAccessRole(user.role) ? <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">Desa</th> : null}
                {user.role === ROLES.BIDAN || isFullAccessRole(user.role) ? <th className="border-r border-slate-200 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">Posyandu</th> : null}
                {["Tgl Monitor", "ASI", "Mkn Pokok", "Kacang", "Susu", "Daging", "Telur", "Vit A", "Sayur Lain", "Intervensi"].map((heading) => (
                  <th className="border-r border-slate-200 bg-orange-50/50 px-2 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500" key={heading}>{heading}</th>
                ))}
                <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.status === "loading" ? (
                <TableSkeleton columns={tableColumnCount} />
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={14 + (isFullAccessRole(user.role) ? 1 : 0) + (user.role === ROLES.BIDAN || isFullAccessRole(user.role) ? 1 : 0)}
                    className="px-6 py-12 text-center text-slate-400"
                  >
                    Tidak ada data MPASI pada kelompok usia 6-23 bulan.
                  </td>
                </tr>
              ) : (
                items.map((item, index) => {
                  const child = dataOf(item);
                  const id = String(item.id || child.id || "");
                  const childRecord = { ...child, id };
                  // A child without a monitoring record must be represented by
                  // dashes in every MPASI column.  Do not turn an absent log
                  // into an empty object: an empty object makes every food
                  // field look like an explicit "Tidak" response.
                  const log = logs.get(id);
                  return (
                    <tr className="ios-data-row text-xs" key={id || index}>
                      <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-center text-slate-500 md:sticky md:left-0 md:z-10 md:bg-white">
                        {(page - 1) * PAGE_SIZE + index + 1}
                      </td>
                      <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 md:sticky md:left-[48px] md:z-10 md:bg-white md:shadow-lg">
                        <p className="font-bold text-slate-900">
                          {display(child.nama || child.name)}
                        </p>
                        <p
                          className={`font-mono text-[10px] ${
                            child.hasNIK === true
                              ? "text-slate-500"
                              : "font-bold text-red-600"
                          }`}
                        >
                          {display(child.nik || child.national_id)}
                        </p>
                        <div className="mt-1 flex items-center gap-1">
                          <Badge color={child.jk === "L" || child.gender === "L" ? "blue" : "pink"}>{child.jk === "L" || child.gender === "L" ? "L" : "P"}</Badge>
                          <span className="text-[10px] text-slate-400">{formatIndoDate(String(child.tglLahir || child.birthDate))} ({display(child.ageInMonths || child.usiaBulan)} Bln)</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-slate-700">{display(child.namaOrtu || child.parentName)}</td>
                      {isFullAccessRole(user.role) ? <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-slate-600">{display(child.desa || child.village)}</td> : null}
                      {user.role === ROLES.BIDAN || isFullAccessRole(user.role) ? <td className="whitespace-nowrap border-r border-slate-100 px-4 py-3 text-slate-600">{display(child.posyandu)}</td> : null}
                      <td className="border-r border-slate-100 px-2 py-3 text-center text-[10px]">{log?.tglMonitoring ? formatIndoDate(String(log.tglMonitoring)) : "-"}</td>
                      <td className="border-r border-slate-100 px-2 py-3 text-center text-[10px]">{log ? display(log.asi) : "-"}</td>
                      {[
                        ["makananPokok", "Makanan pokok"],
                        ["kacang", "Kacang"],
                        ["susu", "Susu"],
                        ["daging", "Daging"],
                        ["telur", "Telur"],
                        ["sayurVitA", "Vitamin A"],
                        ["sayurLain", "Sayur lain"],
                      ].map(([key, label]) => (
                        <td className="border-r border-slate-100 px-2 py-3 text-center text-[10px]" key={key}>
                          {log ? (hasValue(log[key]) ? "Ya" : <span title={label} className="text-slate-400">Tidak</span>) : <span title={label} className="text-slate-400">-</span>}
                        </td>
                      ))}
                      <td className="border-r border-slate-100 px-2 py-3 text-center text-[10px]">{log ? display(log.intervensiGizi) : "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-center">
                        <div className="flex justify-center gap-1">
                          {onOpenMpasi ? (
                            <button
                              type="button"
                              className="apple-button table-action-button table-action-orange"
                              title="Input MPASI"
                              aria-label="Input MPASI"
                              onClick={() => onOpenMpasi(childRecord)}
                            >
                              <Utensils className="h-4 w-4" />
                            </button>
                          ) : null}
                          {user.accessMode === "read" ? <span className="text-xs font-semibold text-slate-400">Hanya baca</span> : (
                            <>
                              {!onOpenMpasi ? <AppButton variant="actionOrange" className="table-action-button table-action-orange" onClick={() => setSelectedChild(childRecord)} title="Input MPASI"><Utensils className="h-4 w-4" /></AppButton> : null}
                              {onEditChild ? <AppButton variant="actionBlue" className="table-action-button table-action-blue" onClick={() => onEditChild(childRecord)} title="Edit Identitas"><Pencil className="h-4 w-4" /></AppButton> : null}
                              {onOpenMeasurement ? <AppButton variant="actionGreen" className="table-action-button table-action-cyan" onClick={() => onOpenMeasurement(childRecord)} title="Pengukuran Balita"><Ruler className="h-4 w-4" /></AppButton> : null}
                              {onDeleteChild ? <AppButton variant="actionRed" className="table-action-button table-action-red" onClick={() => onDeleteChild(childRecord)} title="Hapus Balita"><Trash2 className="h-4 w-4" /></AppButton> : null}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
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
      {selectedChild ? (
        <MpasiModal
          child={selectedChild}
          onClose={() => setSelectedChild(null)}
          onSaved={() => setSelectedChild(null)}
        />
      ) : null}
    </div>
  );
}
