import type { ReactNode } from 'react';

type BadgeColor = 'emerald' | 'blue' | 'pink' | 'slate' | 'amber';

export function Badge({ children, color = 'emerald' }: { children?: ReactNode; color?: BadgeColor }) {
  const colors: Record<BadgeColor, string> = {
    emerald: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
    blue: 'bg-blue-100 text-blue-700 ring-1 ring-blue-200',
    pink: 'bg-pink-100 text-pink-700 ring-1 ring-pink-200',
    slate: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
    amber: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200'
  };
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold ${colors[color]}`}>{children}</span>;
}

export function KenaikanBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-slate-300">-</span>;
  const labels: Record<string, [string, string]> = {
    N: ['N (Naik)', 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200'],
    T: ['T (Tidak Naik)', 'bg-rose-100 text-rose-700 ring-1 ring-rose-200'],
    B: ['B (Baru)', 'bg-blue-100 text-blue-700 ring-1 ring-blue-200'],
    O: ['O (Tidak Hadir)', 'bg-slate-100 text-slate-600 ring-1 ring-slate-200']
  };
  const [label, color] = labels[status] || [status, 'bg-slate-100 text-slate-700'];
  return <span className={`ios-status-pill whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${color}`}>{label}</span>;
}

export function StatusBadge({ status }: { status?: string | null }) {
  if (status === '-' || !status) return <span className="text-slate-300">-</span>;
  const key = String(status).trim().toLowerCase();
  let color = 'bg-slate-100 text-slate-700';
  if (['berat sangat kurang', 'berat badan sangat kurang', 'sangat pendek', 'gizi buruk'].includes(key)) color = 'bg-black text-white ring-1 ring-black';
  else if (['berat kurang', 'berat badan kurang', 'pendek', 'gizi kurang', 'mikrosefali', 'mikrosefali berat', 'lila rendah', 'lila sangat rendah'].includes(key)) color = 'bg-red-100 text-red-700 ring-1 ring-red-200';
  else if (['berat normal', 'berat badan normal', 'normal', 'gizi baik', 'lila normal'].includes(key)) color = 'bg-green-100 text-green-700 ring-1 ring-green-200';
  else if (['risiko berat lebih', 'risiko berat badan lebih', 'risiko gizi lebih'].includes(key)) color = 'bg-teal-100 text-teal-700 ring-1 ring-teal-200';
  else if (['gizi lebih', 'lila tinggi', 'makrosefali'].includes(key)) color = 'bg-sky-100 text-sky-700 ring-1 ring-sky-200';
  else if (['tinggi', 'obesitas'].includes(key)) color = 'bg-blue-900 text-white ring-1 ring-blue-900';
  return <span className={`ios-status-pill whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${color}`}>{status}</span>;
}
