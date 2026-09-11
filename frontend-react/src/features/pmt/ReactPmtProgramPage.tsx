import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Calendar,
  FileDown,
  Gift,
  Loader2,
  Minus,
  Trash2,
  TrendingDown,
} from "../../ui/icons";
import { appId, db } from "../../app/session";
import { collection, onSnapshot, orderBy, query } from "../../api/syncApi";
import {
  AppButton,
  Card,
  DataTable,
  KenaikanBadge,
  StatusBadge,
  SkeletonBlock,
  VirtualizedTableBody,
} from "../../components/base";
import { formatIndoDate } from "../../shared/formatters";
import type { DashboardUser } from "../../types";
import { DEFAULT_AGE_GROUP, matchesAgeGroup } from "../../config/ageFilters";
import { getChildDetail } from "../../api/childrenApi";
import PmtMonitoringModal from "./PmtMonitoringModal";
import {
  CATEGORY_OPTIONS,
  baselineForProgram,
  categoryLabel,
  categoryMetric,
  getMonitoringForWeek,
  maxWeeksForCategory,
  monitoringStatus,
  numericValue,
} from "./pmtRules";

type Program = Record<string, any>;
type Child = Record<string, any>;

export type ReactPmtProgramPageProps = {
  user?: DashboardUser;
  childrenData?: Child[];
  pmtPrograms?: Program[];
  ageGroup?: string;
  currentFilterDate?: Date;
  onExportPmt?: () => void;
  onDeleteProgram?: (program: Program) => void;
  onOpenMonitoring?: (program: Program, child: Child) => Promise<void> | void;
  pageState?: {
    status: "idle" | "loading" | "success" | "error";
    data?: Program[];
    message?: string;
  };
};

function categoryIcon(category: string) {
  if (category === "Wasting") return AlertCircle;
  if (category === "Underweight") return TrendingDown;
  return Minus;
}

function statusResult(category: string, status: string) {
  if (!status || status === "-")
    return <span className="text-slate-400">-</span>;
  return category === "TidakNaik" ? (
    <KenaikanBadge status={status} />
  ) : (
    <StatusBadge status={status} />
  );
}

const MeasurementCell = memo(function MeasurementCell({
  category,
  status,
  date,
  weight,
  height,
}: {
  category: string;
  status: string;
  date?: unknown;
  weight?: unknown;
  height?: unknown;
}) {
  const parsedWeight = numericValue(weight);
  const parsedHeight = numericValue(height);
  if (parsedWeight === null && parsedHeight === null)
    return <span className="text-slate-400">-</span>;
  return (
    <div className="pmt-measurement-cell">
      {date ? (
        <span className="pmt-measurement-date">
          {formatIndoDate(String(date))}
        </span>
      ) : null}
      <span className="pmt-measurement-value">BB {parsedWeight ?? "-"} kg</span>
      <span className="pmt-measurement-value">TB {parsedHeight ?? "-"} cm</span>
      <div className="mt-1">{statusResult(category, status)}</div>
    </div>
  );
});

const PmtTableHeader = memo(function PmtTableHeader({ weeks }: { weeks: number[] }) {
  return (
    <thead>
      <tr>
        <th className="pmt-col-number">No.</th>
        <th className="pmt-col-child">Balita</th>
        <th>Kategori / Indikator</th>
        <th>Sumber Anggaran</th>
        <th>Mitra</th>
        <th>Tanggal Awal</th>
        <th className="pmt-week-column">Pengukuran Awal</th>
        {weeks.map((week) => (
          <th key={week} className="pmt-week-column">
            Minggu {week}
          </th>
        ))}
        <th className="pmt-col-action">Aksi</th>
      </tr>
    </thead>
  );
});

type PmtTableRowProps = {
  program: Program;
  child?: Child;
  index: number;
  weeks: number[];
  openingProgramId: string | null;
  onOpenMonitoring: (program: Program, child: Child | undefined) => void;
  onDeleteProgram?: (program: Program) => void;
};

/** Isolated PMT row.  PMT monitoring state changes should only update the
 * selected row/action, not rebuild every programme row in the table. */
