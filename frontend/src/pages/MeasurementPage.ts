// @ts-nocheck
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, syncPendingMutations, updateDoc, where } from '../api/client';
import Native, { useEffect, useMemo, useState } from '../runtime/dom';
import { actionTooltipProps } from '../ui/actionTooltip';
import { CheckCircle2, ChevronLeft, History, Loader2, Plus, Scale, Trash2 } from '../ui/icons';
import { showError, showSuccess } from '../ui/notifications';
import { appId, Button, calculateGiziStatus, Card, db, formatDate, formatIndoDate, getAgeInMonths, getKBM, InputGroup, KenaikanBadge, Select, StatusBadge } from './DashboardApp';
const inputClass = 'w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors';
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
export default function MeasurementPage({ child, onBack }) {
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
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [deletingMeasurementId, setDeletingMeasurementId] = useState(null);
    const parseLocaleDecimal = (value) => {
        const normalized = normalizeDecimalInput(String(value ?? '')).trim();
        if (!normalized)
            return null;
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const parseDecimalForRange = (value, minimum, maximum, decimalShiftLimit = 2) => {
        const normalized = normalizeDecimalInput(String(value ?? '')).trim();
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
    useEffect(() => {
        if (!child.id) {
            setHistory([]);
            setLoadingHistory(false);
            return;
        }
        setLoadingHistory(true);
        const historyQuery = query(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), where('childId', '==', child.id));
        return onSnapshot(historyQuery, (snapshot) => {
            const data = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
            data.sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
            setHistory(data);
            setLoadingHistory(false);
        }, (error) => {
            console.error('Error memuat riwayat:', error);
            setLoadingHistory(false);
        });
    }, [child.id]);
    useEffect(() => {
        if (!formData.bb || !formData.tglUkur)
            return;
        const currentWeight = parseLocaleDecimal(formData.bb);
        if (currentWeight === null)
            return;
        const currentDate = new Date(formData.tglUkur);
        const previousMeasurement = history.find((item) => new Date(item.tglUkur).getTime() < currentDate.getTime());
        if (!previousMeasurement) {
            setFormData((previous) => ({ ...previous, statusNaik: 'B' }));
            return;
        }
        const previousDate = new Date(previousMeasurement.tglUkur);
        const diffTime = Math.abs(currentDate.getTime() - previousDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays > 45) {
            setFormData((previous) => ({ ...previous, statusNaik: 'O' }));
            return;
        }
        const previousWeight = parseLocaleDecimal(previousMeasurement.bb);
        if (previousWeight === null)
            return;
        const gain = (currentWeight - previousWeight) * 1000;
        const measureAgeInMonths = getAgeInMonths(child.tglLahir, currentDate);
        const minGain = getKBM(measureAgeInMonths);
        const newStatus = gain >= minGain ? 'N' : 'T';
        setFormData((previous) => ({ ...previous, statusNaik: newStatus }));
    }, [formData.bb, formData.tglUkur, history, child.tglLahir]);
    const measureDate = useMemo(() => new Date(formData.tglUkur), [formData.tglUkur]);
    const ageAtMeasure = useMemo(() => getAgeInMonths(child.tglLahir, measureDate), [child.tglLahir, measureDate]);
    const lengthHeightLabel = ageAtMeasure <= 24 ? 'Panjang Badan (cm)' : 'Tinggi Badan (cm)';
    const lengthHeightStatusLabel = ageAtMeasure <= 24 ? 'Status PB/U' : 'Status TB/U';
    const weightLengthHeightStatusLabel = ageAtMeasure <= 24 ? 'Status BB/PB' : 'Status BB/TB';
    const statusSummary = useMemo(() => ({
        bbu: calculateGiziStatus(formData.bb, 'BBU', ageAtMeasure, child.jk),
        tbu: calculateGiziStatus(formData.tb, 'TBU', ageAtMeasure, child.jk, null, formData.caraUkur),
        bbtb: calculateGiziStatus(formData.bb, 'BBTB', ageAtMeasure, child.jk, formData.tb, formData.caraUkur),
        imtu: calculateGiziStatus(formData.bb, 'IMTU', ageAtMeasure, child.jk, formData.tb, formData.caraUkur)
    }), [ageAtMeasure, child.jk, formData.bb, formData.caraUkur, formData.tb]);
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
        setFormData((previous) => ({
            ...previous,
            caraUkur: ageAtMeasure > 24 ? 'Berdiri' : 'Terlentang'
        }));
    }, [ageAtMeasure, activeMenu]);
    const handleStartAdd = () => {
        setActiveMenu('add');
        setFormData((previous) => ({
            ...previous,
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
    const handleSubmit = async (event) => {
        event.preventDefault();
        if (!child.id)
            return;
        const formElement = event.currentTarget;
        const readLiveField = (field, fallback) => {
            const input = formElement?.querySelector?.(`[name="${field}"]`);
            const liveValue = typeof input?.value === 'string' ? input.value : '';
            return liveValue || String(fallback ?? '');
        };
        const weight = parseDecimalForRange(readLiveField('bb', formData.bb), 0.1, 60, 2);
        const height = parseDecimalForRange(readLiveField('tb', formData.tb), 10, 220, 1);
        const lila = parseDecimalForRange(readLiveField('lila', formData.lila), 0.1, 50, 1);
        const lk = parseDecimalForRange(readLiveField('lk', formData.lk), 0.1, 80, 1);
        if (!Number.isFinite(weight) || weight < 0.1 || weight > 60) {
            showError('Berat badan harus diisi dalam kilogram, misalnya 3,2 kg. Jangan masukkan 3200 gram.');
            return;
        }
        if (!Number.isFinite(height) || height < 10 || height > 220) {
            showError('Tinggi badan harus diisi desimal yang valid, misalnya 78,5 cm.');
            return;
        }
        if (!Number.isFinite(lila) || lila <= 0 || lila > 50) {
            showError('LiLa harus diisi desimal yang valid, misalnya 13,2 cm.');
            return;
        }
        if (!Number.isFinite(lk) || lk <= 0 || lk > 80) {
            showError('Lingkar kepala harus diisi desimal yang valid, misalnya 45,5 cm.');
            return;
        }
        const normalizedPayload = {
            ...formData,
            bb: weight,
            tb: height,
            lila,
            lk
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
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id), {
                currentBB: weight,
                currentTB: height,
                currentLILA: lila,
                currentLK: lk,
                lastMeasurementDate: formData.tglUkur,
                updatedAt: serverTimestamp()
            });
            await syncPendingMutations();
            showSuccess('Data penimbangan berhasil disimpan.');
            setActiveMenu('history');
        }
        catch (error) {
            console.error('Gagal simpan: ' + error.message);
            showError(`Data penimbangan belum dapat disimpan: ${error.message}`);
        }
        finally {
            setLoading(false);
        }
    };
    const handleDeleteMeasurement = async (measurement) => {
        if (!measurement.id || deletingMeasurementId)
            return;
        const confirmed = window.confirm(`Hapus penimbangan tanggal ${formatIndoDate(measurement.tglUkur)}? Data yang sudah dihapus tidak dapat dikembalikan.`);
        if (!confirmed)
            return;
        setDeletingMeasurementId(measurement.id);
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'measurements', measurement.id));
            const remainingHistory = history
                .filter((item) => item.id !== measurement.id)
                .sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
            const latestMeasurement = remainingHistory[0];
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id), {
                currentBB: latestMeasurement?.bb ?? child.bbLahir ?? null,
                currentTB: latestMeasurement?.tb ?? child.pbLahir ?? null,
                currentLILA: latestMeasurement?.lila ?? 0,
                currentLK: latestMeasurement?.lk ?? child.lkLahir ?? null,
                lastMeasurementDate: latestMeasurement?.tglUkur ?? null,
                updatedAt: serverTimestamp()
            });
            await syncPendingMutations();
            setHistory(remainingHistory);
            showSuccess('Riwayat penimbangan berhasil dihapus.');
        }
        catch (error) {
            console.error('Gagal menghapus riwayat penimbangan:', error);
            showError(`Riwayat penimbangan gagal dihapus: ${error.message}`);
        }
        finally {
            setDeletingMeasurementId(null);
        }
    };
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
                const parsed = parseDecimalForRange(value, rule.minimum, rule.maximum, rule.shift);
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
    return (Native.createElement("div", { className: "measurement-page apple-page space-y-6", "data-measurement-page": true },
        Native.createElement("div", { className: "flex flex-col lg:flex-row lg:items-end justify-between gap-4" },
            Native.createElement("div", null,
                Native.createElement(Button, { type: "button", variant: "secondary", onClick: onBack, className: "ios-back-button mb-4", title: "Kembali ke daftar balita" },
                    Native.createElement(ChevronLeft, { className: "w-4 h-4" }),
                    " Kembali"),
                Native.createElement("div", { className: "flex items-center gap-3" },
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-blue", "aria-hidden": "true" },
                        Native.createElement(Scale, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "min-w-0" },
                        Native.createElement("h2", { className: "text-2xl font-bold text-slate-800" }, "Pengukuran Balita"),
                        Native.createElement("p", { className: "truncate text-slate-500 text-sm" },
                            child.nama,
                            " - ",
                            getAgeInMonths(child.tglLahir),
                            " Bulan - ",
                            child.desa,
                            " / ",
                            child.posyandu)))),
            Native.createElement("div", { className: "measurement-segmented apple-segmented-control", role: "tablist", "aria-label": "Menu penimbangan" },
                Native.createElement("button", { type: "button", role: "tab", "aria-selected": activeMenu === 'history', className: activeMenu === 'history' ? 'is-active' : '', onClick: () => setActiveMenu('history') },
                    Native.createElement(History, { className: "h-4 w-4" }),
                    Native.createElement("span", null, "Riwayat")),
                Native.createElement("button", { type: "button", role: "tab", "aria-selected": activeMenu === 'add', className: activeMenu === 'add' ? 'is-active' : '', onClick: handleStartAdd },
                    Native.createElement(Plus, { className: "w-4 h-4" }),
                    Native.createElement("span", null, "Tambah")))),
        activeMenu === 'history' ? (Native.createElement(Card, { className: "ios-table-card measurement-history-card" },
            Native.createElement("div", { className: "measurement-history-heading" },
                Native.createElement("div", null,
                    Native.createElement("h3", null, "Riwayat Penimbangan Bulan ke Bulan"),
                    Native.createElement("p", null, `${monthlyHistory.length} catatan pengukuran`)),
                Native.createElement("span", { className: "measurement-history-count", "aria-label": `${monthlyHistory.length} catatan` }, monthlyHistory.length)),
            loadingHistory ? (Native.createElement("div", { className: "py-12 text-center text-slate-400" },
                Native.createElement(Loader2, { className: "w-8 h-8 animate-spin mx-auto mb-2" }),
                "Memuat riwayat...")) : monthlyHistory.length === 0 ? (Native.createElement("p", { className: "measurement-history-empty" }, "Belum ada riwayat pengukuran.")) : (Native.createElement("div", { className: "measurement-history-scroll ios-table-scroll", tabIndex: 0, "aria-label": "Riwayat penimbangan yang dapat digulir" },
                Native.createElement("table", { className: "ios-data-table ios-measurement-table text-xs", "data-measurement-history-table": true },
                    Native.createElement("thead", null,
                        Native.createElement("tr", { className: "text-slate-500 border-b border-slate-200" },
                            Native.createElement("th", { className: "text-left py-2 pr-4" }, "Bulan"),
                            Native.createElement("th", { className: "text-left py-2 pr-4" }, "Tanggal Ukur"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "BB"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "PB/TB"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "LILA"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "LK"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Status BB/U"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Status PB/TB-U"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Status BB/PB atau BB/TB"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Status IMT/U"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Naik BB"),
                            Native.createElement("th", { className: "text-center py-2 pl-2" }, "Aksi"))),
                    Native.createElement("tbody", null, monthlyHistory.map((item) => {
                        const monthLabel = new Date(item.tglUkur).toLocaleDateString('id-ID', {
                            month: 'short',
                            year: 'numeric'
                        });
                        const ageAtHistory = getAgeInMonths(child.tglLahir, new Date(item.tglUkur));
                        const statusBbu = calculateGiziStatus(item.bb, 'BBU', ageAtHistory, child.jk);
                        const statusTbu = calculateGiziStatus(item.tb, 'TBU', ageAtHistory, child.jk, null, item.caraUkur);
                        const statusBbtb = calculateGiziStatus(item.bb, 'BBTB', ageAtHistory, child.jk, item.tb, item.caraUkur);
                        const statusImtu = calculateGiziStatus(item.bb, 'IMTU', ageAtHistory, child.jk, item.tb, item.caraUkur);
                        return (Native.createElement("tr", { key: item.id || item.tglUkur, className: "ios-data-row text-slate-700" },
                            Native.createElement("td", { className: "py-2 pr-4 font-semibold uppercase whitespace-nowrap" }, monthLabel),
                            Native.createElement("td", { className: "py-2 pr-4 whitespace-nowrap" }, formatIndoDate(item.tglUkur)),
                            Native.createElement("td", { className: "py-2 px-2 text-center" }, item.bb || '-'),
                            Native.createElement("td", { className: "py-2 px-2 text-center" }, item.tb || '-'),
                            Native.createElement("td", { className: "py-2 px-2 text-center" }, item.lila || '-'),
                            Native.createElement("td", { className: "py-2 px-2 text-center" }, item.lk || '-'),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(StatusBadge, { status: statusBbu })),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(StatusBadge, { status: statusTbu })),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(StatusBadge, { status: statusBbtb })),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(StatusBadge, { status: statusImtu })),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(KenaikanBadge, { status: item.statusNaik })),
                            Native.createElement("td", { className: "py-2 pl-2 text-center" },
                                Native.createElement("button", { ...actionTooltipProps("Hapus riwayat penimbangan"), type: "button", className: "table-action-button table-action-red disabled:cursor-not-allowed disabled:opacity-50", "aria-label": `Hapus penimbangan tanggal ${formatIndoDate(item.tglUkur)}`, disabled: Boolean(deletingMeasurementId), onClick: () => handleDeleteMeasurement(item) }, deletingMeasurementId === item.id ? Native.createElement(Loader2, { className: "h-4 w-4 animate-spin" }) : Native.createElement(Trash2, { className: "h-4 w-4" })))))
                    }))))))) : (Native.createElement(Card, { className: "ios-measurement-form p-4 sm:p-6" },
            Native.createElement("form", { onSubmit: handleSubmit, className: "measurement-form-stack space-y-6" },
                Native.createElement("div", { className: "measurement-form-panel measurement-time-panel grid grid-cols-1 md:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "Tanggal Pengukuran" },
                        Native.createElement("input", { required: true, type: "date", className: inputClass, value: formData.tglUkur, onChange: (event) => setFormData({ ...formData, tglUkur: event.target.value }) })),
                    Native.createElement(InputGroup, { label: "Cara Ukur" },
                        Native.createElement("input", { type: "text", readOnly: true, className: `${inputClass} bg-slate-100 text-slate-500`, value: formData.caraUkur }))),
                Native.createElement("div", { className: "measurement-form-panel measurement-anthropometry-panel grid grid-cols-1 sm:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "Berat Badan (kg)" },
                        Native.createElement("input", { name: "bb", required: true, type: "text", inputMode: "text", placeholder: "Contoh: 3.20", title: "Masukkan kilogram, misalnya 3.2. Jangan masukkan 3200 gram.", className: inputClass, value: formData.bb, onInvalid: (event) => event.currentTarget.setCustomValidity('Masukkan berat badan dalam kilogram, misalnya 3.2. Jangan masukkan 3200 gram.'), onInput: (event) => {
                                event.currentTarget.setCustomValidity('');
                                handleDecimalFieldChange('bb')(event);
                            }, onChange: handleDecimalFieldChange('bb'), onBlur: handleDecimalFieldBlur('bb') })),
                    Native.createElement(InputGroup, { label: lengthHeightLabel },
                        Native.createElement("input", { name: "tb", required: true, type: "text", inputMode: "text", className: inputClass, value: formData.tb, onInput: handleDecimalFieldChange('tb'), onChange: handleDecimalFieldChange('tb'), onBlur: handleDecimalFieldBlur('tb') }))),
                Native.createElement("div", { className: "measurement-status-panel" },
                    Native.createElement("div", { className: "measurement-status-grid grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 text-xs" },
                        Native.createElement("div", null,
                            Native.createElement("p", { className: "text-slate-500 mb-1" }, "Status BB/U"),
                            Native.createElement(StatusBadge, { status: statusSummary.bbu })),
                        Native.createElement("div", null,
                            Native.createElement("p", { className: "text-slate-500 mb-1" }, lengthHeightStatusLabel),
                            Native.createElement(StatusBadge, { status: statusSummary.tbu })),
                        Native.createElement("div", null,
                            Native.createElement("p", { className: "text-slate-500 mb-1" }, weightLengthHeightStatusLabel),
                            Native.createElement(StatusBadge, { status: statusSummary.bbtb })),
                        Native.createElement("div", null,
                            Native.createElement("p", { className: "text-slate-500 mb-1" }, "Status IMT/U"),
                            Native.createElement(StatusBadge, { status: statusSummary.imtu })))),
                Native.createElement("div", { className: "measurement-form-panel measurement-additional-panel grid grid-cols-1 sm:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "LiLa (cm)" },
                        Native.createElement("input", { name: "lila", type: "text", inputMode: "text", className: inputClass, value: formData.lila, onInput: handleDecimalFieldChange('lila'), onChange: handleDecimalFieldChange('lila'), onBlur: handleDecimalFieldBlur('lila') })),
                    Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                        Native.createElement("input", { name: "lk", type: "text", inputMode: "text", className: inputClass, value: formData.lk, onInput: handleDecimalFieldChange('lk'), onChange: handleDecimalFieldChange('lk'), onBlur: handleDecimalFieldBlur('lk') }))),
                Native.createElement("input", { type: "hidden", value: formData.statusNaik }),
                Native.createElement(InputGroup, { label: "Pitting Edema Bilateral" },
                    Native.createElement(Select, { value: formData.edema, onChange: (event) => setFormData({ ...formData, edema: event.target.value }), options: [
                            { value: 'Tidak', label: 'Tidak' },
                            { value: 'Ada (Derajat +1)', label: 'Ada (Derajat +1)' },
                            { value: 'Ada (Derajat +2)', label: 'Ada (Derajat +2)' },
                            { value: 'Ada (Derajat +3)', label: 'Ada (Derajat +3)' }
                        ] })),
                Native.createElement("div", { className: "measurement-service-panel grid grid-cols-1 sm:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "Kelas Ibu Balita?" },
                        Native.createElement(Select, { value: formData.kelasIbu, onChange: (event) => setFormData({ ...formData, kelasIbu: event.target.value }), options: [
                                { value: 'Tidak', label: 'Tidak' },
                                { value: 'Ya', label: 'Ya' }
                            ] })),
                    Native.createElement(InputGroup, { label: "Terima MBG?" },
                        Native.createElement(Select, { value: formData.mbg, onChange: (event) => setFormData({ ...formData, mbg: event.target.value }), options: [
                                { value: 'Tidak', label: 'Tidak' },
                                { value: 'Ya', label: 'Ya' }
                            ] }))),
                Native.createElement("div", { className: "space-y-4" },
                    showVitA && (Native.createElement("div", { className: "measurement-service-option measurement-service-vitamin" },
                        Native.createElement(InputGroup, { label: "Dapat Vitamin A (Feb/Agu)?" },
                            Native.createElement(Select, { className: "bg-white", value: formData.vitA, onChange: (event) => setFormData({ ...formData, vitA: event.target.value }), options: [
                                    { value: 'Tidak', label: 'Tidak' },
                                    { value: 'Ya', label: 'Ya' }
                                ] })))),
                    showAsi && (Native.createElement("div", { className: "measurement-service-option measurement-service-asi" },
                        Native.createElement(InputGroup, { label: "ASI Eksklusif (0-6 bln)?" },
                            Native.createElement(Select, { className: "bg-white", value: formData.asi, onChange: (event) => setFormData({ ...formData, asi: event.target.value }), options: [
                                    { value: 'Tidak', label: 'Tidak' },
                                    { value: 'Ya', label: 'Ya' }
                                ] }))))),
                Native.createElement("div", { className: "measurement-form-actions pt-2 flex gap-3" },
                    Native.createElement(Button, { variant: "secondary", type: "button", onClick: () => setActiveMenu('history'), className: "ios-back-button flex-1", title: "Kembali ke riwayat penimbangan" },
                        Native.createElement(ChevronLeft, { className: "h-4 w-4" }),
                        "Kembali ke Riwayat"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "flex-1" },
                        Native.createElement(CheckCircle2, { className: "h-4 w-4" }),
                        loading ? 'Menyimpan...' : 'Simpan Pengukuran')))))));
}
