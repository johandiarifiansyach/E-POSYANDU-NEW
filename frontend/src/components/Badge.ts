// Shared status badges. Keep status styling in one place so tables stay consistent.
// @ts-nocheck
import Native from '../runtime/dom';

export const Badge = ({ children, color = 'emerald' }) => {
    const colors = {
        emerald: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
        blue: 'bg-blue-100 text-blue-700 ring-1 ring-blue-200',
        pink: 'bg-pink-100 text-pink-700 ring-1 ring-pink-200',
        slate: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
        amber: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200'
    };
    return Native.createElement('span', { className: `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${colors[color]}` }, children);
};

export const KenaikanBadge = ({ status }) => {
    if (!status) return Native.createElement('span', { className: 'text-slate-300' }, '-');
    let color = 'bg-slate-100 text-slate-700';
    let label = status;
    switch (status) {
        case 'N': color = 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200'; label = 'N (Naik)'; break;
        case 'T': color = 'bg-rose-100 text-rose-700 ring-1 ring-rose-200'; label = 'T (Tidak Naik)'; break;
        case 'B': color = 'bg-blue-100 text-blue-700 ring-1 ring-blue-200'; label = 'B (Baru)'; break;
        case 'O': color = 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'; label = 'O (Tidak Hadir)'; break;
        default: break;
    }
    return Native.createElement('span', { className: `ios-status-pill px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}` }, label);
};

export const StatusBadge = ({ status }) => {
    if (status === '-' || !status) return Native.createElement('span', { className: 'text-slate-300' }, '-');
    let color = 'bg-slate-100 text-slate-700';
    if (['Berat Normal', 'Normal', 'Gizi Baik', 'LILA Normal'].includes(status)) color = 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200';
    if (['Berat Kurang', 'Pendek', 'Gizi Kurang', 'Risiko Berat Lebih', 'Risiko Gizi Lebih', 'LILA Rendah', 'Mikrosefali'].includes(status)) color = 'bg-amber-100 text-amber-700 ring-1 ring-amber-200';
    if (['Berat Sangat Kurang', 'Sangat Pendek', 'Gizi Buruk', 'Obesitas', 'LILA Sangat Rendah', 'Mikrosefali Berat'].includes(status)) color = 'bg-rose-100 text-rose-700 ring-1 ring-rose-200';
    if (['Tinggi', 'Gizi Lebih', 'LILA Tinggi', 'Makrosefali'].includes(status)) color = 'bg-blue-100 text-blue-700 ring-1 ring-blue-200';
    return Native.createElement('span', { className: `ios-status-pill px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}` }, status);
};
