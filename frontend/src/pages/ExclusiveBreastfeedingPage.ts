// @ts-nocheck
import { getExclusiveBreastfeedingPage, peekCachedExclusiveBreastfeedingPage } from '../api/childrenApi';
import { DataTable, Pagination } from '../components';
import Native, { useEffect, useState } from '../runtime/dom';
import { Baby, CalendarDays, CheckCircle2 } from '../ui/icons';
import { ExclusiveBreastfeedingTableSkeleton } from '../ui/skeleton';
import { Card, formatIndoDate, MONTHS } from './DashboardApp';
import type { PageState } from '../shared/pageState';

const ITEMS_PER_PAGE = 10;

export default function ExclusiveBreastfeedingPage({ filterMonth, filterYear, refreshKey, viewDesa, viewPosyandu, pageState: externalPageState }) {
    const [ageFilter, setAgeFilter] = useState('0-5');
    const [currentPage, setCurrentPage] = useState(1);
    const [dataState, setDataState] = useState<PageState<{ items: any[]; total: number }>>({ status: 'idle' });

    useEffect(() => {
        setCurrentPage(1);
    }, [ageFilter, filterMonth, filterYear, viewDesa, viewPosyandu]);

    useEffect(() => {
        let current = true;
        const month = String(filterMonth).padStart(2, '0');
        const lastDay = String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0');
        const request = {
            ageGroup: ageFilter,
            measurementEnd: `${filterYear}-${month}-${lastDay}`,
            measurementStart: `${filterYear}-${month}-01`,
            page: currentPage,
            posyandu: viewPosyandu || undefined,
            size: ITEMS_PER_PAGE,
            village: viewDesa || undefined
        };
        const memoryCached = peekCachedExclusiveBreastfeedingPage(request);
        if (memoryCached) {
            setDataState({
                status: 'success',
                data: {
                    items: memoryCached.items.map((item) => ({ id: item.id, ...item.data })),
                    total: memoryCached.total
                }
            });
        }
        else {
            setDataState({ status: 'loading' });
        }
        void getExclusiveBreastfeedingPage(request)
            .then((result) => {
            if (!current)
                return;
            setDataState({
                status: 'success',
                data: {
                    items: result.items.map((item) => ({ id: item.id, ...item.data })),
                    total: result.total
                }
            });
        })
            .catch((requestError) => {
            if (!current)
                return;
            setDataState({
                status: 'error',
                message: requestError instanceof Error ? requestError.message : 'Permintaan tidak dapat diproses.'
            });
        });
        return () => {
            current = false;
        };
    }, [ageFilter, currentPage, filterMonth, filterYear, refreshKey, viewDesa, viewPosyandu]);

    const effectiveState = externalPageState || dataState;
    const loading = effectiveState.status === 'loading';
    const error = effectiveState.status === 'error' ? effectiveState.message : null;
    const items = effectiveState.status === 'success' ? effectiveState.data.items : [];
    const total = effectiveState.status === 'success' ? effectiveState.data.total : 0;

    const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
    const startRow = items.length > 0 ? (currentPage - 1) * ITEMS_PER_PAGE + 1 : 0;
    const endRow = Math.min(currentPage * ITEMS_PER_PAGE, total);
    const setAgeGroup = (value) => {
        setAgeFilter(value);
        setCurrentPage(1);
    };

    return (Native.createElement("div", { className: "apple-page space-y-6" },
        Native.createElement("div", { className: "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between" },
            Native.createElement("div", null,
                Native.createElement("h2", { className: "text-2xl font-bold text-slate-800" }, "Daftar ASI Eksklusif"),
                Native.createElement("p", { className: "text-sm text-slate-500" },
                    "Pengukuran ", MONTHS[filterMonth - 1], " ", filterYear)),
            Native.createElement("div", { className: "apple-segmented-control inline-flex w-full p-1 sm:w-auto", role: "group", "aria-label": "Filter usia bayi" },
                Native.createElement("button", { type: "button", onClick: () => setAgeGroup('0-5'), "aria-pressed": ageFilter === '0-5', className: `min-h-9 flex-1 px-4 text-sm font-semibold transition-colors sm:flex-none ${ageFilter === '0-5' ? 'is-selected' : ''}` }, "0-5 Bulan"),
                Native.createElement("button", { type: "button", onClick: () => setAgeGroup('6'), "aria-pressed": ageFilter === '6', className: `min-h-9 flex-1 px-4 text-sm font-semibold transition-colors sm:flex-none ${ageFilter === '6' ? 'is-selected' : ''}` }, "6 Bulan"))),
        Native.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-2" },
            Native.createElement("div", { className: "apple-summary-card apple-summary-blue p-4" },
                Native.createElement("div", { className: "flex items-center justify-between gap-3" },
                    Native.createElement("div", null,
                        Native.createElement("p", { className: "text-xs font-bold uppercase tracking-wider text-slate-400" }, "Bayi Mendapat ASI Eksklusif"),
                        Native.createElement("p", { className: "mt-1 text-2xl font-bold text-slate-800" }, total, " ", Native.createElement("span", { className: "text-base font-medium text-slate-500" }, "bayi"))),
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-cyan" },
                        Native.createElement(Baby, { className: "h-5 w-5" })))),
            Native.createElement("div", { className: "apple-summary-card apple-summary-green p-4" },
                Native.createElement("div", { className: "flex items-center justify-between gap-3" },
                    Native.createElement("div", null,
                        Native.createElement("p", { className: "text-xs font-bold uppercase tracking-wider text-slate-400" }, "Kelompok Usia"),
                        Native.createElement("p", { className: "mt-1 text-2xl font-bold text-slate-800" }, ageFilter === '0-5' ? '0-5' : '6', " ", Native.createElement("span", { className: "text-base font-medium text-slate-500" }, "bulan"))),
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-green" },
                        Native.createElement(CalendarDays, { className: "h-5 w-5" }))))),
        error && Native.createElement("div", { role: "alert", className: "ios-inline-notification ios-inline-notification-error" }, `Gagal memuat data ASI eksklusif: ${error}`),
        Native.createElement(Card, { className: "ios-table-card overflow-hidden" },
            Native.createElement(DataTable, { ariaLabel: "Daftar ASI eksklusif" },
                Native.createElement("table", { className: "ios-data-table ios-asi-table min-w-full text-sm", "aria-busy": loading ? "true" : "false" },
                    Native.createElement("thead", { className: "bg-slate-50 text-left text-xs font-bold uppercase tracking-wider text-slate-500" },
                        Native.createElement("tr", null,
                            Native.createElement("th", { className: "w-16 px-4 py-3 text-center" }, "No."),
                            Native.createElement("th", { className: "px-4 py-3" }, "Balita"),
                            Native.createElement("th", { className: "px-4 py-3" }, "Usia"),
                            Native.createElement("th", { className: "px-4 py-3" }, "Tanggal Ukur"),
                            Native.createElement("th", { className: "px-4 py-3" }, "Lokasi"),
                            Native.createElement("th", { className: "px-4 py-3 text-center" }, "ASI Eksklusif"))),
                    Native.createElement("tbody", null, loading ? (Native.createElement(ExclusiveBreastfeedingTableSkeleton, null)) : items.length === 0 ? (Native.createElement("tr", null,
                        Native.createElement("td", { colSpan: 6, className: "px-6 py-12 text-center text-slate-400" }, "Tidak ada data ASI eksklusif pada kelompok usia ini."))) : items.map((child, index) => Native.createElement("tr", { key: child.id, className: "text-slate-700 hover:bg-slate-50" },
                        Native.createElement("td", { className: "px-4 py-3 text-center text-slate-500" }, startRow + index),
                        Native.createElement("td", { className: "px-4 py-3" },
                            Native.createElement("p", { className: "font-semibold text-slate-800" }, child.nama),
                            Native.createElement("p", { className: `text-xs font-mono ${!child.hasNIK ? 'font-bold text-red-600' : 'text-slate-500'}` }, child.nik || '-')),
                        Native.createElement("td", { className: "px-4 py-3" }, child.ageInMonths, " bulan"),
                        Native.createElement("td", { className: "px-4 py-3" }, child.tglUkur ? formatIndoDate(child.tglUkur) : '-'),
                        Native.createElement("td", { className: "px-4 py-3" },
                            Native.createElement("p", null, child.posyandu || '-'),
                            Native.createElement("p", { className: "text-xs text-slate-500" }, child.desa || '-')),
                    Native.createElement("td", { className: "px-4 py-3 text-center" },
                            Native.createElement("span", { className: "ios-status-pill ios-status-success inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700" },
                                Native.createElement(CheckCircle2, { className: "h-4 w-4" }), " Ya"))))))),
            Native.createElement("div", { className: "ios-table-footer flex flex-col items-center justify-between gap-4 sm:flex-row" },
                Native.createElement("span", { className: "text-xs font-medium text-slate-500" }, "Menampilkan ", startRow, " - ", endRow, " dari ", total, " data"),
                Native.createElement(Pagination, { currentPage: currentPage, totalPages: totalPages, disablePrevious: loading || currentPage === 1, disableNext: loading || currentPage >= totalPages || total === 0, onPrevious: () => setCurrentPage((page) => Math.max(1, page - 1)), onNext: () => setCurrentPage((page) => page + 1) })))));
}
