import { useEffect, useMemo, useState } from "react";
import {
  requestGrowthAnalysis,
  requestPythonGrowthChart,
} from "../../api/analysisApi";
import {
  GROWTH_CHART_LABELS,
  GROWTH_CHART_TYPES,
  safeChildFileName,
} from "../measurements/growthCharts";
import {
  AppButton,
  GrowthAnalysisSkeleton,
  GrowthChartSkeleton,
} from "../../components/base";
import { FileDown, Loader2, X } from "../../ui/icons";

type ChartType = (typeof GROWTH_CHART_TYPES)[number];
type Child = Record<string, any>;
type Measurement = Record<string, any>;
type LoadState<T> = {
  status: "loading" | "success" | "error";
  value?: T;
  error?: string;
};

function childChartHeader(child: Child) {
  const gender = child?.jk === "P" ? "Perempuan" : "Laki-laki";
  const posyandu = String(child?.posyandu || "").trim();
  const desa = String(child?.desa || child?.village || "").trim();
  return [
    String(child?.nama || "Balita"),
    posyandu ? `Posyandu: ${posyandu}` : "",
    desa ? `Desa: ${desa}` : "",
    gender,
    "usia lahir–5 tahun",
  ]
    .filter(Boolean)
    .join(" • ");
}

function sanitiseSvg(markup: string) {
  if (typeof DOMParser === "undefined") return "";
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    !svg ||
    svg.nodeName.toLowerCase() !== "svg" ||
    parsed.querySelector("parsererror")
  )
    return "";
  svg
    .querySelectorAll("script,foreignObject,iframe,object,embed")
    .forEach((node) => node.remove());
  svg.querySelectorAll("*").forEach((node) =>
    Array.from(node.attributes).forEach((attribute) => {
      if (
        attribute.name.toLowerCase().startsWith("on") ||
        attribute.name.toLowerCase().includes("href")
      )
        node.removeAttribute(attribute.name);
    }),
  );
  return svg.outerHTML;
}

