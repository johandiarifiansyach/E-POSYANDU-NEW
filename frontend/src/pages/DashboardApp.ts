// @ts-nocheck
import Native, { useState, useEffect, useLayoutEffect, useMemo, useRef } from '../runtime/dom';
import { APP_VERSION } from '../config/app';
import { getFirestore, collection, addDoc, query, where, onSnapshot, serverTimestamp, updateDoc, doc, deleteDoc, getDocs, getDocsForExport, getCachedChildrenPage, getChangeHistory, getChildDetail, getChildrenPage, getDashboardStats, getMonitoringStatus, getSigiziMeasurementExport, initializeApp, listSyncConflicts, resolveSyncConflict, subscribeToSyncConflicts, subscribeToSyncedMutations, syncActiveViewFromServer, syncPendingMutations, orderBy } from '../api/client';
import { WHO_0_TO_5 } from '../data/anthropometry';
import { getPreferredColorScheme, saveColorScheme, subscribeColorScheme } from '../theme/colorScheme';
import { actionTooltipProps } from '../ui/actionTooltip';
import { Ruler, LogOut, Plus, MapPin, Clock, Baby, XCircle, ChevronDown, ChevronLeft, ChevronRight, Loader2, LayoutDashboard, Users, Trash2, Menu, AlertTriangle, TrendingDown, AlertCircle, Minus, Utensils, Gift, ClipboardCheck, CheckSquare, History, Filter, RotateCcw, UserRound, X, Moon, Sun } from '../ui/icons';
import { showSuccess } from '../ui/notifications';
import { openReleaseNotes } from '../ui/releaseNotes';
import { DashboardPageSkeleton } from '../ui/skeleton';
export function formatChildName(value) {
    return value
        .toLowerCase()
        .replace(/(^|[\s'-])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}
// --- 1. CONFIGURATION & CONSTANTS ---
const app = initializeApp({
    projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6'
});
export const db = getFirestore(app);
export const appId = import.meta.env.VITE_APP_ID || 'siposyandu-377b6';
const XLSX_SCRIPT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const XLSX_SCRIPT_INTEGRITY = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
let xlsxLoadPromise = null;
const ensureXlsx = () => {
    if (window.XLSX)
        return Promise.resolve(window.XLSX);
    if (xlsxLoadPromise)
        return xlsxLoadPromise;
    xlsxLoadPromise = new Promise((resolve, reject) => {
        const existingScript = document.querySelector(`script[src="${XLSX_SCRIPT_SRC}"]`);
        const script = existingScript || document.createElement('script');
        script.addEventListener('load', () => resolve(window.XLSX), { once: true });
        script.addEventListener('error', () => reject(new Error('Gagal memuat library Excel.')), { once: true });
        if (!existingScript) {
            script.src = XLSX_SCRIPT_SRC;
            script.integrity = XLSX_SCRIPT_INTEGRITY;
            script.crossOrigin = 'anonymous';
            script.async = true;
            document.body.appendChild(script);
        }
    });
    return xlsxLoadPromise;
};
export const DATA_WILAYAH = {
    "Desa Gumukmas": Array.from({ length: 17 }, (_, i) => `SALAK ${i + 1}`).concat(["SALAK 99"]),
    "Desa Menampu": Array.from({ length: 14 }, (_, i) => `SALAK ${i + 18}`).concat(["SALAK 98"]),
    "Desa Mayangan": Array.from({ length: 11 }, (_, i) => `SALAK ${i + 32}`),
    "Desa Kepanjen": Array.from({ length: 10 }, (_, i) => `SALAK ${i + 43}`),
    "Desa Purwoasri": Array.from({ length: 9 }, (_, i) => `SALAK ${i + 53}`)
};
export const ROLES = {
    KADER: "Kader Posyandu",
    BIDAN: "Bidan Desa",
    GIZI: "Ahli Gizi"
};
const DashboardOverviewPage = Native.lazy(() => import('./DashboardOverviewPage'));
const PmtProgramPage = Native.lazy(() => import('./PmtProgramPage'));
const ChangeHistoryPage = Native.lazy(() => import('./ChangeHistoryPage'));
const ChildrenTablePage = Native.lazy(() => import('./ChildrenTablePage'));
const MeasurementPage = Native.lazy(() => import('./MeasurementPage'));
const AddChildPage = Native.lazy(() => import('./AddChildPage'));
const ExclusiveBreastfeedingPage = Native.lazy(() => import('./ExclusiveBreastfeedingPage'));
const DASHBOARD_TABS = [
    'dashboard',
    'data_balita',
    'asi_eksklusif',
    'mpasi',
    'problem_underweight',
    'problem_stunting',
    'problem_wasting',
    'problem_tidak_naik',
    'pmt_program',
    'recent',
    'change_history',
    'recycle_bin',
    'add_child',
    'measurement'
];
const COMPACT_SIDEBAR_MEDIA_QUERY = '(min-width: 768px), (orientation: landscape) and (min-width: 560px)';
const shouldDefaultToCompactSidebar = () => {
    if (typeof window === 'undefined')
        return true;
    return window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches;
};
const applySidebarCollapsedState = (shell, button, collapsed) => {
    if (shell)
        shell.classList.toggle('is-sidebar-collapsed', collapsed);
    if (button) {
        button.setAttribute('aria-label', collapsed ? 'Perluas Menu' : 'Ringkas Menu');
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
};
const isDashboardTab = (value) => {
    return DASHBOARD_TABS.includes(value);
};
const getDashboardHashState = () => {
    if (typeof window === 'undefined')
        return { tab: 'dashboard', measurementChildId: null };
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (hash.startsWith('measurement/')) {
        const childId = decodeURIComponent(hash.replace(/^measurement\//, ''));
        return { tab: childId ? 'measurement' : 'data_balita', measurementChildId: childId || null };
    }
    return isDashboardTab(hash) ? { tab: hash, measurementChildId: null } : { tab: 'dashboard', measurementChildId: null };
};
export const MONTHS = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
];
export const YEARS = [2025, 2026, 2027, 2028, 2029, 2030];
// --- KBM STANDARDS ---
const KBM_TABLE = {
    1: 800, 2: 900, 3: 800, 4: 600, 5: 500,
    6: 400, 7: 300, 8: 300, 9: 300, 10: 300,
    11: 200
};
export const getKBM = (ageInMonths) => {
    if (ageInMonths <= 1)
        return 800;
    if (ageInMonths > 60)
        return 200;
    if (ageInMonths >= 11)
        return 200;
    return KBM_TABLE[ageInMonths] || 200;
};
// --- 2. UTILITY FUNCTIONS ---
const generateRandomDigits = (length) => {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10);
    }
    return result;
};
export const formatDate = (date) => {
    if (!date)
        return '';
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
        return date;
    const d = new Date(date);
    if (Number.isNaN(d.getTime()))
        return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};
export const formatIndoDate = (dateString) => {
    if (!dateString)
        return '-';
    const d = new Date(dateString);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const formatIndoDateTime = (timestamp) => {
    if (!timestamp)
        return '-';
    const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const getAgeInMonths = (birthDateString, refDate = new Date()) => {
    if (!birthDateString)
        return 0;
    const [year, month, day] = birthDateString.slice(0, 10).split('-').map(Number);
    if (!year || !month || !day)
        return 0;
    let months = (refDate.getFullYear() - year) * 12 + (refDate.getMonth() - (month - 1));
    if (refDate.getDate() < day)
        months -= 1;
    return Math.max(months, 0);
};
// --- ANTROPOMETRY: PERMENKES NO. 2 TAHUN 2020 / WHO 0-60 BULAN ---
const normalizeDecimalInput = (value) => {
    const raw = String(value ?? '').trim();
    let result = '';
    let hasSeparator = false;
    for (const char of raw) {
        if (char >= '0' && char <= '9') {
            result += char;
            continue;
        }
        if (!hasSeparator && char.trim() !== '') {
            result += '.';
            hasSeparator = true;
        }
    }
    return result;
};
const parseLocaleNumber = (value) => {
    const normalized = normalizeDecimalInput(value).trim();
    if (!normalized)
        return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
};
const parseLocaleNumberForRange = (value, minimum, maximum, decimalShiftLimit = 2) => {
    const normalized = normalizeDecimalInput(value).trim();
    if (!normalized)
        return null;
    const direct = Number(normalized);
    if (Number.isFinite(direct) && direct >= minimum && direct <= maximum)
        return direct;
    if (!normalized.includes('.')) {
        for (let shift = 1; shift <= decimalShiftLimit; shift += 1) {
            const candidate = Number(normalized) / Math.pow(10, shift);
            if (Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum)
                return candidate;
        }
    }
    return Number.isFinite(direct) ? direct : null;
};
const toPositiveNumber = (value) => {
    const numberValue = parseLocaleNumber(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
};
const calculateLmsZScore = (value, [l, m, s]) => {
    if (l === 0)
        return Math.log(value / m) / s;
    return (Math.pow(value / m, l) - 1) / (l * s);
};
const getAdjustedLengthHeight = (value, ageMonths, caraUkur) => {
    if (ageMonths <= 24 && caraUkur === 'Berdiri')
        return value + 0.7;
    if (ageMonths > 24 && caraUkur === 'Terlentang')
        return value - 0.7;
    return value;
};
export const calculateZScore = (val, type, ageMonths, gender, secondaryVal = null, caraUkur) => {
    const primaryValue = toPositiveNumber(val);
    const age = Math.floor(ageMonths);
    if (primaryValue === null || age < 0 || age > 60)
        return null;
    if (type === 'BBU') {
        return calculateLmsZScore(primaryValue, WHO_0_TO_5.weightForAge[gender][age]);
    }
    const measuredLengthHeight = toPositiveNumber(secondaryVal);
    const lengthHeight = type === 'TBU' ? primaryValue : measuredLengthHeight;
    if (lengthHeight === null)
        return null;
    const adjustedLengthHeight = getAdjustedLengthHeight(lengthHeight, age, caraUkur);
    if (type === 'TBU') {
        return calculateLmsZScore(adjustedLengthHeight, WHO_0_TO_5.lengthHeightForAge[gender][age]);
    }
    if (type === 'IMTU') {
        const bmi = primaryValue / Math.pow(adjustedLengthHeight / 100, 2);
        return calculateLmsZScore(bmi, WHO_0_TO_5.bmiForAge[gender][age]);
    }
    const isLength = age <= 24;
    const minimumLengthHeight = isLength ? 45 : 65;
    const standards = isLength ? WHO_0_TO_5.weightForLength : WHO_0_TO_5.weightForHeight;
    const index = Math.round((adjustedLengthHeight - minimumLengthHeight) * 2);
    const standard = standards[gender][index];
    if (!standard)
        return null;
    return calculateLmsZScore(primaryValue, standard);
};
const getGiziLabel = (zScore, type) => {
    if (zScore === null)
        return "-";
    if (type === 'BBU') {
        if (zScore < -3)
            return "Berat Sangat Kurang";
        if (zScore < -2)
            return "Berat Kurang";
        if (zScore <= 1)
            return "Berat Normal";
        return "Risiko Berat Lebih";
    }
    if (type === 'TBU') {
        if (zScore < -3)
            return "Sangat Pendek";
        if (zScore < -2)
            return "Pendek";
        if (zScore <= 3)
            return "Normal";
        return "Tinggi";
    }
    if (type === 'BBTB' || type === 'IMTU') {
        if (zScore < -3)
            return "Gizi Buruk";
        if (zScore < -2)
            return "Gizi Kurang";
        if (zScore <= 1)
            return "Gizi Baik";
        if (zScore <= 2)
            return "Risiko Gizi Lebih";
        if (zScore <= 3)
            return "Gizi Lebih";
        return "Obesitas";
    }
    return "-";
};
export const calculateGiziStatus = (val, type, ageMonths, gender, secondaryVal = null, caraUkur) => {
    const zScore = calculateZScore(val, type, ageMonths, gender, secondaryVal, caraUkur);
    return getGiziLabel(zScore, type);
};
// --- 3. UI COMPONENTS ---
export const Card = ({ children, className = "" }) => (Native.createElement("div", { className: `app-card rounded-2xl ${className}` }, children));
export const Button = ({ children, onClick, variant = "primary", className = "", disabled = false, type = "button", title = "" }) => {
    const baseStyle = "apple-button px-4 py-2.5 rounded-xl font-semibold text-xs transition-all duration-200 flex items-center justify-center gap-2 focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]";
    const variants = {
        primary: "apple-button-primary bg-[#007aff] text-white hover:bg-[#006ee6] focus:ring-blue-100",
        secondary: "apple-button-secondary bg-white/70 text-slate-700 border border-white/80 hover:bg-white hover:text-slate-900 focus:ring-slate-100",
        danger: "apple-button-danger bg-rose-50/80 text-rose-600 hover:bg-rose-100 focus:ring-rose-50 border border-rose-100",
        dangerFilled: "apple-button-danger-filled bg-[#ff3b30] text-white hover:bg-[#e8342b] focus:ring-rose-200",
        ghost: "apple-button-ghost bg-transparent text-slate-600 hover:bg-white/60 hover:text-[#007aff] shadow-none",
        actionBlue: "bg-blue-50/80 text-[#007aff] hover:bg-blue-100 border border-blue-100 px-3 py-2",
        actionGreen: "bg-emerald-50/80 text-emerald-600 hover:bg-emerald-100 border border-emerald-100 px-3 py-2",
        actionRed: "bg-rose-50/80 text-rose-600 hover:bg-rose-100 border border-rose-100 px-3 py-2",
        actionOrange: "bg-orange-50/80 text-orange-600 hover:bg-orange-100 border border-orange-100 px-3 py-2",
    };
    const isTableAction = className.split(/\s+/).includes('table-action-button');
    const tooltipHandlers = isTableAction && title ? actionTooltipProps(title) : {};
    return (Native.createElement("button", { ...tooltipHandlers, type: type, onClick: onClick, disabled: disabled, title: isTableAction ? undefined : title, "aria-label": title || undefined, className: `${baseStyle} ${variants[variant]} ${className}` },
        disabled && Native.createElement(Loader2, { className: "w-3 h-3 animate-spin" }),
        children));
};
export const InputGroup = ({ label, children, error }) => (Native.createElement("div", { className: "space-y-2" },
    Native.createElement("label", { className: "block text-xs font-bold text-slate-500 uppercase tracking-wider" }, label),
    children,
    error && Native.createElement("p", { className: "text-xs text-rose-500" }, error)));
export const Select = ({ value, onChange, options, disabled, required = false, className = "" }) => (Native.createElement("div", { className: "relative w-full" },
    Native.createElement("select", { value: value, onChange: onChange, disabled: disabled, required: required, className: `apple-select w-full appearance-none bg-white/70 border border-slate-200/70 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-2.5 pr-8 disabled:bg-slate-100 disabled:text-slate-400 transition-shadow ${className}` }, options.map((opt) => Native.createElement("option", { key: opt.value, value: opt.value }, opt.label))),
    Native.createElement(ChevronDown, { className: "absolute right-3 top-3 w-4 h-4 text-slate-400 pointer-events-none" })));
const LocationFilterPanel = ({ draftDesa, draftPosyandu, filterMonth, filterYear, onApply, onReset, role, setDraftDesa, setDraftPosyandu, setFilterMonth, setFilterYear, user }) => {
    const isGizi = role === ROLES.GIZI;
    const hasLocationFilter = role !== ROLES.KADER;
    const activeDesa = isGizi ? draftDesa : (user.desa || '');
    const posyanduOptions = activeDesa ? DATA_WILAYAH[activeDesa] || [] : [];
    return (Native.createElement("section", { className: `app-card ios-scope-panel overflow-hidden rounded-2xl ${hasLocationFilter ? '' : 'is-period-only'}`, "aria-label": hasLocationFilter ? "Periode dan wilayah data" : "Periode data", "data-scope-panel": "true" },
        Native.createElement("div", { className: "ios-scope-period-row" },
            Native.createElement("div", { className: "ios-scope-period-title" },
                Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-blue", "aria-hidden": "true" },
                    Native.createElement(Clock, { className: "h-4 w-4" })),
                Native.createElement("span", null, "Periode Data")),
            Native.createElement("div", { className: "ios-scope-period-control glass-control" },
                Native.createElement("select", { value: filterMonth, onChange: (event) => setFilterMonth(parseInt(event.target.value)), className: "period-select", "aria-label": "Pilih bulan" }, MONTHS.map((month, index) => Native.createElement("option", { key: month, value: index + 1 }, month))),
                Native.createElement("span", { className: "ios-scope-period-divider", "aria-hidden": "true" }),
                Native.createElement("select", { value: filterYear, onChange: (event) => setFilterYear(parseInt(event.target.value)), className: "period-select period-year", "aria-label": "Pilih tahun" }, YEARS.map((year) => Native.createElement("option", { key: year, value: year }, year)))),
            hasLocationFilter && Native.createElement("button", { type: "button", onClick: onReset, title: "Atur ulang pilihan wilayah", "aria-label": "Atur ulang pilihan wilayah", className: "ios-symbol-button ios-scope-reset" },
                Native.createElement(RotateCcw, { className: "h-4 w-4", "aria-hidden": "true" }))),
        hasLocationFilter && Native.createElement("div", { className: isGizi ? "ios-scope-location-grid is-gizi" : "ios-scope-location-grid" },
            isGizi && (Native.createElement("label", { className: "block min-w-0" },
                Native.createElement("span", { className: "mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600" }, "Desa / Kelurahan"),
                Native.createElement("div", { className: "relative" },
                    Native.createElement(MapPin, { className: "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }),
                    Native.createElement("select", { value: draftDesa, onChange: (event) => {
                            setDraftDesa(event.target.value);
                            setDraftPosyandu('');
                        }, className: "min-h-11 w-full appearance-none border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm font-medium text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" },
                        Native.createElement("option", { value: "" }, "Semua Desa"),
                        Object.keys(DATA_WILAYAH).map((desa) => Native.createElement("option", { key: desa, value: desa }, desa))),
                    Native.createElement(ChevronDown, { className: "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" })))),
            Native.createElement("label", { className: "block min-w-0" },
                Native.createElement("span", { className: "mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600" }, "Posyandu"),
                Native.createElement("div", { className: "relative" },
                    Native.createElement(MapPin, { className: "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }),
                    Native.createElement("select", { value: draftPosyandu, onChange: (event) => setDraftPosyandu(event.target.value), disabled: !activeDesa, className: "min-h-11 w-full appearance-none border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm font-medium text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400" },
                        Native.createElement("option", { value: "" }, "Semua Posyandu"),
                        posyanduOptions.map((posyandu) => Native.createElement("option", { key: posyandu, value: posyandu }, posyandu))),
                    Native.createElement(ChevronDown, { className: "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }))),
            Native.createElement(Button, { onClick: onApply, className: "ios-toolbar-button min-h-11 w-full whitespace-nowrap sm:w-auto", title: "Terapkan filter wilayah" },
                Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" },
                    Native.createElement(Filter, { className: "h-4 w-4" })),
                "Terapkan"))));
};
export const Badge = ({ children, color = "emerald" }) => {
    const colors = { emerald: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200", blue: "bg-blue-100 text-blue-700 ring-1 ring-blue-200", pink: "bg-pink-100 text-pink-700 ring-1 ring-pink-200", slate: "bg-slate-100 text-slate-600 ring-1 ring-slate-200", amber: "bg-amber-100 text-amber-700 ring-1 ring-amber-200" };
    return Native.createElement("span", { className: `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${colors[color]}` }, children);
};
export const KenaikanBadge = ({ status }) => {
    if (!status)
        return Native.createElement("span", { className: "text-slate-300" }, "-");
    let color = "bg-slate-100 text-slate-700", label = status;
    switch (status) {
        case 'N':
            color = "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200";
            label = "N (Naik)";
            break;
        case 'T':
            color = "bg-rose-100 text-rose-700 ring-1 ring-rose-200";
            label = "T (Tidak Naik)";
            break;
        case 'B':
            color = "bg-blue-100 text-blue-700 ring-1 ring-blue-200";
            label = "B (Baru)";
            break;
        case 'O':
            color = "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
            label = "O (Tidak Hadir)";
            break;
        default: label = status;
    }
    return Native.createElement("span", { className: `ios-status-pill px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}` }, label);
};
export const StatusBadge = ({ status }) => {
    if (status === "-" || !status)
        return Native.createElement("span", { className: "text-slate-300" }, "-");
    let color = "bg-slate-100 text-slate-700";
    if (["Berat Normal", "Normal", "Gizi Baik"].includes(status))
        color = "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200";
    if (["Berat Kurang", "Pendek", "Gizi Kurang", "Risiko Berat Lebih", "Risiko Gizi Lebih"].includes(status))
        color = "bg-amber-100 text-amber-700 ring-1 ring-amber-200";
    if (["Berat Sangat Kurang", "Sangat Pendek", "Gizi Buruk", "Obesitas"].includes(status))
        color = "bg-rose-100 text-rose-700 ring-1 ring-rose-200";
    if (["Tinggi", "Gizi Lebih"].includes(status))
        color = "bg-blue-100 text-blue-700 ring-1 ring-blue-200";
    return Native.createElement("span", { className: `ios-status-pill px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}` }, status);
};
// --- 4. MODALS & SCREENS (Defined BEFORE Dashboard and App) ---
const MpasiModal = ({ child, onClose }) => {
    const [formData, setFormData] = useState({
        tglMonitoring: formatDate(new Date()),
        asi: 'Ya',
        makananPokok: false,
        kacang: false,
        susu: false,
        daging: false,
        telur: false,
        sayurVitA: false,
        sayurLain: false,
        intervensiGizi: 'Tidak'
    });
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'mpasi_logs'), {
                childId: child.id,
                childName: child.nama,
                tglMonitoring: formData.tglMonitoring,
                asi: formData.asi,
                makananPokok: formData.makananPokok ? ['Ya'] : [],
                kacang: formData.kacang ? ['Ya'] : [],
                susu: formData.susu ? ['Ya'] : [],
                daging: formData.daging ? ['Ya'] : [],
                telur: formData.telur ? ['Ya'] : [],
                sayurVitA: formData.sayurVitA ? ['Ya'] : [],
                sayurLain: formData.sayurLain ? ['Ya'] : [],
                intervensiGizi: formData.intervensiGizi,
                createdAt: serverTimestamp()
            });
            await syncPendingMutations();
            showSuccess('Data MPASI berhasil disimpan.');
            onClose();
        }
        catch (error) {
            console.error(error);
        }
        finally {
            setLoading(false);
        }
    };
    const CheckItem = ({ label, desc, checked, onChange }) => (Native.createElement("button", { type: "button", className: `ios-mpasi-food-toggle ${checked ? 'is-checked' : ''}`, onClick: () => onChange(!checked), "aria-pressed": checked ? "true" : "false" },
        Native.createElement("span", { className: "ios-mpasi-check", "aria-hidden": "true" }, checked && Native.createElement(ClipboardCheck, { className: "h-4 w-4" })),
        Native.createElement("span", { className: "min-w-0 text-left" },
            Native.createElement("strong", null, label),
            Native.createElement("small", null, desc))));
    return (Native.createElement("div", { className: "ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center", "data-mpasi-modal": "true" },
        Native.createElement("div", { className: "ios-liquid-modal ios-mpasi-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "mpasi-modal-title" },
            Native.createElement("header", { className: "ios-modal-header" },
                Native.createElement("div", { className: "ios-modal-title-group" },
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-orange", "aria-hidden": "true" },
                        Native.createElement(Utensils, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "min-w-0" },
                        Native.createElement("h2", { id: "mpasi-modal-title" }, "Pemantauan MPASI"),
                        Native.createElement("p", null,
                            child.nama,
                            " - usia 6-23 bulan"))),
                Native.createElement("button", { type: "button", onClick: onClose, className: "ios-modal-close", title: "Tutup pemantauan MPASI", "aria-label": "Tutup pemantauan MPASI" },
                    Native.createElement(X, { className: "h-5 w-5", "aria-hidden": "true" }))),
            Native.createElement("form", { onSubmit: handleSubmit, className: "ios-modal-body ios-mpasi-form", "data-mpasi-modal-scroll": "true" },
                Native.createElement("div", { className: "ios-modal-context" },
                    Native.createElement("span", null, "Catatan konsumsi"),
                    Native.createElement("strong", null, "MPASI 6-23 bulan")),
                Native.createElement(InputGroup, { label: "Tanggal Monitoring" },
                    Native.createElement("input", { type: "date", required: true, className: "ios-liquid-control w-full p-2.5", value: formData.tglMonitoring, onChange: e => setFormData({ ...formData, tglMonitoring: e.target.value }) })),
                Native.createElement("div", { className: "ios-form-grid ios-form-grid-two" },
                    Native.createElement(InputGroup, { label: "Masih Diberi ASI?" },
                        Native.createElement(Select, { className: "ios-liquid-control", value: formData.asi, onChange: e => setFormData({ ...formData, asi: e.target.value }), options: [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }] })),
                    Native.createElement(InputGroup, { label: "Intervensi Gizi (MT/Formula)?" },
                        Native.createElement(Select, { className: "ios-liquid-control", value: formData.intervensiGizi, onChange: e => setFormData({ ...formData, intervensiGizi: e.target.value }), options: [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }] }))),
                Native.createElement("fieldset", { className: "ios-mpasi-food-fieldset" },
                    Native.createElement("legend", null, "Komposisi makanan yang dikonsumsi"),
                    Native.createElement("div", { className: "ios-mpasi-food-grid" },
                        Native.createElement(CheckItem, { checked: formData.makananPokok, onChange: v => setFormData({ ...formData, makananPokok: v }), label: "Makanan Pokok", desc: "Nasi, mie, jagung, roti, kentang, dan ubi" }),
                        Native.createElement(CheckItem, { checked: formData.kacang, onChange: v => setFormData({ ...formData, kacang: v }), label: "Kacang-kacangan", desc: "Tempe, tahu, kacang hijau, tanah, dan kedelai" }),
                        Native.createElement(CheckItem, { checked: formData.susu, onChange: v => setFormData({ ...formData, susu: v }), label: "Produk Susu Hewani", desc: "Susu, formula, yoghurt, dan keju" }),
                        Native.createElement(CheckItem, { checked: formData.daging, onChange: v => setFormData({ ...formData, daging: v }), label: "Daging-dagingan", desc: "Ayam, ikan, daging merah, hati, dan seafood" }),
                        Native.createElement(CheckItem, { checked: formData.telur, onChange: v => setFormData({ ...formData, telur: v }), label: "Telur", desc: "Telur ayam, puyuh, dan bebek" }),
                        Native.createElement(CheckItem, { checked: formData.sayurVitA, onChange: v => setFormData({ ...formData, sayurVitA: v }), label: "Buah dan Sayur Kaya Vit A", desc: "Pepaya, mangga, wortel, bayam, katuk, dan kelor" }),
                        Native.createElement(CheckItem, { checked: formData.sayurLain, onChange: v => setFormData({ ...formData, sayurLain: v }), label: "Buah dan Sayur Lainnya", desc: "Pisang, jeruk, semangka, buncis, dan terong" }))),
                Native.createElement("div", { className: "ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "flex-1" }, "Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "ios-modal-primary-orange flex-1" }, "Simpan Data MPASI"))))));
};
const PmtModal = ({ child, category, onClose }) => {
    const [formData, setFormData] = useState({
        jenisPmt: 'Pabrikan',
        sumberAnggaran: 'Dana Desa',
        mitra: '',
        mitraLain: '',
        tglPemberian: formatDate(new Date()),
        siklusKe: '1',
        pmtSesuaiJuknis: 'Ya'
    });
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => {
        e.preventDefault();
        const siklusKe = parseLocaleNumber(formData.siklusKe);
        if (!Number.isFinite(siklusKe) || siklusKe <= 0) {
            showError('Siklus PMT wajib diisi angka desimal yang valid.');
            return;
        }
        setLoading(true);
        try {
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'pmt_programs'), {
                childId: child.id,
                childName: child.nama,
                category,
                jenisPmt: formData.jenisPmt,
                sumberAnggaran: formData.sumberAnggaran,
                mitra: formData.mitra,
                mitraLain: formData.mitraLain,
                tglPemberian: formData.tglPemberian,
                siklusKe,
                pmtSesuaiJuknis: formData.pmtSesuaiJuknis,
                status: 'Aktif',
                initialMeasurementDate: child.lastMeasurementDate || formData.tglPemberian,
                initialBB: child.currentBB || child.bbLahir || null,
                initialTB: child.currentTB || child.pbLahir || null,
                monitorings: {},
                createdAt: serverTimestamp()
            });
            await syncPendingMutations();
            showSuccess('Program PMT berhasil ditambahkan.');
            onClose();
        }
        catch (error) {
            console.error(error);
        }
        finally {
            setLoading(false);
        }
    };
    const handleSiklusKeChange = (event) => {
        const normalized = normalizeDecimalInput(event.target.value);
        setFormData((previous) => ({ ...previous, siklusKe: normalized }));
    };
    const handleSiklusKeBlur = () => {
        setFormData((previous) => {
            const value = String(previous.siklusKe ?? '');
            if (!value.endsWith('.'))
                return previous;
            return { ...previous, siklusKe: value.slice(0, -1) };
        });
    };
    const pmtInputClass = "ios-liquid-control w-full rounded-xl p-2.5";
    return (Native.createElement("div", { className: "ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center", "data-pmt-create-modal": "true" },
        Native.createElement("div", { className: "ios-liquid-modal ios-pmt-create-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pmt-create-title" },
            Native.createElement("div", { className: "ios-modal-header" },
                Native.createElement("div", { className: "ios-modal-title-group" },
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-green", "aria-hidden": "true" },
                        Native.createElement(Gift, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "min-w-0" },
                        Native.createElement("h2", { id: "pmt-create-title" }, "Pemberian PMT"),
                        Native.createElement("p", null, child.nama))),
                Native.createElement("button", { type: "button", onClick: onClose, className: "ios-modal-close", title: "Tutup pemberian PMT", "aria-label": "Tutup pemberian PMT" },
                    Native.createElement(X, { className: "h-4 w-4" }))),
            Native.createElement("form", { onSubmit: handleSubmit, className: "ios-modal-body ios-pmt-form" },
                Native.createElement("div", { className: "ios-modal-context" },
                    Native.createElement("span", null, "Kategori intervensi"),
                    Native.createElement("strong", null, category)),
                Native.createElement("div", { className: "ios-form-grid ios-form-grid-two" },
                    Native.createElement(InputGroup, { label: "Siklus Ke-" },
                        Native.createElement("input", { type: "text", inputMode: "decimal", required: true, className: pmtInputClass, value: formData.siklusKe, onChange: handleSiklusKeChange, onBlur: handleSiklusKeBlur })),
                    Native.createElement(InputGroup, { label: "Jenis PMT" },
                        Native.createElement(Select, { className: "ios-liquid-control", value: formData.jenisPmt, onChange: e => setFormData({ ...formData, jenisPmt: e.target.value }), options: [{ value: 'Pabrikan', label: 'Pabrikan' }, { value: 'Lokal', label: 'Lokal' }] }))),
                Native.createElement(InputGroup, { label: "Sumber Anggaran" },
                    Native.createElement(Select, { className: "ios-liquid-control", value: formData.sumberAnggaran, onChange: e => setFormData({ ...formData, sumberAnggaran: e.target.value }), options: [{ value: 'Dana Desa', label: 'Dana Desa' }, { value: 'DAK Non Fisik', label: 'DAK Non Fisik' }, { value: 'APBD', label: 'APBD' }, { value: 'Mitra', label: 'Mitra' }] })),
                formData.sumberAnggaran === 'Mitra' && (Native.createElement("div", { className: "ios-form-grid ios-form-grid-two" },
                    Native.createElement(InputGroup, { label: "Nama Mitra" },
                        Native.createElement("input", { type: "text", className: pmtInputClass, placeholder: "Contoh: CSR Perusahaan A", value: formData.mitra, onChange: e => setFormData({ ...formData, mitra: e.target.value }) })),
                    formData.mitra === 'Lainnya' && Native.createElement(InputGroup, { label: "Mitra Lainnya" },
                        Native.createElement("input", { type: "text", className: pmtInputClass, value: formData.mitraLain, onChange: e => setFormData({ ...formData, mitraLain: e.target.value }) })))),
                Native.createElement("div", { className: "ios-form-grid ios-form-grid-two" },
                    Native.createElement(InputGroup, { label: "PMT Sesuai Juknis?" },
                        Native.createElement(Select, { className: "ios-liquid-control", value: formData.pmtSesuaiJuknis, onChange: e => setFormData({ ...formData, pmtSesuaiJuknis: e.target.value }), options: [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }] })),
                    Native.createElement(InputGroup, { label: "Tanggal Mulai Pemberian" },
                        Native.createElement("input", { type: "date", required: true, className: pmtInputClass, value: formData.tglPemberian, onChange: e => setFormData({ ...formData, tglPemberian: e.target.value }) }))),
                Native.createElement("div", { className: "ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "ios-modal-secondary flex-1" }, "Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "ios-modal-primary ios-modal-primary-green flex-1" }, loading ? "Menyimpan..." : "Simpan Program"))))));
};
const PmtMonitoringModal = ({ program, child, onClose }) => {
    const [week, setWeek] = useState(1);
    const [data, setData] = useState({
        tgl: formatDate(new Date()),
        bb: '',
        tb: '',
        days: [false, false, false, false, false, false, false],
        pemantauanKesehatan: 'Ada',
        tindakLanjut: 'Dilanjutkan'
    });
    const maxWeeks = program.category === 'Wasting' ? 8 : (program.category === 'Underweight' ? 4 : 2);
    const weeksArr = Array.from({ length: maxWeeks }, (_, i) => i + 1);
    const measureDate = new Date(data.tgl);
    const ageAtMeasure = getAgeInMonths(child.tglLahir, measureDate);
    const caraUkur = ageAtMeasure >= 24 ? 'Berdiri' : 'Terlentang';
    useEffect(() => {
        if (program.monitorings && program.monitorings[week]) {
            const m = program.monitorings[week];
            setData({
                tgl: m.tgl,
                bb: m.bb.toString(),
                tb: m.tb.toString(),
                days: m.days || [false, false, false, false, false, false, false],
                pemantauanKesehatan: m.pemantauanKesehatan || 'Ada',
                tindakLanjut: m.tindakLanjut || 'Dilanjutkan'
            });
        }
        else {
            setData({
                tgl: formatDate(new Date()),
                bb: '',
                tb: '',
                days: [false, false, false, false, false, false, false],
                pemantauanKesehatan: 'Ada',
                tindakLanjut: 'Dilanjutkan'
            });
        }
    }, [week, program.monitorings]);
    const handleSave = async () => {
        try {
            if (!program.id)
                return;
            const parsedBb = parseLocaleNumber(data.bb);
            const parsedTb = parseLocaleNumber(data.tb);
            if (!Number.isFinite(parsedBb) || !Number.isFinite(parsedTb)) {
                showError('BB dan TB wajib diisi dengan angka desimal yang valid.');
                return;
            }
            const updatedMonitorings = {
                ...program.monitorings,
                [week]: {
                    tgl: data.tgl,
                    bb: parsedBb,
                    tb: parsedTb,
                    caraUkur: caraUkur,
                    days: data.days,
                    pemantauanKesehatan: data.pemantauanKesehatan,
                    tindakLanjut: data.tindakLanjut
                }
            };
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'pmt_programs', program.id), { monitorings: updatedMonitorings, updatedAt: serverTimestamp() });
            await syncPendingMutations();
            showSuccess(`Pemantauan PMT minggu ${week} berhasil disimpan.`);
            onClose();
        }
        catch (e) {
            console.error(e);
        }
    };
    const toggleDay = (idx) => {
        const newDays = [...data.days];
        newDays[idx] = !newDays[idx];
        setData({ ...data, days: newDays });
    };
    const handleDecimalChange = (field) => (event) => {
        const normalized = normalizeDecimalInput(event.target.value);
        setData((previous) => ({ ...previous, [field]: normalized }));
    };
    const handleDecimalBlur = (field) => () => {
        setData((previous) => {
            const value = String(previous[field] ?? '');
            if (!value.endsWith('.'))
                return previous;
            return { ...previous, [field]: value.slice(0, -1) };
        });
    };
    const monitoringInputClass = "ios-liquid-control w-full rounded-xl p-2.5";
    return (Native.createElement("div", { className: "ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center", "data-pmt-monitoring-modal": "true" },
        Native.createElement("div", { className: "ios-liquid-modal ios-pmt-monitoring-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pmt-monitoring-title" },
            Native.createElement("div", { className: "ios-modal-header" },
                Native.createElement("div", { className: "ios-modal-title-group" },
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-blue", "aria-hidden": "true" },
                        Native.createElement(ClipboardCheck, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "min-w-0" },
                        Native.createElement("h2", { id: "pmt-monitoring-title" }, "Pemantauan Mingguan"),
                        Native.createElement("p", null, `${child.nama} \u2022 ${program.category}`))),
                Native.createElement("button", { type: "button", onClick: onClose, className: "ios-modal-close", title: "Tutup pemantauan PMT", "aria-label": "Tutup pemantauan PMT" },
                    Native.createElement(X, { className: "h-4 w-4" }))),
            Native.createElement("div", { className: "ios-modal-body ios-monitoring-body" },
                Native.createElement("div", { className: "ios-week-selector", role: "tablist", "aria-label": "Pilih minggu pemantauan" }, weeksArr.map(w => (Native.createElement("button", { key: w, type: "button", role: "tab", "aria-selected": week === w ? "true" : "false", onClick: () => setWeek(w), className: `ios-week-button ${week === w ? 'is-active' : ''} ${(program.monitorings && program.monitorings[w]) ? 'is-complete' : ''}` },
                    "Minggu ",
                    w)))),
                Native.createElement("div", { className: "ios-monitoring-form" },
                    Native.createElement(InputGroup, { label: `Data Pengukuran Minggu Ke-${week}` },
                        Native.createElement("input", { type: "date", className: monitoringInputClass, value: data.tgl, onChange: e => setData({ ...data, tgl: e.target.value }) })),
                    Native.createElement("div", { className: "ios-form-grid ios-form-grid-two" },
                        Native.createElement(InputGroup, { label: "Berat Badan (kg)" },
                            Native.createElement("input", { type: "text", inputMode: "decimal", className: monitoringInputClass, value: data.bb, onChange: handleDecimalChange('bb'), onBlur: handleDecimalBlur('bb') })),
                        Native.createElement(InputGroup, { label: "Tinggi Badan (cm)" },
                            Native.createElement("input", { type: "text", inputMode: "decimal", className: monitoringInputClass, value: data.tb, onChange: handleDecimalChange('tb'), onBlur: handleDecimalBlur('tb') }))),
                    Native.createElement("div", { className: "ios-modal-context ios-measurement-context" },
                        Native.createElement("span", null, "Cara ukur otomatis"),
                        Native.createElement("strong", null, `${caraUkur} \u2022 ${ageAtMeasure} bulan`)),
                    Native.createElement("fieldset", { className: "ios-consumption-fieldset" },
                        Native.createElement("legend", null, "Konsumsi PMT"),
                        Native.createElement("div", { className: "ios-day-grid" }, data.days.map((checked, i) => (Native.createElement("button", { key: i, type: "button", onClick: () => toggleDay(i), className: `ios-day-toggle ${checked ? 'is-checked' : ''}`, "aria-pressed": checked ? "true" : "false", "aria-label": `Konsumsi PMT hari ${i + 1}` },
                            Native.createElement("span", null, `H-${i + 1}`),
                            Native.createElement("span", { className: "ios-day-check", "aria-hidden": "true" }, checked && Native.createElement(CheckSquare, { className: "h-3 w-3" }))))))),
                    Native.createElement("div", { className: "ios-form-grid ios-form-grid-two" },
                        Native.createElement(InputGroup, { label: "Pemantauan Kesehatan" },
                            Native.createElement(Select, { className: "ios-liquid-control", value: data.pemantauanKesehatan, onChange: e => setData({ ...data, pemantauanKesehatan: e.target.value }), options: [{ value: 'Ada', label: 'Ada' }, { value: 'Tidak', label: 'Tidak' }] })),
                        Native.createElement(InputGroup, { label: "Tindak Lanjut" },
                            Native.createElement(Select, { className: "ios-liquid-control", value: data.tindakLanjut, onChange: e => setData({ ...data, tindakLanjut: e.target.value }), options: [{ value: 'Dilanjutkan', label: 'Dilanjutkan' }, { value: 'Selesai', label: 'Selesai' }, { value: 'Rujuk RS', label: 'Rujuk RS' }] })))),
                Native.createElement("div", { className: "ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "ios-modal-secondary flex-1" }, "Tutup"),
                    Native.createElement(Button, { variant: "primary", onClick: handleSave, className: "ios-modal-primary flex-1" },
                        "Simpan Minggu ",
                        week))))));
};
const DeleteChildModal = ({ child, onClose, onConfirm }) => {
    const [reason, setReason] = useState('Salah Input');
    const [deathDate, setDeathDate] = useState('');
    const [deathCause, setDeathCause] = useState('');
    const [deathLocation, setDeathLocation] = useState('');
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => { e.preventDefault(); setLoading(true); const deleteData = { deleteReason: reason, ...(reason === 'Meninggal Dunia' && { deathDate, deathCause, deathLocation }) }; if (child.id)
        await onConfirm(child.id, deleteData); setLoading(false); };
    const inputClass = "w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-rose-500 focus:border-rose-500 block p-2.5 transition-colors";
    return (Native.createElement("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm overflow-y-auto" },
        Native.createElement("div", { className: "bg-white rounded-3xl shadow-2xl w-full max-w-md" },
            Native.createElement("div", { className: "bg-rose-50 p-6 rounded-t-3xl border-b border-rose-100 flex items-start gap-4" },
                Native.createElement("div", { className: "p-2 bg-rose-100 rounded-full text-rose-600" },
                    Native.createElement(AlertTriangle, { className: "w-6 h-6" })),
                Native.createElement("div", null,
                    Native.createElement("h2", { className: "text-lg font-bold text-rose-700" }, "Hapus Data Balita"),
                    Native.createElement("p", { className: "text-sm text-rose-600 mt-1" }, "Data akan dipindahkan ke Recycle Bin."))),
            Native.createElement("form", { onSubmit: handleSubmit, className: "p-6 space-y-4" },
                Native.createElement("div", { className: "p-4 bg-slate-50 rounded-xl border border-slate-100 mb-4" },
                    Native.createElement("p", { className: "text-sm font-semibold text-slate-700" }, child.nama),
                    Native.createElement("p", { className: "text-xs text-slate-500 font-mono mt-1" }, child.nik)),
                Native.createElement(InputGroup, { label: "Alasan Menghapus" },
                    Native.createElement(Select, { value: reason, onChange: (e) => setReason(e.target.value), options: [{ value: 'Salah Input', label: 'Salah Input / Langsung Hapus' }, { value: 'Pindah Domisili', label: 'Pindah Domisili' }, { value: 'Meninggal Dunia', label: 'Meninggal Dunia' }] })),
                reason === 'Meninggal Dunia' && (Native.createElement("div", { className: "space-y-4 animate-in fade-in slide-in-from-top-2 duration-300" },
                    Native.createElement("div", { className: "p-3 bg-rose-50 border border-rose-100 rounded-lg text-xs text-rose-600" }, "Harap lengkapi data kematian untuk pelaporan."),
                    Native.createElement(InputGroup, { label: "Tanggal Meninggal" },
                        Native.createElement("input", { required: true, type: "date", className: inputClass, value: deathDate, onChange: e => setDeathDate(e.target.value) })),
                    Native.createElement(InputGroup, { label: "Penyebab Meninggal" },
                        Native.createElement("input", { required: true, type: "text", placeholder: "Contoh: Sakit Demam Berdarah", className: inputClass, value: deathCause, onChange: e => setDeathCause(e.target.value) })),
                    Native.createElement(InputGroup, { label: "Lokasi Meninggal" },
                        Native.createElement("input", { required: true, type: "text", placeholder: "Contoh: RSUD, Rumah", className: inputClass, value: deathLocation, onChange: e => setDeathLocation(e.target.value) })))),
                Native.createElement("div", { className: "pt-4 flex gap-3" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "flex-1" }, "Batal"),
                    Native.createElement(Button, { variant: "dangerFilled", type: "submit", disabled: loading, className: "flex-1" }, loading ? 'Memproses...' : 'Konfirmasi Hapus'))))));
};
const LegacyAddChildModal = ({ user, onClose, onSuccess, initialData = null, isEdit = false, allChildren = [] }) => {
    const [formData, setFormData] = useState({ nama: '', nik: '', anakKe: '', tglLahir: '', jk: 'L', noKK: '', hasKK: true, hasNIK: true, usiaKehamilan: '', bbLahir: '', pbLahir: '', lkLahir: '', bukuKIA: 'Ya', bukuKIAKecil: 'Tidak', imd: 'Ya', namaOrtu: '', nikOrtu: '', noHpOrtu: '', alamat: '', rt: '', rw: '', desa: user.role === ROLES.KADER || user.role === ROLES.BIDAN ? (user.desa || Object.keys(DATA_WILAYAH)[0]) : Object.keys(DATA_WILAYAH)[0], posyandu: user.role === ROLES.KADER ? (user.posyandu || DATA_WILAYAH[Object.keys(DATA_WILAYAH)[0]][0]) : DATA_WILAYAH[user.role === ROLES.BIDAN ? (user.desa || Object.keys(DATA_WILAYAH)[0]) : Object.keys(DATA_WILAYAH)[0]][0] });
    const [loading, setLoading] = useState(false);
    useEffect(() => { if (isEdit && initialData)
        setFormData({ ...initialData, hasKK: initialData.hasKK !== false, hasNIK: initialData.hasNIK !== false }); }, [isEdit, initialData?.id]);
    useEffect(() => {
        if (!isEdit || (isEdit && !formData.hasKK)) {
            let newKK = formData.noKK;
            if (!formData.hasKK)
                newKK = "350904" + generateRandomDigits(10);
            setFormData(prev => ({ ...prev, noKK: newKK }));
        }
    }, [formData.hasKK, isEdit]);
    // Updated NIK Generation Logic
    useEffect(() => {
        if (!isEdit || (isEdit && !formData.hasNIK)) {
            let newNIK = formData.nik;
            if (!formData.hasNIK && formData.tglLahir && formData.posyandu) {
                const d = new Date(formData.tglLahir);
                const dd = String(d.getDate()).padStart(2, '0');
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const yy = String(d.getFullYear()).slice(-2);
                const posyanduNumMatch = formData.posyandu.match(/\d+/);
                const posyanduCode = posyanduNumMatch ? String(posyanduNumMatch[0]).padStart(2, '0') : '00';
                const baseNIK = `350904${dd}${mm}${yy}00${posyanduCode}`;
                const specialPosyandus = ['SALAK 61', 'SALAK 98', 'SALAK 99'];
                const isSpecial = specialPosyandus.includes(formData.posyandu);
                let finalNIK = baseNIK;
                let isUnique = false;
                let attempts = 0;
                // Function to check uniqueness
                const checkUnique = (nik) => !(allChildren || []).some(c => c.nik === nik && c.id !== initialData?.id);
                // 1. Try standard first (if not special)
                if (!isSpecial && checkUnique(baseNIK)) {
                    finalNIK = baseNIK;
                    isUnique = true;
                }
                // 2. If special or standard collision, generate random last 2 digits
                while (!isUnique && attempts < 100) {
                    const maxRange = isSpecial ? 60 : 99;
                    const randomSuffix = String(Math.floor(Math.random() * maxRange) + 1).padStart(2, '0');
                    const prefix = `350904${dd}${mm}${yy}00`;
                    const candidateNIK = prefix + randomSuffix;
                    if (checkUnique(candidateNIK)) {
                        finalNIK = candidateNIK;
                        isUnique = true;
                    }
                    attempts++;
                }
                newNIK = finalNIK;
            }
            setFormData(prev => ({ ...prev, nik: newNIK }));
        }
    }, [formData.hasNIK, formData.tglLahir, formData.posyandu, isEdit, allChildren, initialData?.id]);
    const handleSubmit = async (e) => {
        e.preventDefault();
        const formElement = e.currentTarget;
        const readLiveField = (field, fallback) => {
            const input = formElement?.querySelector?.(`[name="${field}"]`);
            const liveValue = typeof input?.value === 'string' ? input.value : '';
            return liveValue || String(fallback ?? '');
        };
        const birthWeight = parseLocaleNumberForRange(readLiveField('bbLahir', formData.bbLahir), 0.1, 10, 2);
        const birthLength = parseLocaleNumberForRange(readLiveField('pbLahir', formData.pbLahir), 10, 120, 1);
        const birthHeadCircumference = parseLocaleNumberForRange(readLiveField('lkLahir', formData.lkLahir), 10, 80, 1);
        const normalizedFormData = {
            ...formData,
            bbLahir: birthWeight ?? '',
            pbLahir: birthLength ?? '',
            lkLahir: birthHeadCircumference ?? ''
        };
        setLoading(true);
        try {
            if (isEdit && initialData && initialData.id) {
                // Log Changes
                const changes = [];
                Object.keys(formData).forEach((key) => {
                    const k = key;
                    if (JSON.stringify(formData[k]) !== JSON.stringify(initialData[k]) && k !== 'updatedAt' && k !== 'createdAt') {
                        changes.push({ field: String(k), oldValue: initialData[k], newValue: formData[k] });
                    }
                });
                if (changes.length > 0) {
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'change_logs'), {
                        childId: initialData.id,
                        childName: initialData.nama,
                        changes,
                        changedBy: user.role,
                        timestamp: serverTimestamp()
                    });
                }
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', initialData.id), { ...normalizedFormData, updatedAt: serverTimestamp() });
            }
            else {
                const newChildRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), { ...normalizedFormData, currentBB: normalizedFormData.bbLahir, currentTB: normalizedFormData.pbLahir, currentLK: normalizedFormData.lkLahir, currentLILA: 0, createdAt: serverTimestamp(), createdBy: user.role, deletedAt: null });
                // AUTO-FILL FIRST MEASUREMENT FROM BIRTH DATA
                await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
                    childId: newChildRef.id,
                    childName: normalizedFormData.nama,
                    posyandu: normalizedFormData.posyandu,
                    desa: normalizedFormData.desa,
                    tglUkur: normalizedFormData.tglLahir, // Use Birth Date
                    bb: normalizedFormData.bbLahir, // Use Birth Weight
                    tb: normalizedFormData.pbLahir, // Use Birth Length
                    lk: normalizedFormData.lkLahir, // Use Birth Head Circumference
                    lila: '',
                    edema: 'Tidak',
                    kelasIbu: 'Tidak',
                    mbg: 'Tidak',
                    vitA: 'Tidak',
                    asi: 'Ya',
                    caraUkur: 'Terlentang',
                    statusNaik: 'B',
                    ageInMonths: 0,
                    createdAt: serverTimestamp()
                });
            }
            await syncPendingMutations();
            showSuccess(isEdit ? 'Data balita berhasil diperbarui.' : 'Data balita berhasil ditambahkan.');
            onSuccess();
            onClose();
        }
        catch (error) {
            console.error("Gagal menyimpan: " + error.message);
        }
        finally {
            setLoading(false);
        }
    };
    const handleDecimalFieldChange = (field) => (event) => {
        const normalized = normalizeDecimalInput(event.target.value);
        setFormData((previous) => ({ ...previous, [field]: normalized }));
    };
    const handleDecimalFieldBlur = (field) => () => {
        setFormData((previous) => {
            const value = String(previous[field] ?? '');
            const decimalRules = {
                bbLahir: { minimum: 0.1, maximum: 10, shift: 2 },
                pbLahir: { minimum: 10, maximum: 120, shift: 1 },
                lkLahir: { minimum: 10, maximum: 80, shift: 1 }
            };
            const rule = decimalRules[field];
            if (rule) {
                const parsed = parseLocaleNumberForRange(value, rule.minimum, rule.maximum, rule.shift);
                if (Number.isFinite(parsed)) {
                    const normalized = String(parsed).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
                    return { ...previous, [field]: normalized };
                }
            }
            if (!value.endsWith('.'))
                return previous;
            return { ...previous, [field]: value.slice(0, -1) };
        });
    };
    const inputClass = "w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors";
    return (Native.createElement("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md overflow-y-auto" },
        " ",
        Native.createElement("div", { className: "bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto" },
            " ",
            Native.createElement("div", { className: "sticky top-0 bg-white/80 backdrop-blur-md border-b border-slate-100 p-6 flex justify-between items-center z-10" },
                " ",
                Native.createElement("div", null,
                    " ",
                    Native.createElement("h2", { className: "text-xl font-bold text-slate-800" }, isEdit ? 'Edit Identitas Balita' : 'Registrasi Balita Baru'),
                    " ",
                    Native.createElement("p", { className: "text-sm text-slate-500" }, isEdit ? 'Perbarui data identitas balita' : 'Lengkapi data identitas dan demografi balita'),
                    " "),
                " ",
                Native.createElement("button", { onClick: onClose, className: "p-2 hover:bg-slate-100 rounded-full text-slate-500" },
                    Native.createElement(XCircle, { className: "w-6 h-6" })),
                " "),
            " ",
            Native.createElement("form", { onSubmit: handleSubmit, className: "p-6 space-y-8" },
                " ",
                Native.createElement("div", { className: "bg-emerald-50/50 p-6 rounded-2xl border border-emerald-100 space-y-4" },
                    " ",
                    Native.createElement("div", { className: "flex items-center gap-2 mb-2" },
                        " ",
                        Native.createElement(MapPin, { className: "w-5 h-5 text-emerald-600" }),
                        " ",
                        Native.createElement("h3", { className: "font-semibold text-emerald-900" }, "Lokasi Pencatatan"),
                        " "),
                    " ",
                    Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                        " ",
                        Native.createElement(InputGroup, { label: "Desa" },
                            " ",
                            Native.createElement(Select, { value: formData.desa, onChange: (e) => { const newDesa = e.target.value; setFormData({ ...formData, desa: newDesa, posyandu: DATA_WILAYAH[newDesa][0] }); }, disabled: user.role === ROLES.KADER || user.role === ROLES.BIDAN, options: Object.keys(DATA_WILAYAH).map(d => ({ value: d, label: d })) }),
                            " "),
                        " ",
                        Native.createElement(InputGroup, { label: "Posyandu" },
                            " ",
                            Native.createElement(Select, { value: formData.posyandu, onChange: (e) => setFormData({ ...formData, posyandu: e.target.value }), disabled: user.role === ROLES.KADER, options: DATA_WILAYAH[formData.desa]?.map(p => ({ value: p, label: p })) || [] }),
                            " "),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                    " ",
                    Native.createElement(InputGroup, { label: "Nama Lengkap Balita" },
                        " ",
                        Native.createElement("input", { required: true, type: "text", className: inputClass, value: formData.nama, onChange: e => setFormData({ ...formData, nama: e.target.value }) }),
                        " "),
                    " ",
                    Native.createElement("div", { className: "grid grid-cols-2 gap-4" },
                        " ",
                        Native.createElement(InputGroup, { label: "Anak Ke-" },
                            " ",
                            Native.createElement("input", { required: true, type: "text", inputMode: "numeric", className: inputClass, value: formData.anakKe, onChange: handleDecimalFieldChange('anakKe'), onBlur: handleDecimalFieldBlur('anakKe') }),
                            " "),
                        " ",
                        Native.createElement(InputGroup, { label: "Jenis Kelamin" },
                            " ",
                            Native.createElement(Select, { value: formData.jk, onChange: e => setFormData({ ...formData, jk: e.target.value }), options: [{ value: 'L', label: 'Laki-laki' }, { value: 'P', label: 'Perempuan' }] }),
                            " "),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                    " ",
                    Native.createElement(InputGroup, { label: "Tanggal Lahir" },
                        " ",
                        Native.createElement("input", { required: true, type: "date", className: inputClass, value: formData.tglLahir, onChange: e => setFormData({ ...formData, tglLahir: e.target.value }) }),
                        " "),
                    " ",
                    Native.createElement(InputGroup, { label: "Usia Kehamilan (Minggu)" },
                        " ",
                            Native.createElement("input", { required: true, type: "text", inputMode: "numeric", className: inputClass, value: formData.usiaKehamilan, onChange: handleDecimalFieldChange('usiaKehamilan'), onBlur: handleDecimalFieldBlur('usiaKehamilan') }),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                    " ",
                    Native.createElement("div", { className: "bg-slate-50 p-4 rounded-xl border border-slate-200" },
                        " ",
                        Native.createElement("div", { className: "flex justify-between items-center mb-2" },
                            " ",
                            Native.createElement("label", { className: "text-xs font-bold text-slate-500 uppercase" },
                                "No. KK ",
                                Native.createElement("span", { className: "text-rose-500" }, "*")),
                            " ",
                            Native.createElement("label", { className: "flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700" },
                                " ",
                                Native.createElement("input", { type: "checkbox", className: "rounded text-emerald-600 focus:ring-emerald-500", checked: !formData.hasKK, onChange: e => setFormData({ ...formData, hasKK: !e.target.checked }) }),
                                " Tidak punya KK "),
                            " "),
                        " ",
                        Native.createElement("input", { type: "text", maxLength: 16, required: formData.hasKK, readOnly: !formData.hasKK, className: `${inputClass} font-mono tracking-wider ${!formData.hasKK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`, value: formData.noKK, onChange: e => setFormData({ ...formData, noKK: e.target.value.replace(/\D/g, '') }) }),
                        " "),
                    " ",
                    Native.createElement("div", { className: "bg-slate-50 p-4 rounded-xl border border-slate-200" },
                        " ",
                        Native.createElement("div", { className: "flex justify-between items-center mb-2" },
                            " ",
                            Native.createElement("label", { className: "text-xs font-bold text-slate-500 uppercase" },
                                "NIK Balita ",
                                Native.createElement("span", { className: "text-rose-500" }, "*")),
                            " ",
                            Native.createElement("label", { className: "flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700" },
                                " ",
                                Native.createElement("input", { type: "checkbox", className: "rounded text-emerald-600 focus:ring-emerald-500", checked: !formData.hasNIK, onChange: e => setFormData({ ...formData, hasNIK: !e.target.checked }) }),
                                " Tidak punya NIK "),
                            " "),
                        " ",
                        Native.createElement("input", { type: "text", maxLength: 16, required: formData.hasNIK, readOnly: !formData.hasNIK, className: `${inputClass} font-mono tracking-wider ${!formData.hasNIK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`, value: formData.nik, onChange: e => setFormData({ ...formData, nik: e.target.value.replace(/\D/g, '') }) }),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "grid grid-cols-3 gap-4" },
                    " ",
                    Native.createElement(InputGroup, { label: "Berat Lahir (kg)" },
                        " ",
                        Native.createElement("input", { name: "bbLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.bbLahir, onInput: handleDecimalFieldChange('bbLahir'), onChange: handleDecimalFieldChange('bbLahir'), onBlur: handleDecimalFieldBlur('bbLahir') }),
                        " "),
                    " ",
                    Native.createElement(InputGroup, { label: "Panjang Lahir (cm)" },
                        " ",
                        Native.createElement("input", { name: "pbLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.pbLahir, onInput: handleDecimalFieldChange('pbLahir'), onChange: handleDecimalFieldChange('pbLahir'), onBlur: handleDecimalFieldBlur('pbLahir') }),
                        " "),
                    " ",
                    Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                        " ",
                        Native.createElement("input", { name: "lkLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.lkLahir, onInput: handleDecimalFieldChange('lkLahir'), onChange: handleDecimalFieldChange('lkLahir'), onBlur: handleDecimalFieldBlur('lkLahir') }),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "grid grid-cols-3 gap-4" },
                    " ",
                    Native.createElement(InputGroup, { label: "Buku KIA?" },
                        " ",
                        Native.createElement(Select, { value: formData.bukuKIA, onChange: e => setFormData({ ...formData, bukuKIA: e.target.value }), options: [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }] }),
                        " "),
                    " ",
                    Native.createElement(InputGroup, { label: "Buku KIA Kecil?" },
                        " ",
                        Native.createElement(Select, { value: formData.bukuKIAKecil, onChange: e => setFormData({ ...formData, bukuKIAKecil: e.target.value }), options: [{ value: 'Tidak', label: 'Tidak' }, { value: 'Ya', label: 'Ya' }] }),
                        " "),
                    " ",
                    Native.createElement(InputGroup, { label: "IMD?" },
                        " ",
                        Native.createElement(Select, { value: formData.imd, onChange: e => setFormData({ ...formData, imd: e.target.value }), options: [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }] }),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "border-t border-slate-100 pt-4" },
                    " ",
                    Native.createElement("h3", { className: "font-semibold text-slate-800 mb-4" }, "Data Orang Tua"),
                    " ",
                    Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6 mb-4" },
                        " ",
                        Native.createElement(InputGroup, { label: "Nama Orang Tua" },
                            " ",
                            Native.createElement("input", { required: true, type: "text", className: inputClass, value: formData.namaOrtu, onChange: e => setFormData({ ...formData, namaOrtu: e.target.value }) }),
                            " "),
                        " ",
                        Native.createElement(InputGroup, { label: "NIK Orang Tua" },
                            " ",
                            Native.createElement("input", { required: true, type: "text", maxLength: 16, className: inputClass, value: formData.nikOrtu, onChange: e => setFormData({ ...formData, nikOrtu: e.target.value.replace(/\D/g, '') }) }),
                            " "),
                        " "),
                    " ",
                    Native.createElement(InputGroup, { label: "Alamat Lengkap" },
                        " ",
                        Native.createElement("textarea", { rows: 2, required: true, className: inputClass, value: formData.alamat, onChange: e => setFormData({ ...formData, alamat: e.target.value }) }),
                        " "),
                    " ",
                    Native.createElement("div", { className: "grid grid-cols-3 gap-4 mt-4" },
                        " ",
                        Native.createElement(InputGroup, { label: "No HP" },
                            " ",
                            Native.createElement("input", { type: "text", className: inputClass, placeholder: "Kosong = No HP Kader", value: formData.noHpOrtu, onChange: e => setFormData({ ...formData, noHpOrtu: e.target.value.replace(/\D/g, '') }) }),
                            " "),
                        " ",
                        Native.createElement(InputGroup, { label: "RT" },
                            " ",
                            Native.createElement("input", { required: true, type: "text", className: inputClass, value: formData.rt, onChange: e => setFormData({ ...formData, rt: e.target.value.replace(/\D/g, '') }) }),
                            " "),
                        " ",
                        Native.createElement(InputGroup, { label: "RW" },
                            " ",
                            Native.createElement("input", { required: true, type: "text", className: inputClass, value: formData.rw, onChange: e => setFormData({ ...formData, rw: e.target.value.replace(/\D/g, '') }) }),
                            " "),
                        " "),
                    " "),
                " ",
                Native.createElement("div", { className: "pt-4 flex gap-3 justify-end border-t border-slate-100" },
                    " ",
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "w-full md:w-auto" }, "Batal"),
                    " ",
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "w-full md:w-auto" }, isEdit ? 'Perbarui Data' : 'Simpan Data'),
                    " "),
                " "),
            " "),
        " "));
};
const AddChildModal = ({ user, onClose, onSuccess, initialData = null, isEdit = false, allChildren = [] }) => {
    const [formData, setFormData] = useState(() => {
        const defaultDesa = user.role === ROLES.KADER || user.role === ROLES.BIDAN
            ? user.desa || Object.keys(DATA_WILAYAH)[0]
            : Object.keys(DATA_WILAYAH)[0];
        const defaultPosyandu = user.role === ROLES.KADER
            ? user.posyandu || DATA_WILAYAH[defaultDesa][0]
            : DATA_WILAYAH[defaultDesa][0];
        return {
            nama: '',
            nik: '',
            anakKe: '',
            tglLahir: '',
            jk: '',
            noKK: '',
            hasKK: true,
            hasNIK: true,
            usiaKehamilan: '',
            bbLahir: '',
            pbLahir: '',
            lkLahir: '',
            bukuKIA: '',
            bukuKIAKecil: '',
            imd: '',
            namaOrtu: '',
            nikOrtu: '',
            noHpOrtu: '',
            alamat: '',
            rt: '',
            rw: '',
            desa: defaultDesa,
            posyandu: defaultPosyandu
        };
    });
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (isEdit && initialData)
            setFormData({ ...initialData, hasKK: initialData.hasKK !== false, hasNIK: initialData.hasNIK !== false });
    }, [initialData?.id, isEdit]);
    useEffect(() => {
        if (!formData.hasKK) {
            setFormData((previous) => ({ ...previous, noKK: `350904${generateRandomDigits(10)}` }));
        }
    }, [formData.hasKK]);
    useEffect(() => {
        if (formData.hasNIK || !formData.tglLahir || !formData.posyandu)
            return;
        const birthDate = new Date(formData.tglLahir);
        const day = String(birthDate.getDate()).padStart(2, '0');
        const month = String(birthDate.getMonth() + 1).padStart(2, '0');
        const year = String(birthDate.getFullYear()).slice(-2);
        const posyanduNumber = formData.posyandu.match(/\d+/)?.[0] || '00';
        const standardNik = `350904${day}${month}${year}00${String(posyanduNumber).padStart(2, '0')}`;
        const specialPosyandu = ['SALAK 61', 'SALAK 98', 'SALAK 99'];
        const nikIsAvailable = (nik) => !allChildren.some((child) => child.nik === nik && child.id !== initialData?.id);
        let generatedNik = standardNik;
        if (specialPosyandu.includes(formData.posyandu) || !nikIsAvailable(standardNik)) {
            for (let attempts = 0; attempts < 100; attempts += 1) {
                const suffix = String(Math.floor(Math.random() * (specialPosyandu.includes(formData.posyandu) ? 60 : 99)) + 1).padStart(2, '0');
                const candidate = `350904${day}${month}${year}00${suffix}`;
                if (nikIsAvailable(candidate)) {
                    generatedNik = candidate;
                    break;
                }
            }
        }
        setFormData((previous) => ({ ...previous, nik: generatedNik }));
    }, [allChildren, formData.hasNIK, formData.posyandu, formData.tglLahir, initialData?.id]);
    const handleDecimalFieldChange = (field) => (event) => {
        const normalized = normalizeDecimalInput(event.target.value);
        setFormData((previous) => ({ ...previous, [field]: normalized }));
    };
    const handleDecimalFieldBlur = (field) => () => {
        setFormData((previous) => {
            const value = String(previous[field] ?? '');
            const decimalRules = {
                bbLahir: { minimum: 0.1, maximum: 10, shift: 2 },
                pbLahir: { minimum: 10, maximum: 120, shift: 1 },
                lkLahir: { minimum: 10, maximum: 80, shift: 1 }
            };
            const rule = decimalRules[field];
            if (rule) {
                const parsed = parseLocaleNumberForRange(value, rule.minimum, rule.maximum, rule.shift);
                if (Number.isFinite(parsed)) {
                    const normalized = String(parsed).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
                    return { ...previous, [field]: normalized };
                }
            }
            if (!value.endsWith('.'))
                return previous;
            return { ...previous, [field]: value.slice(0, -1) };
        });
    };
    const handleSubmit = async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const readLiveField = (field, fallback) => {
            const input = formElement?.querySelector?.(`[name="${field}"]`);
            const liveValue = typeof input?.value === 'string' ? input.value : '';
            return liveValue || String(fallback ?? '');
        };
        const birthWeight = parseLocaleNumberForRange(readLiveField('bbLahir', formData.bbLahir), 0.1, 10, 2);
        const birthLength = parseLocaleNumberForRange(readLiveField('pbLahir', formData.pbLahir), 10, 120, 1);
        const birthHeadCircumference = parseLocaleNumberForRange(readLiveField('lkLahir', formData.lkLahir), 10, 80, 1);
        const normalizedFormData = {
            ...formData,
            bbLahir: birthWeight ?? '',
            pbLahir: birthLength ?? '',
            lkLahir: birthHeadCircumference ?? ''
        };
        setLoading(true);
        try {
            if (isEdit && initialData?.id) {
                const changes = [];
                Object.keys(formData).forEach((key) => {
                    const field = key;
                    if (JSON.stringify(formData[field]) !== JSON.stringify(initialData[field]) &&
                        field !== 'updatedAt' &&
                        field !== 'createdAt') {
                        changes.push({ field: String(field), oldValue: initialData[field], newValue: formData[field] });
                    }
                });
                if (changes.length > 0) {
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'change_logs'), {
                        childId: initialData.id,
                        childName: initialData.nama,
                        changes,
                        changedBy: user.role,
                        timestamp: serverTimestamp()
                    });
                }
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', initialData.id), {
                    ...normalizedFormData,
                    updatedAt: serverTimestamp()
                });
            }
            else {
                const newChildRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), {
                    ...normalizedFormData,
                    currentBB: normalizedFormData.bbLahir,
                    currentTB: normalizedFormData.pbLahir,
                    currentLK: normalizedFormData.lkLahir,
                    currentLILA: 0,
                    createdAt: serverTimestamp(),
                    createdBy: user.role,
                    deletedAt: null
                });
                await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
                    childId: newChildRef.id,
                    childName: normalizedFormData.nama,
                    posyandu: normalizedFormData.posyandu,
                    desa: normalizedFormData.desa,
                    tglUkur: normalizedFormData.tglLahir,
                    bb: normalizedFormData.bbLahir,
                    tb: normalizedFormData.pbLahir,
                    lk: normalizedFormData.lkLahir,
                    lila: '',
                    edema: 'Tidak',
                    kelasIbu: 'Tidak',
                    mbg: 'Tidak',
                    vitA: 'Tidak',
                    asi: 'Ya',
                    caraUkur: 'Terlentang',
                    statusNaik: 'B',
                    ageInMonths: 0,
                    createdAt: serverTimestamp()
                });
            }
            await syncPendingMutations();
            showSuccess(isEdit ? 'Data balita berhasil diperbarui.' : 'Data balita berhasil ditambahkan.');
            onSuccess();
            onClose();
        }
        catch (error) {
            console.error('Gagal menyimpan: ' + error.message);
        }
        finally {
            setLoading(false);
        }
    };
    const inputClass = 'ios-liquid-control w-full text-slate-900 text-sm rounded-xl block p-2.5 transition-colors';
    const genderOptions = [
        { value: '', label: 'Pilih jenis kelamin' },
        { value: 'L', label: 'Laki-laki' },
        { value: 'P', label: 'Perempuan' }
    ];
    const yesNoOptions = [
        { value: '', label: 'Pilih jawaban' },
        { value: 'Ya', label: 'Ya' },
        { value: 'Tidak', label: 'Tidak' }
    ];
    return (Native.createElement("div", { className: "identity-modal-backdrop ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center", "data-identity-modal": "true", "data-identity-mode": isEdit ? "edit" : "create" },
        Native.createElement("div", { className: "identity-modal-panel ios-liquid-modal ios-identity-modal w-full max-w-4xl", role: "dialog", "aria-modal": "true", "aria-labelledby": "identity-modal-title" },
            Native.createElement("div", { className: "identity-modal-header ios-modal-header z-10" },
                Native.createElement("div", { className: "ios-modal-title-group" },
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-cyan", "aria-hidden": "true" },
                        Native.createElement(Baby, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "min-w-0" },
                        Native.createElement("h2", { id: "identity-modal-title" }, isEdit ? 'Edit Identitas Balita' : 'Registrasi Balita Baru'),
                        Native.createElement("p", null, isEdit ? formData.nama : 'Lengkapi identitas dan data kelahiran'))),
                Native.createElement("button", { type: "button", onClick: onClose, className: "ios-modal-close", title: "Tutup", "aria-label": "Tutup form identitas" },
                    Native.createElement(X, { className: "h-4 w-4" }))),
            Native.createElement("form", { onSubmit: handleSubmit, className: "identity-modal-scroll ios-modal-body space-y-8", "data-identity-modal-scroll": "true" },
                Native.createElement("section", { className: "space-y-4" },
                    Native.createElement("h3", { className: "font-semibold text-slate-800" }, "Lokasi Pencatatan"),
                    Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                        Native.createElement(InputGroup, { label: "Desa" },
                            Native.createElement(Select, { value: formData.desa, onChange: (event) => {
                                    const desa = event.target.value;
                                    setFormData((previous) => ({ ...previous, desa, posyandu: DATA_WILAYAH[desa][0] }));
                                }, disabled: user.role === ROLES.KADER || user.role === ROLES.BIDAN, required: true, options: Object.keys(DATA_WILAYAH).map((desa) => ({ value: desa, label: desa })) })),
                        Native.createElement(InputGroup, { label: "Posyandu" },
                            Native.createElement(Select, { value: formData.posyandu, onChange: (event) => setFormData((previous) => ({ ...previous, posyandu: event.target.value })), disabled: user.role === ROLES.KADER, required: true, options: (DATA_WILAYAH[formData.desa] || []).map((posyandu) => ({ value: posyandu, label: posyandu })) })))),
                Native.createElement("section", { className: "space-y-4" },
                    Native.createElement("h3", { className: "font-semibold text-slate-800" }, "Identitas Balita"),
                    Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                        Native.createElement(InputGroup, { label: "Nama Lengkap Balita" },
                            Native.createElement("input", { name: "nama", required: true, type: "text", className: inputClass, value: formData.nama, onChange: (event) => setFormData((previous) => ({ ...previous, nama: formatChildName(event.target.value) })) })),
                        Native.createElement("div", { className: "grid grid-cols-2 gap-4" },
                            Native.createElement(InputGroup, { label: "Anak Ke-" },
                                Native.createElement("input", { name: "anakKe", required: true, type: "text", inputMode: "numeric", className: inputClass, value: formData.anakKe, onChange: handleDecimalFieldChange('anakKe'), onBlur: handleDecimalFieldBlur('anakKe') })),
                            Native.createElement(InputGroup, { label: "Jenis Kelamin" },
                                Native.createElement(Select, { required: true, value: formData.jk, onChange: (event) => setFormData((previous) => ({ ...previous, jk: event.target.value })), options: genderOptions }))),
                        Native.createElement(InputGroup, { label: "Tanggal Lahir" },
                            Native.createElement("input", { name: "tglLahir", required: true, type: "date", className: inputClass, value: formData.tglLahir, onChange: (event) => setFormData((previous) => ({ ...previous, tglLahir: event.target.value })) })),
                        Native.createElement(InputGroup, { label: "Usia Kehamilan (Minggu)" },
                            Native.createElement("input", { name: "usiaKehamilan", required: true, type: "text", inputMode: "numeric", className: inputClass, value: formData.usiaKehamilan, onChange: handleDecimalFieldChange('usiaKehamilan'), onBlur: handleDecimalFieldBlur('usiaKehamilan') })),
                        Native.createElement("div", { className: "space-y-2" },
                            Native.createElement("div", { className: "flex items-center justify-between gap-3" },
                                Native.createElement("label", { className: "block text-xs font-bold text-slate-500 uppercase tracking-wider" }, "No. KK"),
                                Native.createElement("label", { className: "flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700 normal-case" },
                                    Native.createElement("input", { type: "checkbox", className: "rounded text-emerald-600 focus:ring-emerald-500", checked: !formData.hasKK, onChange: (event) => setFormData((previous) => ({ ...previous, hasKK: !event.target.checked })) }),
                                    "Tidak punya KK")),
                            Native.createElement("input", { name: "noKK", required: formData.hasKK, readOnly: !formData.hasKK, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "No. KK harus 16 digit", type: "text", className: `${inputClass} font-mono tracking-wider ${!formData.hasKK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`, value: formData.noKK, onChange: (event) => setFormData((previous) => ({ ...previous, noKK: event.target.value.replace(/\D/g, '') })) })),
                        Native.createElement("div", { className: "space-y-2" },
                            Native.createElement("div", { className: "flex items-center justify-between gap-3" },
                                Native.createElement("label", { className: "block text-xs font-bold text-slate-500 uppercase tracking-wider" }, "NIK Balita"),
                                Native.createElement("label", { className: "flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700 normal-case" },
                                    Native.createElement("input", { type: "checkbox", className: "rounded text-emerald-600 focus:ring-emerald-500", checked: !formData.hasNIK, onChange: (event) => setFormData((previous) => ({ ...previous, hasNIK: !event.target.checked })) }),
                                    "Tidak punya NIK")),
                            Native.createElement("input", { name: "nik", required: formData.hasNIK, readOnly: !formData.hasNIK, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "NIK balita harus 16 digit", type: "text", className: `${inputClass} font-mono tracking-wider ${!formData.hasNIK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`, value: formData.nik, onChange: (event) => setFormData((previous) => ({ ...previous, nik: event.target.value.replace(/\D/g, '') })) })))),
                Native.createElement("section", { className: "space-y-4" },
                    Native.createElement("h3", { className: "font-semibold text-slate-800" }, "Data Kelahiran"),
                    Native.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-3 gap-4" },
                        Native.createElement(InputGroup, { label: "Berat Lahir (kg)" },
                            Native.createElement("input", { name: "bbLahir", required: true, type: "text", inputMode: "decimal", placeholder: "Contoh: 3.20", title: "Masukkan kilogram, misalnya 3.2. Jangan masukkan 3200 gram.", className: inputClass, value: formData.bbLahir, onInvalid: (event) => event.currentTarget.setCustomValidity('Masukkan berat lahir dalam kilogram, misalnya 3.2. Jangan masukkan 3200 gram.'), onInput: (event) => {
                                    event.currentTarget.setCustomValidity('');
                                    handleDecimalFieldChange('bbLahir')(event);
                                }, onBlur: handleDecimalFieldBlur('bbLahir') })),
                        Native.createElement(InputGroup, { label: "Panjang Lahir (cm)" },
                            Native.createElement("input", { name: "pbLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.pbLahir, onInput: handleDecimalFieldChange('pbLahir'), onBlur: handleDecimalFieldBlur('pbLahir') })),
                        Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                            Native.createElement("input", { name: "lkLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.lkLahir, onInput: handleDecimalFieldChange('lkLahir'), onBlur: handleDecimalFieldBlur('lkLahir') }))),
                    Native.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-3 gap-4" },
                        Native.createElement(InputGroup, { label: "Buku KIA" },
                            Native.createElement(Select, { required: true, value: formData.bukuKIA, onChange: (event) => setFormData((previous) => ({ ...previous, bukuKIA: event.target.value })), options: yesNoOptions })),
                        Native.createElement(InputGroup, { label: "Buku KIA Kecil" },
                            Native.createElement(Select, { required: true, value: formData.bukuKIAKecil, onChange: (event) => setFormData((previous) => ({ ...previous, bukuKIAKecil: event.target.value })), options: yesNoOptions })),
                        Native.createElement(InputGroup, { label: "IMD" },
                            Native.createElement(Select, { required: true, value: formData.imd, onChange: (event) => setFormData((previous) => ({ ...previous, imd: event.target.value })), options: yesNoOptions })))),
                Native.createElement("section", { className: "space-y-4 border-t border-slate-100 pt-6" },
                    Native.createElement("h3", { className: "font-semibold text-slate-800" }, "Data Orang Tua"),
                    Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6" },
                        Native.createElement(InputGroup, { label: "Nama Orang Tua" },
                            Native.createElement("input", { name: "namaOrtu", required: true, type: "text", className: inputClass, value: formData.namaOrtu, onChange: (event) => setFormData((previous) => ({ ...previous, namaOrtu: event.target.value })) })),
                        Native.createElement(InputGroup, { label: "NIK Orang Tua" },
                            Native.createElement("input", { name: "nikOrtu", required: true, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "NIK orang tua harus 16 digit", type: "text", className: `${inputClass} font-mono tracking-wider`, value: formData.nikOrtu, onChange: (event) => setFormData((previous) => ({ ...previous, nikOrtu: event.target.value.replace(/\D/g, '') })) }))),
                    Native.createElement(InputGroup, { label: "Alamat Lengkap" },
                        Native.createElement("textarea", { name: "alamat", required: true, rows: 2, className: inputClass, value: formData.alamat, onChange: (event) => setFormData((previous) => ({ ...previous, alamat: event.target.value })) })),
                    Native.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-3 gap-4" },
                        Native.createElement(InputGroup, { label: "No. HP" },
                            Native.createElement("input", { name: "noHpOrtu", required: true, inputMode: "tel", pattern: "[0-9]{8,15}", maxLength: 15, title: "No. HP harus 8 sampai 15 digit", type: "text", className: inputClass, value: formData.noHpOrtu, onChange: (event) => setFormData((previous) => ({ ...previous, noHpOrtu: event.target.value.replace(/\D/g, '') })) })),
                        Native.createElement(InputGroup, { label: "RT" },
                            Native.createElement("input", { name: "rt", required: true, inputMode: "numeric", type: "text", className: inputClass, value: formData.rt, onChange: (event) => setFormData((previous) => ({ ...previous, rt: event.target.value.replace(/\D/g, '') })) })),
                        Native.createElement(InputGroup, { label: "RW" },
                            Native.createElement("input", { name: "rw", required: true, inputMode: "numeric", type: "text", className: inputClass, value: formData.rw, onChange: (event) => setFormData((previous) => ({ ...previous, rw: event.target.value.replace(/\D/g, '') })) })))),
                Native.createElement("div", { className: "identity-modal-actions ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "ios-modal-secondary w-full md:w-auto" }, "Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "ios-modal-primary w-full md:w-auto" }, loading ? 'Menyimpan...' : isEdit ? 'Perbarui Data' : 'Simpan Data'))))));
};
const MeasurementModal = ({ child, onClose }) => {
    const [activeMenu, setActiveMenu] = useState('history');
    const [formData, setFormData] = useState({
        tglUkur: formatDate(new Date()),
        bb: '',
        tb: '',
        lila: '',
        lk: '',
        edema: 'Tidak',
        kelasIbu: 'Tidak',
        mbg: 'Tidak',
        vitA: 'Tidak',
        asi: 'Tidak',
        caraUkur: '',
        statusNaik: 'B'
    });
    const [loading, setLoading] = useState(false);
    const [history, setHistory] = useState([]);
    useEffect(() => {
        const fetchHistory = async () => {
            try {
                if (!child.id)
                    return;
                const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), where('childId', '==', child.id));
                const snapshot = await getDocs(q);
                const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                data.sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
                setHistory(data);
            }
            catch (error) {
                console.error('Error fetching history:', error);
            }
        };
        void fetchHistory();
    }, [child.id]);
    useEffect(() => {
        if (!formData.bb || !formData.tglUkur)
            return;
        const currentWeight = parseLocaleNumber(formData.bb);
        if (currentWeight === null)
            return;
        const currentDate = new Date(formData.tglUkur);
        const prevMeasurement = history.find((m) => new Date(m.tglUkur).getTime() < currentDate.getTime());
        if (!prevMeasurement) {
            setFormData((prev) => ({ ...prev, statusNaik: 'B' }));
            return;
        }
        const prevDate = new Date(prevMeasurement.tglUkur);
        const diffTime = Math.abs(currentDate.getTime() - prevDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays > 45) {
            setFormData((prev) => ({ ...prev, statusNaik: 'O' }));
            return;
        }
        const prevWeight = parseLocaleNumber(prevMeasurement.bb);
        if (prevWeight === null)
            return;
        const gain = (currentWeight - prevWeight) * 1000;
        const measureAgeInMonths = getAgeInMonths(child.tglLahir, currentDate);
        const minGain = getKBM(measureAgeInMonths);
        const newStatus = gain >= minGain ? 'N' : 'T';
        setFormData((prev) => ({ ...prev, statusNaik: newStatus }));
    }, [formData.bb, formData.tglUkur, history, child.tglLahir]);
    const measureDate = useMemo(() => new Date(formData.tglUkur), [formData.tglUkur]);
    const ageAtMeasure = useMemo(() => getAgeInMonths(child.tglLahir, measureDate), [child.tglLahir, measureDate]);
    const monthlyHistory = useMemo(() => {
        const monthlyMap = new Map();
        history.forEach((item) => {
            if (!item.tglUkur)
                return;
            const monthKey = item.tglUkur.slice(0, 7);
            const existing = monthlyMap.get(monthKey);
            if (!existing || new Date(item.tglUkur).getTime() > new Date(existing.tglUkur).getTime()) {
                monthlyMap.set(monthKey, item);
            }
        });
        return Array.from(monthlyMap.values()).sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
    }, [history]);
    useEffect(() => {
        if (activeMenu !== 'add')
            return;
        if (ageAtMeasure > 24)
            setFormData((prev) => ({ ...prev, caraUkur: 'Berdiri' }));
        else
            setFormData((prev) => ({ ...prev, caraUkur: 'Terlentang' }));
    }, [ageAtMeasure, activeMenu]);
    const handleStartAdd = () => {
        setActiveMenu('add');
        setFormData((prev) => ({
            ...prev,
            tglUkur: formatDate(new Date()),
            bb: '',
            tb: '',
            lila: '',
            lk: '',
            edema: 'Tidak',
            kelasIbu: 'Tidak',
            mbg: 'Tidak',
            vitA: 'Tidak',
            asi: 'Tidak',
            statusNaik: 'B'
        }));
    };
    const handleSubmit = async (e) => {
        e.preventDefault();
        const formElement = e.currentTarget;
        const readLiveField = (field, fallback) => {
            const input = formElement?.querySelector?.(`[name="${field}"]`);
            const liveValue = typeof input?.value === 'string' ? input.value : '';
            return liveValue || String(fallback ?? '');
        };
        const weight = parseLocaleNumberForRange(readLiveField('bb', formData.bb), 0.1, 60, 2);
        const height = parseLocaleNumberForRange(readLiveField('tb', formData.tb), 10, 220, 1);
        const lila = parseLocaleNumberForRange(readLiveField('lila', formData.lila), 0.1, 50, 1);
        const lk = parseLocaleNumberForRange(readLiveField('lk', formData.lk), 0.1, 80, 1);
        const normalizedPayload = {
            ...formData,
            bb: weight ?? formData.bb,
            tb: height ?? formData.tb,
            lila: lila ?? formData.lila,
            lk: lk ?? formData.lk
        };
        setLoading(true);
        try {
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
                childId: child.id,
                childName: child.nama,
                posyandu: child.posyandu,
                desa: child.desa,
                ...normalizedPayload,
                ageInMonths: ageAtMeasure,
                createdAt: serverTimestamp()
            });
            if (child.id) {
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id), {
                    currentBB: normalizedPayload.bb,
                    currentTB: normalizedPayload.tb,
                    currentLILA: normalizedPayload.lila,
                    currentLK: normalizedPayload.lk,
                    lastMeasurementDate: formData.tglUkur,
                    updatedAt: serverTimestamp()
                });
            }
            onClose();
        }
        catch (error) {
            console.error('Gagal simpan: ' + error.message);
        }
        finally {
            setLoading(false);
        }
    };
    const inputClass = 'w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors';
    const showVitA = measureDate.getMonth() + 1 === 2 || measureDate.getMonth() + 1 === 8;
    const showAsi = ageAtMeasure >= 0 && ageAtMeasure <= 6;
    const handleDecimalFieldChange = (field) => (event) => {
        const normalized = normalizeDecimalInput(event.target.value);
        setFormData((previous) => ({ ...previous, [field]: normalized }));
    };
    const handleDecimalFieldBlur = (field) => () => {
        setFormData((previous) => {
            const value = String(previous[field] ?? '');
            const decimalRules = {
                bb: { minimum: 0.1, maximum: 60, shift: 2 },
                tb: { minimum: 10, maximum: 220, shift: 1 },
                lila: { minimum: 0.1, maximum: 50, shift: 1 },
                lk: { minimum: 0.1, maximum: 80, shift: 1 }
            };
            const rule = decimalRules[field];
            if (rule) {
                const parsed = parseLocaleNumberForRange(value, rule.minimum, rule.maximum, rule.shift);
                if (Number.isFinite(parsed)) {
                    const normalized = String(parsed).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
                    return { ...previous, [field]: normalized };
                }
            }
            if (!value.endsWith('.'))
                return previous;
            return { ...previous, [field]: value.slice(0, -1) };
        });
    };
    return (Native.createElement("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md overflow-y-auto" },
        Native.createElement("div", { className: "bg-white rounded-3xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto" },
            Native.createElement("div", { className: "bg-emerald-600 p-6 rounded-t-3xl text-white flex justify-between items-start" },
                Native.createElement("div", null,
                    Native.createElement("h2", { className: "text-xl font-bold" }, "Pengukuran Balita"),
                    Native.createElement("p", { className: "text-emerald-100 text-sm mt-1" },
                        child.nama,
                        " \u2022 ",
                        getAgeInMonths(child.tglLahir),
                        " Bulan")),
                Native.createElement("button", { onClick: onClose, className: "text-white/80 hover:text-white" },
                    Native.createElement(XCircle, { className: "w-6 h-6" }))),
            Native.createElement("div", { className: "p-6 space-y-5" },
                Native.createElement("div", { className: "flex flex-wrap gap-2 border-b border-slate-200 pb-4" },
                    Native.createElement(Button, { type: "button", variant: activeMenu === 'history' ? 'primary' : 'secondary', className: activeMenu === 'history' ? 'bg-emerald-600 hover:bg-emerald-700' : '', onClick: () => setActiveMenu('history') }, "Riwayat Penimbangan"),
                    Native.createElement(Button, { type: "button", variant: activeMenu === 'add' ? 'primary' : 'secondary', onClick: handleStartAdd },
                        Native.createElement(Plus, { className: "w-4 h-4" }),
                        " Tambah Pengukuran")),
                activeMenu === 'history' ? (Native.createElement("div", { className: "bg-slate-50 rounded-2xl border border-slate-200 p-4" },
                    Native.createElement("h3", { className: "text-sm font-bold text-slate-700 mb-3" }, "Riwayat Penimbangan Bulan ke Bulan"),
                    monthlyHistory.length === 0 ? (Native.createElement("p", { className: "text-xs text-slate-500" }, "Belum ada riwayat pengukuran.")) : (Native.createElement("div", { className: "ios-table-scroll overflow-x-auto" },
                        Native.createElement("table", { className: "ios-data-table ios-measurement-table min-w-full text-xs" },
                            Native.createElement("thead", null,
                                Native.createElement("tr", { className: "text-slate-500 border-b border-slate-200" },
                                    Native.createElement("th", { className: "text-left py-2 pr-4" }, "Bulan"),
                                    Native.createElement("th", { className: "text-left py-2 pr-4" }, "Tanggal Ukur"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "BB"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "TB"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "LILA"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "LK"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "Status BB/U"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "Status TB/U"),
                                    Native.createElement("th", { className: "text-center py-2 px-2" }, "Status BB/TB"),
                                    Native.createElement("th", { className: "text-center py-2 pl-2" }, "Naik BB"))),
                            Native.createElement("tbody", null, monthlyHistory.map((h) => {
                                const monthLabel = new Date(h.tglUkur).toLocaleDateString('id-ID', {
                                    month: 'short',
                                    year: 'numeric'
                                });
                                const ageAtHistory = getAgeInMonths(child.tglLahir, new Date(h.tglUkur));
                                const stBbu = calculateGiziStatus(h.bb, 'BBU', ageAtHistory, child.jk);
                                const stTbu = calculateGiziStatus(h.tb, 'TBU', ageAtHistory, child.jk, null, h.caraUkur);
                                const stBbtb = calculateGiziStatus(h.bb, 'BBTB', ageAtHistory, child.jk, h.tb, h.caraUkur);
                                return (Native.createElement("tr", { key: h.id || h.tglUkur, className: "ios-data-row text-slate-700" },
                                    Native.createElement("td", { className: "py-2 pr-4 font-semibold uppercase whitespace-nowrap" }, monthLabel),
                                    Native.createElement("td", { className: "py-2 pr-4 whitespace-nowrap" }, formatIndoDate(h.tglUkur)),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" }, h.bb || '-'),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" }, h.tb || '-'),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" }, h.lila || '-'),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" }, h.lk || '-'),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" },
                                        Native.createElement(StatusBadge, { status: stBbu })),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" },
                                        Native.createElement(StatusBadge, { status: stTbu })),
                                    Native.createElement("td", { className: "py-2 px-2 text-center" },
                                        Native.createElement(StatusBadge, { status: stBbtb })),
                                    Native.createElement("td", { className: "py-2 pl-2 text-center" },
                                        Native.createElement(KenaikanBadge, { status: h.statusNaik }))));
                            }))))))) : (Native.createElement("form", { onSubmit: handleSubmit, className: "space-y-6" },
                    Native.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4" },
                        Native.createElement(InputGroup, { label: "Tanggal Pengukuran" },
                              Native.createElement("input", { required: true, type: "date", className: inputClass, value: formData.tglUkur, onChange: (e) => setFormData((previous) => ({ ...previous, tglUkur: e.target.value })) })),
                        Native.createElement(InputGroup, { label: "Cara Ukur" },
                            Native.createElement("input", { type: "text", readOnly: true, className: `${inputClass} bg-slate-100 text-slate-500`, value: formData.caraUkur }))),
                    Native.createElement("div", { className: "grid grid-cols-2 gap-4" },
                        Native.createElement(InputGroup, { label: "Berat Badan (kg)" },
                            Native.createElement("input", { name: "bb", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.bb, onInput: handleDecimalFieldChange('bb'), onChange: handleDecimalFieldChange('bb'), onBlur: handleDecimalFieldBlur('bb') })),
                        Native.createElement(InputGroup, { label: "Tinggi Badan (cm)" },
                            Native.createElement("input", { name: "tb", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.tb, onInput: handleDecimalFieldChange('tb'), onChange: handleDecimalFieldChange('tb'), onBlur: handleDecimalFieldBlur('tb') }))),
                    Native.createElement("div", { className: "grid grid-cols-2 gap-4" },
                        Native.createElement(InputGroup, { label: "LiLa (cm)" },
                            Native.createElement("input", { name: "lila", type: "text", inputMode: "decimal", className: inputClass, value: formData.lila, onInput: handleDecimalFieldChange('lila'), onChange: handleDecimalFieldChange('lila'), onBlur: handleDecimalFieldBlur('lila') })),
                        Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                            Native.createElement("input", { name: "lk", type: "text", inputMode: "decimal", className: inputClass, value: formData.lk, onInput: handleDecimalFieldChange('lk'), onChange: handleDecimalFieldChange('lk'), onBlur: handleDecimalFieldBlur('lk') }))),
                    Native.createElement("input", { type: "hidden", value: formData.statusNaik }),
                    Native.createElement(InputGroup, { label: "Pitting Edema Bilateral" },
                        Native.createElement(Select, { value: formData.edema, onChange: (e) => setFormData({ ...formData, edema: e.target.value }), options: [
                                { value: 'Tidak', label: 'Tidak' },
                                { value: 'Ada (Derajat +1)', label: 'Ada (Derajat +1)' },
                                { value: 'Ada (Derajat +2)', label: 'Ada (Derajat +2)' },
                                { value: 'Ada (Derajat +3)', label: 'Ada (Derajat +3)' }
                            ] })),
                    Native.createElement("div", { className: "grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl" },
                        Native.createElement(InputGroup, { label: "Kelas Ibu Balita?" },
                            Native.createElement(Select, { value: formData.kelasIbu, onChange: (e) => setFormData({ ...formData, kelasIbu: e.target.value }), options: [
                                    { value: 'Tidak', label: 'Tidak' },
                                    { value: 'Ya', label: 'Ya' }
                                ] })),
                        Native.createElement(InputGroup, { label: "Terima MBG?" },
                            Native.createElement(Select, { value: formData.mbg, onChange: (e) => setFormData({ ...formData, mbg: e.target.value }), options: [
                                    { value: 'Tidak', label: 'Tidak' },
                                    { value: 'Ya', label: 'Ya' }
                                ] }))),
                    Native.createElement("div", { className: "space-y-4" },
                        showVitA && (Native.createElement("div", { className: "bg-amber-50 p-4 rounded-xl border border-amber-100" },
                            Native.createElement(InputGroup, { label: "Dapat Vitamin A (Feb/Agu)?" },
                                Native.createElement(Select, { className: "bg-white", value: formData.vitA, onChange: (e) => setFormData({ ...formData, vitA: e.target.value }), options: [
                                        { value: 'Tidak', label: 'Tidak' },
                                        { value: 'Ya', label: 'Ya' }
                                    ] })))),
                        showAsi && (Native.createElement("div", { className: "bg-blue-50 p-4 rounded-xl border border-blue-100" },
                            Native.createElement(InputGroup, { label: "ASI Eksklusif (0-6 bln)?" },
                                Native.createElement(Select, { className: "bg-white", value: formData.asi, onChange: (e) => setFormData({ ...formData, asi: e.target.value }), options: [
                                        { value: 'Tidak', label: 'Tidak' },
                                        { value: 'Ya', label: 'Ya' }
                                    ] }))))),
                    Native.createElement("div", { className: "pt-2 flex gap-3" },
                        Native.createElement(Button, { variant: "secondary", type: "button", onClick: () => setActiveMenu('history'), className: "flex-1" }, "Kembali ke Riwayat"),
                        Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "flex-1" }, "Simpan Pengukuran"))))))));
};
// --- MAIN DASHBOARD LAYOUT & LOGIC ---
const EMPTY_DASHBOARD_STATS = {
    S: 0, D: 0, N: 0, T: 0, B: 0, O: 0,
    asiEksklusif: 0, asiTarget: 0,
    underweight: 0, stunting: 0, wasting: 0,
    perD: '0', perN: '0', perT: '0', perAsiEksklusif: '0',
    perUnderweight: '0', perStunting: '0', perWasting: '0'
};
export const Dashboard = ({ user, onLogout }) => {
    const [children, setChildren] = useState([]);
    const [monthlyMeasurements, setMonthlyMeasurements] = useState({});
    const [pmtPrograms, setPmtPrograms] = useState([]);
    const [mpasiLogs, setMpasiLogs] = useState({});
    const [changeLogs, setChangeLogs] = useState([]);
    const [changeHistoryLoading, setChangeHistoryLoading] = useState(false);
    const [changeHistoryError, setChangeHistoryError] = useState(null);
    const [changeHistoryRevision, setChangeHistoryRevision] = useState(0);
    const [changeHistoryPage, setChangeHistoryPage] = useState(1);
    const [changeHistoryTotal, setChangeHistoryTotal] = useState(0);
    const [editingChild, setEditingChild] = useState(null);
    const [childToDelete, setChildToDelete] = useState(null);
    const [childToMpasi, setChildToMpasi] = useState(null);
    const [pmtModalData, setPmtModalData] = useState(null);
    const [pmtMonitoringData, setPmtMonitoringData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState(null);
    const [dashboardStats, setDashboardStats] = useState(EMPTY_DASHBOARD_STATS);
    const [dashboardStatsLoading, setDashboardStatsLoading] = useState(false);
    const [monitoringStatus, setMonitoringStatus] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [searchDraft, setSearchDraft] = useState('');
    const [sortOrder, setSortOrder] = useState('recent');
    const [activeTab, setActiveTab] = useState(() => getDashboardHashState().tab);
    const [measurementChildId, setMeasurementChildId] = useState(() => getDashboardHashState().measurementChildId);
    const [selectedMeasurementChild, setSelectedMeasurementChild] = useState(null);
    const [measurementBackTab, setMeasurementBackTab] = useState('data_balita');
    const [addChildBackTab, setAddChildBackTab] = useState('data_balita');
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const sidebarCollapsedRef = useRef(shouldDefaultToCompactSidebar());
    const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
    const [colorScheme, setColorScheme] = useState(() => getPreferredColorScheme());
    const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
    const [filterYear, setFilterYear] = useState(new Date().getFullYear());
    const [viewDesa, setViewDesa] = useState(user.role === ROLES.GIZI ? '' : (user.desa || ''));
    const [viewPosyandu, setViewPosyandu] = useState(user.role === ROLES.KADER ? (user.posyandu || '') : '');
    const [draftDesa, setDraftDesa] = useState(user.role === ROLES.GIZI ? '' : (user.desa || ''));
    const [draftPosyandu, setDraftPosyandu] = useState(user.role === ROLES.KADER ? (user.posyandu || '') : '');
    const fileInputRef = useRef(null);
    const accountMenuRef = useRef(null);
    const appShellRef = useRef(null);
    const sidebarCollapseButtonRef = useRef(null);
    const sidebarTooltipRef = useRef(null);
    useEffect(() => subscribeColorScheme(setColorScheme), []);
    useEffect(() => {
        if (!isAccountMenuOpen)
            return;
        const closeOnOutsideClick = (event) => {
            if (accountMenuRef.current && !accountMenuRef.current.contains(event.target))
                setIsAccountMenuOpen(false);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape')
                setIsAccountMenuOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsideClick);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsideClick);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [isAccountMenuOpen]);
    useEffect(() => setIsAccountMenuOpen(false), [activeTab]);
    useEffect(() => {
        const compactLayout = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY);
        const handleLayoutChange = (event) => {
            if (!event.matches)
                return;
            sidebarCollapsedRef.current = true;
            applySidebarCollapsedState(appShellRef.current, sidebarCollapseButtonRef.current, true);
            setIsSidebarOpen(false);
        };
        compactLayout.addEventListener('change', handleLayoutChange);
        return () => compactLayout.removeEventListener('change', handleLayoutChange);
    }, []);
    // Pagination State
    const [currentPage, setCurrentPage] = useState(1);
    const [pagedChildren, setPagedChildren] = useState([]);
    const [pagedMeasurements, setPagedMeasurements] = useState({});
    const [pagedMpasiLogs, setPagedMpasiLogs] = useState({});
    const [pagedChildrenTotal, setPagedChildrenTotal] = useState(0);
    const [pagedChildrenLoading, setPagedChildrenLoading] = useState(false);
    const [dataRevision, setDataRevision] = useState(0);
    const [syncConflicts, setSyncConflicts] = useState([]);
    const itemsPerPage = 10;
    const serverPagedChildTabs = [
        'data_balita',
        'recent',
        'recycle_bin',
        'mpasi',
        'problem_underweight',
        'problem_stunting',
        'problem_wasting',
        'problem_tidak_naik'
    ];
    const isServerPagedChildTab = serverPagedChildTabs.includes(activeTab);
    useEffect(() => {
        const syncTabFromHash = () => {
            const hashState = getDashboardHashState();
            setActiveTab(hashState.tab);
            setMeasurementChildId(hashState.measurementChildId);
        };
        window.addEventListener('hashchange', syncTabFromHash);
        return () => window.removeEventListener('hashchange', syncTabFromHash);
    }, []);
    useEffect(() => {
        let refreshTimer;
        const unsubscribe = subscribeToSyncedMutations(() => {
            if (!isServerPagedChildTab && activeTab !== 'dashboard' && activeTab !== 'asi_eksklusif')
                return;
            if (refreshTimer !== undefined)
                window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                setDataRevision((revision) => revision + 1);
                refreshTimer = undefined;
            }, 200);
        });
        return () => {
            unsubscribe();
            if (refreshTimer !== undefined)
                window.clearTimeout(refreshTimer);
        };
    }, [activeTab, isServerPagedChildTab]);
    useEffect(() => {
        let current = true;
        const refreshConflicts = () => {
            void listSyncConflicts().then((items) => {
                if (current)
                    setSyncConflicts(items);
            });
        };
        refreshConflicts();
        const unsubscribe = subscribeToSyncConflicts(refreshConflicts);
        return () => {
            current = false;
            unsubscribe();
        };
    }, []);
    // Fetch Children
    useEffect(() => {
        const hasSelectedMeasurement = activeTab === 'measurement' && selectedMeasurementChild?.id === measurementChildId;
        if (activeTab === 'dashboard' || activeTab === 'asi_eksklusif' || isServerPagedChildTab || hasSelectedMeasurement) {
            setLoading(false);
            return;
        }
        const childrenCollection = collection(db, 'artifacts', appId, 'public', 'data', 'children');
        const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
        const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
        let q = query(childrenCollection);
        if (scopedDesa && scopedPosyandu) {
            q = query(childrenCollection, where('desa', '==', scopedDesa), where('posyandu', '==', scopedPosyandu));
        }
        else if (scopedDesa) {
            q = query(childrenCollection, where('desa', '==', scopedDesa));
        }
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setErrorMsg(null);
            let data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            if (user.role === ROLES.KADER)
                data = data.filter(c => c.posyandu === user.posyandu && c.desa === user.desa);
            else if (user.role === ROLES.BIDAN)
                data = data.filter(c => c.desa === user.desa);
            const now = new Date().getTime();
            const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
            data.forEach(async (child) => { if (child.deletedAt && child.id && (now - child.deletedAt.toDate().getTime() > THIRTY_DAYS_MS))
                await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id)); });
            data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
            setChildren(data);
            setLoading(false);
        }, (err) => { console.error(err); setErrorMsg("Gagal memuat data: " + err.message); setLoading(false); });
        return () => unsubscribe();
    }, [activeTab, isServerPagedChildTab, measurementChildId, selectedMeasurementChild, user, viewDesa, viewPosyandu]);
    // Reset pagination when filters change
    useLayoutEffect(() => {
        setCurrentPage(1);
    }, [activeTab, searchTerm, sortOrder, viewDesa, viewPosyandu, filterMonth, filterYear]);
    // Fetch Change Logs
    useEffect(() => {
        if (activeTab !== 'change_history')
            return;
        let current = true;
        setChangeHistoryLoading(true);
        setChangeHistoryError(null);
        void getChangeHistory(changeHistoryPage, 10)
            .then(({ items, total }) => {
                if (!current)
                    return;
                setChangeLogs(items.map((document) => ({ id: document.id, ...document.data })));
                setChangeHistoryTotal(total);
            })
            .catch((error) => {
                if (!current)
                    return;
                console.error('Gagal memuat riwayat perubahan:', error);
                setChangeHistoryError(error instanceof Error ? error.message : 'Riwayat perubahan tidak dapat dimuat.');
            })
            .finally(() => {
                if (current)
                    setChangeHistoryLoading(false);
            });
        return () => {
            current = false;
        };
    }, [activeTab, changeHistoryPage, changeHistoryRevision]);
    // Fetch Monthly Measurements
    useEffect(() => {
        if (activeTab === 'dashboard' || activeTab === 'asi_eksklusif' || isServerPagedChildTab) {
            setMonthlyMeasurements({});
            return;
        }
        setLoading(true);
        const m = String(filterMonth).padStart(2, '0');
        const y = filterYear;
        const startStr = `${y}-${m}-01`;
        const endStr = `${y}-${m}-31`;
        const measurementsCollection = collection(db, 'artifacts', appId, 'public', 'data', 'measurements');
        const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
        const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
        let q = query(measurementsCollection, where('tglUkur', '>=', startStr), where('tglUkur', '<=', endStr));
        if (scopedDesa && scopedPosyandu) {
            q = query(measurementsCollection, where('tglUkur', '>=', startStr), where('tglUkur', '<=', endStr), where('desa', '==', scopedDesa), where('posyandu', '==', scopedPosyandu));
        }
        else if (scopedDesa) {
            q = query(measurementsCollection, where('tglUkur', '>=', startStr), where('tglUkur', '<=', endStr), where('desa', '==', scopedDesa));
        }
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const mapping = {};
            snapshot.docs.forEach((doc) => {
                const data = doc.data();
                if (data.tglUkur >= startStr && data.tglUkur <= endStr)
                    mapping[data.childId] = { id: doc.id, ...data };
            });
            setMonthlyMeasurements(mapping);
            setLoading(false);
        }, (error) => { console.error("Error fetching measurements:", error); setLoading(false); });
        return () => unsubscribe();
    }, [activeTab, filterMonth, filterYear, isServerPagedChildTab, user, viewDesa, viewPosyandu]);
    // Table-based child views request one page only, never the whole collection.
    useEffect(() => {
        if (!isServerPagedChildTab)
            return;
        let current = true;
        const month = String(filterMonth).padStart(2, '0');
        const lastDay = String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0');
        const monthStart = `${filterYear}-${month}-01`;
        const monthEnd = `${filterYear}-${month}-${lastDay}`;
        const request = {
            asOf: activeTab === 'recent' ? monthStart : monthEnd,
            measurementEnd: monthEnd,
            measurementStart: monthStart,
            page: currentPage,
            posyandu: viewPosyandu || undefined,
            search: searchTerm,
            size: itemsPerPage,
            sort: sortOrder,
            view: activeTab === 'data_balita' ? 'data' : activeTab === 'recycle_bin' ? 'recycle' : activeTab,
            village: viewDesa || undefined
        };
        const applyPage = (result) => {
            if (!current)
                return;
            const measurementByChild = {};
            result.measurements.forEach((item) => {
                const measurement = { id: item.id, ...item.data };
                if (measurement.childId)
                    measurementByChild[measurement.childId] = measurement;
            });
            const mpasiByChild = {};
            (result.mpasiLogs || []).forEach((item) => {
                const log = { id: item.id, ...item.data };
                if (log.childId)
                    mpasiByChild[log.childId] = log;
            });
            setPagedChildren(result.items.map((item) => ({ id: item.id, ...item.data })));
            setPagedMeasurements(measurementByChild);
            setPagedMpasiLogs(mpasiByChild);
            setPagedChildrenTotal(result.total);
            setErrorMsg(null);
        };
        setPagedChildrenLoading(true);
        void getChildrenPage(request)
            .then(applyPage)
            .catch(async (error) => {
            if (!current)
                return;
            const message = error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.';
            const networkUnavailable = !navigator.onLine || /failed to fetch|network|offline|load failed|fetch failed|connection|sementara tidak tersedia/i.test(message);
            if (networkUnavailable && activeTab === 'data_balita') {
                try {
                    applyPage(await getCachedChildrenPage(request));
                    return;
                }
                catch (cacheError) {
                    console.error('Gagal membaca cache Data Balita:', cacheError);
                }
            }
            console.error('Gagal memuat halaman Data Balita:', error);
            setPagedChildren([]);
            setPagedMeasurements({});
            setPagedMpasiLogs({});
            setPagedChildrenTotal(0);
            setErrorMsg(`Gagal memuat data balita: ${message}`);
        })
            .finally(() => {
            if (current)
                setPagedChildrenLoading(false);
        });
        return () => {
            current = false;
        };
    }, [activeTab, currentPage, dataRevision, filterMonth, filterYear, isServerPagedChildTab, itemsPerPage, searchTerm, sortOrder, viewDesa, viewPosyandu]);
    // Dashboard receives calculated totals only; no child or measurement collection is sent to the browser.
    useEffect(() => {
        if (activeTab !== 'dashboard')
            return;
        let current = true;
        const month = String(filterMonth).padStart(2, '0');
        const monthEnd = `${filterYear}-${month}-${String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0')}`;
        const monthStart = `${filterYear}-${month}-01`;
        const previous = new Date(filterYear, filterMonth - 2, 1);
        const previousYear = previous.getFullYear();
        const previousMonth = previous.getMonth() + 1;
        const previousMonthText = String(previousMonth).padStart(2, '0');
        const previousMonthStart = `${previousYear}-${previousMonthText}-01`;
        const previousMonthEnd = `${previousYear}-${previousMonthText}-${String(new Date(previousYear, previousMonth, 0).getDate()).padStart(2, '0')}`;
        const request = {
            monthEnd,
            monthStart,
            previousMonthEnd,
            previousMonthStart,
            village: viewDesa || undefined,
            posyandu: viewPosyandu || undefined
        };
        const cacheKey = `e-posyandu:dashboard-stats:${JSON.stringify(request)}`;
        setDashboardStatsLoading(true);
        void getDashboardStats(request)
            .then((stats) => {
            if (!current)
                return;
            setDashboardStats(stats);
            setErrorMsg(null);
            window.localStorage.setItem(cacheKey, JSON.stringify(stats));
        })
            .catch((error) => {
            if (!current)
                return;
            try {
                const cached = window.localStorage.getItem(cacheKey);
                if (cached) {
                    setDashboardStats(JSON.parse(cached));
                    setErrorMsg(null);
                    return;
                }
            }
            catch {
                // Keep the API error when local storage cannot be read.
            }
            setErrorMsg(`Gagal memuat ringkasan dashboard: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        })
            .finally(() => {
            if (current)
                setDashboardStatsLoading(false);
        });
        return () => {
            current = false;
        };
    }, [activeTab, dataRevision, filterMonth, filterYear, viewDesa, viewPosyandu]);
    useEffect(() => {
        if (activeTab !== 'dashboard' || user.role !== ROLES.GIZI) {
            setMonitoringStatus(null);
            return;
        }
        let current = true;
        const refreshMonitoring = () => {
            void getMonitoringStatus()
                .then((status) => {
                if (current)
                    setMonitoringStatus(status);
            })
                .catch(() => {
                if (current) {
                    setMonitoringStatus({
                        worker: { status: 'unknown', checkedAt: null, consecutiveFailures: 0 }
                    });
                }
            });
        };
        refreshMonitoring();
        const interval = window.setInterval(refreshMonitoring, 10 * 60 * 1000);
        return () => {
            current = false;
            window.clearInterval(interval);
        };
    }, [activeTab, user.role]);
    // Fetch PMT Programs (only active ones)
    useEffect(() => {
        if (activeTab === 'pmt_program') {
            const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'pmt_programs'));
            const unsubscribe = onSnapshot(q, (snapshot) => { setPmtPrograms(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))); });
            return () => unsubscribe();
        }
    }, [activeTab]);
    // Fetch MPASI Logs
    useEffect(() => {
        if (activeTab !== 'mpasi')
            return;
        setMpasiLogs({});
    }, [activeTab, filterMonth, filterYear]);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            void syncActiveViewFromServer().catch((error) => {
                console.warn('Pembaruan data otomatis dilewati:', error);
            });
        }, 0);
        return () => window.clearTimeout(timer);
    }, [activeTab, filterMonth, filterYear, viewDesa, viewPosyandu]);
    const filteredByLocation = useMemo(() => {
        return children.filter(c => {
            const matchDesa = viewDesa ? c.desa === viewDesa : true;
            const matchPosyandu = viewPosyandu ? c.posyandu === viewPosyandu : true;
            return matchDesa && matchPosyandu;
        });
    }, [children, viewDesa, viewPosyandu]);
    const currentFilterDate = useMemo(() => new Date(filterYear, filterMonth, 0), [filterYear, filterMonth]);
    const activeChildren = useMemo(() => filteredByLocation.filter(c => {
        if (c.deletedAt)
            return false;
        const age = getAgeInMonths(c.tglLahir, currentFilterDate);
        return age >= 0 && age <= 59;
    }), [filteredByLocation, currentFilterDate]);
    const deletedChildren = useMemo(() => filteredByLocation.filter(c => c.deletedAt), [filteredByLocation]);
    const newInputs = useMemo(() => activeChildren.filter(c => {
        if (!c.createdAt)
            return false;
        const d = c.createdAt.toDate();
        return d.getMonth() + 1 === parseInt(String(filterMonth)) && d.getFullYear() === parseInt(String(filterYear));
    }), [activeChildren, filterMonth, filterYear]);
    const removeChildFromCurrentPage = (id) => {
        setPagedChildren((current) => current.filter((child) => child.id !== id));
        setPagedChildrenTotal((total) => Math.max(0, total - 1));
        if (pagedChildren.length === 1 && currentPage > 1)
            setCurrentPage((page) => Math.max(1, page - 1));
    };
    const childMutationError = (action, error) => {
        const message = error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.';
        setErrorMsg(`Gagal ${action}: ${message}`);
    };
    const handleDeleteConfirm = async (id, deleteData) => { try {
        setErrorMsg(null);
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id), { deletedAt: serverTimestamp(), ...deleteData });
        removeChildFromCurrentPage(id);
        setChildToDelete(null);
        await syncPendingMutations();
        showSuccess('Data balita berhasil dipindahkan ke daftar dihapus.');
    }
    catch (e) {
        console.error('Gagal menghapus balita:', e);
        setChildToDelete(null);
        childMutationError('menghapus data balita', e);
    } };
    const handleRestore = async (id) => { if (!id)
        return; try {
        setErrorMsg(null);
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id), { deletedAt: null, deleteReason: null, deathDate: null, deathCause: null, deathLocation: null });
        removeChildFromCurrentPage(id);
        await syncPendingMutations();
        showSuccess('Data balita berhasil dipulihkan.');
    }
    catch (e) {
        console.error('Gagal memulihkan balita:', e);
        childMutationError('memulihkan data balita', e);
    } };
    const handlePermanentDelete = async (id) => { if (!id)
        return; try {
        setErrorMsg(null);
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id));
        removeChildFromCurrentPage(id);
        await syncPendingMutations();
        showSuccess('Data balita berhasil dihapus permanen.');
    }
    catch (e) {
        console.error('Gagal menghapus permanen balita:', e);
        childMutationError('menghapus permanen data balita', e);
    } };
    const handleOpenPmtMonitoring = async (program, availableChild) => {
        try {
            setErrorMsg(null);
            let child = availableChild;
            if (!child) {
                if (!program.childId)
                    throw new Error('Program PMT tidak memiliki identitas balita.');
                const childDocument = await getChildDetail(program.childId);
                child = { id: childDocument.id, ...childDocument.data };
                setChildren((current) => [
                    ...current.filter((item) => item.id !== child.id),
                    child
                ]);
            }
            setPmtMonitoringData({ program, child });
            return true;
        }
        catch (error) {
            console.error('Gagal membuka pemantauan PMT:', error);
            const message = error instanceof Error ? error.message : 'Data balita tidak dapat dimuat.';
            setErrorMsg(`Gagal membuka pemantauan PMT: ${message}`);
            return false;
        }
    };
    const handleDeletePmt = async (program) => {
        if (!program.id || !window.confirm(`Hapus program PMT untuk ${program.childName}? Data pemantauan mingguannya juga akan dihapus.`))
            return;
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'pmt_programs', program.id));
            await syncPendingMutations();
            setPmtPrograms((current) => current.filter((item) => item.id !== program.id));
            if (pmtMonitoringData?.program.id === program.id)
                setPmtMonitoringData(null);
            showSuccess('Program PMT berhasil dihapus.');
        }
        catch (error) {
            console.error('Gagal menghapus PMT:', error);
            setErrorMsg('Gagal menghapus program PMT. Silakan coba lagi.');
        }
    };
    const handleImportIdentitas = async (e) => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        let xlsx;
        try {
            xlsx = await ensureXlsx();
        }
        catch (error) {
            console.error(error.message);
            return;
        }
        const reader = new FileReader();
        reader.onload = async (evt) => {
            try {
                const wb = xlsx.read(evt.target?.result, { type: 'binary' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(ws);
                let importedCount = 0;
                let importDesa = user.desa || '', importPosyandu = user.posyandu || '';
                if (user.role === ROLES.GIZI) {
                    if (!viewDesa || !viewPosyandu)
                        return;
                    importDesa = viewDesa;
                    importPosyandu = viewPosyandu;
                }
                else if (user.role === ROLES.BIDAN) {
                    if (!viewPosyandu)
                        return;
                    importDesa = user.desa || '';
                    importPosyandu = viewPosyandu;
                }
                for (const row of data) {
                    const cleanNIK = row['NIK'] ? String(row['NIK']).replace(/'/g, '') : '';
                    const cleanKK = row['nomor_KK'] ? String(row['nomor_KK']).replace(/'/g, '') : '';
                    const cleanNIKOrtu = row['nik_ortu'] ? String(row['nik_ortu']).replace(/'/g, '') : '';
                    const childData = {
                        anakKe: row['anak_ke'] || '', tglLahir: row['tgl_lahir'] || '', jk: row['jenis_kelamin'] === 'Laki-laki' ? 'L' : 'P',
                        noKK: cleanKK, nik: cleanNIK, hasKK: !!cleanKK, hasNIK: !!cleanNIK, nama: row['nama_anak'] || '',
                        usiaKehamilan: row['usia_hamil'] || '', bbLahir: row['berat_lahir'] || '', pbLahir: row['panjang_lahir'] || '',
                        lkLahir: row['lingkar_kepala_lahir'] || '', bukuKIA: row['kia'] || 'Tidak', bukuKIAKecil: row['kia_bayi_kecil'] || 'Tidak',
                        imd: row['imd'] || 'Tidak', namaOrtu: row['nama_ortu'] || '', nikOrtu: cleanNIKOrtu, noHpOrtu: row['hp_ortu'] || '',
                        alamat: row['alamat'] || '', rt: row['rt'] || '', rw: row['rw'] || '', desa: importDesa, posyandu: importPosyandu,
                        currentBB: row['berat_lahir'] || '', currentTB: row['panjang_lahir'] || '', currentLILA: 0, currentLK: row['lingkar_kepala_lahir'] || '',
                        createdAt: serverTimestamp(), createdBy: user.role, deletedAt: null
                    };
                    if (childData.nama && childData.tglLahir) {
                        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), childData);
                        importedCount += 1;
                    }
                }
                await syncPendingMutations();
                if (importedCount > 0)
                    showSuccess(`${importedCount} data balita berhasil diimpor.`);
            }
            catch (error) {
                console.error("Gagal: " + error.message);
            }
            finally {
                if (fileInputRef.current)
                    fileInputRef.current.value = "";
            }
        };
        reader.readAsBinaryString(file);
    };
    const getSelectedMonthRange = () => {
        const month = String(filterMonth).padStart(2, '0');
        const start = `${filterYear}-${month}-01`;
        const end = `${filterYear}-${month}-${String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0')}`;
        return { start, end };
    };
    const fetchExportDocuments = async (resource, dateField, start, end, options = {}) => {
        const constraints = [];
        if (dateField && start)
            constraints.push(where(dateField, '>=', start));
        if (dateField && end)
            constraints.push(where(dateField, '<=', end));
        // Exports follow the selected location. An intentional whole-area export
        // can opt out explicitly; normal export buttons never do this.
        if (!options.allLocations) {
            const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
            const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
            if (scopedDesa)
                constraints.push(where('desa', '==', scopedDesa));
            if (scopedPosyandu)
                constraints.push(where('posyandu', '==', scopedPosyandu));
        }
        const snapshot = await getDocsForExport(query(collection(db, 'artifacts', appId, 'public', 'data', resource), ...constraints));
        return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    };
    const fetchExportChildren = async (options = {}) => {
        const allChildren = await fetchExportDocuments('children', undefined, undefined, undefined, options);
        return allChildren.filter((child) => {
            if (child.deletedAt)
                return false;
            const age = getAgeInMonths(child.tglLahir, currentFilterDate);
            return age >= 0 && age <= 59;
        });
    };
    const toDateValue = (value) => {
        if (value && typeof value.toDate === 'function')
            return value.toDate();
        return new Date(String(value));
    };
    const createdAtValue = (value) => {
        const timestamp = toDateValue(value).getTime();
        return Number.isNaN(timestamp) ? 0 : timestamp;
    };
    const latestMeasurementsByChild = (measurements) => {
        const byChild = {};
        measurements.forEach((measurement) => {
            if (!measurement.childId)
                return;
            const previous = byChild[measurement.childId];
            if (!previous || measurement.tglUkur > previous.tglUkur || (measurement.tglUkur === previous.tglUkur && createdAtValue(measurement.createdAt) > createdAtValue(previous.createdAt))) {
                byChild[measurement.childId] = measurement;
            }
        });
        return byChild;
    };
    const latestMpasiLogsByChild = (logs) => {
        const byChild = {};
        logs.forEach((log) => {
            if (!log.childId)
                return;
            const previous = byChild[log.childId];
            if (!previous || log.tglMonitoring > previous.tglMonitoring || (log.tglMonitoring === previous.tglMonitoring && createdAtValue(log.createdAt) > createdAtValue(previous.createdAt))) {
                byChild[log.childId] = log;
            }
        });
        return byChild;
    };
    const runExport = async (label, createFile) => {
        try {
            setErrorMsg(null);
            await createFile();
        }
        catch (error) {
            console.error(`Gagal ekspor ${label}:`, error);
            setErrorMsg(`Gagal membuat ${label}: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        }
    };
    const handleExportSigizi = async () => {
        await runExport('file identitas Sigizi', async () => {
            const xlsx = await ensureXlsx();
            const exportedChildren = await fetchExportChildren();
            const newChildren = exportedChildren.filter((child) => {
                const createdAt = toDateValue(child.createdAt);
                return !Number.isNaN(createdAt.getTime())
                    && createdAt.getMonth() + 1 === filterMonth
                    && createdAt.getFullYear() === filterYear;
            });
            const headers = ["No", "anak_ke", "tgl_lahir", "jenis_kelamin", "nomor_KK", "NIK", "nama_anak", "usia_hamil", "berat_lahir", "panjang_lahir", "lingkar_kepala_lahir", "kia", "kia_bayi_kecil", "imd", "nama_ortu", "nik_ortu", "hp_ortu", "alamat", "rt", "rw", "hapus", "pindah"];
            const rows = newChildren.map((child, index) => [
                index + 1, child.anakKe, child.tglLahir, child.jk === 'L' ? 'Laki-laki' : 'Perempuan', child.noKK, child.nik, child.nama, child.usiaKehamilan, child.bbLahir, child.pbLahir, child.lkLahir, child.bukuKIA, child.bukuKIAKecil, child.imd, child.namaOrtu, child.nikOrtu, child.noHpOrtu || '-', child.alamat || "", child.rt, child.rw, "", ""
            ]);
            const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data Balita");
            xlsx.writeFile(workbook, `Format_Identitas_Sigizi_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    const handleExportPengukuranSigizi = async () => {
        await runExport('file pengukuran Sigizi', async () => {
            const xlsx = await ensureXlsx();
            const { start, end } = getSelectedMonthRange();
            const result = await getSigiziMeasurementExport({
                monthEnd: end,
                monthStart: start,
                village: viewDesa || undefined,
                posyandu: viewPosyandu || undefined
            });
            const headers = ["No", "NIK", "nama_anak", "TANGGALUKUR", "BERAT", "TINGGI", "LILA", "lingkar_kepala", "Pitting_edema", "CARAUKUR", "vita", "asi_bulan_0", "asi_bulan_1", "asi_bulan_2", "asi_bulan_3", "asi_bulan_4", "asi_bulan_5", "asi_bulan_6", "kelas_ibu_balita", "mbg"];
            const rows = result.items.map((row, index) => {
                let edemaVal = "";
                if (row.edema) {
                    if (row.edema === 'Tidak')
                        edemaVal = 'tidak';
                    else if (row.edema.includes('+1'))
                        edemaVal = '1';
                    else if (row.edema.includes('+2'))
                        edemaVal = '2';
                    else if (row.edema.includes('+3'))
                        edemaVal = '3';
                }
                const asiCols = [row.asiBulan0, row.asiBulan1, row.asiBulan2, row.asiBulan3, row.asiBulan4, row.asiBulan5, row.asiBulan6]
                    .map((asi) => asi === 'Ya' ? 'ya' : asi === 'Tidak' ? 'tidak' : '');
                return [index + 1, row.nik, row.nama, row.tglUkur || "", row.bb ?? "", row.tb ?? "", row.lila ?? "", row.lk ?? "", edemaVal, row.caraUkur.toLowerCase(), row.vitA.toLowerCase(), ...asiCols, row.kelasIbu.toLowerCase(), row.mbg.toLowerCase()];
            });
            const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data Pengukuran");
            xlsx.writeFile(workbook, `Format_Ukur_Sigizi_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    // --- NEW EXPORT FUNCTION FOR TABLES ---
    const handleExportTable = async () => {
        await runExport('file tabel balita', async () => {
            const xlsx = await ensureXlsx();
            const { start, end } = getSelectedMonthRange();
            const [exportedChildren, measurements] = await Promise.all([
                fetchExportChildren(),
                fetchExportDocuments('measurements', 'tglUkur', start, end)
            ]);
            const measurementsByChild = latestMeasurementsByChild(measurements);
            let exportData = exportedChildren;
            if (activeTab === 'problem_underweight') {
                exportData = exportedChildren.filter((child) => {
                    const measurement = child.id ? measurementsByChild[child.id] : undefined;
                    if (!measurement?.bb)
                        return false;
                    const age = getAgeInMonths(child.tglLahir, new Date(measurement.tglUkur));
                    return ["Berat Sangat Kurang", "Berat Kurang"].includes(calculateGiziStatus(measurement.bb, 'BBU', age, child.jk));
                });
            }
            else if (activeTab === 'problem_stunting') {
                exportData = exportedChildren.filter((child) => {
                    const measurement = child.id ? measurementsByChild[child.id] : undefined;
                    if (!measurement?.tb)
                        return false;
                    const age = getAgeInMonths(child.tglLahir, new Date(measurement.tglUkur));
                    return ["Sangat Pendek", "Pendek"].includes(calculateGiziStatus(measurement.tb, 'TBU', age, child.jk, null, measurement.caraUkur));
                });
            }
            else if (activeTab === 'problem_wasting') {
                exportData = exportedChildren.filter((child) => {
                    const measurement = child.id ? measurementsByChild[child.id] : undefined;
                    if (!measurement?.bb || !measurement.tb)
                        return false;
                    const age = getAgeInMonths(child.tglLahir, new Date(measurement.tglUkur));
                    return ["Gizi Buruk", "Gizi Kurang"].includes(calculateGiziStatus(measurement.bb, 'BBTB', age, child.jk, measurement.tb, measurement.caraUkur));
                });
            }
            else if (activeTab === 'problem_tidak_naik') {
                exportData = exportedChildren.filter((child) => child.id && measurementsByChild[child.id]?.statusNaik === 'T');
            }
            const headers = ["No", "Nama", "NIK", "Jenis Kelamin", "Tgl Lahir", "Usia (Bln)", "Nama Ortu", "Desa", "Posyandu", "BB (kg)", "PB/TB (cm)", "LILA (cm)", "LK (cm)", "Status Naik", "Status BB/U", "Status PB/TB-U", "Status BB/PB atau BB/TB", "Status IMT/U"];
            const rows = getSortedData(exportData).map((child, index) => {
                if (!child.id)
                    return [];
                const m = measurementsByChild[child.id];
                const age = getAgeInMonths(child.tglLahir, m?.tglUkur ? new Date(m.tglUkur) : currentFilterDate);
                const st_bbu = calculateGiziStatus(m?.bb, 'BBU', age, child.jk);
                const st_tbu = calculateGiziStatus(m?.tb, 'TBU', age, child.jk, null, m?.caraUkur);
                const st_bbtb = calculateGiziStatus(m?.bb, 'BBTB', age, child.jk, m?.tb, m?.caraUkur);
                const st_imtu = calculateGiziStatus(m?.bb, 'IMTU', age, child.jk, m?.tb, m?.caraUkur);
                return [
                    index + 1,
                    child.nama,
                    child.nik,
                    child.jk === 'L' ? 'Laki-laki' : 'Perempuan',
                    child.tglLahir,
                    age,
                    child.namaOrtu,
                    child.desa,
                    child.posyandu,
                    m?.bb || '-',
                    m?.tb || '-',
                    m?.lila || '-',
                    m?.lk || '-',
                    m?.statusNaik || '-',
                    st_bbu,
                    st_tbu,
                    st_bbtb,
                    st_imtu
                ];
            });
            const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data Export");
            let filenamePrefix = "Data_Balita";
            if (activeTab === 'problem_underweight')
                filenamePrefix = "Balita_Underweight";
            if (activeTab === 'problem_stunting')
                filenamePrefix = "Balita_Stunting";
            if (activeTab === 'problem_wasting')
                filenamePrefix = "Balita_Wasting";
            if (activeTab === 'problem_tidak_naik')
                filenamePrefix = "Balita_Tidak_Naik";
            xlsx.writeFile(workbook, `${filenamePrefix}_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    const handleExportMpasi = async () => {
        await runExport('file MPASI', async () => {
            const xlsx = await ensureXlsx();
            const { start, end } = getSelectedMonthRange();
            const [allChildren, logs] = await Promise.all([
                fetchExportChildren(),
                fetchExportDocuments('mpasi_logs', 'tglMonitoring', start, end)
            ]);
            const exportedChildren = allChildren.filter((child) => {
                const age = getAgeInMonths(child.tglLahir, currentFilterDate);
                return age >= 6 && age <= 23;
            });
            const childIds = new Set(exportedChildren.map((child) => child.id).filter(Boolean));
            const logsByChild = latestMpasiLogsByChild(logs.filter((log) => childIds.has(log.childId)));
            const headers = ["No", "NIK", "Nama", "tgl_monitoring", "asi", "sereal", "kacang", "susu", "daging/unggas", "telur", "buah_sayur_vita", "buah_sayur_lain", "dapat_intervensi"];
            const toBin = (val) => {
                if (val === 'Ya')
                    return 1;
                if (Array.isArray(val) && val.length > 0 && val[0] === 'Ya')
                    return 1;
                return 0;
            };
            const rows = exportedChildren.map((child, index) => {
                if (!child.id)
                    return [];
                const log = logsByChild[child.id];
                const hasLog = !!log;
                return [
                    index + 1,
                    child.nik,
                    child.nama,
                    hasLog ? log.tglMonitoring : "-",
                    hasLog ? toBin(log.asi) : 0,
                    hasLog ? toBin(log.makananPokok) : 0,
                    hasLog ? toBin(log.kacang) : 0,
                    hasLog ? toBin(log.susu) : 0,
                    hasLog ? toBin(log.daging) : 0,
                    hasLog ? toBin(log.telur) : 0,
                    hasLog ? toBin(log.sayurVitA) : 0,
                    hasLog ? toBin(log.sayurLain) : 0,
                    hasLog ? toBin(log.intervensiGizi) : 0
                ];
            });
            const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data MPASI");
            xlsx.writeFile(workbook, `Laporan_MPASI_${MONTHS[filterMonth - 1]}_${filterYear}.xls`, { bookType: 'biff8' });
        });
    };
    const handleExportPmt = async () => {
        await runExport('file PMT', async () => {
            const xlsx = await ensureXlsx();
            const [exportedChildren, exportedPrograms] = await Promise.all([
                fetchExportChildren(),
                fetchExportDocuments('pmt_programs')
            ]);
            const childById = new Map(exportedChildren.filter((child) => child.id).map((child) => [child.id, child]));
            const headers = ["nik", "nama", "tanggal_pemberian_pertama", "siklus_ke", "jenis_pmt", "sumber_anggaran", "mitra", "mitra_lain", "pmt_sesuai_juknis", "alasan_pemberian", "minggu_ke", "tanggal_pemantauan", "hari_1", "hari_2", "hari_3", "hari_4", "hari_5", "hari_6", "hari_7", "bb", "tb", "cara_ukur", "pemantauan_kesehatan", "tindak_lanjut"];
            // Helper Maps
            const mapJenisPmt = (val) => val === 'Pabrikan' ? 1 : 2;
            const mapSumberAnggaran = (val) => {
                if (val === 'DAK Non Fisik')
                    return 1;
                if (val === 'APBD')
                    return 2;
                if (val === 'Mitra')
                    return 3;
                if (val === 'Dana Desa')
                    return 4;
                return 0;
            };
            const mapAlasan = (val) => {
                if (val === 'Wasting')
                    return 1;
                if (val === 'Underweight')
                    return 2;
                if (val === 'TidakNaik')
                    return 3;
                return 0;
            };
            const mapCaraUkur = (val) => val === 'Berdiri' ? 1 : 2;
            const mapKesehatan = (val) => val === 'Ada' ? 1 : 0;
            const mapTindakLanjut = (val) => {
                if (val === 'Dilanjutkan')
                    return 1;
                if (val === 'Selesai')
                    return 2;
                if (val === 'Rujuk RS')
                    return 3;
                return 0;
            };
            const mapSesuaiJuknis = (val) => val === 'Ya' ? 1 : 0;
            const generateRows = (category) => {
                const rows = [];
                const filteredPrograms = exportedPrograms.filter((program) => program.category === category && childById.has(program.childId));
                filteredPrograms.forEach((prog) => {
                    const child = childById.get(prog.childId);
                    if (!child)
                        return;
                    const maxWeeks = prog.category === 'Wasting' ? 8 : (prog.category === 'Underweight' ? 4 : 2);
                    for (let i = 1; i <= maxWeeks; i++) {
                        const m = prog.monitorings?.[i];
                        // Only add rows for weeks that have data or filler data
                        const rowData = [
                            child.nik,
                            child.nama,
                            prog.tglPemberian,
                            prog.siklusKe || 1,
                            mapJenisPmt(prog.jenisPmt),
                            mapSumberAnggaran(prog.sumberAnggaran),
                            prog.mitra || "",
                            prog.mitraLain || "",
                            mapSesuaiJuknis(prog.pmtSesuaiJuknis),
                            mapAlasan(prog.category),
                            i, // Minggu Ke
                            m ? m.tgl : "",
                            m?.days?.[0] ? 1 : 0,
                            m?.days?.[1] ? 1 : 0,
                            m?.days?.[2] ? 1 : 0,
                            m?.days?.[3] ? 1 : 0,
                            m?.days?.[4] ? 1 : 0,
                            m?.days?.[5] ? 1 : 0,
                            m?.days?.[6] ? 1 : 0,
                            m ? m.bb : "",
                            m ? m.tb : "",
                            m ? mapCaraUkur(m.caraUkur) : "",
                            m ? mapKesehatan(m.pemantauanKesehatan) : "",
                            m ? mapTindakLanjut(m.tindakLanjut) : ""
                        ];
                        rows.push(rowData);
                    }
                });
                return rows;
            };
            const workbook = xlsx.utils.book_new();
            // Sheet 1: Wasting
            const rowsWasting = generateRows('Wasting');
            const wsWasting = xlsx.utils.aoa_to_sheet([headers, ...rowsWasting]);
            xlsx.utils.book_append_sheet(workbook, wsWasting, "Wasting");
            // Sheet 2: Underweight
            const rowsUnderweight = generateRows('Underweight');
            const wsUnderweight = xlsx.utils.aoa_to_sheet([headers, ...rowsUnderweight]);
            xlsx.utils.book_append_sheet(workbook, wsUnderweight, "Underweight");
            // Sheet 3: Tidak Naik (T)
            const rowsTidakNaik = generateRows('TidakNaik');
            const wsTidakNaik = xlsx.utils.aoa_to_sheet([headers, ...rowsTidakNaik]);
            xlsx.utils.book_append_sheet(workbook, wsTidakNaik, "Tidak Naik");
            xlsx.writeFile(workbook, `Laporan_PMT_Lengkap_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    const getSortedData = (data) => {
        const sorted = [...data];
        switch (sortOrder) {
            case 'name_asc': return sorted.sort((a, b) => a.nama.localeCompare(b.nama));
            case 'name_desc': return sorted.sort((a, b) => b.nama.localeCompare(a.nama));
            case 'recent': return sorted.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
            case 'oldest_input': return sorted.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
            case 'age_oldest': return sorted.sort((a, b) => new Date(a.tglLahir).getTime() - new Date(b.tglLahir).getTime());
            case 'age_youngest': return sorted.sort((a, b) => new Date(b.tglLahir).getTime() - new Date(a.tglLahir).getTime());
            default: return sorted;
        }
    };
    const getDisplayData = () => {
        switch (activeTab) {
            case 'recycle_bin': return deletedChildren;
            case 'recent': return newInputs;
            case 'mpasi':
                return activeChildren.filter(c => {
                    const age = getAgeInMonths(c.tglLahir, currentFilterDate);
                    return age >= 6 && age <= 23;
                });
            default: return activeChildren;
        }
    };
    const rawDisplayData = isServerPagedChildTab
        ? []
        : getDisplayData().filter(c => c.nama.toLowerCase().includes(searchTerm.toLowerCase()) || c.nik.includes(searchTerm));
    const displayData = getSortedData(rawDisplayData);
    // --- PAGINATION LOGIC ---
    const totalPages = Math.ceil(displayData.length / itemsPerPage);
    const paginatedData = displayData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    const tableDisplayData = isServerPagedChildTab ? pagedChildren : displayData;
    const tablePaginatedData = isServerPagedChildTab ? pagedChildren : paginatedData;
    const tableMeasurements = isServerPagedChildTab ? pagedMeasurements : monthlyMeasurements;
    const tableMpasiLogs = activeTab === 'mpasi' ? pagedMpasiLogs : mpasiLogs;
    const tableLoading = isServerPagedChildTab ? pagedChildrenLoading : loading;
    const tableTotalCount = isServerPagedChildTab ? pagedChildrenTotal : undefined;
    const handleSearchSubmit = () => {
        setCurrentPage(1);
        setSearchTerm(searchDraft.trim());
    };
    const handleClearSearch = () => {
        setSearchDraft('');
        setSearchTerm('');
        setCurrentPage(1);
    };
    const handleApplyLocationFilter = () => {
        setViewDesa(user.role === ROLES.GIZI ? draftDesa : (user.desa || ''));
        setViewPosyandu(user.role === ROLES.KADER ? (user.posyandu || '') : draftPosyandu);
    };
    const handleResetLocationFilter = () => {
        const defaultDesa = user.role === ROLES.GIZI ? '' : (user.desa || '');
        const defaultPosyandu = user.role === ROLES.KADER ? (user.posyandu || '') : '';
        setDraftDesa(defaultDesa);
        setDraftPosyandu(defaultPosyandu);
        setViewDesa(defaultDesa);
        setViewPosyandu(defaultPosyandu);
    };
    const measurementChild = useMemo(() => {
        if (selectedMeasurementChild?.id === measurementChildId)
            return selectedMeasurementChild;
        return children.find((child) => child.id === measurementChildId) || null;
    }, [children, measurementChildId, selectedMeasurementChild]);
    const handleOpenMeasurementPage = (child) => {
        if (!child.id)
            return;
        const backTab = activeTab === 'measurement' ? measurementBackTab : activeTab;
        setMeasurementBackTab(backTab === 'measurement' ? 'data_balita' : backTab);
        setSelectedMeasurementChild(child);
        setMeasurementChildId(child.id);
        setActiveTab('measurement');
        const targetHash = `#measurement/${encodeURIComponent(child.id)}`;
        if (window.location.hash !== targetHash)
            window.location.hash = targetHash;
    };
    const handleOpenEditChild = async (child) => {
        if (!child?.id)
            return;
        try {
            const document = await getChildDetail(child.id);
            setEditingChild({ id: document.id, ...document.data });
            setErrorMsg(null);
        }
        catch (error) {
            setErrorMsg(`Gagal memuat detail balita: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        }
    };
    const handleBackFromMeasurement = () => {
        const backTab = measurementBackTab === 'measurement' ? 'data_balita' : measurementBackTab;
        setSelectedMeasurementChild(null);
        setMeasurementChildId(null);
        setActiveTab(backTab);
        if (window.location.hash !== `#${backTab}`)
            window.location.hash = backTab;
    };
    const handleOpenAddChildPage = () => {
        const backTab = activeTab === 'measurement' || activeTab === 'add_child' ? 'data_balita' : activeTab;
        setAddChildBackTab(backTab);
        setActiveTab('add_child');
        setIsSidebarOpen(false);
        if (window.location.hash !== '#add_child')
            window.location.hash = 'add_child';
    };
    const handleBackFromAddChild = () => {
        const backTab = addChildBackTab === 'add_child' || addChildBackTab === 'measurement' ? 'data_balita' : addChildBackTab;
        setActiveTab(backTab);
        if (window.location.hash !== `#${backTab}`)
            window.location.hash = backTab;
    };
    const accountName = user.role === ROLES.KADER
        ? `Posyandu ${formatChildName(user.posyandu || '')}`.trim()
        : user.role === ROLES.BIDAN
            ? user.desa || 'Desa'
            : 'Admin Gizi';
    const accountDescription = user.role === ROLES.KADER
        ? user.desa || ROLES.KADER
        : user.role === ROLES.BIDAN
            ? ROLES.BIDAN
            : 'UPTD Puskesmas Gumukmas';
    const pageTitles = {
        dashboard: 'Dashboard',
        data_balita: 'Data Balita',
        asi_eksklusif: 'ASI Eksklusif',
        mpasi: 'MPASI',
        problem_underweight: 'Balita Underweight',
        problem_stunting: 'Balita Stunting',
        problem_wasting: 'Balita Wasting',
        problem_tidak_naik: 'Balita Tidak Naik',
        pmt_program: 'Pemberian PMT',
        add_child: 'Tambah Balita',
        recent: 'Balita Baru Diinput',
        change_history: 'Riwayat Perubahan',
        recycle_bin: 'Daftar Dihapus',
        measurement: 'Penimbangan Balita'
    };
    const pageTitle = pageTitles[activeTab] || 'E-Posyandu';
    const handleResolveSyncConflict = async (conflictId, resolution) => {
        try {
            await resolveSyncConflict(conflictId, resolution);
            setSyncConflicts(await listSyncConflicts());
            setDataRevision((revision) => revision + 1);
            showSuccess(resolution === 'keep-local'
                ? 'Perubahan dari perangkat akan dikirim ulang menggunakan data server terbaru.'
                : 'Data server dipakai dan perubahan lokal yang bertabrakan dibatalkan.');
        }
        catch (error) {
            setErrorMsg(`Konflik sinkronisasi belum dapat diselesaikan: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        }
    };
    const setSidebarCollapsed = (collapsed) => {
        sidebarCollapsedRef.current = collapsed;
        hideSidebarTooltip();
        applySidebarCollapsedState(appShellRef.current, sidebarCollapseButtonRef.current, collapsed);
    };
    const showSidebarTooltip = (label, event) => {
        if (!sidebarCollapsedRef.current)
            return;
        const tooltip = sidebarTooltipRef.current;
        if (!tooltip)
            return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const top = Math.max(28, Math.min(window.innerHeight - 28, bounds.top + (bounds.height / 2)));
        tooltip.textContent = label;
        tooltip.style.top = `${top}px`;
        tooltip.setAttribute('aria-hidden', 'false');
        tooltip.classList.add('is-visible');
    };
    const hideSidebarTooltip = () => {
        const tooltip = sidebarTooltipRef.current;
        if (!tooltip)
            return;
        tooltip.classList.remove('is-visible');
        tooltip.setAttribute('aria-hidden', 'true');
    };
    const SidebarItem = ({ id, label, icon: Icon, onClick }) => (Native.createElement("button", { "data-nav-id": id, "data-tooltip": label, "aria-current": activeTab === id ? 'page' : undefined, "aria-label": label, onMouseEnter: (event) => showSidebarTooltip(label, event), onMouseLeave: hideSidebarTooltip, onFocus: (event) => showSidebarTooltip(label, event), onBlur: hideSidebarTooltip, onClick: onClick ? () => {
            hideSidebarTooltip();
            onClick();
        } : () => { hideSidebarTooltip(); if (isDashboardTab(id)) {
            setActiveTab(id);
            if (window.location.hash !== `#${id}`)
                window.location.hash = id;
        } setIsSidebarOpen(false); }, className: `sidebar-nav-item group ${activeTab === id ? 'is-active' : ''}` },
        Native.createElement("div", { className: "sidebar-nav-content flex items-center gap-3" },
            Native.createElement("span", { className: "sidebar-nav-icon" },
                Native.createElement(Icon, { className: "w-5 h-5" })),
            Native.createElement("span", { className: "sidebar-nav-label text-sm text-left" }, label))));
    return (Native.createElement("div", { ref: appShellRef, className: `app-shell font-sans text-slate-900 flex ${sidebarCollapsedRef.current ? 'is-sidebar-collapsed' : ''}` },
        isSidebarOpen && (Native.createElement("div", { className: "sidebar-scrim fixed inset-0 z-40 md:hidden", onClick: () => setIsSidebarOpen(false), "aria-hidden": "true" })),
        Native.createElement("button", { type: "button", className: "sidebar-expanded-dismiss", onClick: () => setSidebarCollapsed(true), "aria-label": "Ringkas menu samping" }),
        Native.createElement("aside", { className: `app-sidebar fixed md:sticky top-0 h-screen flex flex-col z-50 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}` },
            Native.createElement("div", { className: "sidebar-mobile-toolbar md:hidden" },
                Native.createElement("span", null, "Daftar Menu"),
                Native.createElement("button", { type: "button", onClick: () => setIsSidebarOpen(false), title: "Tutup menu", "aria-label": "Tutup menu" },
                    Native.createElement(X, { className: "h-5 w-5" }))),
            Native.createElement("div", { className: "sidebar-brand-panel", "data-sidebar-brand": "true" },
                Native.createElement("span", { className: "sidebar-brand-logo-shell", "aria-hidden": "true" },
                    Native.createElement("img", { src: "/logo-puskesmas-32981.svg", alt: "", className: "h-10 w-10" })),
                Native.createElement("div", { className: "sidebar-brand-copy min-w-0" },
                    Native.createElement("div", { className: "sidebar-brand-name-row" },
                        Native.createElement("strong", null, "E-Posyandu"),
                        Native.createElement("span", null, `v${APP_VERSION}`)),
                    Native.createElement("p", null, "UPTD Puskesmas Gumukmas"))),
            Native.createElement("nav", { className: "app-sidebar-nav flex-1 overflow-y-auto py-4 px-3 space-y-1", "aria-label": "Navigasi utama" },
                Native.createElement("button", { ref: sidebarCollapseButtonRef, type: "button", onMouseEnter: (event) => showSidebarTooltip(sidebarCollapsedRef.current ? 'Perluas Menu' : 'Ringkas Menu', event), onMouseLeave: hideSidebarTooltip, onFocus: (event) => showSidebarTooltip(sidebarCollapsedRef.current ? 'Perluas Menu' : 'Ringkas Menu', event), onBlur: hideSidebarTooltip, onClick: (event) => {
                        event.stopPropagation();
                        setSidebarCollapsed(!sidebarCollapsedRef.current);
                    }, className: "sidebar-collapse-button hidden md:flex", "aria-label": sidebarCollapsedRef.current ? 'Perluas Menu' : 'Ringkas Menu', "aria-expanded": !sidebarCollapsedRef.current },
                    Native.createElement("span", { className: "sidebar-nav-icon sidebar-collapse-symbol" },
                        Native.createElement(ChevronRight, { className: "sidebar-expand-icon h-5 w-5" }),
                        Native.createElement(ChevronLeft, { className: "sidebar-collapse-icon h-5 w-5" })),
                    Native.createElement("span", { className: "sidebar-nav-label text-sm text-left" },
                        Native.createElement("span", { className: "sidebar-expand-label" }, "Perluas Menu"),
                        Native.createElement("span", { className: "sidebar-collapse-label" }, "Ringkas Menu"))),
                Native.createElement("p", { className: "sidebar-section-label" }, "Menu Utama"),
                Native.createElement(SidebarItem, { id: "dashboard", label: "Dashboard", icon: LayoutDashboard }),
                Native.createElement(SidebarItem, { id: "data_balita", label: "Data Balita", icon: Users }),
                Native.createElement(SidebarItem, { id: "asi_eksklusif", label: "ASI Eksklusif", icon: Baby }),
                Native.createElement(SidebarItem, { id: "mpasi", label: "MPASI (6-23 Bln)", icon: Utensils }),
                Native.createElement("div", { className: "sidebar-nav-spacer sidebar-nav-spacer-small" }),
                Native.createElement("p", { className: "sidebar-section-label" }, "Analisis Gizi"),
                Native.createElement(SidebarItem, { id: "problem_underweight", label: "Balita Underweight", icon: TrendingDown }),
                Native.createElement(SidebarItem, { id: "problem_stunting", label: "Balita Stunting", icon: Ruler }),
                Native.createElement(SidebarItem, { id: "problem_wasting", label: "Balita Wasting", icon: AlertCircle }),
                Native.createElement(SidebarItem, { id: "problem_tidak_naik", label: "Balita Tidak Naik", icon: Minus }),
                Native.createElement(SidebarItem, { id: "pmt_program", label: "Pemberian PMT", icon: Gift }),
                Native.createElement("div", { className: "sidebar-nav-spacer" }),
                Native.createElement("p", { className: "sidebar-section-label" }, "Manajemen Data"),
                Native.createElement(SidebarItem, { id: "add_child", label: "Tambah Balita", icon: Plus, onClick: handleOpenAddChildPage }),
                Native.createElement(SidebarItem, { id: "recent", label: "Balita Baru Diinput", icon: Clock }),
                Native.createElement(SidebarItem, { id: "change_history", label: "Riwayat Perubahan", icon: History }),
                Native.createElement(SidebarItem, { id: "recycle_bin", label: "Daftar Dihapus", icon: Trash2 }))),
        Native.createElement("div", { ref: sidebarTooltipRef, className: "sidebar-dock-tooltip", role: "tooltip", "aria-hidden": "true" }),
        Native.createElement("div", { className: "flex-1 flex flex-col min-w-0" },
            Native.createElement("header", { className: "app-topbar sticky top-0 z-30" },
                Native.createElement("div", { className: "app-header-title flex min-w-0 items-center gap-3" },
                    Native.createElement("button", { type: "button", onClick: () => setIsSidebarOpen(true), className: "sidebar-mobile-trigger icon-button md:hidden", title: "Buka menu", "aria-label": "Buka menu" },
                        Native.createElement(Menu, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "app-page-context min-w-0" },
                        Native.createElement("h1", { className: "truncate" }, pageTitle))),
                Native.createElement("div", { className: "topbar-actions" },
                    Native.createElement("button", { type: "button", className: "theme-toggle glass-control", onClick: () => saveColorScheme(colorScheme === 'dark' ? 'light' : 'dark'), title: colorScheme === 'dark' ? 'Gunakan mode terang' : 'Gunakan mode gelap', "aria-label": colorScheme === 'dark' ? 'Gunakan mode terang' : 'Gunakan mode gelap', "aria-pressed": colorScheme === 'dark' ? 'true' : 'false' }, colorScheme === 'dark'
                        ? Native.createElement(Sun, { className: "h-5 w-5", "aria-hidden": "true" })
                        : Native.createElement(Moon, { className: "h-5 w-5", "aria-hidden": "true" })),
                    Native.createElement("div", { ref: accountMenuRef, className: "account-wrapper relative" },
                    Native.createElement("button", { type: "button", className: "account-trigger glass-control", onClick: () => setIsAccountMenuOpen(!isAccountMenuOpen), "aria-haspopup": "menu", "aria-expanded": isAccountMenuOpen, "aria-controls": "account-dropdown-menu", title: "Buka menu akun" },
                        Native.createElement("span", { className: "account-avatar" }, accountName.charAt(0)),
                        Native.createElement("span", { className: "account-trigger-copy min-w-0 text-left" },
                            Native.createElement("span", { className: "block truncate text-sm font-bold text-slate-800" }, accountName),
                            Native.createElement("span", { className: "block truncate text-[11px] text-slate-500" }, accountDescription)),
                        Native.createElement(ChevronDown, { className: `account-chevron h-4 w-4 text-slate-500 ${isAccountMenuOpen ? 'is-open' : ''}` })),
                    isAccountMenuOpen && (Native.createElement("div", { id: "account-dropdown-menu", role: "menu", className: "account-menu" },
                        Native.createElement("div", { className: "account-menu-profile" },
                            Native.createElement("span", { className: "account-menu-avatar" },
                                Native.createElement(UserRound, { className: "h-5 w-5" })),
                            Native.createElement("div", { className: "min-w-0" },
                                Native.createElement("p", { className: "truncate text-sm font-bold text-slate-800" }, accountName),
                                Native.createElement("p", { className: "truncate text-xs text-slate-500" }, accountDescription),
                                Native.createElement("span", { className: "account-role-badge" }, user.role))),
                        Native.createElement("div", { className: "account-menu-divider" }),
                        Native.createElement("button", { type: "button", role: "menuitem", className: "account-logout-button", onClick: () => {
                                setIsAccountMenuOpen(false);
                                onLogout();
                            } },
                            Native.createElement(LogOut, { className: "h-4 w-4" }),
                            Native.createElement("span", null, "Keluar Sistem"))))))),
            Native.createElement("main", { className: "app-content flex-1 p-4 sm:p-6 lg:p-8 overflow-x-hidden" },
                errorMsg && (Native.createElement("div", { role: "alert", className: "ios-inline-notification ios-inline-notification-error mb-6 flex items-center gap-3" },
                    Native.createElement(AlertTriangle, { className: "w-5 h-5 flex-shrink-0" }),
                    Native.createElement("p", { className: "text-sm font-medium" }, errorMsg))),
                syncConflicts.length > 0 && (Native.createElement("section", { role: "alert", className: "ios-inline-notification ios-inline-notification-warning mb-6", "aria-live": "polite" },
                    Native.createElement("div", { className: "flex items-start gap-3" },
                        Native.createElement(AlertTriangle, { className: "mt-0.5 h-5 w-5 flex-shrink-0" }),
                        Native.createElement("div", { className: "min-w-0 flex-1" },
                            Native.createElement("p", { className: "text-sm font-bold" }, "Perubahan data perlu dikonfirmasi"),
                            Native.createElement("p", { className: "mt-1 text-sm" }, syncConflicts[0].detail),
                            syncConflicts.length > 1 && Native.createElement("p", { className: "mt-1 text-xs" }, `${syncConflicts.length} konflik menunggu penyelesaian.`),
                            Native.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
                                Native.createElement("button", { type: "button", className: "apple-button apple-button-primary bg-blue-600 px-4 py-2 text-sm font-semibold text-white", onClick: () => void handleResolveSyncConflict(syncConflicts[0].id, 'keep-local') }, "Gunakan Data Saya"),
                                Native.createElement("button", { type: "button", className: "apple-button apple-button-secondary px-4 py-2 text-sm font-semibold", onClick: () => void handleResolveSyncConflict(syncConflicts[0].id, 'accept-server') }, "Gunakan Data Server")))))),
                activeTab !== 'add_child' && activeTab !== 'measurement' && activeTab !== 'change_history' && (Native.createElement("div", { className: "mb-6" },
                    Native.createElement(LocationFilterPanel, { draftDesa: draftDesa, draftPosyandu: draftPosyandu, filterMonth: filterMonth, filterYear: filterYear, onApply: handleApplyLocationFilter, onReset: handleResetLocationFilter, role: user.role, setDraftDesa: setDraftDesa, setDraftPosyandu: setDraftPosyandu, setFilterMonth: setFilterMonth, setFilterYear: setFilterYear, user: user }))),
                Native.createElement(Native.Suspense, { fallback: Native.createElement(DashboardPageSkeleton, null) }, activeTab === 'add_child' ? (Native.createElement(AddChildPage, { allChildren: children, onBack: handleBackFromAddChild, onSuccess: handleBackFromAddChild, user: user })) : activeTab === 'measurement' ? (measurementChild ? (Native.createElement(MeasurementPage, { child: measurementChild, onBack: handleBackFromMeasurement })) : (Native.createElement(Card, { className: "p-8 text-center text-slate-500" }, loading ? 'Memuat data balita...' : 'Data balita tidak ditemukan atau tidak dapat diakses.'))) : activeTab === 'dashboard' ? (Native.createElement(DashboardOverviewPage, { stats: dashboardStats, loading: dashboardStatsLoading, monitoringStatus: monitoringStatus, filterMonth: filterMonth, filterYear: filterYear, viewDesa: viewDesa, viewPosyandu: viewPosyandu })) : activeTab === 'asi_eksklusif' ? (Native.createElement(ExclusiveBreastfeedingPage, { filterMonth: filterMonth, filterYear: filterYear, refreshKey: dataRevision, viewDesa: viewDesa, viewPosyandu: viewPosyandu })) : activeTab === 'pmt_program' ? (Native.createElement(PmtProgramPage, { childrenData: children, pmtPrograms: pmtPrograms, onExportPmt: handleExportPmt, onDeleteProgram: handleDeletePmt, onOpenMonitoring: handleOpenPmtMonitoring })) : activeTab === 'change_history' ? (Native.createElement(ChangeHistoryPage, { changeLogs: changeLogs, loading: changeHistoryLoading, error: changeHistoryError, currentPage: changeHistoryPage, total: changeHistoryTotal, pageSize: 10, onPageChange: setChangeHistoryPage, onRetry: () => setChangeHistoryRevision((revision) => revision + 1) })) : (Native.createElement(ChildrenTablePage, { activeTab: activeTab, currentFilterDate: currentFilterDate, currentPage: currentPage, displayData: tableDisplayData, fileInputRef: fileInputRef, filterMonth: filterMonth, filterYear: filterYear, handleExportMpasi: handleExportMpasi, handleExportPengukuranSigizi: handleExportPengukuranSigizi, handleExportTable: handleExportTable, handleImportIdentitas: handleImportIdentitas, handlePermanentDelete: handlePermanentDelete, handleRestore: handleRestore, itemsPerPage: itemsPerPage, loading: tableLoading, monthlyMeasurements: tableMeasurements, mpasiLogs: tableMpasiLogs, paginatedData: tablePaginatedData, searchTerm: searchTerm, searchDraft: searchDraft, setChildToDelete: setChildToDelete, setChildToMpasi: setChildToMpasi, setCurrentPage: setCurrentPage, onEditChild: handleOpenEditChild, setPmtModalData: setPmtModalData, setSearchDraft: setSearchDraft, onClearSearch: handleClearSearch, onSubmitSearch: handleSearchSubmit, onOpenMeasurement: handleOpenMeasurementPage, onOpenAddChild: handleOpenAddChildPage, setSortOrder: setSortOrder, sortOrder: sortOrder, totalDataCount: tableTotalCount, user: user })))),
            Native.createElement("footer", { className: "app-footer" },
                Native.createElement("p", null, "\u00A9 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach"),
                Native.createElement("button", { type: "button", className: "app-version-button", onClick: openReleaseNotes, "aria-haspopup": "dialog", title: "Lihat apa yang baru" }, `E-Posyandu v${APP_VERSION}`))),
        editingChild && (Native.createElement(AddChildModal, { user: user, isEdit: true, initialData: editingChild, onClose: () => setEditingChild(null), onSuccess: () => setEditingChild(null), allChildren: children })),
        childToDelete && (Native.createElement(DeleteChildModal, { child: childToDelete, onClose: () => setChildToDelete(null), onConfirm: handleDeleteConfirm })),
        childToMpasi && (Native.createElement(MpasiModal, { child: childToMpasi, onClose: () => setChildToMpasi(null) })),
        pmtModalData && (Native.createElement(PmtModal, { child: pmtModalData.child, category: pmtModalData.category, onClose: () => setPmtModalData(null) })),
        pmtMonitoringData && (Native.createElement(PmtMonitoringModal, { program: pmtMonitoringData.program, child: pmtMonitoringData.child, onClose: () => setPmtMonitoringData(null) }))));
};
