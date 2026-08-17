// @ts-nocheck
import Native, { useMemo, useState } from '../runtime/dom';
import { Button, DataTable, KenaikanBadge, StatusBadge, actionTooltipProps } from '../components';
import { AlertCircle, Calendar, FileDown, Gift, Loader2, Minus, Trash2, TrendingDown } from '../ui/icons';
import {
  CATEGORY_OPTIONS,
  baselineForProgram,
  categoryLabel,
  categoryMetric,
  getMonitoringForWeek,
  maxWeeksForCategory,
  monitoringStatus,
  numericValue,
} from '../features/pmt/pmtRules';
import { formatIndoDate } from './DashboardApp';
import type { PageState } from '../shared/pageState';

function categoryIcon(category) {
  if (category === 'Wasting') return AlertCircle;
  if (category === 'Underweight') return TrendingDown;
  return Minus;
}

function StatusResult({ category, status }) {
  if (!status || status === '-') return Native.createElement('span', { className: 'text-slate-400' }, '-');
  if (category === 'TidakNaik') return Native.createElement(KenaikanBadge, { status });
  return Native.createElement(StatusBadge, { status });
}

function MeasurementCell({ category, status, date, weight, height }) {
  const hasMeasurement = numericValue(weight) !== null || numericValue(height) !== null;
  if (!hasMeasurement) return Native.createElement('span', { className: 'text-slate-400' }, '-');
  return Native.createElement('div', { className: 'pmt-measurement-cell' },
    date && Native.createElement('span', { className: 'pmt-measurement-date' }, formatIndoDate(date)),
    Native.createElement('span', { className: 'pmt-measurement-value' },
      `BB ${numericValue(weight) ?? '-'} kg`),
    Native.createElement('span', { className: 'pmt-measurement-value' },
      `TB ${numericValue(height) ?? '-'} cm`),
    Native.createElement('div', { className: 'mt-1' },
      Native.createElement(StatusResult, { category, status }))
  );
}

