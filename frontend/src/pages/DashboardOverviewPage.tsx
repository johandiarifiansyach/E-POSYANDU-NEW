import {
  Activity,
  AlertCircle,
  Baby,
  CircleOff,
  Minus,
  Ruler,
  Scale,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users
} from 'lucide-react';
import { Card, MONTHS } from './LegacyApp';

type DashboardStats = {
  S: number;
  D: number;
  N: number;
  T: number;
  B: number;
  O: number | null;
  asiEksklusif: number;
  asiTarget: number;
  underweight: number;
  stunting: number;
  wasting: number;
  perD: string;
  perN: string;
  perT: string;
  perAsiEksklusif: string;
  perUnderweight: string;
  perStunting: string;
  perWasting: string;
};

type DashboardOverviewPageProps = {
  stats: DashboardStats;
  filterMonth: number;
  filterYear: number;
  viewDesa: string;
  viewPosyandu: string;
};

export default function DashboardOverviewPage({
  stats,
  filterMonth,
  filterYear,
  viewDesa,
  viewPosyandu
}: DashboardOverviewPageProps) {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Capaian Program SKDN</h2>
          <p className="text-slate-500">
            Laporan bulan <span className="font-bold text-emerald-600">{MONTHS[filterMonth - 1]} {filterYear}</span>
            {viewDesa && ` - ${viewDesa}`} {viewPosyandu && ` - ${viewPosyandu}`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <Card className="p-4 border-l-4 border-l-blue-500 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-400 uppercase">S (Sasaran)</span>
            <Users className="w-4 h-4 text-blue-500" />
          </div>
          <p className="text-2xl font-bold text-slate-800">{stats.S}</p>
          <p className="text-xs text-slate-400">Total Balita Aktif</p>
        </Card>

        <Card className="p-4 border-l-4 border-l-emerald-500 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-400 uppercase">D (Ditimbang)</span>
            <Scale className="w-4 h-4 text-emerald-500" />
          </div>
          <p className="text-2xl font-bold text-slate-800">{stats.D}</p>
          <div className="flex items-center gap-1 mt-1">
            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${stats.perD}%` }} />
            </div>
            <span className="text-xs font-bold text-emerald-600">{stats.perD}%</span>
          </div>
        </Card>

        <Card className="p-4 border-l-4 border-l-indigo-500 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-400 uppercase">N (Naik)</span>
            <TrendingUp className="w-4 h-4 text-indigo-500" />
          </div>
          <p className="text-2xl font-bold text-slate-800">{stats.N}</p>
          <div className="flex items-center gap-1 mt-1">
            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${stats.perN}%` }} />
            </div>
            <span className="text-xs font-bold text-indigo-600">{stats.perN}%</span>
          </div>
        </Card>

        <Card className="p-4 border-l-4 border-l-amber-500 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-400 uppercase">T (Tidak Naik)</span>
            <Minus className="w-4 h-4 text-amber-500" />
          </div>
          <p className="text-2xl font-bold text-slate-800">{stats.T}</p>
          <div className="flex items-center gap-1 mt-1">
            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full" style={{ width: `${stats.perT}%` }} />
            </div>
            <span className="text-xs font-bold text-amber-600">{stats.perT}%</span>
          </div>
        </Card>

        <Card className="p-4 border-l-4 border-l-cyan-500 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-400 uppercase">B (Bayi Baru)</span>
            <UserPlus className="w-4 h-4 text-cyan-500" />
          </div>
          <p className="text-2xl font-bold text-slate-800">{stats.B}</p>
          <p className="text-xs text-slate-400">Diinput bulan ini</p>
        </Card>

        <Card className="p-4 border-l-4 border-l-rose-500 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-400 uppercase">O (Tidak Ditimbang)</span>
            <CircleOff className="w-4 h-4 text-rose-500" />
          </div>
          <p className="text-2xl font-bold text-slate-800">{stats.O ?? '-'}</p>
          <p className="text-xs text-slate-400">Bulan sebelumnya</p>
        </Card>
      </div>

      <h2 className="text-lg font-bold text-slate-800 mt-6">Capaian ASI Eksklusif</h2>
      <Card className="p-5 border-l-4 border-l-sky-500">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-sky-100 rounded-lg text-sky-600"><Baby className="w-5 h-5" /></div>
            <div>
              <p className="font-bold text-slate-700">Bayi usia 6 bulan</p>
              <p className="text-xs text-slate-500">Tercatat ASI eksklusif pada bulan laporan</p>
            </div>
          </div>
          <div className="sm:text-right">
            <p className="text-2xl font-bold text-slate-800">{stats.asiEksklusif} <span className="text-base font-medium text-slate-500">/ {stats.asiTarget} bayi</span></p>
            <p className="text-sm font-bold text-sky-600">{stats.perAsiEksklusif}%</p>
          </div>
        </div>
        <div className="mt-4 h-2 w-full bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-sky-500 rounded-full" style={{ width: `${stats.perAsiEksklusif}%` }} />
        </div>
      </Card>

      <h2 className="text-lg font-bold text-slate-800 mt-6">Prevalensi Status Gizi</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="p-5 flex flex-col justify-between border border-slate-100 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-3 opacity-10"><Scale className="w-24 h-24 text-rose-500" /></div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 bg-rose-100 rounded-lg text-rose-600"><TrendingDown className="w-4 h-4" /></div>
              <span className="font-bold text-slate-700">Underweight (BB/U)</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-slate-800">{stats.underweight}</span>
              <span className="text-sm text-slate-500">Balita</span>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-500">Persentase</span>
              <span className="font-bold text-rose-600">{stats.perUnderweight}%</span>
            </div>
            <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-rose-500 rounded-full" style={{ width: `${stats.perUnderweight}%` }} />
            </div>
          </div>
        </Card>

        <Card className="p-5 flex flex-col justify-between border border-slate-100 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-3 opacity-10"><Ruler className="w-24 h-24 text-orange-500" /></div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 bg-orange-100 rounded-lg text-orange-600"><Ruler className="w-4 h-4" /></div>
              <span className="font-bold text-slate-700">Stunting (TB/U)</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-slate-800">{stats.stunting}</span>
              <span className="text-sm text-slate-500">Balita</span>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-500">Persentase</span>
              <span className="font-bold text-orange-600">{stats.perStunting}%</span>
            </div>
            <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500 rounded-full" style={{ width: `${stats.perStunting}%` }} />
            </div>
          </div>
        </Card>

        <Card className="p-5 flex flex-col justify-between border border-slate-100 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-3 opacity-10"><Activity className="w-24 h-24 text-yellow-500" /></div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 bg-yellow-100 rounded-lg text-yellow-600"><AlertCircle className="w-4 h-4" /></div>
              <span className="font-bold text-slate-700">Wasting (BB/TB)</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-slate-800">{stats.wasting}</span>
              <span className="text-sm text-slate-500">Balita</span>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-500">Persentase</span>
              <span className="font-bold text-yellow-600">{stats.perWasting}%</span>
            </div>
            <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-yellow-500 rounded-full" style={{ width: `${stats.perWasting}%` }} />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
