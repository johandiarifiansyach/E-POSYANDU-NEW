import { useState } from 'react';
import { addDoc, collection, serverTimestamp, syncPendingMutations } from '../../api/syncApi';
import { appId, db } from '../../app/session';
import { formatDate } from '../../shared/formatters';
import { errorMessage } from '../../shared/pageState';
import { AppButton, AppSelect, Card, InputGroup } from '../../components/base';
import { ClipboardCheck, Utensils, X } from '../../ui/icons';
import { showSuccess } from '../../ui/notifications';

type Child = Record<string, any>;
type Form = { tglMonitoring: string; asi: string; makananPokok: boolean; kacang: boolean; susu: boolean; daging: boolean; telur: boolean; sayurVitA: boolean; sayurLain: boolean; intervensiGizi: string };
export type MpasiModalProps = { child: Child; onClose: () => void; onSaved?: () => void };

const yesNo = [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }];
const foodItems: Array<[keyof Form, string, string]> = [
  ['makananPokok', 'Makanan Pokok', 'Nasi, mie, jagung, roti, kentang, dan ubi'],
  ['kacang', 'Kacang-kacangan', 'Tempe, tahu, kacang hijau, tanah, dan kedelai'],
  ['susu', 'Produk Susu Hewani', 'Susu, formula, yoghurt, dan keju'],
  ['daging', 'Daging-dagingan', 'Ayam, ikan, daging merah, hati, dan seafood'],
  ['telur', 'Telur', 'Telur ayam, puyuh, dan bebek'],
  ['sayurVitA', 'Buah dan Sayur Kaya Vit A', 'Pepaya, mangga, wortel, bayam, katuk, dan kelor'],
  ['sayurLain', 'Buah dan Sayur Lainnya', 'Pisang, jeruk, semangka, buncis, dan terong']
];

export default function MpasiModal({ child, onClose, onSaved }: MpasiModalProps) {
  const [form, setForm] = useState<Form>({ tglMonitoring: formatDate(new Date()), asi: 'Ya', makananPokok: false, kacang: false, susu: false, daging: false, telur: false, sayurVitA: false, sayurLain: false, intervensiGizi: 'Tidak' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'mpasi_logs'), { childId: child.id, childName: child.nama, tglMonitoring: form.tglMonitoring, asi: form.asi, makananPokok: form.makananPokok ? ['Ya'] : [], kacang: form.kacang ? ['Ya'] : [], susu: form.susu ? ['Ya'] : [], daging: form.daging ? ['Ya'] : [], telur: form.telur ? ['Ya'] : [], sayurVitA: form.sayurVitA ? ['Ya'] : [], sayurLain: form.sayurLain ? ['Ya'] : [], intervensiGizi: form.intervensiGizi, createdAt: serverTimestamp() });
      await syncPendingMutations(); showSuccess('Data MPASI berhasil disimpan.'); onSaved?.(); onClose();
    } catch (cause) { setError(errorMessage(cause, 'Data MPASI gagal disimpan.')); } finally { setSaving(false); }
  };
  return <div className="ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <Card className="ios-liquid-modal ios-mpasi-modal max-h-[90vh] w-full max-w-3xl overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="react-mpasi-modal-title">
      <header className="ios-modal-header flex items-start justify-between"><div className="flex items-center gap-3"><span className="apple-symbol-tile apple-symbol-tile-orange"><Utensils /></span><div><h2 id="react-mpasi-modal-title" className="text-lg font-bold">Pemantauan MPASI</h2><p className="text-sm text-slate-500">{String(child.nama || 'Balita')} · usia 6–23 bulan</p></div></div><button type="button" className="ios-modal-close" onClick={onClose} aria-label="Tutup pemantauan MPASI"><X /></button></header>
      <form onSubmit={submit} className="ios-modal-body ios-mpasi-form space-y-4"><div className="ios-modal-context"><span>Catatan konsumsi</span><strong>MPASI 6–23 bulan</strong></div><InputGroup label="Tanggal Monitoring"><input type="date" required className="ios-liquid-control w-full rounded-xl p-2.5" value={form.tglMonitoring} onChange={(event) => update('tglMonitoring', event.target.value)} /></InputGroup><div className="grid gap-4 sm:grid-cols-2"><InputGroup label="Masih Diberi ASI?"><AppSelect value={form.asi} options={yesNo} onChange={(event) => update('asi', event.target.value)} /></InputGroup><InputGroup label="Intervensi Gizi (MT/Formula)?"><AppSelect value={form.intervensiGizi} options={yesNo} onChange={(event) => update('intervensiGizi', event.target.value)} /></InputGroup></div><fieldset className="ios-mpasi-food-fieldset"><legend>Komposisi makanan yang dikonsumsi</legend><div className="grid gap-3 sm:grid-cols-2">{foodItems.map(([key, label, description]) => { const checked = Boolean(form[key]); return <button key={String(key)} type="button" className={`ios-mpasi-food-toggle ${checked ? 'is-checked' : ''}`} aria-pressed={checked} onClick={() => update(key, !checked)}><span className="ios-mpasi-check" aria-hidden="true">{checked ? <ClipboardCheck /> : null}</span><span className="min-w-0 text-left"><strong>{label}</strong><small>{description}</small></span></button>; })}</div></fieldset>{error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}<div className="ios-modal-actions flex gap-3"><AppButton type="button" variant="secondary" onClick={onClose} className="flex-1">Batal</AppButton><AppButton type="submit" disabled={saving} className="flex-1">{saving ? 'Menyimpan…' : 'Simpan Data MPASI'}</AppButton></div></form>
    </Card>
  </div>;
}
