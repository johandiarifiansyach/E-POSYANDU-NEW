import Native, { useEffect, useMemo, useState } from '../runtime/dom';
import { getAdminMonitoringStreamUrl, type AdminMonitoringSample } from '../api/adminApi';
import { Activity, Clock, Loader2 } from '../ui/icons';

type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'paused';
type MetricKey =
    | 'cpuPercent'
    | 'memoryPercent'
    | 'memoryUsedBytes'
    | 'loadAverage'
    | 'diskReadOperationsPerSecond'
    | 'diskWriteOperationsPerSecond'
    | 'diskReadBytesPerSecond'
    | 'diskWriteBytesPerSecond'
    | 'networkReceiveBytesPerSecond'
    | 'networkTransmitBytesPerSecond';

type MetricDefinition = {
    key: MetricKey;
    title: string;
    description: string;
    unit: 'percent' | 'number' | 'bytes' | 'bytesRate';
    color: string;
    fixedMaximum?: number;
};

const MAX_POINTS = 60;
const METRICS: MetricDefinition[] = [
    { key: 'cpuPercent', title: 'CPU Utilization', description: 'Persentase waktu CPU yang sedang digunakan.', unit: 'percent', color: '#0f766e', fixedMaximum: 100 },
    { key: 'memoryPercent', title: 'Memory Utilization', description: 'Persentase memori runtime Oracle yang sedang digunakan.', unit: 'percent', color: '#2563eb', fixedMaximum: 100 },
    { key: 'memoryUsedBytes', title: 'Memory Used Bytes', description: 'Jumlah memori runtime Oracle yang sedang digunakan.', unit: 'bytes', color: '#4f46e5' },
    { key: 'loadAverage', title: 'Load Average', description: 'Rata-rata beban sistem selama satu menit.', unit: 'number', color: '#7c3aed' },
    { key: 'diskReadOperationsPerSecond', title: 'Disk Read I/O', description: 'Jumlah operasi baca disk setiap detik.', unit: 'number', color: '#0891b2' },
    { key: 'diskWriteOperationsPerSecond', title: 'Disk Write I/O', description: 'Jumlah operasi tulis disk setiap detik.', unit: 'number', color: '#ea580c' },
    { key: 'diskReadBytesPerSecond', title: 'Disk Read Bytes', description: 'Laju byte yang dibaca dari disk.', unit: 'bytesRate', color: '#0284c7' },
    { key: 'diskWriteBytesPerSecond', title: 'Disk Write Bytes', description: 'Laju byte yang ditulis ke disk.', unit: 'bytesRate', color: '#dc2626' },
    { key: 'networkReceiveBytesPerSecond', title: 'Network Receive Bytes', description: 'Laju trafik yang diterima runtime API.', unit: 'bytesRate', color: '#059669' },
    { key: 'networkTransmitBytesPerSecond', title: 'Network Transmit Bytes', description: 'Laju trafik yang dikirim runtime API.', unit: 'bytesRate', color: '#d97706' }
];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validSample = (value: unknown): value is AdminMonitoringSample => {
    if (!value || typeof value !== 'object') return false;
    const sample = value as Partial<AdminMonitoringSample>;
    return typeof sample.timestamp === 'string'
        && Boolean(sample.system)
        && finite(sample.system?.cpuPercent)
        && finite(sample.system?.memoryPercent)
        && finite(sample.system?.loadAverage)
        && Boolean(sample.services);
};
const formatClock = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('id-ID', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta'
    }).format(date);
};
const formatBytes = (value: number, suffix = '') => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = Math.max(0, value);
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    const decimals = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(decimals)} ${units[unit]}${suffix}`;
};
const formatMetric = (value: number, unit: MetricDefinition['unit']) => {
    if (unit === 'percent') return `${value.toFixed(1)}%`;
    if (unit === 'bytes') return formatBytes(value);
    if (unit === 'bytesRate') return formatBytes(value, '/dtk');
    return value >= 100 ? value.toFixed(0) : value.toFixed(2);
};
const statusText = (status: StreamStatus) => ({
    connecting: 'Menghubungkan', live: 'Realtime aktif', reconnecting: 'Menyambung ulang', paused: 'Dijeda'
}[status]);

function MonitoringChart({ definition, samples }: { definition: MetricDefinition; samples: AdminMonitoringSample[] }) {
    const values = samples.map((sample) => Math.max(0, Number(sample.system[definition.key]) || 0));
    const current = values[values.length - 1] || 0;
    const automaticMaximum = Math.max(1, ...values) * 1.12;
    const maximum = definition.fixedMaximum || automaticMaximum;
    const width = 600;
    const height = 210;
    const left = 42;
    const right = 584;
    const top = 18;
    const bottom = 166;
    const points = values.map((value, index) => {
        const x = values.length <= 1 ? left : left + (index / (values.length - 1)) * (right - left);
        const y = bottom - Math.min(value / maximum, 1) * (bottom - top);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const firstTime = samples[0]?.timestamp;
    const lastTime = samples[samples.length - 1]?.timestamp;

    return Native.createElement('article', { className: 'admin-monitoring-chart' },
        Native.createElement('div', { className: 'admin-chart-heading' },
            Native.createElement('div', null,
                Native.createElement('h4', null, definition.title),
                Native.createElement('p', null, definition.description)),
            Native.createElement('strong', null, formatMetric(current, definition.unit))),
        Native.createElement('div', { className: 'admin-chart-filters' },
            Native.createElement('span', null, 'Interval 5 detik'),
            Native.createElement('span', null, 'Realtime')),
        Native.createElement('div', { className: 'admin-chart-canvas' },
            Native.createElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${definition.title}: ${formatMetric(current, definition.unit)}` },
                [0, 1, 2, 3].map((line) => {
                    const y = top + (line / 3) * (bottom - top);
                    return Native.createElement('line', { key: line, x1: left, x2: right, y1: y, y2: y, className: 'admin-chart-grid-line' });
                }),
                Native.createElement('line', { x1: left, x2: right, y1: bottom, y2: bottom, className: 'admin-chart-axis' }),
                points && Native.createElement('polyline', { points, fill: 'none', stroke: definition.color, strokeWidth: '3.5', strokeLinecap: 'round', strokeLinejoin: 'round', className: 'admin-chart-line' }),
                values.length > 0 && Native.createElement('circle', {
                    cx: values.length <= 1 ? left : right,
                    cy: bottom - Math.min(current / maximum, 1) * (bottom - top),
                    r: '4.5', fill: definition.color, className: 'admin-chart-current-point'
                }),
                Native.createElement('text', { x: left, y: 196, className: 'admin-chart-time' }, firstTime ? formatClock(firstTime) : 'Menunggu data'),
                Native.createElement('text', { x: right, y: 196, textAnchor: 'end', className: 'admin-chart-time' }, lastTime ? formatClock(lastTime) : ''),
                Native.createElement('text', { x: 34, y: 26, textAnchor: 'end', className: 'admin-chart-value' }, formatMetric(maximum, definition.unit)),
                Native.createElement('text', { x: 34, y: bottom + 4, textAnchor: 'end', className: 'admin-chart-value' }, '0'))),
        Native.createElement('p', { className: 'admin-chart-window' }, `Riwayat aktif ${Math.max(0, Math.round(values.length * 5 / 60))} menit · ${values.length}/${MAX_POINTS} titik`));
}

