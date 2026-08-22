// @ts-nocheck
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, syncMeasurementMutationsNow, syncPendingMutations, updateDoc, where } from '../api/syncApi';
import Native, { useEffect, useMemo, useState } from '../runtime/dom';
import { Button, DataTable, KenaikanBadge, Select, StatusBadge, actionTooltipProps } from '../components';
import { Card, InputGroup } from '../ui/dashboardPrimitives';
import { CheckCircle2, ChevronLeft, History, Loader2, Pencil, Plus, Scale, Trash2, TrendingUp } from '../ui/icons';
import { showError, showSuccess } from '../ui/notifications';
import GrowthChartsDialog from '../features/measurements/GrowthChartsDialog';
import { fetchChildMeasurementHistory } from '../services/measurementService';
import {
    calculateWeightGainStatus as calculateMeasurementWeightGainStatus,
    getMeasurementStatuses,
    MEASUREMENT_DECIMAL_RULES,
    normalizeMeasurementInput,
    parseMeasurementDecimalForRange,
    validateMeasurementForm
} from '../features/measurements/measurementRules';
import { appId, db, formatDate, formatIndoDate, getAgeInMonths } from './DashboardApp';
import type { PageState } from '../shared/pageState';
const inputClass = 'w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors';
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
    const [historyState, setHistoryState] = useState<PageState<any[]>>({ status: 'idle' });
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const history = historyState.status === 'success' ? historyState.data : [];
    const loading = saveState.status === 'loading';
    const loadingHistory = historyState.status === 'loading';
    const historyError = historyState.status === 'error' ? historyState.message : null;
    const [deletingMeasurementId, setDeletingMeasurementId] = useState(null);
    const [editingMeasurementId, setEditingMeasurementId] = useState(null);
    const [showGrowthCharts, setShowGrowthCharts] = useState(false);
    useEffect(() => {
        if (!child.id) {
            setHistoryState({ status: 'success', data: [] });
            return;
        }
        let active = true;
        setHistoryState({ status: 'loading' });
        const historyQuery = query(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), where('childId', '==', child.id));
        const unsubscribe = onSnapshot(historyQuery, (snapshot) => {
            const data = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
            data.sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
            if (active)
                setHistoryState({ status: 'success', data });
        }, (error) => {
            console.error('Error memuat riwayat:', error);
            if (active)
                setHistoryState({ status: 'error', message: error instanceof Error ? error.message : 'Riwayat penimbangan tidak dapat dimuat.' });
        });
        void fetchChildMeasurementHistory(child)
            .then((completeHistory) => {
                if (!active)
                    return;
                setHistoryState((previous) => {
                    const cachedHistory = previous.status === 'success' ? previous.data : [];
                    const byId = new Map([...cachedHistory, ...completeHistory].map((item) => [item.id, item]));
                    const data = Array.from(byId.values()).sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
                    return { status: 'success', data };
                });
            })
            .catch((error) => {
                console.error('Riwayat lengkap belum dapat dimuat:', error);
                if (!active)
                    return;
                setHistoryState((previous) => previous.status === 'success' && previous.data.length > 0
                    ? previous
                    : { status: 'error', message: error instanceof Error ? error.message : 'Riwayat penimbangan tidak dapat dimuat.' });
            });
        return () => {
            active = false;
            unsubscribe();
        };
    }, [child.id]);
    const measureDate = useMemo(() => new Date(formData.tglUkur), [formData.tglUkur]);
    const ageAtMeasure = useMemo(() => getAgeInMonths(child.tglLahir, measureDate), [child.tglLahir, measureDate]);
    const showLilaMeasurement = ageAtMeasure >= 3;
    const lengthHeightLabel = ageAtMeasure <= 24 ? 'Panjang Badan (cm)' : 'Tinggi Badan (cm)';
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
        const caraUkur = ageAtMeasure > 24 ? 'Berdiri' : 'Terlentang';
        setFormData((previous) => {
            const nextLila = ageAtMeasure < 3 ? '' : previous.lila;
            return previous.caraUkur === caraUkur && previous.lila === nextLila
                ? previous
                : { ...previous, caraUkur, lila: nextLila };
        });
    }, [ageAtMeasure, activeMenu]);
    const handleStartAdd = () => {
        setEditingMeasurementId(null);
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
    const handleStartEdit = (measurement) => {
        if (!measurement?.id || loading || deletingMeasurementId)
            return;
        setEditingMeasurementId(measurement.id);
        setFormData({
            tglUkur: String(measurement.tglUkur || formatDate(new Date())).slice(0, 10),
            bb: String(measurement.bb ?? ''),
            tb: String(measurement.tb ?? ''),
            lila: String(measurement.lila ?? ''),
            lk: String(measurement.lk ?? ''),
            edema: measurement.edema || 'Tidak',
            kelasIbu: measurement.kelasIbu || 'Tidak',
            mbg: measurement.mbg || 'Tidak',
            vitA: measurement.vitA || 'Tidak',
            asi: measurement.asi || 'Tidak',
            caraUkur: measurement.caraUkur || '',
            statusNaik: measurement.statusNaik || 'B'
        });
        setActiveMenu('add');
    };
    const handleShowHistory = () => {
        setEditingMeasurementId(null);
        setActiveMenu('history');
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
        const liveMeasurementDate = readLiveField('tglUkur', formData.tglUkur);
        const liveAgeInMonths = getAgeInMonths(child.tglLahir, new Date(`${liveMeasurementDate.slice(0, 10)}T00:00:00`));
        const validation = validateMeasurementForm({
            date: liveMeasurementDate,
            bb: readLiveField('bb', formData.bb),
            tb: readLiveField('tb', formData.tb),
            lila: readLiveField('lila', formData.lila),
            lk: readLiveField('lk', formData.lk),
            ageInMonths: liveAgeInMonths
        });
        if (!validation.ok) {
            showError(validation.message);
            return;
        }
        const { measurementDate, bb: weight, tb: height, lila, lk } = validation.data;
        const currentDate = new Date(`${measurementDate}T00:00:00`);
        if (!measurementDate || Number.isNaN(currentDate.getTime())) {
            showError('Tanggal pengukuran belum valid.');
            return;
        }
        const previousMeasurement = history
            .filter((item) => item.id !== editingMeasurementId)
            .find((item) => new Date(item.tglUkur).getTime() < currentDate.getTime());
        const statusNaik = calculateMeasurementWeightGainStatus({ bb: weight, tglUkur: measurementDate }, previousMeasurement, child);
        const normalizedPayload = {
            ...formData,
            tglUkur: measurementDate,
            bb: weight,
            tb: height,
            lila,
            lk,
            statusNaik
        };
        setSaveState({ status: 'loading' });
        try {
            const measurementData = {
                childId: child.id,
                childName: child.nama,
                posyandu: child.posyandu,
                desa: child.desa,
                ...normalizedPayload,
                ageInMonths: getAgeInMonths(child.tglLahir, currentDate),
                updatedAt: serverTimestamp()
            };
            const measurementMutation = editingMeasurementId
                ? await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'measurements', editingMeasurementId), measurementData, { deferSync: true })
                : await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
                    ...measurementData,
                    createdAt: serverTimestamp()
                }, { deferSync: true });
            const measurementId = editingMeasurementId || measurementMutation.id;
            const projectedHistory = [
                ...history.filter((item) => item.id !== measurementId),
                { ...(history.find((item) => item.id === measurementId) || {}), id: measurementId, ...measurementData }
            ].sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
            const chronologicalHistory = [...projectedHistory].reverse();
            const statusMutationIds = [];
            for (let index = 0; index < chronologicalHistory.length; index += 1) {
                const item = chronologicalHistory[index];
                const recalculatedStatus = calculateMeasurementWeightGainStatus(item, chronologicalHistory[index - 1], child);
                if (item.id !== measurementId && item.statusNaik !== recalculatedStatus) {
                    const statusMutation = await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'measurements', item.id), {
                        statusNaik: recalculatedStatus,
                        updatedAt: serverTimestamp()
                    }, { deferSync: true });
                    statusMutationIds.push(statusMutation.mutationId);
                }
                item.statusNaik = recalculatedStatus;
            }
            const latestMeasurement = projectedHistory[0];
            const childMutation = await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id), {
                currentBB: latestMeasurement?.bb ?? child.bbLahir ?? null,
                currentTB: latestMeasurement?.tb ?? child.pbLahir ?? null,
                currentLILA: latestMeasurement?.lila ?? null,
                currentLK: latestMeasurement?.lk ?? child.lkLahir ?? null,
                lastMeasurementDate: latestMeasurement?.tglUkur ?? null,
                updatedAt: serverTimestamp()
            }, { deferSync: true });
            await syncMeasurementMutationsNow([measurementMutation.mutationId, ...statusMutationIds, childMutation.mutationId]);
            setHistoryState({ status: 'success', data: projectedHistory });
            setSaveState({ status: 'success', data: undefined });
            showSuccess(editingMeasurementId ? 'Data penimbangan berhasil diperbarui.' : 'Data penimbangan berhasil disimpan.');
            handleShowHistory();
        }
        catch (error) {
            console.error('Gagal simpan: ' + error.message);
            setSaveState({ status: 'error', message: error instanceof Error ? error.message : 'Data penimbangan belum dapat disimpan.' });
            showError(`Data penimbangan belum dapat disimpan: ${error.message}`);
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
                currentLILA: latestMeasurement?.lila ?? null,
                currentLK: latestMeasurement?.lk ?? child.lkLahir ?? null,
                lastMeasurementDate: latestMeasurement?.tglUkur ?? null,
                updatedAt: serverTimestamp()
            });
            await syncPendingMutations();
            setHistoryState({ status: 'success', data: remainingHistory });
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
        const normalized = normalizeMeasurementInput(event.target.value);
        setFormData((previous) => ({ ...previous, [field]: normalized }));
    };
    const handleDecimalFieldBlur = (field) => () => {
        setFormData((previous) => {
            const value = String(previous[field] ?? '');
            const rule = MEASUREMENT_DECIMAL_RULES[field];
            if (rule) {
                const parsed = parseMeasurementDecimalForRange(value, rule.minimum, rule.maximum, rule.shift);
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
        saveState.status === 'error' && (Native.createElement("div", { className: "ios-inline-notification ios-inline-notification-error", role: "alert" },
            Native.createElement("strong", null, "Data penimbangan belum tersimpan"),
            Native.createElement("span", null, saveState.message))),
        showGrowthCharts && Native.createElement(GrowthChartsDialog, { child: child, history: monthlyHistory, onClose: () => setShowGrowthCharts(false) }),
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
                Native.createElement("button", { type: "button", role: "tab", "aria-selected": activeMenu === 'history', className: activeMenu === 'history' ? 'is-active' : '', onClick: handleShowHistory },
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
                Native.createElement("div", { className: "measurement-history-tools" },
                    Native.createElement(Button, { type: "button", variant: "secondary", className: "measurement-growth-button", onClick: () => setShowGrowthCharts(true), title: "Buka enam grafik pertumbuhan WHO" },
                        Native.createElement(TrendingUp, { className: "h-4 w-4" }),
                        Native.createElement("span", null, "Grafik Pertumbuhan")),
                    Native.createElement("span", { className: "measurement-history-count", "aria-label": `${monthlyHistory.length} catatan` }, monthlyHistory.length))),
            historyError && (Native.createElement("div", { className: "ios-inline-notification ios-inline-notification-error mb-4", role: "alert" },
                Native.createElement("strong", null, "Riwayat penimbangan tidak dapat dimuat"),
                Native.createElement("span", null, historyError))),
            loadingHistory ? (Native.createElement("div", { className: "py-12 text-center text-slate-400" },
                Native.createElement(Loader2, { className: "w-8 h-8 animate-spin mx-auto mb-2" }),
                "Memuat riwayat...")) : monthlyHistory.length === 0 ? (Native.createElement("p", { className: "measurement-history-empty" }, "Belum ada riwayat pengukuran.")) : (Native.createElement(DataTable, { className: "measurement-history-scroll", ariaLabel: "Riwayat penimbangan yang dapat digulir" },
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
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Status LILA/U"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Status LK/U"),
                            Native.createElement("th", { className: "text-center py-2 px-2" }, "Naik BB"),
                            Native.createElement("th", { className: "text-center py-2 pl-2" }, "Aksi"))),
                    Native.createElement("tbody", null, monthlyHistory.map((item) => {
                        const monthLabel = new Date(item.tglUkur).toLocaleDateString('id-ID', {
                            month: 'short',
                            year: 'numeric'
                        });
                        const statuses = getMeasurementStatuses(item, child);
                        const statusBbu = statuses.statusBbu;
                        const statusTbu = statuses.statusTbu;
                        const statusBbtb = statuses.statusBbtb;
                        const statusImtu = statuses.statusImtu;
                        const statusLilau = statuses.statusLilau;
                        const statusLku = statuses.statusLku;
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
                                Native.createElement(StatusBadge, { status: statusLilau })),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(StatusBadge, { status: statusLku })),
                            Native.createElement("td", { className: "py-2 px-2 text-center" },
                                Native.createElement(KenaikanBadge, { status: item.statusNaik })),
                            Native.createElement("td", { className: "py-2 pl-2 text-center" },
                                Native.createElement("div", { className: "flex items-center justify-center gap-2" },
                                    Native.createElement("button", { ...actionTooltipProps("Edit riwayat penimbangan"), type: "button", className: "table-action-button table-action-blue disabled:cursor-not-allowed disabled:opacity-50", "aria-label": `Edit penimbangan tanggal ${formatIndoDate(item.tglUkur)}`, disabled: loading || Boolean(deletingMeasurementId), onClick: () => handleStartEdit(item) },
                                        Native.createElement(Pencil, { className: "h-4 w-4" })),
                                    Native.createElement("button", { ...actionTooltipProps("Hapus riwayat penimbangan"), type: "button", className: "table-action-button table-action-red disabled:cursor-not-allowed disabled:opacity-50", "aria-label": `Hapus penimbangan tanggal ${formatIndoDate(item.tglUkur)}`, disabled: loading || Boolean(deletingMeasurementId), onClick: () => handleDeleteMeasurement(item) }, deletingMeasurementId === item.id ? Native.createElement(Loader2, { className: "h-4 w-4 animate-spin" }) : Native.createElement(Trash2, { className: "h-4 w-4" }))))))
                    }))))))) : (Native.createElement(Card, { className: "ios-measurement-form p-4 sm:p-6" },
            Native.createElement("form", { onSubmit: handleSubmit, className: "measurement-form-stack space-y-6" },
                Native.createElement("div", { className: "measurement-form-panel measurement-time-panel grid grid-cols-1 md:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "Tanggal Pengukuran" },
                        Native.createElement("input", { name: "tglUkur", required: true, type: "date", className: inputClass, value: formData.tglUkur, onChange: (event) => setFormData((previous) => ({ ...previous, tglUkur: event.target.value })) })),
                    Native.createElement(InputGroup, { label: "Cara Ukur" },
                        Native.createElement("input", { type: "text", readOnly: true, className: `${inputClass} bg-slate-100 text-slate-500`, value: formData.caraUkur }))),
                Native.createElement("div", { className: "measurement-form-panel measurement-anthropometry-panel grid grid-cols-1 sm:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "Berat Badan (kg)" },
                        Native.createElement("input", { name: "bb", required: true, type: "text", inputMode: "decimal", placeholder: "Contoh: 3.20", title: "Masukkan kilogram, misalnya 3.2. Jangan masukkan 3200 gram.", className: inputClass, value: formData.bb, onInvalid: (event) => event.currentTarget.setCustomValidity('Masukkan berat badan dalam kilogram, misalnya 3.2. Jangan masukkan 3200 gram.'), onInput: (event) => {
                                event.currentTarget.setCustomValidity('');
                                handleDecimalFieldChange('bb')(event);
                            }, onBlur: handleDecimalFieldBlur('bb') })),
                    Native.createElement(InputGroup, { label: lengthHeightLabel },
                        Native.createElement("input", { name: "tb", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.tb, onInput: handleDecimalFieldChange('tb'), onBlur: handleDecimalFieldBlur('tb') }))),
                Native.createElement("div", { className: `measurement-form-panel measurement-additional-panel grid grid-cols-1 ${showLilaMeasurement ? 'sm:grid-cols-2' : ''} gap-4` },
                    showLilaMeasurement && Native.createElement(InputGroup, { label: "LILA (cm)" },
                        Native.createElement("input", { name: "lila", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.lila, onInput: handleDecimalFieldChange('lila'), onBlur: handleDecimalFieldBlur('lila') })),
                    Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                        Native.createElement("input", { name: "lk", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.lk, onInput: handleDecimalFieldChange('lk'), onBlur: handleDecimalFieldBlur('lk') }))),
                Native.createElement(InputGroup, { label: "Pitting Edema Bilateral" },
                    Native.createElement(Select, { value: formData.edema, onChange: (event) => setFormData((previous) => ({ ...previous, edema: event.target.value })), options: [
                            { value: 'Tidak', label: 'Tidak' },
                            { value: 'Ada (Derajat +1)', label: 'Ada (Derajat +1)' },
                            { value: 'Ada (Derajat +2)', label: 'Ada (Derajat +2)' },
                            { value: 'Ada (Derajat +3)', label: 'Ada (Derajat +3)' }
                        ] })),
                Native.createElement("div", { className: "measurement-service-panel grid grid-cols-1 sm:grid-cols-2 gap-4" },
                    Native.createElement(InputGroup, { label: "Kelas Ibu Balita?" },
                        Native.createElement(Select, { value: formData.kelasIbu, onChange: (event) => setFormData((previous) => ({ ...previous, kelasIbu: event.target.value })), options: [
                                { value: 'Tidak', label: 'Tidak' },
                                { value: 'Ya', label: 'Ya' }
                            ] })),
                    Native.createElement(InputGroup, { label: "Terima MBG?" },
                        Native.createElement(Select, { value: formData.mbg, onChange: (event) => setFormData((previous) => ({ ...previous, mbg: event.target.value })), options: [
                                { value: 'Tidak', label: 'Tidak' },
                                { value: 'Ya', label: 'Ya' }
                            ] }))),
                Native.createElement("div", { className: "space-y-4" },
                    showVitA && (Native.createElement("div", { className: "measurement-service-option measurement-service-vitamin" },
                        Native.createElement(InputGroup, { label: "Dapat Vitamin A (Feb/Agu)?" },
                            Native.createElement(Select, { className: "bg-white", value: formData.vitA, onChange: (event) => setFormData((previous) => ({ ...previous, vitA: event.target.value })), options: [
                                    { value: 'Tidak', label: 'Tidak' },
                                    { value: 'Ya', label: 'Ya' }
                                ] })))),
                    showAsi && (Native.createElement("div", { className: "measurement-service-option measurement-service-asi" },
                        Native.createElement(InputGroup, { label: "ASI Eksklusif (0-6 bln)?" },
                            Native.createElement(Select, { className: "bg-white", value: formData.asi, onChange: (event) => setFormData((previous) => ({ ...previous, asi: event.target.value })), options: [
                                    { value: 'Tidak', label: 'Tidak' },
                                    { value: 'Ya', label: 'Ya' }
                                ] }))))),
                Native.createElement("div", { className: "measurement-form-actions pt-2 flex gap-3" },
                    Native.createElement(Button, { variant: "secondary", type: "button", onClick: handleShowHistory, className: "ios-back-button flex-1", title: "Kembali ke riwayat penimbangan" },
                        Native.createElement(ChevronLeft, { className: "h-4 w-4" }),
                        "Kembali ke Riwayat"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "flex-1" },
                        Native.createElement(CheckCircle2, { className: "h-4 w-4" }),
                        loading ? 'Menyimpan...' : editingMeasurementId ? 'Simpan Perubahan' : 'Simpan Pengukuran')))))));
}
