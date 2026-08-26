// @ts-nocheck
import * as Context from '../../shared/dashboardContext';
import { errorMessage, type PageState } from '../../shared/pageState';
import { TableLoadingSkeleton } from '../../ui/skeleton';

const {
    Native, useState, useEffect, useMemo, useRef, collection, addDoc,
    query, where, onSnapshot, serverTimestamp, updateDoc, doc, deleteDoc,
    getDocs, db, appId, formatDate, parseLocaleNumber, parseLocaleNumberForRange,
    calculateZScore, calculateGiziStatus, showSuccess, Button, InputGroup,
    Select, Badge, KenaikanBadge, StatusBadge, X, XCircle, ChevronLeft
} = Context;

export const MeasurementModal = ({ child, onClose }) => {
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
    const [historyState, setHistoryState] = useState<PageState<any[]>>({ status: 'idle' });
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    useEffect(() => {
        const fetchHistory = async () => {
            if (!child.id) {
                setHistoryState({ status: 'success', data: [] });
                return;
            }
            setHistoryState({ status: 'loading' });
            try {
                const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), where('childId', '==', child.id));
                const snapshot = await getDocs(q);
                const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                data.sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
                setHistoryState({ status: 'success', data });
            }
            catch (error) {
                console.error('Error fetching history:', error);
                setHistoryState({ status: 'error', message: errorMessage(error, 'Riwayat penimbangan gagal dimuat.') });
            }
        };
        void fetchHistory();
    }, [child.id]);
    const history = historyState.status === 'success' ? historyState.data : [];
    const loading = saveState.status === 'loading';
    const historyLoading = historyState.status === 'loading';
    const historyError = historyState.status === 'error' ? historyState.message : null;
    const saveError = saveState.status === 'error' ? saveState.message : null;
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
        setSaveState({ status: 'loading' });
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
            setSaveState({ status: 'success', data: undefined });
            onClose();
        }
        catch (error) {
            const message = errorMessage(error, 'Data penimbangan gagal disimpan.');
            console.error('Gagal simpan: ' + message);
            setSaveState({ status: 'error', message });
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700", role: "alert" }, saveError),
                activeMenu === 'history' ? (Native.createElement("div", { className: "bg-slate-50 rounded-2xl border border-slate-200 p-4" },
                    Native.createElement("h3", { className: "text-sm font-bold text-slate-700 mb-3" }, "Riwayat Penimbangan Bulan ke Bulan"),
                    historyLoading ? (Native.createElement("div", { className: "ios-table-scroll overflow-x-auto", role: "status", "aria-label": "Memuat riwayat penimbangan" },
                        Native.createElement("table", { className: "ios-data-table ios-measurement-table min-w-full text-xs", "aria-busy": "true" },
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
                            Native.createElement("tbody", null, Native.createElement(TableLoadingSkeleton, { columnCount: 10, rowCount: 5 }))))) : historyError ? (Native.createElement("p", { className: "text-sm text-rose-600" }, historyError)) : monthlyHistory.length === 0 ? (Native.createElement("p", { className: "text-xs text-slate-500" }, "Belum ada riwayat pengukuran.")) : (Native.createElement("div", { className: "ios-table-scroll overflow-x-auto" },
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
