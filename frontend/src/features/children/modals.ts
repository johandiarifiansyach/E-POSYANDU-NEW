// @ts-nocheck
import * as Context from '../../shared/dashboardContext';
import { errorMessage, type PageState } from '../../shared/pageState';

const {
    Native, useState, useEffect, useMemo, useRef, collection, addDoc,
    serverTimestamp, updateDoc, doc, db, appId, formatDate, formatChildName,
    generateRandomDigits, normalizeDecimalInput, parseLocaleNumber,
    parseLocaleNumberForRange, showSuccess, Button, InputGroup, Select,
    syncPendingMutations, DATA_WILAYAH, ROLES, Baby, X, AlertTriangle
} = Context;

export const DeleteChildModal = ({ child, onClose, onConfirm }) => {
    const [reason, setReason] = useState('Salah Input');
    const [deathDate, setDeathDate] = useState('');
    const [deathCause, setDeathCause] = useState('');
    const [deathLocation, setDeathLocation] = useState('');
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const loading = saveState.status === 'loading';
    const saveError = saveState.status === 'error' ? saveState.message : null;
    const handleSubmit = async (e) => {
        e.preventDefault();
        setSaveState({ status: 'loading' });
        try {
            const deleteData = { deleteReason: reason, ...(reason === 'Meninggal Dunia' && { deathDate, deathCause, deathLocation }) };
            if (!child.id)
                throw new Error('Data balita tidak ditemukan.');
            await onConfirm(child.id, deleteData);
            setSaveState({ status: 'success', data: undefined });
        }
        catch (error) {
            console.error(error);
            setSaveState({ status: 'error', message: errorMessage(error, 'Data balita gagal dihapus.') });
        }
    };
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700", role: "alert" }, saveError),
                Native.createElement("div", { className: "pt-4 flex gap-3" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "flex-1" }, "Batal"),
                    Native.createElement(Button, { variant: "dangerFilled", type: "submit", disabled: loading, className: "flex-1" }, loading ? 'Memproses...' : 'Konfirmasi Hapus'))))));
};
export const LegacyAddChildModal = ({ user, onClose, onSuccess, initialData = null, isEdit = false, allChildren = [] }) => {
    const [formData, setFormData] = useState({ nama: '', nik: '', anakKe: '', tglLahir: '', jk: 'L', noKK: '', hasKK: true, hasNIK: true, usiaKehamilan: '', bbLahir: '', pbLahir: '', lkLahir: '', bukuKIA: 'Ya', bukuKIAKecil: 'Tidak', imd: 'Ya', namaOrtu: '', nikOrtu: '', noHpOrtu: '', alamat: '', rt: '', rw: '', desa: user.role === ROLES.KADER || user.role === ROLES.BIDAN ? (user.desa || Object.keys(DATA_WILAYAH)[0]) : Object.keys(DATA_WILAYAH)[0], posyandu: user.role === ROLES.KADER ? (user.posyandu || DATA_WILAYAH[Object.keys(DATA_WILAYAH)[0]][0]) : DATA_WILAYAH[user.role === ROLES.BIDAN ? (user.desa || Object.keys(DATA_WILAYAH)[0]) : Object.keys(DATA_WILAYAH)[0]][0] });
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const loading = saveState.status === 'loading';
    const saveError = saveState.status === 'error' ? saveState.message : null;
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
        setSaveState({ status: 'loading' });
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
            setSaveState({ status: 'success', data: undefined });
            showSuccess(isEdit ? 'Data balita berhasil diperbarui.' : 'Data balita berhasil ditambahkan.');
            onSuccess();
            onClose();
        }
        catch (error) {
            console.error(error);
            setSaveState({ status: 'error', message: errorMessage(error, 'Data balita gagal disimpan.') });
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700", role: "alert" }, saveError),
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
export const AddChildModal = ({ user, onClose, onSuccess, initialData = null, isEdit = false, allChildren = [] }) => {
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
    const [saveState, setSaveState] = useState<PageState<void>>({ status: 'idle' });
    const loading = saveState.status === 'loading';
    const saveError = saveState.status === 'error' ? saveState.message : null;
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
        setSaveState({ status: 'loading' });
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
            setSaveState({ status: 'success', data: undefined });
            showSuccess(isEdit ? 'Data balita berhasil diperbarui.' : 'Data balita berhasil ditambahkan.');
            onSuccess();
            onClose();
        }
        catch (error) {
            console.error(error);
            setSaveState({ status: 'error', message: errorMessage(error, 'Data balita gagal disimpan.') });
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
                saveError && Native.createElement("div", { className: "rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700", role: "alert" }, saveError),
                Native.createElement("div", { className: "identity-modal-actions ios-modal-actions" },
                    Native.createElement(Button, { variant: "secondary", onClick: onClose, className: "ios-modal-secondary w-full md:w-auto" }, "Batal"),
                    Native.createElement(Button, { variant: "primary", type: "submit", disabled: loading, className: "ios-modal-primary w-full md:w-auto" }, loading ? 'Menyimpan...' : isEdit ? 'Perbarui Data' : 'Simpan Data'))))));
};