const PmtTableRow = memo(function PmtTableRow({
  program,
  child,
  index,
  weeks,
  openingProgramId,
  onOpenMonitoring,
  onDeleteProgram,
}: PmtTableRowProps) {
  const programKey = String(program.id || program.childId || index);
  const baseline = baselineForProgram(program, child);
  const programWeeks = maxWeeksForCategory(program.category);
  const category = String(program.category || "TidakNaik");
  const Icon = categoryIcon(category);
  const partner = program.mitraLain || program.mitra || "-";
  return (
    <tr className="ios-data-row">
      <td className="pmt-col-number">{index + 1}</td>
      <td className="pmt-col-child">
        <strong>{program.childName || child?.nama || "-"}</strong>
        <span>
          {child
            ? `${child.desa || ""} / ${child.posyandu || ""}`
            : "Data wilayah tersedia saat balita dimuat"}
        </span>
      </td>
      <td>
        <div className={`pmt-category-label pmt-category-${category.toLowerCase()}`}>
          <Icon className="h-4 w-4" />
          <span>{categoryLabel(category)}</span>
        </div>
        <span className="pmt-metric-label">Status {categoryMetric(category)}</span>
      </td>
      <td>{program.sumberAnggaran || "-"}</td>
      <td>{partner}</td>
      <td className="whitespace-nowrap">{formatIndoDate(String(baseline.date || ""))}</td>
      <td className="pmt-week-column">
        <MeasurementCell
          category={category}
          status={monitoringStatus(program, child, null, 0, baseline)}
          date={baseline.date}
          weight={baseline.weight}
          height={baseline.height}
        />
      </td>
      {weeks.map((week) => {
        const monitoring = getMonitoringForWeek(program, week);
        return week > programWeeks ? (
          <td key={week} className="pmt-week-column pmt-week-disabled">Tidak berlaku</td>
        ) : (
          <td key={week} className="pmt-week-column">
            <MeasurementCell
              category={category}
              status={monitoringStatus(program, child, monitoring, week, baseline)}
              date={monitoring?.tgl}
              weight={monitoring?.bb}
              height={monitoring?.tb}
            />
          </td>
        );
      })}
      <td className="pmt-col-action">
        <div className="pmt-row-actions">
          <button
            type="button"
            className="table-action-button table-action-blue"
            disabled={!child || Boolean(openingProgramId)}
            aria-label={`Pantau PMT ${program.childName || "balita"}`}
            onClick={() => onOpenMonitoring(program, child)}
          >
            {openingProgramId === programKey ? (
              <Loader2 className="h-4 w-4" />
            ) : (
              <Calendar className="h-4 w-4" />
            )}
          </button>
          {onDeleteProgram ? (
            <button
              type="button"
              className="table-action-button table-action-red"
              disabled={!program.id}
              aria-label={`Hapus PMT ${program.childName || "balita"}`}
              onClick={() => onDeleteProgram(program)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
});

export default function ReactPmtProgramPage({
  user,
  childrenData = [],
  pmtPrograms = [],
  ageGroup = DEFAULT_AGE_GROUP,
  currentFilterDate = new Date(),
  onExportPmt,
  onDeleteProgram,
  onOpenMonitoring,
  pageState,
}: ReactPmtProgramPageProps) {
  const [categoryFilter, setCategoryFilter] = useState("Semua");
  const [openingProgramId, setOpeningProgramId] = useState<string | null>(null);
  const [selectedMonitoring, setSelectedMonitoring] = useState<{
    program: Program;
    child: Child;
  } | null>(null);
  const [remotePrograms, setRemotePrograms] = useState<Program[]>([]);
  const [remoteChildren, setRemoteChildren] = useState<Child[]>([]);
  const [remoteState, setRemoteState] = useState<
    "loading" | "success" | "error"
  >("loading");

  useEffect(() => {
    const programsQuery = query(
      collection(db, "artifacts", appId, "public", "data", "pmt_programs"),
      orderBy("createdAt", "desc"),
    );
    return onSnapshot(
      programsQuery,
      (snapshot) => {
        setRemotePrograms(
          snapshot.docs.map((document) => ({
            id: document.id,
            ...document.data(),
          })),
        );
        setRemoteState("success");
      },
      () => setRemoteState("error"),
    );
  }, [user?.role]);

  // The PMT endpoint returns programme rows separately from the child
  // registry.  Resolve only the linked children needed by those rows instead
  // of loading the complete 3k-child collection, while still retaining the
  // legacy behaviour where every programme is classified by the child's age
  // and location before it is displayed.
  useEffect(() => {
    let active = true;
    const known = new Set(
      childrenData.filter((child) => child.id).map((child) => String(child.id)),
    );
    const missingIds = Array.from(
      new Set(
        remotePrograms
          .map((program) => String(program.childId || program.child_id || ""))
          .filter((id) => id && !known.has(id)),
      ),
    ).slice(0, 200);
    if (!missingIds.length) {
      setRemoteChildren([]);
      return () => {
        active = false;
      };
    }
    void Promise.allSettled(missingIds.map((id) => getChildDetail(id))).then(
      (results) => {
        if (!active) return;
        setRemoteChildren(
          results.flatMap((result) =>
            result.status === "fulfilled"
              ? [{ id: result.value.id, ...result.value.data }]
              : [],
          ),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [childrenData, remotePrograms]);

  const displayedPrograms = useMemo(
    () =>
      pageState?.status === "success"
        ? pageState.data || []
        : pmtPrograms.length
          ? pmtPrograms
          : remotePrograms,
    [pageState?.data, pageState?.status, pmtPrograms, remotePrograms],
  );
  const childById = useMemo(
    () =>
      new Map(
        [...childrenData, ...remoteChildren]
          .filter((child) => child.id)
          .map((child) => [String(child.id), child]),
      ),
    [childrenData, remoteChildren],
  );
  const filteredPrograms = useMemo(() => {
    const ageFiltered = displayedPrograms.filter((program) => {
      const child =
        childById.get(String(program.childId)) ||
        (program.child && typeof program.child === "object"
          ? (program.child as Child)
          : undefined);
      const age = Number(
        program.ageInMonths ?? program.usiaBulan ?? child?.ageInMonths,
      );
      const cohortMatch =
        ageGroup === "6-23" && Number.isFinite(age) && age >= 6 && age <= 23;
      return (
        Boolean(child && matchesAgeGroup(child, ageGroup, currentFilterDate)) ||
        cohortMatch
      );
    });
    const categoryFiltered =
      categoryFilter === "Semua"
        ? ageFiltered
        : ageFiltered.filter((program) => program.category === categoryFilter);
    return [...categoryFiltered].sort((left, right) =>
      String(left.childName || "").localeCompare(
        String(right.childName || ""),
        "id",
      ),
    );
  }, [
    ageGroup,
    categoryFilter,
    childById,
    currentFilterDate,
    displayedPrograms,
  ]);
  const visibleWeekCount = useMemo(
    () =>
      categoryFilter === "Semua"
        ? Math.max(
            2,
            ...filteredPrograms.map((program) =>
              maxWeeksForCategory(program.category),
            ),
          )
        : maxWeeksForCategory(categoryFilter),
    [categoryFilter, filteredPrograms],
  );
  const weeks = useMemo(
    () => Array.from({ length: visibleWeekCount }, (_, index) => index + 1),
    [visibleWeekCount],
  );
  const pageLoading = pageState?.status === "loading";
  const pageError = pageState?.status === "error" ? pageState.message : null;
  const waiting =
    pageLoading ||
    (!pageState && remoteState === "loading" && !pmtPrograms.length);

  const openMonitoring = useCallback(
    async (program: Program, child: Child | undefined) => {
      const programKey = String(program.id || program.childId || "");
      if (!child || !program.childId || !programKey || openingProgramId) return;
      setOpeningProgramId(programKey);
      try {
        if (onOpenMonitoring) await onOpenMonitoring(program, child);
        else setSelectedMonitoring({ program, child });
      } finally {
        setOpeningProgramId(null);
      }
    },
    [onOpenMonitoring, openingProgramId],
  );
  const renderPmtRow = useCallback(
    (program: Program, index: number) => {
      const child =
        childById.get(String(program.childId)) ||
        (program.child && typeof program.child === "object"
          ? (program.child as Child)
          : undefined);
      return (
        <PmtTableRow
          key={String(program.id || program.childId || index)}
          program={program}
          child={child}
          index={index}
          weeks={weeks}
          openingProgramId={openingProgramId}
          onOpenMonitoring={openMonitoring}
          onDeleteProgram={onDeleteProgram}
        />
      );
    },
    [childById, onDeleteProgram, openMonitoring, openingProgramId, weeks],
  );

  return (
    <div
      className="pmt-page apple-page space-y-5"
      data-pmt-page="true"
      data-react-pmt-page="true"
    >
      {selectedMonitoring ? (
        <PmtMonitoringModal
          program={selectedMonitoring.program}
          child={selectedMonitoring.child}
          onClose={() => setSelectedMonitoring(null)}
          onSaved={() => setRemotePrograms((current) => [...current])}
        />
      ) : null}
      <div className="apple-page-header flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <span
            className="apple-symbol-tile apple-symbol-tile-green"
            aria-hidden="true"
          >
            <Gift className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-slate-800">
              Program Pemberian PMT
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {displayedPrograms.length} balita penerima PMT
            </p>
          </div>
        </div>
        {onExportPmt ? (
          <AppButton
            onClick={onExportPmt}
            className="ios-toolbar-button"
            title="Export program PMT ke XLS"
          >
            <FileDown className="h-4 w-4" />
            Export PMT (XLS)
          </AppButton>
        ) : null}
      </div>
      <div className="pmt-filter-bar">
        <div
          className="pmt-category-filter apple-segmented-control"
          role="tablist"
          aria-label="Filter kategori PMT"
        >
          {CATEGORY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={categoryFilter === option.value}
              className={categoryFilter === option.value ? "is-active" : ""}
              title={option.label}
              onClick={() => setCategoryFilter(option.value)}
            >
              {option.shortLabel}
            </button>
          ))}
        </div>
      </div>
      <Card className="pmt-table-card ios-table-card">
        {waiting ? (
          <DataTable
            className="pmt-table-scroll"
            ariaLabel="Memuat tabel pemantauan PMT"
          >
            <table className="pmt-data-table ios-data-table" aria-busy="true">
              <PmtTableHeader weeks={weeks} />
              <tbody>
                {Array.from({ length: 5 }, (_, row) => (
                  <tr key={row}>
                    {Array.from({ length: 8 + weeks.length }, (_, column) => (
                      <td key={column} className="px-3 py-4">
                        <SkeletonBlock
                          className={column === 1 ? "h-4 w-36" : "h-4 w-16"}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        ) : pageError || remoteState === "error" ? (
          <div
            className="pmt-empty-state ios-inline-notification ios-inline-notification-error"
            role="alert"
          >
            <AlertCircle className="h-8 w-8" />
            <p>
              Gagal memuat program PMT:{" "}
              {pageError || "Periksa koneksi lalu coba lagi."}
            </p>
          </div>
        ) : filteredPrograms.length === 0 ? (
          <div className="pmt-empty-state">
            <Gift className="h-8 w-8" />
            <p>Belum ada program PMT pada kategori ini.</p>
          </div>
        ) : (
          <DataTable
            className="pmt-table-scroll"
            ariaLabel="Tabel pemantauan PMT"
          >
            <table className="pmt-data-table ios-data-table">
              <PmtTableHeader weeks={weeks} />
              <VirtualizedTableBody
                items={filteredPrograms}
                colSpan={8 + weeks.length}
                rowKey={(program, index) => String(program.id || program.childId || index)}
                renderRow={renderPmtRow}
                estimateRowHeight={112}
                className="divide-y divide-slate-100"
              />
            </table>
          </DataTable>
        )}
      </Card>
    </div>
  );
}
