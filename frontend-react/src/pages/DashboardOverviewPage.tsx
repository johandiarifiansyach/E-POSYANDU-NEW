import type { ReactNode, SVGAttributes } from 'react';
import type { DashboardStatsResponse, MonitoringStatus } from '../api/dashboardApi';
import type { PageState } from '../shared/pageState';
import { Card } from '../components/base/Card';
import SkeletonBlock from '../components/base/SkeletonBlock';
import SharedMetricCard from '../components/data-display/MetricCard';

export type DashboardOverviewPageProps = {
  stats: DashboardStatsResponse;
  pageState?: PageState<DashboardStatsResponse>;
  loading?: boolean;
  monitoringStatus?: MonitoringStatus | null;
  filterMonth: number;
  filterYear: number;
  ageGroup?: string;
  viewDesa?: string | null;
  viewPosyandu?: string | null;
};

type IconProps = SVGAttributes<SVGSVGElement>;

function Icon({ children, className = '', ...props }: IconProps & { children?: ReactNode }) {
  const hasAccessibleName = Boolean(props['aria-label'] || props['aria-labelledby']);
  return <svg {...props} className={`apple-symbol${className ? ` ${className}` : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false" {...(hasAccessibleName ? {} : { 'aria-hidden': true })}>{children}</svg>;
}

function ActivityIcon(props: IconProps) {
  return <Icon {...props}><path d="M2.5 12h4l2.35-7.3 4.3 14.6 2.35-7.3h6" /></Icon>;
}
function AlertTriangleIcon(props: IconProps) {
  return <Icon {...props}><path d="M10.35 4.25 2.7 18a2 2 0 0 0 1.75 3h15.1a2 2 0 0 0 1.75-3L13.65 4.25a1.9 1.9 0 0 0-3.3 0Z" /><path d="M12 9v4.4" /><circle cx="12" cy="17" r=".65" fill="currentColor" stroke="none" /></Icon>;
}
function BabyIcon(props: IconProps) {
  return <Icon {...props}><path d="M8.2 5.15A8.15 8.15 0 1 0 19.4 9.1" /><path d="M8.15 5.2c.55-2.15 3.85-2.9 5.15-1.05 1.1 1.55-.15 3.65-1.9 3.4-1.05-.15-1.55-1.15-1.15-2.05" /><circle cx="8.9" cy="12" r=".75" fill="currentColor" stroke="none" /><circle cx="15.1" cy="12" r=".75" fill="currentColor" stroke="none" /><path d="M9.3 16c1.55 1.2 3.85 1.2 5.4 0" /></Icon>;
}
function CircleOffIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9.25" /><path d="M5.45 5.45 18.55 18.55" /></Icon>;
}
function MinusIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 12h14" /></Icon>;
}
function ScaleIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="3.5" width="18" height="17.5" rx="4" /><path d="M7.25 10.25a4.75 4.75 0 0 1 9.5 0M12 10.25l2.55-2.15M7.5 17h9" /></Icon>;
}
function TrendingUpIcon(props: IconProps) {
  return <Icon {...props}><path d="m3.25 17.5 6.1-6.15 4.2 4.2 7.2-7.15" /><path d="M16.25 8.4h4.5v4.5" /></Icon>;
}
function UserPlusIcon(props: IconProps) {
  return <Icon {...props}><circle cx="9" cy="8" r="3.5" /><path d="M2.75 20c.35-3.65 2.65-6 6.25-6s5.9 2.35 6.25 6" /><circle cx="18" cy="9" r="3.25" /><path d="M18 7.35v3.3M16.35 9h3.3" /></Icon>;
}
function UsersIcon(props: IconProps) {
  return <Icon {...props}><circle cx="8.75" cy="8" r="3.25" /><path d="M2.5 19.75c.35-3.6 2.7-5.75 6.25-5.75S14.65 16.15 15 19.75" /><circle cx="16.75" cy="7.25" r="2.5" /><path d="M15.25 13.4c.5-.18 1-.27 1.55-.27 2.85 0 4.45 1.75 4.7 4.7" /></Icon>;
}

function MetricValue({ value, loading, className = '' }: { value: number | string; loading: boolean; className?: string }) {
  return loading ? <SkeletonBlock className={`dashboard-stat-skeleton-value ${className}`.trim()} /> : <>{value}</>;
}

function MetricPercent({ value, loading }: { value: string; loading: boolean }) {
  return loading ? <SkeletonBlock className="dashboard-stat-skeleton-percent" /> : <>{value}%</>;
}

function MetricProgress({ value, loading, colorClass }: { value: string; loading: boolean; colorClass: string }) {
  return loading ? <SkeletonBlock className="dashboard-stat-skeleton-progress" /> : <div className={`h-full ${colorClass} rounded-full`} style={{ width: `${value}%` }} />;
}

export default function DashboardOverviewPage({ stats: providedStats, pageState, loading = false, monitoringStatus }: DashboardOverviewPageProps) {
  const resolvedState: PageState<DashboardStatsResponse> = pageState ?? (loading ? { status: 'loading' } : { status: 'success', data: providedStats });
  const pageLoading = resolvedState.status === 'loading';
  const pageError = resolvedState.status === 'error' ? resolvedState.message : null;
  const stats = resolvedState.status === 'success' ? resolvedState.data : providedStats;
  const snapshotStale = !pageLoading && Boolean(stats.snapshotStale);
  const workerStatus = monitoringStatus?.worker?.status;
  const monitoringMessage = workerStatus === 'down'
    ? `Worker laporan tidak tersedia setelah ${monitoringStatus?.worker.consecutiveFailures || 3} pemeriksaan. Login dan input data tetap dapat digunakan.`
    : workerStatus === 'degraded' ? 'Worker laporan sedang lambat atau gagal diperiksa. Sistem akan memeriksa ulang otomatis.'
      : workerStatus === 'unconfigured' ? 'Alamat health check worker laporan belum dikonfigurasi.' : '';
  const storageStatus = monitoringStatus?.storage?.status;
  const storageMessage = storageStatus?.status === 'warning'
    ? 'Penyimpanan berkas mendekati batas 10 GB dan tidak dapat dibersihkan seluruhnya. Periksa lampiran permanen di R2.'
    : storageStatus?.status === 'cleaned' ? `${storageStatus.deletedObjects} file ekspor lama dibersihkan otomatis untuk menjaga kapasitas R2.` : '';
  const asiSummary = pageLoading ? <SkeletonBlock className="dashboard-stat-skeleton-asi" /> : <>{stats.asiEksklusif} <span className="text-base font-medium text-slate-500">/ {stats.asiTarget} bayi</span></>;
  const metricCardProps = [
    { label: 'S (Sasaran)', value: stats.S, className: 'apple-metric-blue', icon: <UsersIcon className="h-4 w-4 text-blue-500" />, subtitle: 'Total Balita Aktif' },
    { label: 'D (Ditimbang)', value: stats.D, className: 'apple-metric-green', icon: <ScaleIcon className="h-4 w-4 text-emerald-500" />, progress: stats.perD, progressColor: 'bg-emerald-500', progressTextColor: 'text-emerald-600' },
    { label: 'N (Naik)', value: stats.N, className: 'apple-metric-indigo', icon: <TrendingUpIcon className="h-4 w-4 text-indigo-500" />, progress: stats.perN, progressColor: 'bg-indigo-500', progressTextColor: 'text-indigo-600' },
    { label: 'T (Tidak Naik)', value: stats.T, className: 'apple-metric-orange', icon: <MinusIcon className="h-4 w-4 text-amber-500" />, progress: stats.perT, progressColor: 'bg-amber-500', progressTextColor: 'text-amber-600' },
    { label: 'B (Bayi Baru)', value: stats.B, className: 'apple-metric-cyan', icon: <UserPlusIcon className="h-4 w-4 text-cyan-500" />, subtitle: 'Diinput bulan ini' },
    { label: 'O (Tidak Ditimbang)', value: stats.O ?? '-', className: 'apple-metric-red', icon: <CircleOffIcon className="h-4 w-4 text-rose-500" />, subtitle: 'Bulan sebelumnya' }
  ];
  return <div className="apple-page space-y-6" aria-busy={pageLoading ? 'true' : 'false'}>
    <div className="apple-page-header flex items-end justify-between"><h2 className="apple-section-title dashboard-overview-title">Capaian Program SKDN</h2>{pageLoading ? <ActivityIcon className="h-5 w-5 animate-spin text-emerald-600" aria-label="Memuat ringkasan" /> : null}</div>
    {pageError ? <div role="alert" className="ios-inline-notification ios-inline-notification-error system-health-notice">{pageError}</div> : null}
    {snapshotStale && !pageError ? <div role="status" aria-live="polite" className="ios-inline-notification ios-inline-notification-warning system-health-notice">Menampilkan snapshot dashboard terakhir. Data akan disegarkan setelah analisis Python selesai.</div> : null}
    {monitoringMessage ? <div role="status" aria-live="polite" className={`ios-inline-notification ${workerStatus === 'down' ? 'ios-inline-notification-error' : 'ios-inline-notification-warning'} system-health-notice flex items-start gap-3`}><AlertTriangleIcon className="h-5 w-5 flex-shrink-0" /><div><p className="font-bold">Status pemrosesan laporan</p><p className="mt-1">{monitoringMessage}</p></div></div> : null}
    {storageMessage ? <div role="status" aria-live="polite" className={`ios-inline-notification ${storageStatus?.status === 'warning' ? 'ios-inline-notification-error' : 'ios-inline-notification-warning'} system-health-notice flex items-start gap-3`}><AlertTriangleIcon className="h-5 w-5 flex-shrink-0" /><div><p className="font-bold">Kapasitas penyimpanan ekspor</p><p className="mt-1">{storageMessage}</p></div></div> : null}
    <div className="apple-metrics-grid grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">{metricCardProps.map((item) => <SharedMetricCard {...item} loading={pageLoading} key={item.label} />)}</div>
    <h2 className="apple-section-title mt-6">Capaian ASI Eksklusif</h2>
    <Card className="apple-feature-card p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="apple-symbol-tile apple-symbol-tile-cyan"><BabyIcon className="h-5 w-5" /></div><div><p className="font-bold text-slate-700">Bayi usia 6 bulan</p><p className="text-xs text-slate-500">Pembanding (S): seluruh balita usia 6 bulan</p></div></div><div className="sm:text-right"><p className="text-2xl font-bold text-slate-800">{asiSummary}</p><p className="text-sm font-bold text-sky-600"><MetricPercent value={stats.perAsiEksklusif} loading={pageLoading} /></p></div></div><div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100"><MetricProgress value={stats.perAsiEksklusif} loading={pageLoading} colorClass="bg-sky-500" /></div></Card>
    <h2 className="apple-section-title mt-6">Prevalensi Status Gizi</h2>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">{[
      { title: 'Underweight (BB/U)', value: stats.underweight, percent: stats.perUnderweight, card: 'prevalence-red', dot: 'bg-rose-500', text: 'text-rose-600', progress: 'bg-rose-500' },
      { title: 'Stunting (TB/U)', value: stats.stunting, percent: stats.perStunting, card: 'prevalence-orange', dot: 'bg-orange-500', text: 'text-orange-600', progress: 'bg-orange-500' },
      { title: 'Wasting (BB/TB)', value: stats.wasting, percent: stats.perWasting, card: 'prevalence-yellow', dot: 'bg-yellow-500', text: 'text-yellow-600', progress: 'bg-yellow-500' }
    ].map((item) => <Card className={`apple-prevalence-card ${item.card} flex flex-col justify-between p-5`} key={item.title}><div><div className="mb-2 flex items-center gap-2"><span className={`prevalence-dot ${item.dot}`} aria-hidden="true" /><span className="font-bold text-slate-700">{item.title}</span></div><div className="flex items-baseline gap-2"><span className="text-3xl font-bold text-slate-800"><MetricValue value={item.value} loading={pageLoading} className="dashboard-stat-skeleton-prevalence" /></span><span className="text-sm text-slate-500">Balita</span></div></div><div className="mt-4"><div className="mb-1 flex justify-between text-xs"><span className="text-slate-500">Persentase</span><span className={`font-bold ${item.text}`}><MetricPercent value={item.percent} loading={pageLoading} /></span></div><div className="h-2 w-full overflow-hidden rounded-full bg-slate-100"><MetricProgress value={item.percent} loading={pageLoading} colorClass={item.progress} /></div></div></Card>)} </div>
  </div>;
}
