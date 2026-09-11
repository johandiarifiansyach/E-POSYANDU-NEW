import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  syncMeasurementMutationsNow,
  updateDoc,
} from "../../api/syncApi";
import { fetchChildMeasurementHistory } from "../../services/measurementService";
import {
  hasUsableAnalysis,
  pythonWeightGainStatus,
  requestMeasurementAnalysis,
  requestPythonAnthropometry,
} from "../../api/analysisApi";
import {
  MEASUREMENT_DECIMAL_RULES,
  normalizeMeasurementInput,
  parseMeasurementDecimalForRange,
  validateMeasurementForm,
} from "./measurementRules";
import { appId, db } from "../../app/session";
import {
  formatDate,
  formatIndoDate,
  getAgeInMonths,
} from "../../shared/formatters";
import {
  AppButton,
  Card,
  InputGroup,
  AppSelect,
  GrowthChartSkeleton,
  KenaikanBadge,
  SkeletonBlock,
  StatusBadge,
} from "../../components/base";
import {
  CheckCircle2,
  ChevronLeft,
  History,
  Loader2,
  Pencil,
  Plus,
  Scale,
  Trash2,
  TrendingUp,
} from "../../ui/icons";
import type { DashboardUser } from "../../types";
import MeasurementAnalysisDialog from "./MeasurementAnalysisDialog";

// Growth charts are opened from a button in the measurement view. Defer the
// chart renderer and PDF export code until that modal is actually requested.
const ReactGrowthChartsPage = lazy(
  () => import("../growth-charts/ReactGrowthChartsPage"),
);

type Child = Record<string, any>;
type Measurement = Record<string, any> & { id: string };
type Form = {
  tglUkur: string;
  bb: string;
  tb: string;
  lila: string;
  lk: string;
  edema: string;
  kelasIbu: string;
  mbg: string;
  vitA: string;
  asi: string;
  caraUkur: string;
  statusNaik: string;
};
const inputClass =
  "w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";
const simpleOptions = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
const emptyForm = (): Form => ({
  tglUkur: formatDate(new Date()),
  bb: "",
  tb: "",
  lila: "",
  lk: "",
  edema: "Tidak",
  kelasIbu: "Tidak",
  mbg: "Tidak",
  vitA: "Tidak",
  asi: "Tidak",
  caraUkur: "",
  statusNaik: "B",
});

function normalise(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}
function currentChildMeasurement(history: Measurement[], child: Child) {
  return (
    history[0] || {
      bb: child.currentBB ?? child.bbLahir,
      tb: child.currentTB ?? child.pbLahir,
      lila: child.currentLILA,
      lk: child.currentLK ?? child.lkLahir,
    }
  );
}

export type ReactMeasurementPageProps = {
  user?: DashboardUser;
  child: Child;
  onBack: () => void;
};

