import Native from '../runtime/dom';
import type { DashboardStatsResponse, MonitoringStatus } from '../api/dashboardApi';
import type { PageState } from '../shared/pageState';
import { Activity, AlertTriangle, Baby, CircleOff, Minus, Scale, TrendingUp, UserPlus, Users } from '../ui/icons';
import { Card } from '../ui/dashboardPrimitives';
import { MONTHS } from './DashboardApp';

type DashboardOverviewPageProps = {
    stats: DashboardStatsResponse;
    pageState?: PageState<DashboardStatsResponse>;
    loading?: boolean;
    monitoringStatus?: MonitoringStatus | null;
    filterMonth: number;
    filterYear: number;
    viewDesa?: string | null;
    viewPosyandu?: string | null;
};

export default function DashboardOverviewPage({ stats: providedStats, pageState, loading = false, monitoringStatus, filterMonth, filterYear, viewDesa, viewPosyandu }: DashboardOverviewPageProps) {
    const resolvedState: PageState<DashboardStatsResponse> = pageState ?? (loading
        ? { status: 'loading' }
        : { status: 'success', data: providedStats });
    const pageLoading = resolvedState.status === 'loading';
    const pageError = resolvedState.status === 'error' ? resolvedState.message : null;
    const stats = resolvedState.status === 'success' ? resolvedState.data : providedStats;
    const workerStatus = monitoringStatus?.worker?.status;
    const monitoringMessage = workerStatus === 'down'
        ? `Worker laporan tidak tersedia setelah ${monitoringStatus?.worker.consecutiveFailures || 3} pemeriksaan. Login dan input data tetap dapat digunakan.`
        : workerStatus === 'degraded'
            ? 'Worker laporan sedang lambat atau gagal diperiksa. Sistem akan memeriksa ulang otomatis.'
            : workerStatus === 'unconfigured'
                ? 'Alamat health check worker laporan belum dikonfigurasi.'
            : '';
    const storageStatus = monitoringStatus?.storage?.status;
    const storageMessage = storageStatus?.status === 'warning'
        ? 'Penyimpanan berkas mendekati batas 10 GB dan tidak dapat dibersihkan seluruhnya. Periksa lampiran permanen di R2.'
        : storageStatus?.status === 'cleaned'
            ? `${storageStatus.deletedObjects} file ekspor lama dibersihkan otomatis untuk menjaga kapasitas R2.`
            : '';
    return (Native.createElement("div", { className: "apple-page space-y-6" },
        Native.createElement("div", { className: "apple-page-header flex justify-between items-end" },
            Native.createElement("div", null,
                Native.createElement("h2", { className: "apple-page-title" }, "Capaian Program SKDN"),
                Native.createElement("p", { className: "text-slate-500" },
                    "Laporan bulan ",
                    Native.createElement("span", { className: "font-bold text-emerald-600" },
                        MONTHS[filterMonth - 1],
                        " ",
                        filterYear),
                    viewDesa && ` - ${viewDesa}`,
                    " ",
                    viewPosyandu && ` - ${viewPosyandu}`)),
            pageLoading && Native.createElement(Activity, { className: "w-5 h-5 animate-spin text-emerald-600", "aria-label": "Memuat ringkasan" })),
        pageError && Native.createElement("div", { role: "alert", className: "ios-inline-notification ios-inline-notification-error system-health-notice" },
            pageError),
        monitoringMessage && Native.createElement("div", { role: "status", "aria-live": "polite", className: `ios-inline-notification ${workerStatus === 'down' ? 'ios-inline-notification-error' : 'ios-inline-notification-warning'} system-health-notice flex items-start gap-3` },
            Native.createElement(AlertTriangle, { className: "w-5 h-5 flex-shrink-0" }),
            Native.createElement("div", null,
                Native.createElement("p", { className: "font-bold" }, "Status pemrosesan laporan"),
                Native.createElement("p", { className: "mt-1" }, monitoringMessage))),
        storageMessage && Native.createElement("div", { role: "status", "aria-live": "polite", className: `ios-inline-notification ${storageStatus?.status === 'warning' ? 'ios-inline-notification-error' : 'ios-inline-notification-warning'} system-health-notice flex items-start gap-3` },
            Native.createElement(AlertTriangle, { className: "w-5 h-5 flex-shrink-0" }),
            Native.createElement("div", null,
                Native.createElement("p", { className: "font-bold" }, "Kapasitas penyimpanan ekspor"),
                Native.createElement("p", { className: "mt-1" }, storageMessage))),
        Native.createElement("div", { className: "apple-metrics-grid grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4" },
            Native.createElement(Card, { className: "apple-metric-card apple-metric-blue p-4" },
                Native.createElement("div", { className: "flex items-center justify-between mb-2" },
                    Native.createElement("span", { className: "text-xs font-bold text-slate-400 uppercase" }, "S (Sasaran)"),
                    Native.createElement(Users, { className: "w-4 h-4 text-blue-500" })),
                Native.createElement("p", { className: "text-2xl font-bold text-slate-800" }, stats.S),
                Native.createElement("p", { className: "text-xs text-slate-400" }, "Total Balita Aktif")),
            Native.createElement(Card, { className: "apple-metric-card apple-metric-green p-4" },
                Native.createElement("div", { className: "flex items-center justify-between mb-2" },
                    Native.createElement("span", { className: "text-xs font-bold text-slate-400 uppercase" }, "D (Ditimbang)"),
                    Native.createElement(Scale, { className: "w-4 h-4 text-emerald-500" })),
                Native.createElement("p", { className: "text-2xl font-bold text-slate-800" }, stats.D),
                Native.createElement("div", { className: "flex items-center gap-1 mt-1" },
                    Native.createElement("div", { className: "h-1.5 w-full bg-slate-100 rounded-full overflow-hidden" },
                        Native.createElement("div", { className: "h-full bg-emerald-500 rounded-full", style: { width: `${stats.perD}%` } })),
                    Native.createElement("span", { className: "text-xs font-bold text-emerald-600" },
                        stats.perD,
                        "%"))),
            Native.createElement(Card, { className: "apple-metric-card apple-metric-indigo p-4" },
                Native.createElement("div", { className: "flex items-center justify-between mb-2" },
                    Native.createElement("span", { className: "text-xs font-bold text-slate-400 uppercase" }, "N (Naik)"),
                    Native.createElement(TrendingUp, { className: "w-4 h-4 text-indigo-500" })),
                Native.createElement("p", { className: "text-2xl font-bold text-slate-800" }, stats.N),
                Native.createElement("div", { className: "flex items-center gap-1 mt-1" },
                    Native.createElement("div", { className: "h-1.5 w-full bg-slate-100 rounded-full overflow-hidden" },
                        Native.createElement("div", { className: "h-full bg-indigo-500 rounded-full", style: { width: `${stats.perN}%` } })),
                    Native.createElement("span", { className: "text-xs font-bold text-indigo-600" },
                        stats.perN,
                        "%"))),
            Native.createElement(Card, { className: "apple-metric-card apple-metric-orange p-4" },
                Native.createElement("div", { className: "flex items-center justify-between mb-2" },
                    Native.createElement("span", { className: "text-xs font-bold text-slate-400 uppercase" }, "T (Tidak Naik)"),
                    Native.createElement(Minus, { className: "w-4 h-4 text-amber-500" })),
                Native.createElement("p", { className: "text-2xl font-bold text-slate-800" }, stats.T),
                Native.createElement("div", { className: "flex items-center gap-1 mt-1" },
                    Native.createElement("div", { className: "h-1.5 w-full bg-slate-100 rounded-full overflow-hidden" },
                        Native.createElement("div", { className: "h-full bg-amber-500 rounded-full", style: { width: `${stats.perT}%` } })),
                    Native.createElement("span", { className: "text-xs font-bold text-amber-600" },
                        stats.perT,
                        "%"))),
            Native.createElement(Card, { className: "apple-metric-card apple-metric-cyan p-4" },
                Native.createElement("div", { className: "flex items-center justify-between mb-2" },
                    Native.createElement("span", { className: "text-xs font-bold text-slate-400 uppercase" }, "B (Bayi Baru)"),
                    Native.createElement(UserPlus, { className: "w-4 h-4 text-cyan-500" })),
                Native.createElement("p", { className: "text-2xl font-bold text-slate-800" }, stats.B),
                Native.createElement("p", { className: "text-xs text-slate-400" }, "Diinput bulan ini")),
            Native.createElement(Card, { className: "apple-metric-card apple-metric-red p-4" },
                Native.createElement("div", { className: "flex items-center justify-between mb-2" },
                    Native.createElement("span", { className: "text-xs font-bold text-slate-400 uppercase" }, "O (Tidak Ditimbang)"),
                    Native.createElement(CircleOff, { className: "w-4 h-4 text-rose-500" })),
                Native.createElement("p", { className: "text-2xl font-bold text-slate-800" }, stats.O ?? '-'),
                Native.createElement("p", { className: "text-xs text-slate-400" }, "Bulan sebelumnya"))),
        Native.createElement("h2", { className: "apple-section-title mt-6" }, "Capaian ASI Eksklusif"),
        Native.createElement(Card, { className: "apple-feature-card p-5" },
            Native.createElement("div", { className: "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4" },
                Native.createElement("div", { className: "flex items-center gap-3" },
                    Native.createElement("div", { className: "apple-symbol-tile apple-symbol-tile-cyan" },
                        Native.createElement(Baby, { className: "w-5 h-5" })),
                    Native.createElement("div", null,
                        Native.createElement("p", { className: "font-bold text-slate-700" }, "Bayi usia 6 bulan"),
                        Native.createElement("p", { className: "text-xs text-slate-500" }, "Tercatat ASI eksklusif pada bulan laporan"))),
                Native.createElement("div", { className: "sm:text-right" },
                    Native.createElement("p", { className: "text-2xl font-bold text-slate-800" },
                        stats.asiEksklusif,
                        " ",
                        Native.createElement("span", { className: "text-base font-medium text-slate-500" },
                            "/ ",
                            stats.asiTarget,
                            " bayi")),
                    Native.createElement("p", { className: "text-sm font-bold text-sky-600" },
                        stats.perAsiEksklusif,
                        "%"))),
            Native.createElement("div", { className: "mt-4 h-2 w-full bg-slate-100 rounded-full overflow-hidden" },
                Native.createElement("div", { className: "h-full bg-sky-500 rounded-full", style: { width: `${stats.perAsiEksklusif}%` } }))),
        Native.createElement("h2", { className: "apple-section-title mt-6" }, "Prevalensi Status Gizi"),
        Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
            Native.createElement(Card, { className: "apple-prevalence-card prevalence-red p-5 flex flex-col justify-between" },
                Native.createElement("div", null,
                    Native.createElement("div", { className: "flex items-center gap-2 mb-2" },
                        Native.createElement("span", { className: "prevalence-dot bg-rose-500", "aria-hidden": "true" }),
                        Native.createElement("span", { className: "font-bold text-slate-700" }, "Underweight (BB/U)")),
                    Native.createElement("div", { className: "flex items-baseline gap-2" },
                        Native.createElement("span", { className: "text-3xl font-bold text-slate-800" }, stats.underweight),
                        Native.createElement("span", { className: "text-sm text-slate-500" }, "Balita"))),
                Native.createElement("div", { className: "mt-4" },
                    Native.createElement("div", { className: "flex justify-between text-xs mb-1" },
                        Native.createElement("span", { className: "text-slate-500" }, "Persentase"),
                        Native.createElement("span", { className: "font-bold text-rose-600" },
                            stats.perUnderweight,
                            "%")),
                    Native.createElement("div", { className: "h-2 w-full bg-slate-100 rounded-full overflow-hidden" },
                        Native.createElement("div", { className: "h-full bg-rose-500 rounded-full", style: { width: `${stats.perUnderweight}%` } })))),
            Native.createElement(Card, { className: "apple-prevalence-card prevalence-orange p-5 flex flex-col justify-between" },
                Native.createElement("div", null,
                    Native.createElement("div", { className: "flex items-center gap-2 mb-2" },
                        Native.createElement("span", { className: "prevalence-dot bg-orange-500", "aria-hidden": "true" }),
                        Native.createElement("span", { className: "font-bold text-slate-700" }, "Stunting (TB/U)")),
                    Native.createElement("div", { className: "flex items-baseline gap-2" },
                        Native.createElement("span", { className: "text-3xl font-bold text-slate-800" }, stats.stunting),
                        Native.createElement("span", { className: "text-sm text-slate-500" }, "Balita"))),
                Native.createElement("div", { className: "mt-4" },
                    Native.createElement("div", { className: "flex justify-between text-xs mb-1" },
                        Native.createElement("span", { className: "text-slate-500" }, "Persentase"),
                        Native.createElement("span", { className: "font-bold text-orange-600" },
                            stats.perStunting,
                            "%")),
                    Native.createElement("div", { className: "h-2 w-full bg-slate-100 rounded-full overflow-hidden" },
                        Native.createElement("div", { className: "h-full bg-orange-500 rounded-full", style: { width: `${stats.perStunting}%` } })))),
            Native.createElement(Card, { className: "apple-prevalence-card prevalence-yellow p-5 flex flex-col justify-between" },
                Native.createElement("div", null,
                    Native.createElement("div", { className: "flex items-center gap-2 mb-2" },
                        Native.createElement("span", { className: "prevalence-dot bg-yellow-500", "aria-hidden": "true" }),
                        Native.createElement("span", { className: "font-bold text-slate-700" }, "Wasting (BB/TB)")),
                    Native.createElement("div", { className: "flex items-baseline gap-2" },
                        Native.createElement("span", { className: "text-3xl font-bold text-slate-800" }, stats.wasting),
                        Native.createElement("span", { className: "text-sm text-slate-500" }, "Balita"))),
                Native.createElement("div", { className: "mt-4" },
                    Native.createElement("div", { className: "flex justify-between text-xs mb-1" },
                        Native.createElement("span", { className: "text-slate-500" }, "Persentase"),
                        Native.createElement("span", { className: "font-bold text-yellow-600" },
                            stats.perWasting,
                            "%")),
                    Native.createElement("div", { className: "h-2 w-full bg-slate-100 rounded-full overflow-hidden" },
                        Native.createElement("div", { className: "h-full bg-yellow-500 rounded-full", style: { width: `${stats.perWasting}%` } })))))));
}
