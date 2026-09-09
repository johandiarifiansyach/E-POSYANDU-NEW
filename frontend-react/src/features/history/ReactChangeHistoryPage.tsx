import { useEffect, useMemo, useState } from "react";
import { getChangeHistory } from "../../api/dashboardApi";
import { DEFAULT_AGE_GROUP, type AgeGroup } from "../../config/ageFilters";
import { isFullAccessRole, MONTHS } from "../../config/dashboard";
import { formatIndoDateTime } from "../../shared/formatters";
import { errorMessage, type PageState } from "../../shared/pageState";
import type { DashboardUser } from "../../types";
import { Card, Pagination, SkeletonBlock } from "../../components/base";
import { History, RotateCcw } from "../../ui/icons";

type Scope = {
  month: number;
  year: number;
  ageGroup: AgeGroup;
  desa?: string | null;
  posyandu?: string | null;
};
type HistoryDocument = { id: string; data: Record<string, unknown> };
type HistoryResponse = { items: HistoryDocument[]; total: number };

const PAGE_SIZE = 10;
const FIELD_LABELS: Record<string, string> = {
  nama: "Nama lengkap",
  nik: "NIK balita",
  tglLahir: "Tanggal lahir",
  jk: "Jenis kelamin",
  namaOrtu: "Nama orang tua",
  desa: "Desa / kelurahan",
  posyandu: "Posyandu",
};

function endOfMonth(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
}

function dataOf(item: HistoryDocument) {
  return item.data && typeof item.data === "object" ? item.data : {};
}

function text(value: unknown, empty = "Kosong") {
  if (value === null || value === undefined || value === "") return empty;
  if (typeof value === "boolean") return value ? "Ya" : "Tidak";
  if (Array.isArray(value)) return value.length ? value.join(", ") : empty;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) || empty;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function timestamp(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "seconds" in value &&
    typeof value.seconds === "number"
  )
    return new Date(value.seconds * 1000);
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function HistorySkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <Card className="p-4" key={index}>
          <SkeletonBlock className="h-5 w-48" />
          <SkeletonBlock className="mt-2 h-3 w-72" />
          <SkeletonBlock className="mt-4 h-14 w-full" />
        </Card>
      ))}
    </div>
  );
}

export type ReactChangeHistoryPageProps = { user: DashboardUser; scope: Scope };

/** Read-only React view of the audited identity change log. */
export default function ReactChangeHistoryPage({
  user,
  scope,
}: ReactChangeHistoryPageProps) {
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<PageState<HistoryResponse>>({
    status: "loading",
  });
  const village = isFullAccessRole(user.role)
    ? scope.desa || undefined
    : user.desa || undefined;
  const posyandu =
    user.role === "Kader Posyandu"
      ? user.posyandu || undefined
      : scope.posyandu || undefined;

  useEffect(
    () => setPage(1),
    [
      scope.ageGroup,
      scope.month,
      scope.year,
      scope.desa,
      scope.posyandu,
      search,
    ],
  );
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void getChangeHistory(
      page,
      PAGE_SIZE,
      scope.ageGroup || DEFAULT_AGE_GROUP,
      endOfMonth(scope.year, scope.month),
      village,
      posyandu,
      search || undefined,
    )
      .then((response) => {
        if (active) setState({ status: "success", data: response });
      })
      .catch((cause) => {
        if (active)
          setState({
            status: "error",
            message: errorMessage(
              cause,
              "Riwayat perubahan belum dapat dimuat.",
            ),
          });
      });
    return () => {
      active = false;
    };
  }, [
    page,
    posyandu,
    scope.ageGroup,
    scope.month,
    scope.year,
    search,
    village,
  ]);

  const response = state.status === "success" ? state.data : null;
  const items = useMemo(
    () =>
      [...(response?.items || [])].sort((left, right) => {
        const rightTime = timestamp(dataOf(right).timestamp)?.getTime() || 0;
        const leftTime = timestamp(dataOf(left).timestamp)?.getTime() || 0;
        return rightTime - leftTime;
      }),
    [response],
  );
  const total = response?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  };

  return (
    <div className="apple-page space-y-6" data-react-change-history-page="true">
      <div>
        <h2 className="apple-page-title">Riwayat Perubahan Identitas</h2>
        <p className="text-sm text-slate-500">
          Mencatat semua perubahan data identitas balita yang dilakukan oleh
          petugas.
        </p>
      </div>
      {state.status === "error" ? (
        <div
          className="app-card rounded-2xl border border-rose-200 p-8 text-center"
          role="alert"
        >
          <p className="font-semibold text-rose-600">
            Riwayat perubahan tidak dapat dimuat.
          </p>
          <p className="mt-1 text-sm text-slate-500">{state.message}</p>
          <button
            type="button"
            onClick={() => {
              setPage(1);
              setSearch(searchDraft.trim());
            }}
            className="ios-action-button ios-action-button-blue mt-4 inline-flex items-center gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            <span>Coba Lagi</span>
          </button>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <HistorySkeleton />
      ) : state.status !== "error" && items.length === 0 ? (
        <div className="app-card rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
          Belum ada riwayat perubahan data.
        </div>
      ) : state.status !== "error" ? (
        <div className="space-y-3">
          {items.map((item) => {
            const change = dataOf(item);
            const changes = Array.isArray(change.changes)
              ? (change.changes as Array<Record<string, unknown>>)
              : [];
            const changedAt = timestamp(change.timestamp);
            return (
              <Card className="apple-list-card p-4" key={item.id}>
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-slate-800">
                      {text(change.childName, "Balita")}
                    </h3>
                    <p className="text-xs text-slate-500">
                      {changedAt ? formatIndoDateTime(changedAt) : "-"} - Oleh:{" "}
                      {text(change.changedBy, "Petugas")}
                    </p>
                  </div>
                  <History className="h-5 w-5 text-amber-500" />
                </div>
                <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-xs">
                  {changes.length === 0 ? (
                    <p className="change-history-empty-detail text-slate-500">
                      Pembaruan identitas tercatat, tetapi rincian perubahan
                      tidak tersedia pada catatan lama.
                    </p>
                  ) : (
                    changes.map((entry, index) => {
                      const field = String(entry.field || "Data identitas");
                      return (
                        <div
                          className="flex flex-col gap-1 border-b border-slate-200 pb-1 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:gap-2"
                          key={`${field}-${index}`}
                        >
                          <span className="w-36 font-semibold text-slate-600">
                            {FIELD_LABELS[field] || field}
                          </span>
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="break-words rounded bg-rose-50 px-1 text-rose-500 line-through">
                              {text(entry.oldValue)}
                            </span>
                            <span className="text-slate-400">-&gt;</span>
                            <span className="break-words rounded bg-emerald-50 px-1 font-bold text-emerald-600">
                              {text(entry.newValue)}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}
      {state.status !== "loading" && state.status !== "error" && total > 0 ? (
        <div className="ios-table-footer app-card flex flex-col items-center justify-between gap-4 p-4 sm:flex-row">
          <span className="text-xs font-medium text-slate-500">
            Menampilkan {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1} -{" "}
            {Math.min(page * PAGE_SIZE, total)} dari {total} riwayat
          </span>
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            disablePrevious={page <= 1}
            disableNext={page >= totalPages}
            onPrevious={() => setPage((current) => Math.max(1, current - 1))}
            onNext={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
          />
        </div>
      ) : null}
    </div>
  );
}