export default function PmtProgramPage({ childrenData, pmtPrograms, onExportPmt, onDeleteProgram, onOpenMonitoring, pageState: externalPageState }) {
  const [categoryFilter, setCategoryFilter] = useState('Semua');
  const [openingProgramId, setOpeningProgramId] = useState(null);
  const fallbackState = { status: 'success', data: pmtPrograms };
  const effectiveState = externalPageState || fallbackState;
  const displayedPrograms = effectiveState.status === 'success' ? effectiveState.data : pmtPrograms;
  const pageLoading = effectiveState.status === 'loading';
  const pageError = effectiveState.status === 'error' ? effectiveState.message : null;
  const childById = useMemo(() => new Map(childrenData.filter((child) => child.id).map((child) => [child.id, child])), [childrenData]);
  const filteredPrograms = useMemo(() => {
    const programs = categoryFilter === 'Semua'
      ? displayedPrograms
      : displayedPrograms.filter((program) => program.category === categoryFilter);
    return [...programs].sort((left, right) => String(left.childName || '').localeCompare(String(right.childName || ''), 'id'));
  }, [categoryFilter, displayedPrograms]);
  const visibleWeekCount = categoryFilter === 'Semua'
    ? Math.max(2, ...filteredPrograms.map((program) => maxWeeksForCategory(program.category)))
    : maxWeeksForCategory(categoryFilter);
  const weeks = Array.from({ length: visibleWeekCount }, (_, index) => index + 1);
  const openMonitoring = async (program, child) => {
    const programKey = program.id || program.childId;
    if (!program.childId || !programKey || openingProgramId) return;
    setOpeningProgramId(programKey);
    try {
      await onOpenMonitoring(program, child);
    } finally {
      setOpeningProgramId(null);
    }
  };

  return Native.createElement('div', { className: 'pmt-page apple-page space-y-5', 'data-pmt-page': true },
    Native.createElement('div', { className: 'apple-page-header flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between' },
      Native.createElement('div', { className: 'flex items-center gap-3' },
        Native.createElement('span', { className: 'apple-symbol-tile apple-symbol-tile-green', 'aria-hidden': 'true' },
          Native.createElement(Gift, { className: 'h-5 w-5' })),
        Native.createElement('div', { className: 'min-w-0' },
          Native.createElement('h2', { className: 'text-2xl font-bold text-slate-800' }, 'Program Pemberian PMT'),
          Native.createElement('p', { className: 'mt-1 text-sm text-slate-500' }, `${displayedPrograms.length} balita penerima PMT`))),
      Native.createElement(Button, { onClick: onExportPmt, variant: 'primary', className: 'ios-toolbar-button', title: 'Export program PMT ke XLS' },
        Native.createElement('span', { className: 'ios-button-symbol', 'aria-hidden': 'true' },
          Native.createElement(FileDown, { className: 'h-4 w-4' })),
        'Export PMT (XLS)')),
    Native.createElement('div', { className: 'pmt-filter-bar' },
      Native.createElement('div', { className: 'pmt-category-filter apple-segmented-control', role: 'tablist', 'aria-label': 'Filter kategori PMT' },
        CATEGORY_OPTIONS.map((option) => Native.createElement('button', {
          key: option.value,
          type: 'button',
          role: 'tab',
          className: categoryFilter === option.value ? 'is-active' : '',
          'aria-selected': categoryFilter === option.value ? 'true' : 'false',
          title: option.label,
          onClick: () => setCategoryFilter(option.value)
        }, option.shortLabel)))),
    Native.createElement('div', { className: 'pmt-table-card ios-table-card' },
      pageLoading
        ? Native.createElement('div', { className: 'pmt-empty-state', role: 'status' },
            Native.createElement(Loader2, { className: 'h-8 w-8 animate-spin' }),
            Native.createElement('p', null, 'Memuat program PMT...'))
        : pageError
          ? Native.createElement('div', { className: 'pmt-empty-state ios-inline-notification ios-inline-notification-error', role: 'alert' },
              Native.createElement(AlertCircle, { className: 'h-8 w-8' }),
              Native.createElement('p', null, `Gagal memuat program PMT: ${pageError}`))
          : filteredPrograms.length === 0
        ? Native.createElement('div', { className: 'pmt-empty-state' },
            Native.createElement(Gift, { className: 'h-8 w-8' }),
            Native.createElement('p', null, 'Belum ada program PMT pada kategori ini.'))
        : Native.createElement(DataTable, { className: 'pmt-table-scroll', ariaLabel: 'Tabel pemantauan PMT' },
            Native.createElement('table', { className: 'pmt-data-table ios-data-table' },
              Native.createElement('thead', null,
                Native.createElement('tr', null,
                  Native.createElement('th', { className: 'pmt-col-number' }, 'No.'),
                  Native.createElement('th', { className: 'pmt-col-child' }, 'Balita'),
                  Native.createElement('th', null, 'Kategori / Indikator'),
                  Native.createElement('th', null, 'Sumber Anggaran'),
                  Native.createElement('th', null, 'Mitra'),
                  Native.createElement('th', null, 'Tanggal Awal'),
                  Native.createElement('th', { className: 'pmt-week-column' }, 'Pengukuran Awal'),
                  ...weeks.map((week) => Native.createElement('th', { key: week, className: 'pmt-week-column' }, `Minggu ${week}`)),
                  Native.createElement('th', { className: 'pmt-col-action' }, 'Aksi'))),
              Native.createElement('tbody', null,
                filteredPrograms.map((program, index) => {
                  const child = childById.get(program.childId);
                  const programKey = program.id || program.childId;
                  const isOpening = openingProgramId === programKey;
                  const baseline = baselineForProgram(program, child);
                  const initialStatus = monitoringStatus(program, child, null, 0, baseline);
                  const Icon = categoryIcon(program.category);
                  const programWeeks = maxWeeksForCategory(program.category);
                  const partner = program.mitraLain || program.mitra || '-';
                  return Native.createElement('tr', { key: program.id || `${program.childId}-${index}`, className: 'ios-data-row' },
                    Native.createElement('td', { className: 'pmt-col-number' }, index + 1),
                    Native.createElement('td', { className: 'pmt-col-child' },
                      Native.createElement('strong', null, program.childName || child?.nama || '-'),
                      Native.createElement('span', null, child ? `${child.desa || ''} / ${child.posyandu || ''}` : 'Data wilayah tersedia saat balita dimuat')),
                    Native.createElement('td', null,
                      Native.createElement('div', { className: `pmt-category-label pmt-category-${String(program.category).toLowerCase()}` },
                        Native.createElement(Icon, { className: 'h-4 w-4' }),
                        Native.createElement('span', null, categoryLabel(program.category))),
                      Native.createElement('span', { className: 'pmt-metric-label' }, `Status ${categoryMetric(program.category)}`)),
                    Native.createElement('td', null, program.sumberAnggaran || '-'),
                    Native.createElement('td', null, partner),
                    Native.createElement('td', { className: 'whitespace-nowrap' }, formatIndoDate(baseline.date)),
                    Native.createElement('td', { className: 'pmt-week-column' },
                      Native.createElement(MeasurementCell, { category: program.category, status: initialStatus, date: baseline.date, weight: baseline.weight, height: baseline.height })),
                    ...weeks.map((week) => {
                      if (week > programWeeks) return Native.createElement('td', { key: week, className: 'pmt-week-column pmt-week-disabled' }, 'Tidak berlaku');
                      const monitoring = getMonitoringForWeek(program, week);
                      const status = monitoringStatus(program, child, monitoring, week, baseline);
                      return Native.createElement('td', { key: week, className: 'pmt-week-column' },
                        Native.createElement(MeasurementCell, { category: program.category, status, date: monitoring?.tgl, weight: monitoring?.bb, height: monitoring?.tb }));
                    }),
                    Native.createElement('td', { className: 'pmt-col-action' },
                      Native.createElement('div', { className: 'pmt-row-actions' },
                        Native.createElement('button', { ...actionTooltipProps('Isi pemantauan mingguan'), type: 'button', className: 'table-action-button table-action-blue', disabled: !program.childId || Boolean(openingProgramId), 'aria-label': `Pantau PMT ${program.childName}`, onClick: () => void openMonitoring(program, child) },
                          isOpening
                            ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' })
                            : Native.createElement(Calendar, { className: 'h-4 w-4' })),
                        Native.createElement('button', { ...actionTooltipProps('Hapus program PMT'), type: 'button', className: 'table-action-button table-action-red', disabled: !program.id, 'aria-label': `Hapus PMT ${program.childName}`, onClick: () => onDeleteProgram(program) },
                          Native.createElement(Trash2, { className: 'h-4 w-4' })))));
                }))))));
}