function rasteriseSvg(
  svg: string,
  scale = 2,
): Promise<{ blob: Blob; dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined" || typeof Image === "undefined") {
      reject(new Error("Browser tidak mendukung ekspor grafik."));
      return;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      const width = Number(image.naturalWidth || image.width || 1200);
      const height = Number(image.naturalHeight || image.height || 760);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        cleanup();
        reject(new Error("Canvas ekspor grafik tidak tersedia."));
        return;
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      canvas.toBlob((blob) => {
        cleanup();
        blob
          ? resolve({ blob, dataUrl, width, height })
          : reject(new Error("PNG grafik tidak dapat dibuat."));
      }, "image/png");
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("SVG grafik tidak dapat dirasterisasi menjadi PNG."));
    };
    image.src = objectUrl;
  });
}
function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function formatAnalysisValue(value: unknown, unit: unknown) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toFixed(2).replace(".", ",")} ${String(unit || "")}`
    : "—";
}
function arrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function PosterGuidance({ poster, prefix }: { poster?: any; prefix: string }) {
  if (!poster) return null;
  const points = arrayOf(poster.keyPoints);
  const portions = arrayOf(poster.portionExamples);
  return (
    <div className="measurement-analysis-poster">
      {poster.asset ? (
        <img
          className="measurement-analysis-poster-image"
          src={String(poster.asset)}
          alt={String(poster.title || "Poster Isi Piringku sesuai usia")}
          width={1200}
          height={1715}
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <div className="measurement-analysis-poster-copy">
        <strong>{String(poster.title || "Isi Piringku sesuai usia")}</strong>
        {points.length ? (
          <ul>
            {points.map((item, index) => (
              <li key={`${prefix}-point-${index}`}>{String(item)}</li>
            ))}
          </ul>
        ) : null}
        {portions.length ? (
          <div className="measurement-analysis-poster-portions">
            <span>Contoh porsi dari poster</span>
            <ul>
              {portions.map((item, index) => (
                <li key={`${prefix}-portion-${index}`}>{String(item)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {poster.sourceFile ? (
          <small>Sumber: {String(poster.sourceFile)}</small>
        ) : null}
      </div>
    </div>
  );
}

function Guidance({
  guidance,
  prefix,
  normal = false,
}: {
  guidance: any;
  prefix: string;
  normal?: boolean;
}) {
  if (!guidance) return null;
  const education = arrayOf(guidance.education);
  const recommendations = arrayOf(
    guidance.recommendations || guidance.followUp,
  );
  const findings = arrayOf(guidance.findings);
  const materials = arrayOf(guidance.matchedGuidance);
  return (
    <section
      className={`measurement-analysis-guidance ${normal ? "" : "measurement-analysis-card-alert"}`}
    >
      <div className="growth-chart-analysis-list">
        <strong>
          {String(
            guidance.title ||
              (normal
                ? "Edukasi mempertahankan pertumbuhan"
                : "Edukasi dan rekomendasi tindak lanjut"),
          )}
        </strong>
        <p>
          {String(
            guidance.summary ||
              "Status gizi memerlukan pemantauan dan tindak lanjut dari tenaga kesehatan.",
          )}
        </p>
      </div>
      {findings.length ? (
        <div className="measurement-analysis-guidance-findings">
          {findings.map((item, index) => (
            <span key={`${prefix}-finding-${index}`}>
              {String(item.indicator || "Indikator")}:{" "}
              {String(item.status || "—")}
            </span>
          ))}
        </div>
      ) : null}
      {materials.length ? (
        <div className="measurement-analysis-guidance-list measurement-analysis-guidance-sources">
          <strong>Materi tatalaksana yang digunakan</strong>
          <ul>
            {materials.map((item, index) => (
              <li key={`${prefix}-material-${index}`}>
                {String(item.title || item.id || "Panduan status gizi")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <PosterGuidance poster={guidance.posterGuidance} prefix={prefix} />
      {education.length ? (
        <div className="measurement-analysis-guidance-list">
          <strong>
            {normal
              ? "Edukasi sesuai usia dan persentase skrining"
              : "Edukasi singkat"}
          </strong>
          <ul>
            {education.map((item, index) => (
              <li key={`${prefix}-education-${index}`}>{String(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {recommendations.length ? (
        <div className="measurement-analysis-guidance-list">
          <strong>
            {guidance.urgency === "segera"
              ? "Rekomendasi tindak lanjut segera"
              : "Rekomendasi tindak lanjut"}
          </strong>
          <ul>
            {recommendations.map((item, index) => (
              <li key={`${prefix}-recommendation-${index}`}>{String(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {guidance.disclaimer ? (
        <small className="measurement-analysis-guidance-disclaimer">
          {String(guidance.disclaimer)}
        </small>
      ) : null}
    </section>
  );
}

function GrowthAnalysisPanel({ state }: { state: LoadState<any> }) {
  if (state.status === "loading") return <GrowthAnalysisSkeleton />;
  if (state.status === "error")
    return (
      <div
        className="growth-chart-analysis growth-chart-analysis-warning"
        role="status"
      >
        <strong>Analisis pertumbuhan belum tersedia.</strong>
        <span>
          {state.error || "Layanan Python belum mengembalikan penjelasan tren."}
        </span>
      </div>
    );
  const analysis = state.value || {};
  const indicators = arrayOf(analysis.indicators);
  const conclusions = arrayOf(analysis.conclusions);
  const recommendations = arrayOf(analysis.recommendations);
  const concern = analysis.nutritionConcern;
  const education = analysis.nutritionEducation;
  return (
    <section
      className="growth-chart-analysis"
      aria-label="Analisis Pertumbuhan"
    >
      <div className="growth-chart-analysis-header">
        <div>
          <h3>Analisis Pertumbuhan</h3>
          <p>
            {analysis.model
              ? `Model skrining: ${analysis.model}`
              : "Model skrining tren grafik"}
          </p>
        </div>
        {Number.isFinite(Number(analysis.confidence)) ? (
          <span className="growth-chart-analysis-confidence">
            Keyakinan {(Number(analysis.confidence) * 100).toFixed(0)}%
          </span>
        ) : null}
      </div>
      <p className="growth-chart-analysis-summary">
        {String(analysis.summary || "Belum ada kesimpulan tren.")}
      </p>
      {concern ? (
        <Guidance guidance={concern} prefix="growth-problem" />
      ) : education ? (
        <Guidance guidance={education} prefix="growth-normal" normal />
      ) : null}
      {indicators.length ? (
        <div className="growth-chart-analysis-grid">
          {indicators.map((indicator: any, index) => (
            <article
              key={indicator.key || indicator.label || index}
              className={`growth-chart-analysis-indicator growth-chart-analysis-${indicator.trend || "neutral"}`}
            >
              <strong>
                {String(indicator.label || indicator.key || "Indikator")}
              </strong>
              <span>{String(indicator.trendLabel || "—")}</span>
              <small>
                {Number(indicator.points) >= 2
                  ? `${formatAnalysisValue(indicator.firstValue, indicator.unit)} → ${formatAnalysisValue(indicator.latestValue, indicator.unit)} (${formatAnalysisValue(indicator.delta, indicator.unit)})`
                  : "Memerlukan minimal dua titik bertanggal"}
              </small>
              <p>{String(indicator.explanation || "")}</p>
            </article>
          ))}
        </div>
      ) : null}
      {conclusions.length ? (
        <div className="growth-chart-analysis-list">
          <strong>Kesimpulan</strong>
          <ul>
            {conclusions.map((item, index) => (
              <li key={`conclusion-${index}`}>{String(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {recommendations.length ? (
        <div className="growth-chart-analysis-list">
          <strong>Saran tindak lanjut</strong>
          <ul>
            {recommendations.map((item, index) => (
              <li key={`recommendation-${index}`}>{String(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {analysis.disclaimer ? (
        <p className="growth-chart-analysis-disclaimer">
          {String(analysis.disclaimer)}
        </p>
      ) : null}
    </section>
  );
}

export type ReactGrowthChartsPageProps = {
  child: Child;
  history: Measurement[];
  onClose: () => void;
};

export default function ReactGrowthChartsPage({
  child,
  history,
  onClose,
}: ReactGrowthChartsPageProps) {
  const [activeType, setActiveType] = useState<ChartType>("bbu");
  const [exporting, setExporting] = useState<"png" | "pdf" | "">("");
  const [pythonState, setPythonState] = useState<LoadState<any>>({
    status: "loading",
  });
  const [chartState, setChartState] = useState<LoadState<string>>({
    status: "loading",
  });
  const historyKey = useMemo(
    () =>
      (history || [])
        .map((item) => `${item?.id || ""}:${item?.tglUkur || ""}`)
        .join("|"),
    [history],
  );
  useEffect(() => {
    let active = true;
    setPythonState({ status: "loading" });
    void requestGrowthAnalysis(child, history)
      .then((response: any) => {
        if (!response?.graphAnalysis)
          throw new Error(
            "Respons analisis pertumbuhan belum memuat ringkasan grafik.",
          );
        if (active)
          setPythonState({ status: "success", value: response.graphAnalysis });
      })
      .catch((cause: unknown) => {
        if (active)
          setPythonState({
            status: "error",
            error:
              cause instanceof Error
                ? cause.message
                : "Analisis pertumbuhan belum tersedia.",
          });
      });
    return () => {
      active = false;
    };
  }, [child?.id, historyKey]);
  useEffect(() => {
    let active = true;
    setChartState({ status: "loading" });
    void requestPythonGrowthChart(child, history, activeType)
      .then((response: any) => {
        if (!response?.svg)
          throw new Error("Renderer Python tidak mengembalikan SVG grafik.");
        if (active) setChartState({ status: "success", value: response.svg });
      })
      .catch((cause: unknown) => {
        if (active)
          setChartState({
            status: "error",
            error:
              cause instanceof Error
                ? cause.message
                : "Grafik Python belum tersedia.",
          });
      });
    return () => {
      active = false;
    };
  }, [activeType, child?.id, historyKey]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !exporting) onClose();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", escape);
    };
  }, [onClose, exporting]);
  const requestChartSvg = async (type: ChartType) => {
    if (
      type === activeType &&
      chartState.status === "success" &&
      chartState.value
    )
      return chartState.value;
    const response: any = await requestPythonGrowthChart(child, history, type);
    if (!response?.svg)
      throw new Error(
        `Grafik ${GROWTH_CHART_LABELS[type]} belum selesai dirender.`,
      );
    return response.svg as string;
  };
  const downloadActivePng = async () => {
    setExporting("png");
    try {
      const image = await rasteriseSvg(await requestChartSvg(activeType));
      downloadBlob(
        image.blob,
        `grafik-${activeType}-${safeChildFileName(child)}.png`,
      );
    } catch (cause) {
      window.alert(
        cause instanceof Error
          ? cause.message
          : "PNG grafik belum dapat diunduh.",
      );
    } finally {
      setExporting("");
    }
  };
  const downloadAllPdf = async () => {
    setExporting("pdf");
    try {
      // PDF generation is an explicit action. Keep jsPDF (and its sizeable
      // rendering dependencies) out of the measurement page's first chunk.
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({
        orientation: "landscape",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      for (let index = 0; index < GROWTH_CHART_TYPES.length; index += 1) {
        const image = await rasteriseSvg(
          await requestChartSvg(GROWTH_CHART_TYPES[index]),
        );
        if (index) pdf.addPage();
        const margin = 6;
        const maxWidth = pageWidth - margin * 2;
        const maxHeight = pageHeight - margin * 2;
        const ratio = image.width / image.height;
        let width = maxWidth;
        let height = width / ratio;
        if (height > maxHeight) {
          height = maxHeight;
          width = height * ratio;
        }
        pdf.addImage(
          image.dataUrl,
          "PNG",
          (pageWidth - width) / 2,
          (pageHeight - height) / 2,
          width,
          height,
          undefined,
          "FAST",
        );
      }
      pdf.setProperties({
        title: `Grafik Pertumbuhan WHO - ${childChartHeader(child)}`,
      });
      pdf.save(`grafik-pertumbuhan-who-${safeChildFileName(child)}.pdf`);
    } catch (cause) {
      window.alert(
        cause instanceof Error
          ? cause.message
          : "PDF grafik belum dapat diunduh.",
      );
    } finally {
      setExporting("");
    }
  };
  const graph =
    chartState.status === "success" && chartState.value
      ? sanitiseSvg(chartState.value)
      : "";
  return (
    <div
      className="growth-chart-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !exporting) onClose();
      }}
    >
      <section
        className="growth-chart-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="growth-chart-dialog-title"
      >
        <header className="growth-chart-header">
          <div>
            <h2 id="growth-chart-dialog-title">Grafik Pertumbuhan WHO</h2>
            <p>{childChartHeader(child)}</p>
          </div>
          <button
            type="button"
            className="growth-chart-close"
            onClick={onClose}
            disabled={Boolean(exporting)}
            aria-label="Tutup grafik pertumbuhan"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="growth-chart-body">
          <div
            className="growth-chart-tabs"
            role="tablist"
            aria-label="Pilih jenis grafik pertumbuhan"
          >
            {GROWTH_CHART_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={activeType === type}
                className={activeType === type ? "is-active" : ""}
                onClick={() => setActiveType(type)}
              >
                {GROWTH_CHART_LABELS[type]}
              </button>
            ))}
          </div>
          {graph ? (
            <div
              className="growth-chart-python-svg"
              role="img"
              aria-label={`${GROWTH_CHART_LABELS[activeType]}, grafik standar WHO dan hasil pengukuran anak`}
              dangerouslySetInnerHTML={{ __html: graph }}
            />
          ) : chartState.status === "loading" ? (
            <GrowthChartSkeleton />
          ) : (
            <div className="growth-chart-python-warning" role="status">
              Grafik Python belum tersedia:{" "}
              {chartState.error || "kesalahan tidak diketahui."}
            </div>
          )}
          <p className="growth-chart-footnote">
            Garis menunjukkan −3, −2, median, +2, dan +3 SD standar WHO. Kurva
            −1 dan +1 SD berwarna kuning khusus pada BB/PB atau BB/TB, IMT/U,
            LILA/U, dan LK/U. Titik hasil anak dihubungkan per segmen mengikuti
            warna jenis kelamin; garis terputus jika ada bulan tanpa pengukuran
            atau status O.
          </p>
          {Number(pythonState.value?.anomalies?.length || 0) > 0 ? (
            <div className="growth-chart-anomaly-note" role="alert">
              Ditemukan {pythonState.value.anomalies.length} titik anomali:
              tinggi/panjang badan lebih rendah dari pengukuran sebelumnya.
              Periksa ulang alat dan cara ukur.
            </div>
          ) : null}
          <GrowthAnalysisPanel state={pythonState} />
        </div>
        <footer className="growth-chart-actions">
          <AppButton
            type="button"
            variant="secondary"
            onClick={() => void downloadActivePng()}
            disabled={Boolean(exporting)}
          >
            {exporting === "png" ? (
              <>
                <Loader2 className="h-4 w-4" /> Menyiapkan PNG...
              </>
            ) : (
              <>
                <FileDown className="h-4 w-4" /> Unduh{" "}
                {GROWTH_CHART_LABELS[activeType]} (PNG)
              </>
            )}
          </AppButton>
          <AppButton
            type="button"
            onClick={() => void downloadAllPdf()}
            disabled={Boolean(exporting)}
          >
            {exporting === "pdf" ? (
              <>
                <Loader2 className="h-4 w-4" /> Menyiapkan PDF...
              </>
            ) : (
              <>
                <FileDown className="h-4 w-4" /> Unduh Semua Grafik (PDF)
              </>
            )}
          </AppButton>
        </footer>
      </section>
    </div>
  );
}
