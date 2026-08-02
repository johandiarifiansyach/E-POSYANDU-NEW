// @ts-nocheck
import { addDoc, collection, serverTimestamp, syncPendingMutations } from '../api/client';
import Native, { useState } from '../runtime/dom';
import { Baby, CheckCircle2, ChevronLeft, MapPin, UserPlus, UserRound, XCircle } from '../ui/icons';
import { showSuccess } from '../ui/notifications';
import { appId, Button, Card, DATA_WILAYAH, db, formatChildName, InputGroup, ROLES, Select } from './DashboardApp';
const inputClass = 'block w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-900 transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100';
function randomDigits(length) {
    const values = new Uint32Array(length);
    if (globalThis.crypto?.getRandomValues)
        globalThis.crypto.getRandomValues(values);
    else
        values.forEach((_, index) => values[index] = Math.floor(Math.random() * 10));
    return Array.from(values, (value) => String(value % 10)).join('');
}
function generateTemporaryKk() {
    return `350904${randomDigits(10)}`;
}
function generateTemporaryNik(data, allChildren) {
    const [year = '', month = '', day = ''] = String(data.tglLahir || '').split('-');
    const birthSegment = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)
        ? `${day}${month}${year.slice(-2)}`
        : randomDigits(6);
    const existingNiks = new Set((Array.isArray(allChildren) ? allChildren : []).map((child) => String(child.nik || '')));
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = `350904${birthSegment}${randomDigits(4)}`;
        if (!existingNiks.has(candidate))
            return candidate;
    }
    return `350904${birthSegment}${String(Date.now()).slice(-4)}`;
}
function initialFormData(user) {
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
}
export default function AddChildPage({ allChildren, onBack, onSuccess, user }) {
    const [formData, setFormData] = useState(() => initialFormData(user));
    const [saving, setSaving] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);
    const handleSubmit = async (event) => {
        event.preventDefault();
        setErrorMessage(null);
        const submissionData = {
            ...formData,
            nama: formatChildName(formData.nama),
            noKK: formData.hasKK || /^\d{16}$/.test(formData.noKK) ? formData.noKK : generateTemporaryKk(),
            nik: formData.hasNIK || /^\d{16}$/.test(formData.nik) ? formData.nik : generateTemporaryNik(formData, allChildren)
        };
        if (!/^\d{16}$/.test(submissionData.noKK)) {
            setErrorMessage('No. KK harus berisi 16 digit. Centang Tidak punya KK untuk membuat nomor sementara.');
            return;
        }
        if (!/^\d{16}$/.test(submissionData.nik)) {
            setErrorMessage('NIK balita harus berisi 16 digit. Centang Tidak punya NIK untuk membuat nomor sementara.');
            return;
        }
        const birthWeight = Number(submissionData.bbLahir);
        if (!Number.isFinite(birthWeight) || birthWeight < 0.1 || birthWeight > 10) {
            setErrorMessage('Berat lahir harus diisi dalam kilogram, misalnya 3,2 kg. Jangan masukkan 3200 gram.');
            return;
        }
        setFormData(submissionData);
        setSaving(true);
        try {
            const newChildRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), {
                ...submissionData,
                currentBB: submissionData.bbLahir,
                currentTB: submissionData.pbLahir,
                currentLK: submissionData.lkLahir,
                currentLILA: 0,
                createdAt: serverTimestamp(),
                createdBy: user.role,
                deletedAt: null
            });
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
                childId: newChildRef.id,
                childName: submissionData.nama,
                posyandu: submissionData.posyandu,
                desa: submissionData.desa,
                tglUkur: submissionData.tglLahir,
                bb: submissionData.bbLahir,
                tb: submissionData.pbLahir,
                lk: submissionData.lkLahir,
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
            await syncPendingMutations();
            showSuccess('Data balita berhasil ditambahkan.');
            onSuccess();
        }
        catch (error) {
            console.error('Gagal menyimpan balita:', error);
            setErrorMessage(error instanceof Error ? error.message : 'Data balita belum dapat disimpan.');
        }
        finally {
            setSaving(false);
        }
    };
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
    return (Native.createElement("div", { className: "add-child-page apple-page space-y-6", "data-add-child-page": true },
        Native.createElement("div", { className: "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between" },
            Native.createElement("div", null,
                Native.createElement(Button, { type: "button", variant: "secondary", onClick: onBack, className: "ios-back-button mb-4", title: "Kembali ke daftar balita" },
                    Native.createElement(ChevronLeft, { className: "h-4 w-4" }),
                    " Kembali"),
                Native.createElement("div", { className: "flex items-center gap-3" },
                    Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-blue", "aria-hidden": "true" },
                        Native.createElement(UserPlus, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "min-w-0" },
                        Native.createElement("h2", { className: "text-2xl font-bold text-slate-800" }, "Registrasi Balita Baru"),
                        Native.createElement("p", { className: "mt-1 text-sm text-slate-500" }, "Data identitas, kelahiran, dan orang tua"))))),
        Native.createElement(Card, { className: "p-4 sm:p-6" },
            Native.createElement("form", { onSubmit: handleSubmit, className: "space-y-8" },
                Native.createElement("section", { className: "space-y-4" },
                    Native.createElement("div", { className: "ios-form-section-header text-slate-800" },
                        Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-green", "aria-hidden": "true" },
                            Native.createElement(MapPin, { className: "h-4 w-4" })),
                        Native.createElement("h3", { className: "font-semibold" }, "Lokasi Pencatatan")),
                    Native.createElement("div", { className: "grid grid-cols-1 gap-4 md:grid-cols-2" },
                        Native.createElement(InputGroup, { label: "Desa" },
                            Native.createElement(Select, { required: true, value: formData.desa, onChange: (event) => {
                                    const desa = event.target.value;
                                    const posyandu = DATA_WILAYAH[desa][0];
                                    setFormData((previous) => ({ ...previous, desa, posyandu, nik: previous.hasNIK ? previous.nik : generateTemporaryNik({ ...previous, desa, posyandu }, allChildren) }));
                                }, disabled: user.role === ROLES.KADER || user.role === ROLES.BIDAN, options: Object.keys(DATA_WILAYAH).map((desa) => ({ value: desa, label: desa })) })),
                        Native.createElement(InputGroup, { label: "Posyandu" },
                            Native.createElement(Select, { required: true, value: formData.posyandu, onChange: (event) => {
                                    const posyandu = event.target.value;
                                    setFormData((previous) => ({ ...previous, posyandu, nik: previous.hasNIK ? previous.nik : generateTemporaryNik({ ...previous, posyandu }, allChildren) }));
                                }, disabled: user.role === ROLES.KADER, options: (DATA_WILAYAH[formData.desa] || []).map((posyandu) => ({ value: posyandu, label: posyandu })) })))),
                Native.createElement("section", { className: "border-t border-slate-200 pt-6 space-y-4" },
                    Native.createElement("div", { className: "ios-form-section-header text-slate-800" },
                        Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-cyan", "aria-hidden": "true" },
                            Native.createElement(Baby, { className: "h-4 w-4" })),
                        Native.createElement("h3", { className: "font-semibold" }, "Identitas dan Kelahiran")),
                    Native.createElement("div", { className: "grid grid-cols-1 gap-4 md:grid-cols-2" },
                        Native.createElement(InputGroup, { label: "Nama Lengkap Balita" },
                            Native.createElement("input", { required: true, type: "text", className: inputClass, value: formData.nama, onChange: (event) => setFormData({ ...formData, nama: formatChildName(event.target.value) }) })),
                        Native.createElement("div", { className: "grid grid-cols-2 gap-4" },
                            Native.createElement(InputGroup, { label: "Anak Ke-" },
                                Native.createElement("input", { required: true, min: "1", type: "number", className: inputClass, value: formData.anakKe, onChange: (event) => setFormData({ ...formData, anakKe: event.target.value }) })),
                            Native.createElement(InputGroup, { label: "Jenis Kelamin" },
                                Native.createElement(Select, { required: true, value: formData.jk, onChange: (event) => setFormData({ ...formData, jk: event.target.value }), options: genderOptions }))),
                        Native.createElement(InputGroup, { label: "Tanggal Lahir" },
                            Native.createElement("input", { required: true, type: "date", className: `${inputClass} min-h-12 text-base`, value: formData.tglLahir, onChange: (event) => {
                                    const tglLahir = event.target.value;
                                    setFormData((previous) => ({ ...previous, tglLahir, nik: previous.hasNIK ? previous.nik : generateTemporaryNik({ ...previous, tglLahir }, allChildren) }));
                                } })),
                        Native.createElement(InputGroup, { label: "Usia Kehamilan (Minggu)" },
                            Native.createElement("input", { required: true, min: "1", type: "number", className: inputClass, value: formData.usiaKehamilan, onChange: (event) => setFormData({ ...formData, usiaKehamilan: event.target.value }) })),
                        Native.createElement("div", { className: "space-y-2" },
                            Native.createElement("div", { className: "flex items-center justify-between gap-3" },
                                Native.createElement("label", { className: "text-xs font-bold uppercase text-slate-500" }, "No. KK"),
                                Native.createElement("label", { className: "ios-form-switch text-xs font-medium text-emerald-700" },
                                    Native.createElement("input", { type: "checkbox", className: "ios-form-switch-input", checked: !formData.hasKK, onChange: (event) => {
                                            const hasKK = !event.target.checked;
                                            setFormData((previous) => ({ ...previous, hasKK, noKK: hasKK ? '' : generateTemporaryKk() }));
                                        } }),
                                    Native.createElement("span", { className: "ios-form-switch-track", "aria-hidden": "true" }),
                                    Native.createElement("span", null, "Tidak punya KK"))),
                            Native.createElement("input", { required: formData.hasKK, readOnly: !formData.hasKK, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "No. KK harus 16 digit", type: "text", className: `${inputClass} font-mono ${!formData.hasKK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`, value: formData.noKK, onChange: (event) => setFormData({ ...formData, noKK: event.target.value.replace(/\D/g, '') }) })),
                        Native.createElement("div", { className: "space-y-2" },
                            Native.createElement("div", { className: "flex items-center justify-between gap-3" },
                                Native.createElement("label", { className: "text-xs font-bold uppercase text-slate-500" }, "NIK Balita"),
                                Native.createElement("label", { className: "ios-form-switch text-xs font-medium text-emerald-700" },
                                    Native.createElement("input", { type: "checkbox", className: "ios-form-switch-input", checked: !formData.hasNIK, onChange: (event) => {
                                            const hasNIK = !event.target.checked;
                                            setFormData((previous) => ({ ...previous, hasNIK, nik: hasNIK ? '' : generateTemporaryNik(previous, allChildren) }));
                                        } }),
                                    Native.createElement("span", { className: "ios-form-switch-track", "aria-hidden": "true" }),
                                    Native.createElement("span", null, "Tidak punya NIK"))),
                            Native.createElement("input", { required: formData.hasNIK, readOnly: !formData.hasNIK, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "NIK balita harus 16 digit", type: "text", className: `${inputClass} font-mono ${!formData.hasNIK ? 'bg-slate-200 text-rose-700' : 'bg-white'}`, value: formData.nik, onChange: (event) => setFormData({ ...formData, nik: event.target.value.replace(/\D/g, '') }) })),
                        Native.createElement(InputGroup, { label: "Berat Lahir (kg)" },
                            Native.createElement("input", { required: true, min: "0.1", max: "10", type: "number", step: "0.01", placeholder: "Contoh: 3.20", title: "Masukkan kilogram, misalnya 3.2. Jangan masukkan 3200 gram.", className: inputClass, value: formData.bbLahir, onInvalid: (event) => event.currentTarget.setCustomValidity('Masukkan berat lahir dalam kilogram, misalnya 3.2. Jangan masukkan 3200 gram.'), onInput: (event) => event.currentTarget.setCustomValidity(''), onChange: (event) => setFormData({ ...formData, bbLahir: event.target.value }) })),
                        Native.createElement(InputGroup, { label: "Panjang Lahir (cm)" },
                            Native.createElement("input", { required: true, min: "0.1", type: "number", step: "0.1", className: inputClass, value: formData.pbLahir, onChange: (event) => setFormData({ ...formData, pbLahir: event.target.value }) })),
                        Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                            Native.createElement("input", { required: true, min: "0.1", type: "number", step: "0.1", className: inputClass, value: formData.lkLahir, onChange: (event) => setFormData({ ...formData, lkLahir: event.target.value }) })),
                        Native.createElement(InputGroup, { label: "Buku KIA" },
                            Native.createElement(Select, { required: true, value: formData.bukuKIA, onChange: (event) => setFormData({ ...formData, bukuKIA: event.target.value }), options: yesNoOptions })),
                        Native.createElement(InputGroup, { label: "Buku KIA Kecil" },
                            Native.createElement(Select, { required: true, value: formData.bukuKIAKecil, onChange: (event) => setFormData({ ...formData, bukuKIAKecil: event.target.value }), options: yesNoOptions })),
                        Native.createElement(InputGroup, { label: "IMD" },
                            Native.createElement(Select, { required: true, value: formData.imd, onChange: (event) => setFormData({ ...formData, imd: event.target.value }), options: yesNoOptions })))),
                Native.createElement("section", { className: "border-t border-slate-200 pt-6 space-y-4" },
                    Native.createElement("div", { className: "ios-form-section-header text-slate-800" },
                        Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-purple", "aria-hidden": "true" },
                            Native.createElement(UserRound, { className: "h-4 w-4" })),
                        Native.createElement("h3", { className: "font-semibold" }, "Data Orang Tua")),
                    Native.createElement("div", { className: "grid grid-cols-1 gap-4 md:grid-cols-2" },
                        Native.createElement(InputGroup, { label: "Nama Orang Tua" },
                            Native.createElement("input", { required: true, type: "text", className: inputClass, value: formData.namaOrtu, onChange: (event) => setFormData({ ...formData, namaOrtu: event.target.value }) })),
                        Native.createElement(InputGroup, { label: "NIK Orang Tua" },
                            Native.createElement("input", { required: true, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "NIK orang tua harus 16 digit", type: "text", className: `${inputClass} font-mono`, value: formData.nikOrtu, onChange: (event) => setFormData({ ...formData, nikOrtu: event.target.value.replace(/\D/g, '') }) }))),
                    Native.createElement(InputGroup, { label: "Alamat Lengkap" },
                        Native.createElement("textarea", { required: true, rows: 2, className: inputClass, value: formData.alamat, onChange: (event) => setFormData({ ...formData, alamat: event.target.value }) })),
                    Native.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-3" },
                        Native.createElement(InputGroup, { label: "No. HP" },
                            Native.createElement("input", { required: true, inputMode: "tel", pattern: "[0-9]{8,15}", maxLength: 15, title: "No. HP harus 8 sampai 15 digit", type: "text", className: inputClass, value: formData.noHpOrtu, onChange: (event) => setFormData({ ...formData, noHpOrtu: event.target.value.replace(/\D/g, '') }) })),
                        Native.createElement(InputGroup, { label: "RT" },
                            Native.createElement("input", { required: true, inputMode: "numeric", type: "text", className: inputClass, value: formData.rt, onChange: (event) => setFormData({ ...formData, rt: event.target.value.replace(/\D/g, '') }) })),
                        Native.createElement(InputGroup, { label: "RW" },
                            Native.createElement("input", { required: true, inputMode: "numeric", type: "text", className: inputClass, value: formData.rw, onChange: (event) => setFormData({ ...formData, rw: event.target.value.replace(/\D/g, '') }) })))),
                errorMessage && Native.createElement("p", { role: "alert", className: "ios-inline-notification ios-inline-notification-error" }, errorMessage),
                Native.createElement("div", { className: "flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-end" },
                    Native.createElement(Button, { variant: "secondary", type: "button", onClick: onBack, className: "w-full sm:w-auto" },
                        Native.createElement(XCircle, { className: "h-4 w-4" }),
                        " Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: saving, className: "w-full sm:w-auto" },
                        Native.createElement(CheckCircle2, { className: "h-4 w-4" }),
                        saving ? ' Menyimpan...' : ' Simpan Data Balita'))))));
}
