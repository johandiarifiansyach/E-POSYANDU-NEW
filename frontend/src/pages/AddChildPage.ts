// @ts-nocheck
import { addDoc, collection, serverTimestamp, syncPendingMutations } from '../api/syncApi';
import Native, { useState } from '../runtime/dom';
import { Baby, CheckCircle2, ChevronLeft, MapPin, UserPlus, UserRound, XCircle } from '../ui/icons';
import { showSuccess } from '../ui/notifications';
import { Button, Select } from '../components';
import { Card, InputGroup } from '../ui/dashboardPrimitives';
import {
    CHILD_BIRTH_DECIMAL_RULES,
    createInitialChildForm,
    formatChildName,
    generateTemporaryKk,
    generateTemporaryNik,
    normalizeChildInput,
    parseChildDecimalForRange,
    validateChildBirthMeasurements
} from '../features/children/childRules';
import { appId, DATA_WILAYAH, db, ROLES } from './DashboardApp';
import type { PageState } from '../shared/pageState';
const inputClass = 'block w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-900 transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100';
export default function AddChildPage({ allChildren, onBack, onSuccess, user }) {
    const [formData, setFormData] = useState(() => createInitialChildForm(user));
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const saving = saveState.status === 'loading';
    const errorMessage = saveState.status === 'error' ? saveState.message : null;
    const setFormError = (message) => setSaveState(message ? { status: 'error', message } : { status: 'idle' });
    const handleDecimalFieldChange = (field) => (event) => {
        const normalized = normalizeChildInput(event.target.value);
        setFormData((previous) => ({ ...previous, [field]: normalized }));
    };
    const handleDecimalFieldBlur = (field) => () => {
        setFormData((previous) => {
            const value = String(previous[field] ?? '');
            const rule = CHILD_BIRTH_DECIMAL_RULES[field];
            if (rule) {
                const parsed = parseChildDecimalForRange(value, rule.minimum, rule.maximum, rule.shift);
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
        setFormError(null);
        const formElement = event.currentTarget;
        const readLiveField = (field, fallback) => {
            const input = formElement?.querySelector?.(`[name="${field}"]`);
            const liveValue = typeof input?.value === 'string' ? input.value : '';
            return liveValue || String(fallback ?? '');
        };
        const birthValidation = validateChildBirthMeasurements({
            bbLahir: readLiveField('bbLahir', formData.bbLahir),
            pbLahir: readLiveField('pbLahir', formData.pbLahir),
            lkLahir: readLiveField('lkLahir', formData.lkLahir)
        });
        if (!birthValidation.ok) {
            setFormError(birthValidation.message);
            return;
        }
        const { bbLahir: birthWeight, pbLahir: birthLength, lkLahir: birthHeadCircumference } = birthValidation.data;
        const submissionData = {
            ...formData,
            nama: formatChildName(formData.nama),
            bbLahir: birthWeight ?? '',
            pbLahir: birthLength ?? '',
            lkLahir: birthHeadCircumference ?? '',
            noKK: formData.hasKK || /^\d{16}$/.test(formData.noKK) ? formData.noKK : generateTemporaryKk(),
            nik: formData.hasNIK || /^\d{16}$/.test(formData.nik) ? formData.nik : generateTemporaryNik(formData, allChildren)
        };
        if (!/^\d{16}$/.test(submissionData.noKK)) {
            setFormError('No. KK harus berisi 16 digit. Centang Tidak punya KK untuk membuat nomor sementara.');
            return;
        }
        if (!/^\d{16}$/.test(submissionData.nik)) {
            setFormError('NIK balita harus berisi 16 digit. Centang Tidak punya NIK untuk membuat nomor sementara.');
            return;
        }
        setFormData(submissionData);
        setSaveState({ status: 'loading' });
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
            const birthMeasurementRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
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
            await syncPendingMutations([newChildRef.mutationId, birthMeasurementRef.mutationId]);
            setSaveState({ status: 'success', data: undefined });
            showSuccess('Data balita berhasil ditambahkan.');
            onSuccess();
        }
        catch (error) {
            console.error('Gagal menyimpan balita:', error);
            setFormError(error instanceof Error ? error.message : 'Data balita belum dapat disimpan.');
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
                            Native.createElement("input", { name: "nama", required: true, type: "text", className: inputClass, value: formData.nama, onChange: (event) => setFormData((previous) => ({ ...previous, nama: formatChildName(event.target.value) })) })),
                        Native.createElement("div", { className: "grid grid-cols-2 gap-4" },
                            Native.createElement(InputGroup, { label: "Anak Ke-" },
                                Native.createElement("input", { name: "anakKe", required: true, type: "text", inputMode: "numeric", className: inputClass, value: formData.anakKe, onChange: handleDecimalFieldChange('anakKe'), onBlur: handleDecimalFieldBlur('anakKe') })),
                            Native.createElement(InputGroup, { label: "Jenis Kelamin" },
                                Native.createElement(Select, { required: true, value: formData.jk, onChange: (event) => setFormData({ ...formData, jk: event.target.value }), options: genderOptions }))),
                        Native.createElement(InputGroup, { label: "Tanggal Lahir" },
                            Native.createElement("input", { name: "tglLahir", required: true, type: "date", className: `${inputClass} min-h-12 text-base`, value: formData.tglLahir, onChange: (event) => {
                                    const tglLahir = event.target.value;
                                    setFormData((previous) => ({ ...previous, tglLahir, nik: previous.hasNIK ? previous.nik : generateTemporaryNik({ ...previous, tglLahir }, allChildren) }));
                                } })),
                        Native.createElement(InputGroup, { label: "Usia Kehamilan (Minggu)" },
                            Native.createElement("input", { name: "usiaKehamilan", required: true, type: "text", inputMode: "numeric", className: inputClass, value: formData.usiaKehamilan, onChange: handleDecimalFieldChange('usiaKehamilan'), onBlur: handleDecimalFieldBlur('usiaKehamilan') })),
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
                            Native.createElement("input", { name: "noKK", required: formData.hasKK, readOnly: !formData.hasKK, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "No. KK harus 16 digit", type: "text", className: `${inputClass} font-mono ${!formData.hasKK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`, value: formData.noKK, onChange: (event) => setFormData((previous) => ({ ...previous, noKK: event.target.value.replace(/\D/g, '') })) })),
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
                            Native.createElement("input", { name: "nik", required: formData.hasNIK, readOnly: !formData.hasNIK, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "NIK balita harus 16 digit", type: "text", className: `${inputClass} font-mono ${!formData.hasNIK ? 'bg-slate-200 text-rose-700' : 'bg-white'}`, value: formData.nik, onChange: (event) => setFormData((previous) => ({ ...previous, nik: event.target.value.replace(/\D/g, '') })) })),
                        Native.createElement(InputGroup, { label: "Berat Lahir (kg)" },
                            Native.createElement("input", { name: "bbLahir", required: true, type: "text", inputMode: "decimal", placeholder: "Contoh: 3.20", title: "Masukkan kilogram, misalnya 3.2. Jangan masukkan 3200 gram.", className: inputClass, value: formData.bbLahir, onInvalid: (event) => event.currentTarget.setCustomValidity('Masukkan berat lahir dalam kilogram, misalnya 3.2. Jangan masukkan 3200 gram.'), onInput: (event) => {
                                    event.currentTarget.setCustomValidity('');
                                    handleDecimalFieldChange('bbLahir')(event);
                                }, onBlur: handleDecimalFieldBlur('bbLahir') })),
                        Native.createElement(InputGroup, { label: "Panjang Lahir (cm)" },
                            Native.createElement("input", { name: "pbLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.pbLahir, onInput: handleDecimalFieldChange('pbLahir'), onBlur: handleDecimalFieldBlur('pbLahir') })),
                        Native.createElement(InputGroup, { label: "Lingkar Kepala (cm)" },
                            Native.createElement("input", { name: "lkLahir", required: true, type: "text", inputMode: "decimal", className: inputClass, value: formData.lkLahir, onInput: handleDecimalFieldChange('lkLahir'), onBlur: handleDecimalFieldBlur('lkLahir') })),
                        Native.createElement(InputGroup, { label: "Buku KIA" },
                            Native.createElement(Select, { required: true, value: formData.bukuKIA, onChange: (event) => setFormData({ ...formData, bukuKIA: event.target.value }), options: yesNoOptions })),
                        Native.createElement(InputGroup, { label: "Buku KIA Kecil" },
                            Native.createElement(Select, { required: true, value: formData.bukuKIAKecil, onChange: (event) => setFormData({ ...formData, bukuKIAKecil: event.target.value }), options: yesNoOptions }),
                            Native.createElement("p", { className: "text-[11px] leading-4 font-semibold italic normal-case text-slate-500" }, "Hanya jawab YA apabila berat bayi lahir di bawah 2.5 Kg (BBLR) dan bayi lahir prematur serta mendapatkan Buku KIA bayi kecil.")),
                        Native.createElement(InputGroup, { label: "IMD" },
                            Native.createElement(Select, { required: true, value: formData.imd, onChange: (event) => setFormData({ ...formData, imd: event.target.value }), options: yesNoOptions })))),
                Native.createElement("section", { className: "border-t border-slate-200 pt-6 space-y-4" },
                    Native.createElement("div", { className: "ios-form-section-header text-slate-800" },
                        Native.createElement("span", { className: "apple-symbol-tile apple-symbol-tile-purple", "aria-hidden": "true" },
                            Native.createElement(UserRound, { className: "h-4 w-4" })),
                        Native.createElement("h3", { className: "font-semibold" }, "Data Orang Tua")),
                    Native.createElement("div", { className: "grid grid-cols-1 gap-4 md:grid-cols-2" },
                        Native.createElement(InputGroup, { label: "Nama Orang Tua" },
                            Native.createElement("input", { name: "namaOrtu", required: true, type: "text", className: inputClass, value: formData.namaOrtu, onChange: (event) => setFormData((previous) => ({ ...previous, namaOrtu: event.target.value })) })),
                        Native.createElement(InputGroup, { label: "NIK Orang Tua" },
                            Native.createElement("input", { name: "nikOrtu", required: true, inputMode: "numeric", pattern: "[0-9]{16}", maxLength: 16, title: "NIK orang tua harus 16 digit", type: "text", className: `${inputClass} font-mono`, value: formData.nikOrtu, onChange: (event) => setFormData((previous) => ({ ...previous, nikOrtu: event.target.value.replace(/\D/g, '') })) }))),
                    Native.createElement(InputGroup, { label: "Alamat Lengkap" },
                        Native.createElement("textarea", { name: "alamat", required: true, rows: 2, className: inputClass, value: formData.alamat, onChange: (event) => setFormData((previous) => ({ ...previous, alamat: event.target.value })) })),
                    Native.createElement("div", { className: "grid grid-cols-1 gap-4 sm:grid-cols-3" },
                        Native.createElement(InputGroup, { label: "No. HP" },
                            Native.createElement("input", { name: "noHpOrtu", required: true, inputMode: "tel", pattern: "[0-9]{8,15}", maxLength: 15, title: "No. HP harus 8 sampai 15 digit", type: "text", className: inputClass, value: formData.noHpOrtu, onChange: (event) => setFormData((previous) => ({ ...previous, noHpOrtu: event.target.value.replace(/\D/g, '') })) })),
                        Native.createElement(InputGroup, { label: "RT" },
                            Native.createElement("input", { name: "rt", required: true, inputMode: "numeric", type: "text", className: inputClass, value: formData.rt, onChange: (event) => setFormData((previous) => ({ ...previous, rt: event.target.value.replace(/\D/g, '') })) })),
                        Native.createElement(InputGroup, { label: "RW" },
                            Native.createElement("input", { name: "rw", required: true, inputMode: "numeric", type: "text", className: inputClass, value: formData.rw, onChange: (event) => setFormData((previous) => ({ ...previous, rw: event.target.value.replace(/\D/g, '') })) })))),
                errorMessage && Native.createElement("p", { role: "alert", className: "ios-inline-notification ios-inline-notification-error" }, errorMessage),
                Native.createElement("div", { className: "flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-end" },
                    Native.createElement(Button, { variant: "secondary", type: "button", onClick: onBack, className: "w-full sm:w-auto" },
                        Native.createElement(XCircle, { className: "h-4 w-4" }),
                        " Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: saving, className: "w-full sm:w-auto" },
                        Native.createElement(CheckCircle2, { className: "h-4 w-4" }),
                        saving ? ' Menyimpan...' : ' Simpan Data Balita'))))));
}
