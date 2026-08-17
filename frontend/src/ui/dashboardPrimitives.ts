// @ts-nocheck
import Native from '../runtime/dom';
import { Clock, ChevronDown, Filter, MapPin, RotateCcw } from './icons';
import { DATA_WILAYAH, MONTHS, ROLES, YEARS } from '../config/dashboard';
import { Button } from '../components/Button';
import { Select } from '../components/Select';
import { Badge, KenaikanBadge, StatusBadge } from '../components/Badge';

export { Button, Select, Badge, KenaikanBadge, StatusBadge };

export const Card = ({ children, className = "" }) => (
    Native.createElement("div", { className: `app-card rounded-2xl ${className}` }, children)
);

export const InputGroup = ({ label, children, error }) => Native.createElement("div", { className: "space-y-2" },
    Native.createElement("label", { className: "block text-xs font-bold text-slate-500 uppercase tracking-wider" }, label),
    children,
    error && Native.createElement("p", { className: "text-xs text-rose-500" }, error));

export const LocationFilterPanel = ({ draftDesa, draftPosyandu, filterMonth, filterYear, onApply, onReset, role, setDraftDesa, setDraftPosyandu, setFilterMonth, setFilterYear, user }) => {
    const isGizi = role === ROLES.GIZI;
    const hasLocationFilter = role !== ROLES.KADER;
    const activeDesa = isGizi ? draftDesa : (user.desa || '');
    const posyanduOptions = activeDesa ? DATA_WILAYAH[activeDesa] || [] : [];
    return Native.createElement("section", { className: `app-card ios-scope-panel overflow-hidden rounded-2xl ${hasLocationFilter ? '' : 'is-period-only'}`, "aria-label": hasLocationFilter ? "Periode dan wilayah data" : "Periode data", "data-scope-panel": "true" },
        Native.createElement("div", { className: "ios-scope-period-row" },
            Native.createElement("div", { className: "ios-scope-period-title" },
                Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-blue", "aria-hidden": "true" }, Native.createElement(Clock, { className: "h-4 w-4" })),
                Native.createElement("span", null, "Periode Data")),
            Native.createElement("div", { className: "ios-scope-period-control glass-control" },
                Native.createElement("select", { value: filterMonth, onChange: (event) => setFilterMonth(parseInt(event.target.value)), className: "period-select", "aria-label": "Pilih bulan" }, MONTHS.map((month, index) => Native.createElement("option", { key: month, value: index + 1 }, month))),
                Native.createElement("span", { className: "ios-scope-period-divider", "aria-hidden": "true" }),
                Native.createElement("select", { value: filterYear, onChange: (event) => setFilterYear(parseInt(event.target.value)), className: "period-select period-year", "aria-label": "Pilih tahun" }, YEARS.map((year) => Native.createElement("option", { key: year, value: year }, year)))),
            hasLocationFilter && Native.createElement("button", { type: "button", onClick: onReset, title: "Atur ulang pilihan wilayah", "aria-label": "Atur ulang pilihan wilayah", className: "ios-symbol-button ios-scope-reset" }, Native.createElement(RotateCcw, { className: "h-4 w-4", "aria-hidden": "true" }))),
        hasLocationFilter && Native.createElement("div", { className: isGizi ? "ios-scope-location-grid is-gizi" : "ios-scope-location-grid" },
            isGizi && Native.createElement("label", { className: "block min-w-0" },
                Native.createElement("span", { className: "mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600" }, "Desa / Kelurahan"),
                Native.createElement("div", { className: "relative" },
                    Native.createElement(MapPin, { className: "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }),
                    Native.createElement("select", { value: draftDesa, onChange: (event) => { setDraftDesa(event.target.value); setDraftPosyandu(''); }, className: "min-h-11 w-full appearance-none border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm font-medium text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" },
                        Native.createElement("option", { value: "" }, "Semua Desa"), Object.keys(DATA_WILAYAH).map((desa) => Native.createElement("option", { key: desa, value: desa }, desa))),
                    Native.createElement(ChevronDown, { className: "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }))),
            Native.createElement("label", { className: "block min-w-0" },
                Native.createElement("span", { className: "mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600" }, "Posyandu"),
                Native.createElement("div", { className: "relative" },
                    Native.createElement(MapPin, { className: "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }),
                    Native.createElement("select", { value: draftPosyandu, onChange: (event) => setDraftPosyandu(event.target.value), disabled: !activeDesa, className: "min-h-11 w-full appearance-none border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm font-medium text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400" },
                        Native.createElement("option", { value: "" }, "Semua Posyandu"), posyanduOptions.map((posyandu) => Native.createElement("option", { key: posyandu, value: posyandu }, posyandu))),
                    Native.createElement(ChevronDown, { className: "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400", "aria-hidden": "true" }))),
            Native.createElement(Button, { onClick: onApply, className: "ios-toolbar-button min-h-11 w-full whitespace-nowrap sm:w-auto", title: "Terapkan filter wilayah" },
                Native.createElement("span", { className: "ios-button-symbol", "aria-hidden": "true" }, Native.createElement(Filter, { className: "h-4 w-4" })), "Terapkan")));
};
