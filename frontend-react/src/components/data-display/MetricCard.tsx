import type { ReactNode } from 'react';
import { Card } from '../base/Card';
import SkeletonBlock from '../base/SkeletonBlock';

export type MetricCardProps = {
  label: string;
  value: number | string;
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
  progress?: string;
  progressColor?: string;
  progressTextColor?: string;
  subtitle?: string;
};

/** Dashboard metric card with a skeleton-safe value and progress bar. */
export default function MetricCard({ label, value, loading = false, icon, className = '', progress, progressColor, progressTextColor = 'text-slate-600', subtitle }: MetricCardProps) {
  return <Card className={`apple-metric-card ${className} p-4`.trim()}>
    <div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold uppercase text-slate-400">{label}</span>{icon}</div>
    <p className="text-2xl font-bold text-slate-800">{loading ? <SkeletonBlock className="dashboard-stat-skeleton-value" /> : value}</p>
    {progress !== undefined && progressColor ? <div className="mt-1 flex items-center gap-1"><div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">{loading ? <SkeletonBlock className="dashboard-stat-skeleton-progress h-full w-full" /> : <div className={`h-full rounded-full ${progressColor}`} style={{ width: `${progress}%` }} />}</div><span className={`text-xs font-bold ${progressTextColor}`}>{loading ? <SkeletonBlock className="dashboard-stat-skeleton-percent" /> : `${progress}%`}</span></div> : <p className="text-xs text-slate-400">{subtitle}</p>}
  </Card>;
}
