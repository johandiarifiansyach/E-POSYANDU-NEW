// @ts-nocheck
import Native, { useEffect, useMemo, useState } from '../runtime/dom';
import { Badge, Button, DataTable, KenaikanBadge, Pagination, StatusBadge } from '../components';
import { ChevronDown, FileDown, FileText, FileUp, Filter, Gift, Pencil, Plus, RotateCcw, Ruler, Search, Trash2, Utensils, X } from '../ui/icons';
import { TableLoadingSkeleton } from '../ui/skeleton';
import { Card, formatIndoDate, isFullAccessRole, MONTHS, ROLES } from './DashboardApp';
import { getMeasurementStatuses } from '../features/measurements/measurementRules';
import { requestPythonAnthropometry } from '../api/analysisApi';
import { getPmtCategoryForTab } from '../features/children/childRules';
import type { PageState } from '../shared/pageState';
function getPageTitle(activeTab, filterMonth, filterYear) {
    if (activeTab === 'recycle_bin')
        return 'Daftar Sampah (Recycle Bin)';
    if (activeTab === 'recent')
        return `Balita Baru (${MONTHS[filterMonth - 1]} ${filterYear})`;
    if (activeTab === 'problem_underweight')
        return 'Daftar Balita Underweight (BB/U)';
    if (activeTab === 'problem_stunting')
        return 'Daftar Balita Stunting (TB/U)';
    if (activeTab === 'problem_wasting')
        return 'Daftar Balita Wasting (BB/TB)';
    if (activeTab === 'problem_tidak_naik')
        return 'Daftar Balita Tidak Naik (T)';
    if (activeTab === 'mpasi')
        return 'Balita MPASI (6-23 Bulan)';
    return 'Data Balita Lengkap';
}
export default function ChildrenTablePage({ activeTab, currentFilterDate, currentPage, displayData, fileInputRef, filterMonth, filterYear, handleExportMpasi, handleExportPengukuranSigizi, handleExportSigizi, handleExportTable, handleImportIdentitas, handlePermanentDelete, handleRestore, itemsPerPage, loading, monthlyMeasurements, mpasiLogs, paginatedData, onClearSearch, searchTerm, searchDraft, setChildToDelete, setChildToMpasi, setCurrentPage, onEditChild, setPmtModalData, setSearchDraft, onOpenAddChild, onOpenMeasurement, onSubmitSearch, setSortOrder, sortOrder, totalDataCount, user, pageState, readOnly = false }) {
    const fallbackTotal = totalDataCount ?? displayData.length;
    const resolvedState = pageState ?? (loading
        ? { status: 'loading' }
        : { status: 'success', data: { items: paginatedData, total: fallbackTotal } });
    const pageLoading = resolvedState.status === 'loading';
    const pageError = resolvedState.status === 'error' ? resolvedState.message : null;
    const pageItems = resolvedState.status === 'success' ? resolvedState.data.items : paginatedData;
    const [pythonStatuses, setPythonStatuses] = useState({});
    const pythonBatchKey = useMemo(() => pageItems.map((child) => {
        const measurement = monthlyMeasurements[child?.id];
        return `${child?.id || ''}:${measurement?.id || ''}:${measurement?.tglUkur || ''}:${measurement?.bb || ''}:${measurement?.tb || ''}`;
    }).join('|'), [pageItems, monthlyMeasurements]);
    useEffect(() => {
        let active = true;
        const entries = pageItems
            .map((child) => ({ child, measurement: monthlyMeasurements[child?.id] }))
            .filter((entry) => entry.child?.id && entry.measurement && entry.measurement.bb !== null && entry.measurement.bb !== undefined && entry.measurement.bb !== '');
        if (!entries.length) {
            setPythonStatuses({});
            return () => { active = false; };
        }
        void requestPythonAnthropometry(entries)
            .then((response) => {
                if (!active) return;
                const next = {};
                (response.items || []).forEach((item) => {
                    const entry = entries[Math.max(0, Number(item.rowNumber || 1) - 1)];
                    const key = String(entry?.child?.id || item.recordId || '');
                    if (key) next[key] = item;
                });
                setPythonStatuses(next);
            })
            .catch(() => {
                // Keep the deterministic local presentation while an older
                // gateway or an offline browser is unavailable.
                if (active) setPythonStatuses({});
            });
        return () => { active = false; };
    }, [pythonBatchKey]);
    const totalItems = resolvedState.status === 'success' ? resolvedState.data.total : fallbackTotal;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const identityColumnCount = 3 + (activeTab === 'recycle_bin' ? 1 : 0) + (isFullAccessRole(user.role) ? 1 : 0) + (user.role === ROLES.BIDAN || isFullAccessRole(user.role) ? 1 : 0);
    const dataColumnCount = activeTab === 'mpasi' ? 10 : 9;
    const tableColumnCount = identityColumnCount + dataColumnCount + 1;
    return (Native.createElement("div", { className: "apple-page space-y-6" },
        Native.createElement("div", { className: "flex flex-col xl:flex-row xl:items-center justify-between gap-4" },
            Native.createElement("div", null,
                Native.createElement("h2", { className: "text-2xl font-bold text-slate-800" }, getPageTitle(activeTab, filterMonth, filterYear)),
                Native.createElement("p", { className: "text-slate-500 text-sm" }, activeTab === 'mpasi'
                    ? `Menampilkan ${totalItems} balita usia 6-23 bulan untuk pemantauan MPASI.`
                    : `Menampilkan ${totalItems} data balita.`)),
            Native.createElement("div", { className: "flex flex-col sm:flex-row gap-3 w-full xl:w-auto" },
                Native.createElement("form", { className: "flex w-full sm:w-72", onSubmit: (event) => {
                        event.preventDefault();
                        onSubmitSearch();
                    } },
                    Native.createElement("div", { className: "relative min-w-0 flex-1" },
                        Native.createElement(Search, { className: "absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" }),
                        Native.createElement("input", { type: "text", className: "pl-9 pr-8 py-2.5 w-full border border-slate-200 rounded-l-xl text-sm focus:ring-2 focus:ring-emerald-500 outline-none shadow-sm", placeholder: "Cari Nama / NIK...", value: searchDraft, onChange: (event) => setSearchDraft(event.target.value) }),
                        searchTerm && (Native.createElement("button", { type: "button", onClick: onClearSearch, title: "Hapus pencarian", className: "absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700" },
                            Native.createElement(X, { className: "h-4 w-4" })))),
                    Native.createElement(Button, { type: "submit", className: "rounded-l-none px-3", title: "Cari data balita" },
                        Native.createElement(Search, { className: "h-4 w-4" }),
                        Native.createElement("span", { className: "ml-1 hidden sm:inline" }, "Cari"))),
                Native.createElement("div", { className: "relative w-full sm:w-48" },
                    Native.createElement("select", { value: sortOrder, onChange: (event) => setSortOrder(event.target.value), className: "appearance-none pl-9 pr-8 py-2.5 w-full border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 outline-none bg-white cursor-pointer shadow-sm" },
                        Native.createElement("option", { value: "recent" }, "Terbaru Ditambahkan"),
                        Native.createElement("option", { value: "oldest_input" }, "Awal Diinput"),
                        Native.createElement("option", { value: "name_asc" }, "Nama (A-Z)"),
                        Native.createElement("option", { value: "name_desc" }, "Nama (Z-A)"),
                        Native.createElement("option", { value: "age_oldest" }, "Umur Tertua"),
                        Native.createElement("option", { value: "age_youngest" }, "Umur Termuda")),
                    Native.createElement(Filter, { className: "absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" }),
                    Native.createElement(ChevronDown, { className: "absolute right-3 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 pointer-events-none" })),
                Native.createElement("div", { className: "flex gap-2 overflow-x-auto pb-1 sm:pb-0 no-scrollbar" },
                    activeTab === 'recent' && (Native.createElement(Native.Fragment, null,
                        Native.createElement("input", { type: "file", ref: fileInputRef, onChange: handleImportIdentitas, accept: ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", style: { display: 'none' } }),
                        !readOnly && Native.createElement(Button, { onClick: () => fileInputRef.current?.click(), variant: "primary", className: "ios-toolbar-button icon-only-mobile bg-indigo-600 hover:bg-indigo-700 whitespace-nowrap", title: "Import identitas balita" },
                            Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                                Native.createElement(FileUp, { className: "w-4 h-4" })),
                            " ",
                            Native.createElement("span", { className: "hidden sm:inline" }, "Import")),
                        Native.createElement(Button, { onClick: handleExportSigizi, variant: "primary", className: "ios-toolbar-button icon-only-mobile bg-blue-600 hover:bg-blue-700 whitespace-nowrap", title: "Export identitas Sigizi" },
                            Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                                Native.createElement(FileDown, { className: "w-4 h-4" })),
                            " ",
                            Native.createElement("span", { className: "hidden sm:inline" }, "Export Sigizi")))),
                    activeTab === 'mpasi' && (Native.createElement(Button, { onClick: handleExportMpasi, variant: "primary", className: "ios-toolbar-button icon-only-mobile bg-orange-600 hover:bg-orange-700 whitespace-nowrap", title: "Export MPASI ke XLS" },
                        Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                            Native.createElement(FileDown, { className: "w-4 h-4" })),
                        " ",
                        Native.createElement("span", { className: "hidden sm:inline" }, "Export MPASI"))),
                    ['data_balita', 'problem_underweight', 'problem_stunting', 'problem_wasting', 'problem_tidak_naik'].includes(activeTab) && (Native.createElement(Button, { onClick: handleExportTable, variant: "primary", className: "ios-toolbar-button icon-only-mobile bg-teal-600 hover:bg-teal-700 whitespace-nowrap", title: "Export tabel balita" },
                        Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                            Native.createElement(FileText, { className: "w-4 h-4" })),
                        " ",
                        Native.createElement("span", { className: "hidden sm:inline" }, "Export Tabel"))),
                    activeTab !== 'recent' && activeTab !== 'recycle_bin' && activeTab !== 'mpasi' && (Native.createElement(Button, { onClick: handleExportPengukuranSigizi, variant: "primary", className: "ios-toolbar-button icon-only-mobile bg-emerald-600 hover:bg-emerald-700 whitespace-nowrap", title: "Export pengukuran Sigizi" },
                        Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                            Native.createElement(FileDown, { className: "w-4 h-4" })),
                        " ",
                        Native.createElement("span", { className: "hidden sm:inline" }, "Export Pengukuran"))),
                    !readOnly && activeTab !== 'recycle_bin' && (Native.createElement(Button, { onClick: onOpenAddChild, className: "ios-toolbar-button icon-only-mobile whitespace-nowrap", title: "Tambah balita" },
                        Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                            Native.createElement(Plus, { className: "w-4 h-4" })),
                        " ",
                        Native.createElement("span", { className: "hidden sm:inline" }, "Tambah")))))),
        pageError && Native.createElement("div", { role: "alert", className: "ios-inline-notification ios-inline-notification-error" },
            "Gagal memuat data balita: ",
            pageError),
        Native.createElement(Card, { className: "ios-table-card overflow-hidden flex flex-col" },
            Native.createElement(DataTable, { className: "relative w-full overflow-y-visible", ariaLabel: "Daftar balita" },
                Native.createElement("table", { className: "ios-data-table ios-children-table min-w-full" },
                    Native.createElement("thead", { className: "bg-slate-50" },
                        Native.createElement("tr", null,
                            Native.createElement("th", { className: "px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 md:sticky md:left-0 bg-slate-50 z-20" }, "No"),
                            Native.createElement("th", { className: "px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 md:sticky md:left-[48px] bg-slate-50 z-20 md:shadow-lg" }, "Identitas"),
                            Native.createElement("th", { className: "px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200" }, "Ortu"),
                            activeTab === 'recycle_bin' && (Native.createElement("th", { className: "px-4 py-3 text-left text-[10px] font-bold text-rose-600 uppercase tracking-wider border-r border-slate-200 bg-rose-50/60" }, "Alasan Dihapus")),
                            isFullAccessRole(user.role) && (Native.createElement("th", { className: "px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200" }, "Desa")),
                            (user.role === ROLES.BIDAN || isFullAccessRole(user.role)) && (Native.createElement("th", { className: "px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200" }, "Posyandu")),
                            activeTab === 'mpasi' ? (Native.createElement(Native.Fragment, null,
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Tgl Monitor"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "ASI"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Mkn Pokok"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Kacang"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Susu"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Daging"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Telur"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Vit A"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Sayur Lain"),
                                Native.createElement("th", { className: "px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50" }, "Intervensi"))) : (Native.createElement(Native.Fragment, null,
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50" },
                                    "BB",
                                    Native.createElement("br", null),
                                    "(kg)"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50" },
                                    "PB/TB",
                                    Native.createElement("br", null),
                                    "(cm)"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50" },
                                    "LILA",
                                    Native.createElement("br", null),
                                    "(cm)"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50" },
                                    "LK",
                                    Native.createElement("br", null),
                                    "(cm)"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-indigo-50/50" },
                                    "Status",
                                    Native.createElement("br", null),
                                    "Kenaikan"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50" },
                                    "Status",
                                    Native.createElement("br", null),
                                    "BB/U"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50" },
                                    "Status",
                                    Native.createElement("br", null),
                                    "PB/TB-U"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50" },
                                    "Status",
                                    Native.createElement("br", null),
                                    "BB/PB atau BB/TB"),
                                Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50" },
                                    "Status",
                                    Native.createElement("br", null),
                                    "IMT/U"))),
                            Native.createElement("th", { className: "px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider" }, "Aksi"))),
                    Native.createElement("tbody", { className: "bg-white divide-y divide-slate-100" }, pageLoading ? (Native.createElement(TableLoadingSkeleton, { columnCount: tableColumnCount })) : pageItems.length === 0 ? (Native.createElement("tr", null,
                        Native.createElement("td", { colSpan: tableColumnCount, className: "px-6 py-12 text-center text-slate-400" }, "Tidak ada data ditemukan"))) : (pageItems.map((child, index) => {
                        if (!child.id)
                            return null;
                        const realIndex = (currentPage - 1) * itemsPerPage + index + 1;
                        const mpasiLog = mpasiLogs[child.id];
                        const hasMpasi = !!mpasiLog;
                        const measurement = monthlyMeasurements[child.id];
                        const localStatuses = getMeasurementStatuses(measurement || {}, child, measurement?.tglUkur ? new Date(measurement.tglUkur) : currentFilterDate);
                        const pythonStatus = pythonStatuses[String(child.id)];
                        const statuses = pythonStatus ? {
                            ...localStatuses,
                            statusBbu: pythonStatus.bbuStatus,
                            statusTbu: pythonStatus.tbuStatus,
                            statusBbtb: pythonStatus.bbtbStatus,
                            statusImtu: pythonStatus.imtuStatus,
                            statusLilau: pythonStatus.lilaStatus,
                            statusLku: pythonStatus.lkStatus,
                            zScoreBbu: pythonStatus.bbuZScore,
                            zScoreTbu: pythonStatus.tbuZScore,
                            zScoreBbtb: pythonStatus.bbtbZScore,
                            zScoreImtu: pythonStatus.imtuZScore,
                            zScoreLilau: pythonStatus.lilaZScore,
                            zScoreLku: pythonStatus.lkZScore,
                        } : localStatuses;
                        const age = statuses.age;
                        const statusBbu = statuses.statusBbu;
                        const statusTbu = statuses.statusTbu;
                        const statusBbtb = statuses.statusBbtb;
                        const statusImtu = statuses.statusImtu;
                        return (Native.createElement("tr", { key: child.id, className: "ios-data-row text-xs" },
                            Native.createElement("td", { className: "px-4 py-3 whitespace-nowrap text-slate-500 border-r border-slate-100 text-center md:sticky md:left-0 bg-white z-10" }, realIndex),
                            Native.createElement("td", { className: "px-4 py-3 whitespace-nowrap border-r border-slate-100 md:sticky md:left-[48px] bg-white z-10 md:shadow-lg" },
                                Native.createElement("div", { className: "font-bold text-slate-900" }, child.nama),
                                Native.createElement("div", { className: `text-[10px] font-mono ${!child.hasNIK ? 'text-red-600 font-bold' : 'text-slate-500'}` }, child.nik),
                                Native.createElement("div", { className: "flex gap-1 mt-1" },
                                    Native.createElement(Badge, { color: child.jk === 'L' ? 'blue' : 'pink' }, child.jk === 'L' ? 'L' : 'P'),
                                    Native.createElement("span", { className: "text-[10px] text-slate-400" },
                                        formatIndoDate(child.tglLahir),
                                        " (",
                                        age,
                                        " Bln)"))),
                            Native.createElement("td", { className: "px-4 py-3 whitespace-nowrap border-r border-slate-100" },
                                Native.createElement("div", { className: "font-medium text-slate-700" }, child.namaOrtu)),
                            activeTab === 'recycle_bin' && (Native.createElement("td", { className: "px-4 py-3 min-w-[11rem] border-r border-slate-100 bg-rose-50/30" },
                                Native.createElement("span", { className: "font-semibold text-rose-700" }, child.deleteReason || 'Alasan tidak tercatat'))),
                            isFullAccessRole(user.role) && (Native.createElement("td", { className: "px-4 py-3 whitespace-nowrap border-r border-slate-100 text-slate-600" }, child.desa)),
                            (user.role === ROLES.BIDAN || isFullAccessRole(user.role)) && (Native.createElement("td", { className: "px-4 py-3 whitespace-nowrap border-r border-slate-100 text-slate-600" }, child.posyandu)),
                            activeTab === 'mpasi' ? (Native.createElement(Native.Fragment, null,
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? formatIndoDate(mpasiLog.tglMonitoring) : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? mpasiLog.asi : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.makananPokok?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.kacang?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.susu?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.daging?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.telur?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.sayurVitA?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? (mpasiLog.sayurLain?.length ? 'Ya' : 'Tidak') : '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 text-[10px]" }, hasMpasi ? mpasiLog.intervensiGizi : '-'))) : (Native.createElement(Native.Fragment, null,
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10" }, measurement?.bb || '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10" }, measurement?.tb || '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10" }, measurement?.lila || '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10" }, measurement?.lk || '-'),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 bg-indigo-50/10" },
                                    Native.createElement(KenaikanBadge, { status: measurement?.statusNaik })),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10" },
                                    Native.createElement(StatusBadge, { status: statusBbu })),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10" },
                                    Native.createElement(StatusBadge, { status: statusTbu })),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10" },
                                    Native.createElement(StatusBadge, { status: statusBbtb })),
                                Native.createElement("td", { className: "px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10" },
                                    Native.createElement(StatusBadge, { status: statusImtu })))),
                            Native.createElement("td", { className: "px-4 py-3 whitespace-nowrap text-center" },
                                Native.createElement("div", { className: "flex justify-center gap-1" }, readOnly ? Native.createElement("span", { className: "text-xs font-semibold text-slate-400" }, "Hanya baca") : activeTab === 'recycle_bin' ? (Native.createElement(Native.Fragment, null,
                                    Native.createElement(Button, { variant: "actionGreen", className: "table-action-button table-action-green", onClick: () => handleRestore(child.id), title: "Pulihkan" },
                                        Native.createElement(RotateCcw, { className: "w-4 h-4" })),
                                    Native.createElement(Button, { variant: "actionRed", className: "table-action-button table-action-red", onClick: () => handlePermanentDelete(child.id), title: "Hapus Permanen" },
                                        Native.createElement(X, { className: "w-4 h-4" })))) : (Native.createElement(Native.Fragment, null,
                                    activeTab === 'mpasi' && (Native.createElement(Button, { variant: "actionOrange", className: "table-action-button table-action-orange", onClick: () => setChildToMpasi(child), title: "Input MPASI" },
                                        Native.createElement(Utensils, { className: "w-4 h-4" }))),
                                    ['problem_wasting', 'problem_underweight', 'problem_tidak_naik'].includes(activeTab) && (Native.createElement(Button, { variant: "actionGreen", className: "table-action-button table-action-pmt", onClick: () => setPmtModalData({ child, category: getPmtCategoryForTab(activeTab) }), title: "Beri PMT" },
                                        Native.createElement(Gift, { className: "w-4 h-4" }))),
                                    Native.createElement(Button, { variant: "actionBlue", className: "table-action-button table-action-blue", onClick: () => onEditChild(child), title: "Edit Identitas" },
                                        Native.createElement(Pencil, { className: "w-4 h-4" })),
                                    Native.createElement(Button, { variant: "actionGreen", className: "table-action-button table-action-cyan", onClick: () => onOpenMeasurement(child), title: "Pengukuran Balita" },
                                        Native.createElement(Ruler, { className: "w-4 h-4" })),
                                    Native.createElement(Button, { variant: "actionRed", className: "table-action-button table-action-red", onClick: () => setChildToDelete(child), title: "Hapus Balita" },
                                        Native.createElement(Trash2, { className: "w-4 h-4" }))))))));
                    }))))),
            Native.createElement("div", { className: "ios-table-footer flex flex-col sm:flex-row justify-between items-center gap-4" },
                Native.createElement("span", { className: "text-xs text-slate-500 font-medium" },
                    "Menampilkan ",
                    pageItems.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0,
                    " - ",
                    Math.min(currentPage * itemsPerPage, totalItems),
                    " dari ",
                    totalItems,
                    " data"),
                Native.createElement(Pagination, { currentPage: currentPage, totalPages: totalPages, disablePrevious: pageLoading || currentPage === 1, disableNext: pageLoading || currentPage >= totalPages || totalItems === 0, onPrevious: () => setCurrentPage((page) => Math.max(1, page - 1)), onNext: () => setCurrentPage((page) => page + 1) })))));
}
