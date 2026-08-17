// @ts-nocheck
import * as Context from '../../shared/dashboardContext';
import { errorMessage, type PageState } from '../../shared/pageState';

const {
    Native, useState, useEffect, useMemo, useRef, collection, addDoc,
    serverTimestamp, updateDoc, doc, db, appId, formatDate, getAgeInMonths,
    normalizeDecimalInput, parseLocaleNumber, showError, showSuccess,
    syncPendingMutations, Button, InputGroup, Select, Gift, ClipboardCheck,
    CheckSquare, X
} = Context;

export const PmtModal = ({ child, category, onClose }) => {
    const [formData, setFormData] = useState({
        jenisPmt: 'Pabrikan',
        sumberAnggaran: 'Dana Desa',
        mitra: '',
        mitraLain: '',
        tglPemberian: formatDate(new Date()),
        siklusKe: '1',
        pmtSesuaiJuknis: 'Ya'
    });
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const loading = saveState.status === 'loading';
    const saveError = saveState.status === 'error' ? saveState.message : null;
    const handleSubmit = async (e) => {
        e.preventDefault();
        const siklusKe = parseLocaleNumber(formData.siklusKe);
        if (!Number.isFinite(siklusKe) || siklusKe <= 0) {
            showError('Siklus PMT wajib diisi angka desimal yang valid.');
            setSaveState({ status: 'error', message: 'Siklus PMT wajib diisi angka desimal yang valid.' });
            return;
        }
        setSaveState({ status: 'loading' });
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
            setSaveState({ status: 'success', data: undefined });
            showSuccess('Program PMT berhasil ditambahkan.');
            onClose();
        }
        catch (error) {
            console.error(error);
            setSaveState({ status: 'error', message: errorMessage(error, 'Program PMT gagal disimpan.') });
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700", role: "alert" }, saveError),
                Native.createElement("div", { className: "ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "ios-modal-secondary flex-1" }, "Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "ios-modal-primary ios-modal-primary-green flex-1" }, loading ? "Menyimpan..." : "Simpan Program"))))));
};
export const PmtMonitoringModal = ({ program, child, onClose }) => {
    const [week, setWeek] = useState(1);
    const [data, setData] = useState({
        tgl: formatDate(new Date()),
        bb: '',
        tb: '',
        days: [false, false, false, false, false, false, false],
        pemantauanKesehatan: 'Ada',
        tindakLanjut: 'Dilanjutkan'
    });
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const saving = saveState.status === 'loading';
    const saveError = saveState.status === 'error' ? saveState.message : null;
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
        setSaveState({ status: 'loading' });
        try {
            if (!program.id) {
                setSaveState({ status: 'error', message: 'Program PMT tidak ditemukan.' });
                return;
            }
            const parsedBb = parseLocaleNumber(data.bb);
            const parsedTb = parseLocaleNumber(data.tb);
            if (!Number.isFinite(parsedBb) || !Number.isFinite(parsedTb)) {
                showError('BB dan TB wajib diisi dengan angka desimal yang valid.');
                setSaveState({ status: 'error', message: 'BB dan TB wajib diisi dengan angka desimal yang valid.' });
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
            setSaveState({ status: 'success', data: undefined });
            showSuccess(`Pemantauan PMT minggu ${week} berhasil disimpan.`);
            onClose();
        }
        catch (e) {
            console.error(e);
            setSaveState({ status: 'error', message: errorMessage(e, 'Pemantauan PMT gagal disimpan.') });
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700", role: "alert" }, saveError),
                Native.createElement("div", { className: "ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "ios-modal-secondary flex-1" }, "Tutup"),
                    Native.createElement(Button, { variant: "primary", onClick: handleSave, disabled: saving, className: "ios-modal-primary flex-1" },
                        saving ? "Menyimpan..." : "Simpan Minggu ",
                        !saving && week))))));
};