/** Strict React measurement workflow. Python remains the sole analysis authority. */
export default function ReactMeasurementPage({
  child,
  onBack,
}: ReactMeasurementPageProps) {
  const [history, setHistory] = useState<Measurement[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"history" | "add">("history");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [asiTouched, setAsiTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{
    status: "idle" | "loading" | "success" | "error";
    result?: any;
    error?: string;
    measurement?: Measurement;
  }>({ status: "idle" });
  const [showCharts, setShowCharts] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, any>>({});
  const [statusLoading, setStatusLoading] = useState(false);

  const ageAtMeasure = useMemo(
    () =>
      getAgeInMonths(
        child.tglLahir,
        new Date(`${form.tglUkur.slice(0, 10)}T00:00:00`),
      ),
    [child.tglLahir, form.tglUkur],
  );
  const showLila = ageAtMeasure >= 3;
  const showAsi = ageAtMeasure >= 0 && ageAtMeasure <= 6;
  const showVitA =
    new Date(`${form.tglUkur}T00:00:00`).getMonth() + 1 === 2 ||
    new Date(`${form.tglUkur}T00:00:00`).getMonth() + 1 === 8;
  const asiLabel = `ASI EKSKLUSIF USIA ${Math.max(0, Math.min(6, ageAtMeasure))} BULAN`;
  const monthlyHistory = useMemo(() => {
    const map = new Map<string, Measurement>();
    history.forEach((item) => {
      const key = String(item.tglUkur || "").slice(0, 7);
      if (
        key &&
        (!map.has(key) || String(item.tglUkur) > String(map.get(key)?.tglUkur))
      )
        map.set(key, item);
    });
    return [...map.values()].sort((a, b) =>
      String(b.tglUkur).localeCompare(String(a.tglUkur)),
    );
  }, [history]);

  useEffect(() => {
    let active = true;
    setLoadingHistory(true);
    setHistoryError(null);
    void fetchChildMeasurementHistory(child)
      .then((items) => {
        if (active) {
          setHistory((items || []) as Measurement[]);
          setLoadingHistory(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setHistoryError(
            cause instanceof Error
              ? cause.message
              : "Riwayat penimbangan tidak dapat dimuat.",
          );
          setLoadingHistory(false);
        }
      });
    return () => {
      active = false;
    };
  }, [child]);

  useEffect(() => {
    const entries = monthlyHistory
      .filter(
        (item) => item.bb !== "" && item.bb !== null && item.bb !== undefined,
      )
      .map((measurement) => ({ child, measurement, history }));
    if (!entries.length) {
      setStatuses({});
      setStatusLoading(false);
      return;
    }
    let active = true;
    setStatusLoading(true);
    void requestPythonAnthropometry(entries)
      .then((response: any) => {
        if (!active) return;
        const next: Record<string, any> = {};
        (response.items || []).forEach((item: any) => {
          const source = entries[Math.max(0, Number(item.rowNumber || 1) - 1)];
          if (source?.measurement?.id) next[source.measurement.id] = item;
        });
        setStatuses(next);
        setStatusLoading(false);
      })
      .catch(() => {
        if (active) {
          setStatuses({});
          setStatusLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [child, history, monthlyHistory]);

  useEffect(() => {
    setForm((current) => ({
      ...current,
      caraUkur: ageAtMeasure > 24 ? "Berdiri" : "Terlentang",
      lila: ageAtMeasure < 3 ? "" : current.lila,
      asi: !asiTouched && ageAtMeasure === 0 ? "Ya" : current.asi,
    }));
  }, [ageAtMeasure, asiTouched]);

  const startAdd = () => {
    setEditingId(null);
    setAsiTouched(false);
    setForm(emptyForm());
    setMenu("add");
  };
  const startEdit = (measurement: Measurement) => {
    setEditingId(measurement.id);
    setAsiTouched(Boolean(measurement.asi));
    setForm({
      tglUkur: normalise(measurement.tglUkur).slice(0, 10),
      bb: normalise(measurement.bb),
      tb: normalise(measurement.tb),
      lila: normalise(measurement.lila),
      lk: normalise(measurement.lk),
      edema: normalise(measurement.edema || "Tidak"),
      kelasIbu: normalise(measurement.kelasIbu || "Tidak"),
      mbg: normalise(measurement.mbg || "Tidak"),
      vitA: normalise(measurement.vitA || "Tidak"),
      asi: normalise(measurement.asi || "Tidak"),
      caraUkur: normalise(measurement.caraUkur),
      statusNaik: normalise(measurement.statusNaik || "B"),
    });
    setMenu("add");
  };
  const decimalChange = (field: keyof Form, value: string) =>
    setForm((current) => ({
      ...current,
      [field]: normalizeMeasurementInput(value),
    }));
  const decimalBlur = (field: keyof typeof MEASUREMENT_DECIMAL_RULES) => {
    const value = form[field];
    const rule = MEASUREMENT_DECIMAL_RULES[field];
    const parsed = parseMeasurementDecimalForRange(
      value,
      rule.minimum,
      rule.maximum,
      rule.shift,
    );
    if (Number.isFinite(parsed))
      setForm((current) => ({
        ...current,
        [field]: String(parsed)
          .replace(/\.0+$/, "")
          .replace(/(\.\d*?)0+$/, "$1"),
      }));
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = (validateMeasurementForm as any)({
      date: form.tglUkur,
      bb: form.bb,
      tb: form.tb,
      lila: form.lila,
      lk: form.lk,
      ageInMonths: ageAtMeasure,
    }) as {
      ok: boolean;
      message?: string;
      data?: {
        measurementDate: string;
        bb: number;
        tb: number;
        lila: number | null;
        lk: number;
      };
    };
    if (!validation.ok || !validation.data) {
      setHistoryError(validation.message || "Data pengukuran belum valid.");
      return;
    }
    setSaving(true);
    setHistoryError(null);
    const values = validation.data;
    const payload = {
      childId: child.id,
      childName: child.nama,
      posyandu: child.posyandu,
      desa: child.desa,
      ...form,
      tglUkur: values.measurementDate,
      bb: values.bb,
      tb: values.tb,
      lila: values.lila,
      lk: values.lk,
      ageInMonths: getAgeInMonths(
        child.tglLahir,
        new Date(`${values.measurementDate}T00:00:00`),
      ),
      updatedAt: serverTimestamp(),
    };
    try {
      const mutation = editingId
        ? await updateDoc(
            doc(
              db,
              "artifacts",
              appId,
              "public",
              "data",
              "measurements",
              editingId,
            ),
            payload,
            { deferSync: true },
          )
        : await addDoc(
            collection(
              db,
              "artifacts",
              appId,
              "public",
              "data",
              "measurements",
            ),
            { ...payload, createdAt: serverTimestamp() },
            { deferSync: true },
          );
      const id =
        editingId ||
        ("id" in mutation && typeof mutation.id === "string"
          ? mutation.id
          : "");
      const projected = [
        ...history.filter((item) => item.id !== id),
        { ...payload, id } as Measurement,
      ].sort((a, b) => String(b.tglUkur).localeCompare(String(a.tglUkur)));
      const latest = currentChildMeasurement(projected, child);
      const childMutation = await updateDoc(
        doc(db, "artifacts", appId, "public", "data", "children", child.id),
        {
          currentBB: latest.bb ?? child.bbLahir ?? null,
          currentTB: latest.tb ?? child.pbLahir ?? null,
          currentLILA: latest.lila ?? null,
          currentLK: latest.lk ?? child.lkLahir ?? null,
          lastMeasurementDate: latest.tglUkur ?? null,
          updatedAt: serverTimestamp(),
        },
        { deferSync: true },
      );
      await syncMeasurementMutationsNow([
        mutation.mutationId,
        childMutation.mutationId,
      ]);
      setHistory(projected);
      setMenu("history");
      setAnalysis({
        status: "loading",
        measurement: projected.find((item) => item.id === id),
      });
      void requestMeasurementAnalysis(
        child,
        projected.find((item) => item.id === id),
        projected,
      )
        .then((result: any) =>
          setAnalysis({
            status: "success",
            result,
            measurement: projected.find((item) => item.id === id),
          }),
        )
        .catch((cause: unknown) =>
          setAnalysis({
            status: "error",
            error:
              cause instanceof Error
                ? cause.message
                : "Analisis pertumbuhan belum tersedia.",
            measurement: projected.find((item) => item.id === id),
          }),
        );
    } catch (cause) {
      setHistoryError(
        cause instanceof Error
          ? cause.message
          : "Data penimbangan belum dapat disimpan.",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (measurement: Measurement) => {
    if (
      !window.confirm(
        `Hapus penimbangan tanggal ${formatIndoDate(measurement.tglUkur)}?`,
      )
    )
      return;
    setDeletingId(measurement.id);
    try {
      await deleteDoc(
        doc(
          db,
          "artifacts",
          appId,
          "public",
          "data",
          "measurements",
          measurement.id,
        ),
      );
      const remaining = history.filter((item) => item.id !== measurement.id);
      const latest = currentChildMeasurement(remaining, child);
      await updateDoc(
        doc(db, "artifacts", appId, "public", "data", "children", child.id),
        {
          currentBB: latest.bb ?? child.bbLahir ?? null,
          currentTB: latest.tb ?? child.pbLahir ?? null,
          currentLILA: latest.lila ?? null,
          currentLK: latest.lk ?? child.lkLahir ?? null,
          lastMeasurementDate: latest.tglUkur ?? null,
          updatedAt: serverTimestamp(),
        },
      );
      setHistory(remaining);
    } catch (cause) {
      setHistoryError(
        cause instanceof Error ? cause.message : "Riwayat tidak dapat dihapus.",
      );
    } finally {
      setDeletingId(null);
    }
  };
  const runAnalysis = (measurement: Measurement) => {
    setAnalysis({ status: "loading", measurement });
    void requestMeasurementAnalysis(child, measurement, history)
      .then((result: any) =>
        setAnalysis({ status: "success", result, measurement }),
      )
      .catch((cause: unknown) =>
        setAnalysis({
          status: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "Analisis pertumbuhan belum tersedia.",
          measurement,
        }),
      );
  };

  const field = (key: keyof Form, label: string, required = true) => (
    <InputGroup label={label}>
      <input
        required={required}
        name={key}
        type={key === "tglUkur" ? "date" : "text"}
        inputMode={key === "tglUkur" ? undefined : "decimal"}
        className={inputClass}
        value={form[key]}
        onChange={(event) =>
          key === "bb" || key === "tb" || key === "lila" || key === "lk"
            ? decimalChange(key, event.target.value)
            : setForm((current) => ({ ...current, [key]: event.target.value }))
        }
        onBlur={() =>
          key === "bb" || key === "tb" || key === "lila" || key === "lk"
            ? decimalBlur(key)
            : undefined
        }
      />
    </InputGroup>
  );
  const select = (
    key: keyof Form,
    label: string,
    options: Array<{ value: string; label: string }>,
  ) => (
    <InputGroup label={label}>
      <AppSelect
        value={form[key]}
        options={options}
        onChange={(event) =>
          setForm((current) => ({ ...current, [key]: event.target.value }))
        }
      />
    </InputGroup>
  );

  const tableHeaders = [
    "Bulan",
    "Tanggal Ukur",
    "BB",
    "PB/TB",
    "LILA",
    "LK",
    "Status BB/U",
    "Status PB/TB-U",
    "Status BB/PB atau BB/TB",
    "Status IMT/U",
    "Status LILA/U",
    "Status LK/U",
    "Naik BB",
    "Aksi",
  ];
  const actionButton = (kind: "edit" | "delete", item: Measurement) => (
    <button
      type="button"
      className={`table-action-button table-action-${kind === "edit" ? "blue" : "red"}`}
      aria-label={`${kind === "edit" ? "Edit" : "Hapus"} penimbangan tanggal ${formatIndoDate(item.tglUkur)}`}
      disabled={Boolean(deletingId)}
      onClick={() => (kind === "edit" ? startEdit(item) : void remove(item))}
    >
      {kind === "delete" && deletingId === item.id ? (
        <Loader2 className="h-4 w-4" />
      ) : kind === "edit" ? (
        <Pencil className="h-4 w-4" />
      ) : (
        <Trash2 className="h-4 w-4" />
      )}
    </button>
  );
  return (
    <div
      className="measurement-page apple-page space-y-6"
      data-react-measurement-page="true"
    >
      {showCharts ? (
        <Suspense
          fallback={
            <div className="growth-chart-backdrop" role="presentation">
              <GrowthChartSkeleton />
            </div>
          }
        >
          <ReactGrowthChartsPage
            child={child}
            history={monthlyHistory}
            onClose={() => setShowCharts(false)}
          />
        </Suspense>
      ) : null}
      {analysis.status !== "idle" ? (
        <MeasurementAnalysisDialog
          child={child}
          measurement={analysis.measurement}
          state={analysis}
          onClose={() => setAnalysis({ status: "idle" })}
          onOpenChart={() => {
            setAnalysis({ status: "idle" });
            setShowCharts(true);
          }}
        />
      ) : null}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <AppButton
            type="button"
            variant="secondary"
            className="ios-back-button mb-4"
            onClick={onBack}
            title="Kembali ke daftar balita"
          >
            <ChevronLeft className="h-4 w-4" /> Kembali
          </AppButton>
          <div className="flex items-center gap-3">
            <span
              className="apple-symbol-tile apple-symbol-tile-blue"
              aria-hidden="true"
            >
              <Scale className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-2xl font-bold text-slate-800">
                Pengukuran Balita
              </h2>
              <p className="truncate text-sm text-slate-500">
                {child.nama} - {getAgeInMonths(child.tglLahir)} Bulan -{" "}
                {child.desa} / {child.posyandu}
              </p>
            </div>
          </div>
        </div>
        <div
          className="measurement-segmented apple-segmented-control"
          role="tablist"
          aria-label="Menu penimbangan"
        >
          <button
            type="button"
            role="tab"
            aria-selected={menu === "history"}
            className={menu === "history" ? "is-active" : ""}
            onClick={() => setMenu("history")}
          >
            <History className="h-4 w-4" />
            <span>Riwayat</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={menu === "add"}
            className={menu === "add" ? "is-active" : ""}
            onClick={startAdd}
          >
            <Plus className="h-4 w-4" />
            <span>Tambah</span>
          </button>
        </div>
      </div>
      {historyError ? (
        <div
          role="alert"
          className="ios-inline-notification ios-inline-notification-error"
        >
          <strong>Riwayat penimbangan tidak dapat dimuat</strong>
          <span>{historyError}</span>
        </div>
      ) : null}
      {menu === "history" ? (
        <Card className="ios-table-card measurement-history-card">
          <div className="measurement-history-heading">
            <div>
              <h3>Riwayat Penimbangan Bulan ke Bulan</h3>
              <p>{monthlyHistory.length} catatan pengukuran</p>
            </div>
            <div className="measurement-history-tools">
              {monthlyHistory.length ? (
                <AppButton
                  type="button"
                  variant="secondary"
                  className="measurement-growth-button"
                  onClick={() => setShowCharts(true)}
                  title="Buka enam grafik pertumbuhan WHO"
                >
                  <TrendingUp className="h-4 w-4" />
                  <span>Grafik Pertumbuhan</span>
                </AppButton>
              ) : null}
              {monthlyHistory[0] ? (
                <AppButton
                  type="button"
                  variant="secondary"
                  className="measurement-analysis-button"
                  onClick={() => runAnalysis(monthlyHistory[0])}
                  title="Analisis pertumbuhan, anomali, edukasi, dan tindak lanjut"
                >
                  <TrendingUp className="h-4 w-4" />
                  <span>Analisis Pertumbuhan</span>
                </AppButton>
              ) : null}
              <span
                className="measurement-history-count"
                aria-label={`${monthlyHistory.length} catatan`}
              >
                {monthlyHistory.length}
              </span>
            </div>
          </div>
          {loadingHistory ? (
            <div className="measurement-history-scroll">
              <table
                className="ios-data-table ios-measurement-table text-xs"
                aria-busy="true"
              >
                <thead>
                  <tr>
                    {tableHeaders.map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 6 }, (_, index) => (
                    <tr key={index} className="app-table-loading-row">
                      {tableHeaders.map((_, cellIndex) => (
                        <td key={cellIndex}>
                          <SkeletonBlock className="app-table-cell-skeleton app-table-cell-skeleton-line" />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : monthlyHistory.length === 0 ? (
            <p className="measurement-history-empty">
              Belum ada riwayat pengukuran.
            </p>
          ) : (
            <div className="measurement-history-scroll">
              <table
                className="ios-data-table ios-measurement-table text-xs"
                data-measurement-history-table="true"
              >
                <thead>
                  <tr>
                    {tableHeaders.map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthlyHistory.map((item) => {
                    const result = statuses[item.id];
                    const busy = statusLoading && !hasUsableAnalysis(result);
                    const badge = (value: unknown) =>
                      busy ? (
                        <SkeletonBlock className="table-analysis-skeleton table-analysis-skeleton-badge" />
                      ) : (
                        <StatusBadge status={String(value || "-")} />
                      );
                    return (
                      <tr key={item.id} className="ios-data-row">
                        <td className="font-semibold uppercase whitespace-nowrap">
                          {new Date(item.tglUkur).toLocaleDateString("id-ID", {
                            month: "short",
                            year: "numeric",
                          })}
                        </td>
                        <td className="whitespace-nowrap">
                          {formatIndoDate(item.tglUkur)}
                        </td>
                        <td className="text-center">{item.bb ?? "-"}</td>
                        <td className="text-center">{item.tb ?? "-"}</td>
                        <td className="text-center">{item.lila ?? "-"}</td>
                        <td className="text-center">{item.lk ?? "-"}</td>
                        <td className="text-center">
                          {badge(result?.bbuStatus)}
                        </td>
                        <td className="text-center">
                          {badge(result?.tbuStatus)}
                        </td>
                        <td className="text-center">
                          {badge(result?.bbtbStatus)}
                        </td>
                        <td className="text-center">
                          {badge(result?.imtuStatus)}
                        </td>
                        <td className="text-center">
                          {badge(result?.lilaStatus)}
                        </td>
                        <td className="text-center">
                          {badge(result?.lkStatus)}
                        </td>
                        <td className="text-center">
                          {busy ? (
                            <SkeletonBlock className="table-analysis-skeleton table-analysis-skeleton-badge" />
                          ) : (
                            <KenaikanBadge
                              status={pythonWeightGainStatus(result) || "-"}
                            />
                          )}
                        </td>
                        <td>
                          <div className="flex items-center justify-center gap-2">
                            {actionButton("edit", item)}
                            {actionButton("delete", item)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card className="ios-measurement-form p-4 sm:p-6">
          <form onSubmit={save} className="measurement-form-stack space-y-6">
            <div className="measurement-form-panel measurement-time-panel grid grid-cols-1 gap-4 md:grid-cols-2">
              {field("tglUkur", "Tanggal Pengukuran")}
              <InputGroup label="Cara Ukur">
                <input
                  readOnly
                  className={`${inputClass} bg-slate-100 text-slate-500`}
                  value={form.caraUkur}
                />
              </InputGroup>
            </div>
            <div className="measurement-form-panel measurement-anthropometry-panel grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field("bb", "Berat Badan (kg)")}
              {field(
                "tb",
                ageAtMeasure <= 24 ? "Panjang Badan (cm)" : "Tinggi Badan (cm)",
              )}
            </div>
            <div
              className={`measurement-form-panel measurement-additional-panel grid grid-cols-1 gap-4 ${showLila ? "sm:grid-cols-2" : ""}`}
            >
              {showLila ? field("lila", "LILA (cm)") : null}
              {field("lk", "Lingkar Kepala (cm)")}
            </div>
            {select(
              "edema",
              "Pitting Edema Bilateral",
              simpleOptions([
                "Tidak",
                "Ada (Derajat +1)",
                "Ada (Derajat +2)",
                "Ada (Derajat +3)",
              ]),
            )}
            <div className="measurement-service-panel grid grid-cols-1 gap-4 sm:grid-cols-2">
              {select(
                "kelasIbu",
                "Kelas Ibu Balita?",
                simpleOptions(["Tidak", "Ya"]),
              )}
              <InputGroup label="Terima MBG?">
                <AppSelect
                  value={form.mbg}
                  options={simpleOptions(["Tidak", "Ya"])}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      mbg: event.target.value,
                    }))
                  }
                />
                <p className="text-[11px] leading-4 font-medium italic normal-case text-slate-500">
                  *Balita yang menerima PMT dari Posyandu atau PAUD/TK.
                </p>
              </InputGroup>
            </div>
            <div className="space-y-4">
              {showVitA ? (
                <div className="measurement-service-option measurement-service-vitamin">
                  {select(
                    "vitA",
                    "Dapat Vitamin A (Feb/Agu)?",
                    simpleOptions(["Tidak", "Ya"]),
                  )}
                </div>
              ) : null}
              {showAsi ? (
                <div className="measurement-service-option measurement-service-asi">
                  {
                    <InputGroup label={asiLabel}>
                      <AppSelect
                        value={form.asi}
                        options={simpleOptions(["Tidak", "Ya"])}
                        onChange={(event) => {
                          setAsiTouched(true);
                          setForm((current) => ({
                            ...current,
                            asi: event.target.value,
                          }));
                        }}
                      />
                    </InputGroup>
                  }
                </div>
              ) : null}
            </div>
            <div className="measurement-form-actions flex gap-3 pt-2">
              <AppButton
                variant="secondary"
                type="button"
                onClick={() => setMenu("history")}
                className="ios-back-button flex-1"
              >
                <ChevronLeft className="h-4 w-4" /> Kembali ke Riwayat
              </AppButton>
              <AppButton type="submit" disabled={saving} className="flex-1">
                <CheckCircle2 className="h-4 w-4" />
                {saving
                  ? "Menyimpan..."
                  : editingId
                    ? "Simpan Perubahan"
                    : "Simpan Pengukuran"}
              </AppButton>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
