import { useEffect, type ChangeEvent } from 'react';
import { DATA_WILAYAH, isFullAccessRole, MONTHS, ROLES, YEARS } from '../../config/dashboard';
import { AGE_GROUP_OPTIONS, DEFAULT_AGE_GROUP, type AgeGroup } from '../../config/ageFilters';
import AppButton from '../base/Button';

type AgeGroupOption = { value: AgeGroup; label: string };
type FilterUser = { desa?: string | null };

export type LocationFilterPanelProps = {
  draftDesa: string;
  draftPosyandu: string;
  filterMonth: number;
  filterYear: number;
  ageGroup?: AgeGroup;
  ageGroupOptions?: readonly AgeGroupOption[];
  onApply: () => void;
  onReset: () => void;
  role: string;
  setAgeGroup?: (value: AgeGroup) => void;
  setDraftDesa: (value: string) => void;
  setDraftPosyandu: (value: string) => void;
  setFilterMonth: (value: number) => void;
  setFilterYear: (value: number) => void;
  user: FilterUser;
  showAgeGroupFilter?: boolean;
};

function ChevronDown() {
  return <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6.5 9.5 5.5 5.25 5.5-5.25" /></svg>;
}

function MapPin() {
  return <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 21s7-6.15 7-12a7 7 0 1 0-14 0c0 5.85 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></svg>;
}

function ClockIcon() {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.25" /><path d="M12 6.7v5.65l3.75 2.2" /></svg>;
}

function FilterIcon() {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 6h17M5.75 12h12.5M8.25 18h7.5" /></svg>;
}

function ResetIcon() {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.25 8V3.75H8.5" /><path d="M4.75 7.15A8.75 8.75 0 1 1 3.25 14" /></svg>;
}

function notifyFilterContext(ageGroup: AgeGroup, month: number, year: number) {
  if (typeof window === 'undefined') return;
  const filterDate = new Date(year, month, 0).toISOString();
  window.__ePosyanduAgeGroup = ageGroup;
  window.__ePosyanduFilterDate = filterDate;
  window.dispatchEvent(new CustomEvent('e-posyandu-filter-context-change', { detail: { ageGroup, filterDate } }));
}

export default function LocationFilterPanel({
  draftDesa,
  draftPosyandu,
  filterMonth,
  filterYear,
  ageGroup = DEFAULT_AGE_GROUP,
  ageGroupOptions = AGE_GROUP_OPTIONS,
  onApply,
  onReset,
  role,
  setAgeGroup,
  setDraftDesa,
  setDraftPosyandu,
  setFilterMonth,
  setFilterYear,
  user,
  showAgeGroupFilter = true
}: LocationFilterPanelProps) {
  const options = ageGroupOptions.length ? ageGroupOptions : AGE_GROUP_OPTIONS;
  const selectedAgeGroup = options.some((option) => option.value === ageGroup) ? ageGroup : options[0].value;
  const fullAccess = isFullAccessRole(role);
  const hasLocationFilter = role !== ROLES.KADER;
  const activeDesa = fullAccess ? draftDesa : (user.desa || '');
  const posyanduOptions = activeDesa ? DATA_WILAYAH[activeDesa as keyof typeof DATA_WILAYAH] || [] : [];

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__ePosyanduAgeGroup = selectedAgeGroup;
    window.__ePosyanduFilterDate = new Date(filterYear, filterMonth, 0).toISOString();
  }, [filterMonth, filterYear, selectedAgeGroup]);

  const monthChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const month = Number(event.target.value);
    setFilterMonth(month);
    notifyFilterContext(selectedAgeGroup, month, filterYear);
  };
  const yearChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const year = Number(event.target.value);
    setFilterYear(year);
    notifyFilterContext(selectedAgeGroup, filterMonth, year);
  };
  const ageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as AgeGroup;
    setAgeGroup?.(next);
    notifyFilterContext(next, filterMonth, filterYear);
    window.dispatchEvent(new CustomEvent('e-posyandu-age-group-change', { detail: next }));
  };

  return <section className={`app-card ios-scope-panel overflow-hidden rounded-2xl ${hasLocationFilter ? '' : 'is-period-only'}`} aria-label={hasLocationFilter ? 'Periode dan wilayah data' : 'Periode data'} data-scope-panel="true">
    <div className="ios-scope-period-row">
      <div className="ios-scope-period-title"><span className="apple-symbol-tile apple-symbol-tile-blue" aria-hidden="true"><ClockIcon /></span><span>Periode Data</span></div>
      <div className="ios-scope-period-control glass-control">
        <select value={filterMonth} onChange={monthChange} className="period-select" aria-label="Pilih bulan">{MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select>
        <span className="ios-scope-period-divider" aria-hidden="true" />
        <select value={filterYear} onChange={yearChange} className="period-select period-year" aria-label="Pilih tahun">{YEARS.map((year) => <option key={year} value={year}>{year}</option>)}</select>
      </div>
      {showAgeGroupFilter ? <label className="ios-scope-age-control glass-control"><span className="sr-only">Kelompok umur</span><select value={selectedAgeGroup} onChange={ageChange} className="period-select" aria-label="Pilih kelompok umur">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
      {hasLocationFilter ? <button type="button" onClick={onReset} title="Atur ulang pilihan wilayah" aria-label="Atur ulang pilihan wilayah" className="ios-symbol-button ios-scope-reset"><ResetIcon /></button> : null}
    </div>
    {hasLocationFilter ? <div className={`ios-scope-location-grid ${fullAccess ? 'is-gizi' : ''}`}>
      {fullAccess ? <label className="block min-w-0"><span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600">Desa / Kelurahan</span><div className="relative"><MapPin /><select value={draftDesa} onChange={(event) => { setDraftDesa(event.target.value); setDraftPosyandu(''); }} className="min-h-11 w-full appearance-none border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm font-medium text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"><option value="">Semua Desa</option>{Object.keys(DATA_WILAYAH).map((desa) => <option key={desa} value={desa}>{desa}</option>)}</select><ChevronDown /></div></label> : null}
      <label className="block min-w-0"><span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600">Posyandu</span><div className="relative"><MapPin /><select value={draftPosyandu} onChange={(event) => setDraftPosyandu(event.target.value)} disabled={!activeDesa} className="min-h-11 w-full appearance-none border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm font-medium text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"><option value="">Semua Posyandu</option>{posyanduOptions.map((posyandu) => <option key={posyandu} value={posyandu}>{posyandu}</option>)}</select><ChevronDown /></div></label>
      <AppButton onClick={onApply} className="ios-toolbar-button min-h-11 w-full whitespace-nowrap sm:w-auto" title="Terapkan filter wilayah"><span className="ios-button-symbol" aria-hidden="true"><FilterIcon /></span>Terapkan</AppButton>
    </div> : null}
  </section>;
}