export default function AdminMonitoringPanel() {
    const [samples, setSamples] = useState<AdminMonitoringSample[]>([]);
    const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
    const [streamError, setStreamError] = useState<string | null>(null);

    useEffect(() => {
        let source: EventSource | null = null;
        let disposed = false;
        const disconnect = (paused = true) => {
            source?.close();
            source = null;
            if (!disposed && paused) setStreamStatus('paused');
        };
        const connect = () => {
            if (disposed || source || document.visibilityState !== 'visible' || !navigator.onLine) {
                if (!disposed && (document.visibilityState !== 'visible' || !navigator.onLine)) setStreamStatus('paused');
                return;
            }
            setStreamStatus('connecting');
            setStreamError(null);
            const nextSource = new EventSource(getAdminMonitoringStreamUrl(), { withCredentials: true });
            source = nextSource;
            nextSource.onopen = () => {
                if (!disposed) setStreamStatus('live');
            };
            nextSource.addEventListener('metrics', (event: MessageEvent) => {
                if (disposed) return;
                try {
                    const parsed: unknown = JSON.parse(event.data);
                    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
                        throw new Error((parsed as { error: string }).error);
                    }
                    if (!validSample(parsed)) throw new Error('Format metrik tidak valid.');
                    const sample = parsed as AdminMonitoringSample;
                    const sequence = finite(sample.sequence)
                        ? sample.sequence
                        : (samples[samples.length - 1]?.sequence || 0) + 1;
                    setSamples((current) => [...current, { ...sample, sequence }].slice(-MAX_POINTS));
                    setStreamStatus('live');
                    setStreamError(null);
                } catch (error) {
                    setStreamError(error instanceof Error ? error.message : 'Data monitoring yang diterima tidak valid.');
                }
            });
            nextSource.onerror = () => {
                if (!disposed && document.visibilityState === 'visible' && navigator.onLine) {
                    setStreamStatus('reconnecting');
                    setStreamError('Koneksi realtime terputus. Sistem sedang menyambung ulang otomatis.');
                }
            };
        };
        const handleVisibility = () => {
            if (document.visibilityState === 'visible' && navigator.onLine) connect();
            else disconnect();
        };
        const handleOnline = () => connect();
        const handleOffline = () => disconnect();
        connect();
        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            disposed = true;
            source?.close();
            source = null;
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const latest = samples[samples.length - 1] || null;
    const serviceEntries = useMemo(() => latest ? [
        ['API Utama', latest.services.api], ['Database', latest.services.database],
        ['Redis', latest.services.redis], ['Worker Gizi', latest.services.nutritionWorker]
    ] as Array<[string, 'online' | 'offline']> : [], [latest]);

    return Native.createElement('section', { className: 'admin-monitoring-panel', 'data-admin-monitoring-panel': 'true' },
        Native.createElement('div', { className: 'admin-monitoring-heading' },
            Native.createElement('div', null,
                Native.createElement('h3', null, 'Monitoring Realtime'),
                Native.createElement('p', null, 'Metrik dikirim langsung dari Oracle selama tab ini aktif. Koneksi berhenti otomatis saat tab ditinggalkan.')),
            Native.createElement('span', { className: `admin-stream-state is-${streamStatus}` },
                streamStatus === 'connecting' || streamStatus === 'reconnecting'
                    ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' })
                    : Native.createElement('span', { className: 'admin-presence-dot' }),
                statusText(streamStatus))),
        streamError && Native.createElement('div', { role: 'status', className: 'admin-stream-message' }, streamError),
        latest && Native.createElement('div', { className: 'admin-live-summary' },
            Native.createElement('article', null, Native.createElement('span', null, 'CPU'), Native.createElement('strong', null, `${latest.system.cpuPercent.toFixed(1)}%`)),
            Native.createElement('article', null, Native.createElement('span', null, 'Memori'), Native.createElement('strong', null, `${latest.system.memoryPercent.toFixed(1)}%`), Native.createElement('small', null, `${formatBytes(latest.system.memoryUsedBytes)} / ${formatBytes(latest.system.memoryTotalBytes)}`)),
            Native.createElement('article', null, Native.createElement('span', null, 'Load average'), Native.createElement('strong', null, latest.system.loadAverage.toFixed(2))),
            Native.createElement('article', null, Native.createElement('span', null, 'Sampel terakhir'), Native.createElement('strong', null, formatClock(latest.timestamp)), Native.createElement('small', null, 'WIB'))),
        Native.createElement('div', { className: 'admin-live-services', 'aria-label': 'Status layanan realtime' },
            serviceEntries.length === 0
                ? Native.createElement('div', { className: 'admin-monitoring-waiting' }, Native.createElement(Loader2, { className: 'h-5 w-5 animate-spin' }), 'Menunggu sampel pertama...')
                : serviceEntries.map(([label, status]) => Native.createElement('article', { key: label },
                    Native.createElement(Activity, { className: 'h-4 w-4' }),
                    Native.createElement('div', null, Native.createElement('strong', null, label), Native.createElement('span', { className: `is-${status}` }, status === 'online' ? 'Online' : 'Offline'))))),
        Native.createElement('div', { className: 'admin-monitoring-meta' },
            Native.createElement(Clock, { className: 'h-4 w-4' }),
            Native.createElement('span', null, 'Interval 5 detik · maksimum 5 menit pada browser · tidak memuat data kesehatan atau identitas pengguna')),
        Native.createElement('div', { className: 'admin-monitoring-grid' },
            METRICS.map((definition) => Native.createElement(MonitoringChart, { key: definition.key, definition, samples }))));
}
