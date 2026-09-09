// @ts-nocheck
import * as Context from '../../shared/dashboardContext';
import { errorMessage, type PageState } from '../../shared/pageState';

const {
    Native, useState, useEffect, useMemo, useRef, collection, addDoc,
    serverTimestamp, db, appId, formatDate, showSuccess, Button, InputGroup,
    Select, syncPendingMutations, ClipboardCheck, Utensils, X
} = Context;

export const MpasiModal = ({ child, onClose }) => {
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
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const loading = saveState.status === 'loading';
    const saveError = saveState.status === 'error' ? saveState.message : null;
    const handleSubmit = async (e) => {
        e.preventDefault();
        setSaveState({ status: 'loading' });
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
            setSaveState({ status: 'success', data: undefined });
            showSuccess('Data MPASI berhasil disimpan.');
            onClose();
        }
        catch (error) {
            console.error(error);
            setSaveState({ status: 'error', message: errorMessage(error, 'Data MPASI gagal disimpan.') });
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700", role: "alert" }, saveError),
                Native.createElement("div", { className: "ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "flex-1" }, "Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "ios-modal-primary-orange flex-1" }, "Simpan Data MPASI"))))));
};
