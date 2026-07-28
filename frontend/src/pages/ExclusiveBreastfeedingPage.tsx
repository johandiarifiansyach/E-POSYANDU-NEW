import { useMemo, useState } from 'react';
import { Baby, CheckCircle2, CalendarDays } from 'lucide-react';
import {
  Card,
  ChildData,
  formatIndoDate,
  getAgeInMonths,
  MeasurementData,
  MONTHS
} from './LegacyApp';

type AgeFilter = '0-5' | '6';

type ExclusiveBreastfeedingPageProps = {
  childrenData: ChildData[];
  currentFilterDate: Date;
  filterMonth: number;
  filterYear: number;
  monthlyMeasurements: Record<string, MeasurementData>;
};

export default function ExclusiveBreastfeedingPage({
  childrenData,
  currentFilterDate,
  filterMonth,
  filterYear,
  monthlyMeasurements
}: ExclusiveBreastfeedingPageProps) {
  const [ageFilter, setAgeFilter] = useState<AgeFilter>('0-5');

  const childrenByAgeGroup = useMemo(() => childrenData.filter((child) => {
    if (!child.id || monthlyMeasurements[child.id]?.asi !== 'Ya') return false;
    const measurementDate = monthlyMeasurements[child.id]?.tglUkur;
    const age = getAgeInMonths(child.tglLahir, measurementDate ? new Date(measurementDate) : currentFilterDate);
    return ageFilter === '0-5' ? age >= 0 && age <= 5 : age === 6;
  }), [ageFilter, childrenData, currentFilterDate, monthlyMeasurements]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Daftar ASI Eksklusif</h2>
          <p className="text-sm text-slate-500">Pengukuran {MONTHS[filterMonth - 1]} {filterYear}</p>
        </div>
        <div className="inline-flex w-full sm:w-auto rounded-lg border border-slate-200 bg-slate-50 p-1" role="group" aria-label="Filter usia bayi">
          <button
            type="button"
            onClick={() => setAgeFilter('0-5')}
            aria-pressed={ageFilter === '0-5'}
            className={`min-h-9 flex-1 px-4 text-sm font-semibold transition-colors sm:flex-none ${ageFilter === '0-5' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            0-5 Bulan
          </button>
          <button
            type="button"
            onClick={() => setAgeFilter('6')}
            aria-pressed={ageFilter === '6'}
            className={`min-h-9 flex-1 px-4 text-sm font-semibold transition-colors sm:flex-none ${ageFilter === '6' ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            6 Bulan
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="border-l-4 border-sky-500 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Bayi Mendapat ASI Eksklusif</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">{childrenByAgeGroup.length} <span className="text-base font-medium text-slate-500">bayi</span></p>
            </div>
            <Baby className="h-6 w-6 text-sky-500" />
          </div>
        </div>
        <div className="border-l-4 border-emerald-500 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Kelompok Usia</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">{ageFilter === '0-5' ? '0-5' : '6'} <span className="text-base font-medium text-slate-500">bulan</span></p>
            </div>
            <CalendarDays className="h-6 w-6 text-emerald-500" />
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="w-16 px-4 py-3 text-center">No.</th>
                <th className="px-4 py-3">Balita</th>
                <th className="px-4 py-3">Usia</th>
                <th className="px-4 py-3">Tanggal Ukur</th>
                <th className="px-4 py-3">Lokasi</th>
                <th className="px-4 py-3 text-center">ASI Eksklusif</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {childrenByAgeGroup.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">Tidak ada data ASI eksklusif pada kelompok usia ini.</td>
                </tr>
              ) : childrenByAgeGroup.map((child, index) => {
                const measurement = monthlyMeasurements[child.id as string];
                const age = getAgeInMonths(child.tglLahir, measurement?.tglUkur ? new Date(measurement.tglUkur) : currentFilterDate);

                return (
                  <tr key={child.id} className="text-slate-700 hover:bg-slate-50">
                    <td className="px-4 py-3 text-center text-slate-500">{index + 1}</td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-800">{child.nama}</p>
                      <p className={`text-xs font-mono ${!child.hasNIK ? 'font-bold text-red-600' : 'text-slate-500'}`}>{child.nik}</p>
                    </td>
                    <td className="px-4 py-3">{age} bulan</td>
                    <td className="px-4 py-3">{measurement?.tglUkur ? formatIndoDate(measurement.tglUkur) : '-'}</td>
                    <td className="px-4 py-3">
                      <p>{child.posyandu}</p>
                      <p className="text-xs text-slate-500">{child.desa}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                        <CheckCircle2 className="h-4 w-4" /> Ya
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
