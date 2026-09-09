import { useEffect, useMemo, useState } from 'react';
import { getAdminMonitoringStreamUrl, type AdminMonitoringSample } from '../../api/adminApi';
import { Card, SkeletonBlock } from '../../components/base';
import type { DashboardUser } from '../../types';

type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'paused';
type MetricKey = 'cpuPercent' | 'memoryPercent' | 'memoryUsedBytes' | 'loadAverage' | 'diskReadOperationsPerSecond' | 'diskWriteOperationsPerSecond' | 'diskReadBytesPerSecond' | 'diskWriteBytesPerSecond' | 'networkReceiveBytesPerSecond' | 'networkTransmitBytesPerSecond';
type MetricUnit = 'percent' | 'number' | 'bytes' | 'bytesRate';
type Metric = { key: MetricKey; title: string; description: string; color: string; unit: MetricUnit; fixedMaximum?: number };
const MAX_POINTS = 60;
const METRICS: Metric[] = [
  { key: 'cpuPercent', title: 'CPU Utilization', description: 'Persentase waktu CPU yang sedang digunakan.', color: '#0f766e', unit: 'percent', fixedMaximum: 100 },
  { key: 'memoryPercent', title: 'Memory Utilization', description: 'Persentase memori runtime Oracle yang sedang digunakan.', color: '#2563eb', unit: 'percent', fixedMaximum: 100 },
  { key: 'memoryUsedBytes', title: 'Memory Used Bytes', description: 'Jumlah memori runtime Oracle yang sedang digunakan.', color: '#4f46e5', unit: 'bytes' },
  { key: 'loadAverage', title: 'Load Average', description: 'Rata-rata beban sistem selama satu menit.', color: '#7c3aed', unit: 'number' },
  { key: 'diskReadOperationsPerSecond', title: 'Disk Read I/O', description: 'Jumlah operasi baca disk setiap detik.', color: '#0891b2', unit: 'number' },
  { key: 'diskWriteOperationsPerSecond', title: 'Disk Write I/O', description: 'Jumlah operasi tulis disk setiap detik.', color: '#ea580c', unit: 'number' },
  { key: 'diskReadBytesPerSecond', title: 'Disk Read Bytes', description: 'Laju byte yang dibaca dari disk.', color: '#0284c7', unit: 'bytesRate' },
  { key: 'diskWriteBytesPerSecond', title: 'Disk Write Bytes', description: 'Laju byte yang ditulis ke disk.', color: '#dc2626', unit: 'bytesRate' },
  { key: 'networkReceiveBytesPerSecond', title: 'Network Receive Bytes', description: 'Laju trafik yang diterima runtime API.', color: '#059669', unit: 'bytesRate' },
  { key: 'networkTransmitBytesPerSecond', title: 'Network Transmit Bytes', description: 'Laju trafik yang dikirim runtime API.', color: '#d97706', unit: 'bytesRate' }
];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validSample(value: unknown): value is AdminMonitoringSample {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AdminMonitoringSample>;
  return typeof candidate.timestamp === 'string' && Boolean(candidate.system) && Boolean(candidate.services)
    && finite(candidate.system?.cpuPercent) && finite(candidate.system?.memoryPercent) && finite(candidate.system?.loadAverage);
}
function formatBytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let amount = Math.max(0, value); let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}`;
}
function formatClock(value: string) {
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' }).format(date);
}
function metricValue(sample: AdminMonitoringSample, metric: Metric) {
  const value = Number(sample.system[metric.key]);
  if (metric.unit === 'percent') return `${value.toFixed(1)}%`;
  if (metric.unit === 'bytes') return formatBytes(value);
  if (metric.unit === 'bytesRate') return `${formatBytes(value)}/dtk`;
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function MonitoringChart({ metric, samples }: { metric: Metric; samples: AdminMonitoringSample[] }) {
  const values = samples.map((sample) => Math.max(0, Number(sample.system[metric.key]) || 0));
  const maximum = metric.fixedMaximum || Math.max(1, ...values) * 1.12;
  const points = values.map((value, index) => `${values.length <= 1 ? 42 : 42 + index / (values.length - 1) * 542},${166 - Math.min(value / maximum, 1) * 148}`).join(' ');
  const current = samples[samples.length - 1];
  return <article className="admin-monitoring-chart"><div className="admin-chart-heading"><div><h4>{metric.title}</h4><p>{metric.description}</p></div><strong>{current ? metricValue(current, metric) : '—'}</strong></div><svg viewBox="0 0 600 210" role="img" aria-label={`${metric.title}: ${current ? metricValue(current, metric) : 'menunggu data'}`} className="h-52 w-full"><line x1="42" x2="584" y1="166" y2="166" className="admin-chart-axis" />{[0, 1, 2, 3].map((line) => <line key={line} x1="42" x2="584" y1={18 + line / 3 * 148} y2={18 + line / 3 * 148} className="admin-chart-grid-line" />)}{points ? <polyline points={points} fill="none" stroke={metric.color} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /> : null}<text x="42" y="196" className="admin-chart-time">{samples[0] ? formatClock(samples[0].timestamp) : 'Menunggu data'}</text><text x="584" y="196" textAnchor="end" className="admin-chart-time">{current ? formatClock(current.timestamp) : ''}</text></svg><p className="admin-chart-window">Riwayat aktif {Math.max(0, Math.round(values.length * 5 / 60))} menit · {values.length}/{MAX_POINTS} titik</p></article>;
}

export type ReactAdminMonitoringPageProps = { user?: DashboardUser };

export default function ReactAdminMonitoringPage({ user }: ReactAdminMonitoringPageProps) {
  const [samples, setSamples] = useState<AdminMonitoringSample[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let source: EventSource | null = null; let disposed = false;
    const disconnect = () => { source?.close(); source = null; if (!disposed) setStatus('paused'); };
    const connect = () => {
      if (disposed || source || document.visibilityState !== 'visible' || !navigator.onLine) { if (!disposed) setStatus('paused'); return; }
      setStatus('connecting'); setError(null); const next = new EventSource(getAdminMonitoringStreamUrl(), { withCredentials: true }); source = next;
      next.onopen = () => { if (!disposed) setStatus('live'); };
      next.addEventListener('metrics', (event: MessageEvent<string>) => {
        try { const parsed: unknown = JSON.parse(event.data); if (!validSample(parsed)) throw new Error('Format metrik tidak valid.'); setSamples((current) => [...current, { ...parsed, sequence: finite(parsed.sequence) ? parsed.sequence : ((current.length ? current[current.length - 1].sequence : 0) || 0) + 1 }].slice(-MAX_POINTS)); setStatus('live'); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Data monitoring tidak valid.'); }
      });
      next.onerror = () => { if (!disposed) { source?.close(); source = null; setStatus('reconnecting'); setError('Koneksi realtime terputus. Sistem sedang menyambung ulang otomatis.'); window.setTimeout(connect, 3000); } };
    };
    const visibility = () => document.visibilityState === 'visible' && navigator.onLine ? connect() : disconnect();
    connect(); document.addEventListener('visibilitychange', visibility); window.addEventListener('online', connect); window.addEventListener('offline', disconnect);
    return () => { disposed = true; source?.close(); source = null; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', connect); window.removeEventListener('offline', disconnect); };
  }, []);
  const latest = samples.length ? samples[samples.length - 1] : undefined; const services = useMemo(() => latest ? [['API Utama', latest.services.api], ['Database', latest.services.database], ['Redis', latest.services.redis], ['Data Processing', latest.services.dataProcessingWorker || latest.services.nutritionWorker]] as Array<[string, 'online' | 'offline' | undefined]> : [], [latest]);
  return <div className="apple-page space-y-5" data-react-admin-monitoring="true"><div><h2 className="apple-page-title">Monitoring Realtime</h2><p className="text-sm text-slate-500">Metrik layanan hanya dibuka untuk administrator; koneksi berhenti saat tab ditinggalkan.</p></div><Card className="p-5"><div className="flex items-center justify-between"><div><h3 className="text-lg font-bold text-slate-800">Status layanan</h3><p className="text-sm text-slate-500">{user?.role || 'Administrator'}</p></div><span className={`admin-stream-state is-${status}`}>{status === 'live' ? '● Realtime aktif' : status === 'paused' ? 'Dijeda' : status === 'reconnecting' ? 'Menyambung ulang' : 'Menghubungkan'}</span></div>{error ? <p role="status" className="ios-inline-notification ios-inline-notification-warning mt-4">{error}</p> : null}{latest ? <div className="admin-live-summary mt-5"><article><span>CPU</span><strong>{latest.system.cpuPercent.toFixed(1)}%</strong></article><article><span>Memori</span><strong>{latest.system.memoryPercent.toFixed(1)}%</strong><small>{formatBytes(latest.system.memoryUsedBytes)} / {formatBytes(latest.system.memoryTotalBytes)}</small></article><article><span>Load average</span><strong>{latest.system.loadAverage.toFixed(2)}</strong></article><article><span>Sampel terakhir</span><strong>{formatClock(latest.timestamp)}</strong><small>WIB</small></article></div> : <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><SkeletonBlock className="h-5 w-5 rounded-full" /> Menunggu sampel pertama…</div>}<div className="admin-live-services mt-4">{services.map(([label, service]) => <article key={label}><strong>{label}</strong><span className={`is-${service || 'offline'}`}>{service === 'online' ? 'Online' : 'Offline'}</span></article>)}</div></Card><div className="admin-monitoring-grid">{METRICS.map((metric) => <MonitoringChart key={metric.key} metric={metric} samples={samples} />)}</div></div>;
}
