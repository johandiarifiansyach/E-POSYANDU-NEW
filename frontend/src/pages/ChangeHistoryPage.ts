// @ts-nocheck
import Native from '../runtime/dom';
import { History } from '../ui/icons';
import { Card, formatIndoDateTime } from './DashboardApp';

const FIELD_LABELS = {
    nama: 'Nama lengkap',
    nik: 'NIK balita',
    anakKe: 'Anak ke-',
    tglLahir: 'Tanggal lahir',
    jk: 'Jenis kelamin',
    noKK: 'Nomor KK',
    hasKK: 'Kepemilikan KK',
    hasNIK: 'Kepemilikan NIK',
    usiaKehamilan: 'Usia kehamilan',
    bbLahir: 'Berat lahir',
    pbLahir: 'Panjang lahir',
    lkLahir: 'Lingkar kepala lahir',
    bukuKIA: 'Buku KIA',
    bukuKIAKecil: 'Buku KIA kecil',
    imd: 'IMD',
    namaOrtu: 'Nama orang tua',
    nikOrtu: 'NIK orang tua',
    noHpOrtu: 'Nomor HP orang tua',
    alamat: 'Alamat',
    rt: 'RT',
    rw: 'RW',
    desa: 'Desa / kelurahan',
    posyandu: 'Posyandu'
};

const fieldLabel = (field) => FIELD_LABELS[field] || String(field || 'Data identitas');
const changeValue = (field, value) => {
    if (value === null || value === undefined || value === '')
        return 'Kosong';
    if (typeof value === 'boolean')
        return value ? 'Ya' : 'Tidak';
    if (field === 'jk')
        return value === 'L' ? 'Laki-laki' : value === 'P' ? 'Perempuan' : String(value);
    if (Array.isArray(value))
        return value.length > 0 ? value.join(', ') : 'Kosong';
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
};

export default function ChangeHistoryPage({ changeLogs }) {
    const timestampValue = (value) => {
        if (!value)
            return 0;
        if (typeof value.toDate === 'function')
            return value.toDate().getTime();
        if (typeof value.seconds === 'number')
            return value.seconds * 1000;
        const parsed = new Date(value).getTime();
        return Number.isNaN(parsed) ? 0 : parsed;
    };
    const sortedChangeLogs = [...changeLogs].sort((left, right) => {
        const timeDifference = timestampValue(right.timestamp) - timestampValue(left.timestamp);
        return timeDifference || String(right.id || '').localeCompare(String(left.id || ''));
    });
    return (Native.createElement("div", { className: "apple-page space-y-6" },
        Native.createElement("div", null,
            Native.createElement("h2", { className: "text-2xl font-bold text-slate-800" }, "Riwayat Perubahan Identitas"),
            Native.createElement("p", { className: "text-slate-500 text-sm" }, "Mencatat semua perubahan data identitas balita yang dilakukan oleh petugas.")),
        Native.createElement("div", { className: "space-y-4" }, sortedChangeLogs.length === 0 ? (Native.createElement("div", { className: "app-card p-8 text-center text-slate-400 rounded-2xl border border-dashed border-slate-300" }, "Belum ada riwayat perubahan data.")) : (sortedChangeLogs.map((log) => {
            const changes = Array.isArray(log.changes) ? log.changes : [];
            return Native.createElement(Card, { key: log.id, className: "apple-list-card p-4" },
            Native.createElement("div", { className: "flex justify-between items-start mb-2" },
                Native.createElement("div", null,
                    Native.createElement("h4", { className: "font-bold text-slate-800" }, log.childName),
                    Native.createElement("p", { className: "text-xs text-slate-500" },
                        formatIndoDateTime(log.timestamp),
                        " - Oleh: ",
                        log.changedBy)),
                Native.createElement(History, { className: "w-5 h-5 text-amber-500" })),
            Native.createElement("div", { className: "bg-slate-50 rounded-lg p-3 space-y-2 text-xs" }, changes.length === 0 ? (Native.createElement("p", { className: "change-history-empty-detail text-slate-500" }, "Pembaruan identitas tercatat, tetapi rincian perubahan tidak tersedia pada catatan lama.")) : changes.map((change, index) => (Native.createElement("div", { key: index, className: "flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center border-b border-slate-200 last:border-0 pb-1 last:pb-0" },
                Native.createElement("span", { className: "font-semibold text-slate-600 w-36" }, fieldLabel(change.field)),
                Native.createElement("div", { className: "flex items-center gap-2 flex-1 min-w-0" },
                    Native.createElement("span", { className: "text-rose-500 line-through bg-rose-50 px-1 rounded break-words" }, changeValue(change.field, change.oldValue)),
                    Native.createElement("span", { className: "text-slate-400" }, "->"),
                    Native.createElement("span", { className: "text-emerald-600 font-bold bg-emerald-50 px-1 rounded break-words" }, changeValue(change.field, change.newValue))))))));
        })))));
}
