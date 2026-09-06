// Shared status badges. Keep status styling in one place so tables stay consistent.
import Native, { type DomChild } from '../runtime/dom';

type BadgeColor = 'emerald' | 'blue' | 'pink' | 'slate' | 'amber';
type BadgeProps = { children?: DomChild; color?: BadgeColor };
type StatusProps = { status?: string | null };

export const Badge = ({ children, color = 'emerald' }: BadgeProps) => {
    const colors: Record<BadgeColor, string> = {
        emerald: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
        blue: 'bg-blue-100 text-blue-700 ring-1 ring-blue-200',
        pink: 'bg-pink-100 text-pink-700 ring-1 ring-pink-200',
        slate: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
        amber: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200'
    };
    return Native.createElement('span', { className: `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${colors[color]}` }, children);
};

export const KenaikanBadge = ({ status }: StatusProps) => {
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

export const StatusBadge = ({ status }: StatusProps) => {
    if (status === '-' || !status) return Native.createElement('span', { className: 'text-slate-300' }, '-');
    let color = 'bg-slate-100 text-slate-700';
    const statusKey = String(status).trim().toLowerCase();
    // Keep the table palette aligned with the KIA/WHO-style interpretation:
    // severe findings black, deficit red, normal green, risk teal, excess
    // light blue, and the highest categories dark blue.
    if (['berat sangat kurang', 'berat badan sangat kurang', 'sangat pendek', 'gizi buruk'].includes(statusKey)) {
        color = 'bg-black text-white ring-1 ring-black';
    } else if (['berat kurang', 'berat badan kurang', 'pendek', 'gizi kurang', 'mikrosefali', 'mikrosefali berat', 'lila rendah', 'lila sangat rendah'].includes(statusKey)) {
        color = 'bg-red-100 text-red-700 ring-1 ring-red-200';
    } else if (['berat normal', 'berat badan normal', 'normal', 'gizi baik', 'lila normal'].includes(statusKey)) {
        color = 'bg-green-100 text-green-700 ring-1 ring-green-200';
    } else if (['risiko berat lebih', 'risiko berat badan lebih', 'risiko gizi lebih'].includes(statusKey)) {
        color = 'bg-teal-100 text-teal-700 ring-1 ring-teal-200';
    } else if (['gizi lebih', 'lila tinggi', 'makrosefali'].includes(statusKey)) {
        color = 'bg-sky-100 text-sky-700 ring-1 ring-sky-200';
    } else if (['tinggi', 'obesitas'].includes(statusKey)) {
        color = 'bg-blue-900 text-white ring-1 ring-blue-900';
    }
    return Native.createElement('span', { className: `ios-status-pill px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}` }, status);
};
