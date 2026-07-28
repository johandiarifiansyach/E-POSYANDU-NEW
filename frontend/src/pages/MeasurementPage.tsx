import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Plus } from 'lucide-react';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where
} from '../lib/supabase-compat';
import {
  appId,
  Button,
  calculateGiziStatus,
  Card,
  ChildData,
  db,
  formatDate,
  formatIndoDate,
  getAgeInMonths,
  getKBM,
  InputGroup,
  KenaikanBadge,
  MeasurementData,
  Select,
  StatusBadge
} from './LegacyApp';

type MeasurementFormData = Omit<
  MeasurementData,
  'id' | 'childId' | 'childName' | 'posyandu' | 'desa' | 'ageInMonths'
>;

type MeasurementPageProps = {
  child: ChildData;
  onBack: () => void;
};

const inputClass =
  'w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors';

export default function MeasurementPage({ child, onBack }: MeasurementPageProps) {
  const [activeMenu, setActiveMenu] = useState<'history' | 'add'>('history');
  const [formData, setFormData] = useState<MeasurementFormData>({
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
  const [history, setHistory] = useState<MeasurementData[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const refreshHistory = useCallback(async () => {
    try {
      if (!child.id) return;
      setLoadingHistory(true);
      const historyQuery = query(
        collection(db, 'artifacts', appId, 'public', 'data', 'measurements'),
        where('childId', '==', child.id)
      );
      const snapshot = await getDocs(historyQuery);
      const data = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as MeasurementData));
      data.sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
      setHistory(data);
    } catch (error) {
      console.error('Error fetching history:', error);
    } finally {
      setLoadingHistory(false);
    }
  }, [child.id]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!formData.bb || !formData.tglUkur) return;

    const currentWeight = parseFloat(String(formData.bb));
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

    const previousWeight = parseFloat(String(previousMeasurement.bb));
    const gain = (currentWeight - previousWeight) * 1000;
    const measureAgeInMonths = getAgeInMonths(child.tglLahir, currentDate);
    const minGain = getKBM(measureAgeInMonths);
    const newStatus: 'N' | 'T' = gain >= minGain ? 'N' : 'T';
    setFormData((previous) => ({ ...previous, statusNaik: newStatus }));
  }, [formData.bb, formData.tglUkur, history, child.tglLahir]);

  const measureDate = useMemo(() => new Date(formData.tglUkur), [formData.tglUkur]);
  const ageAtMeasure = useMemo(() => getAgeInMonths(child.tglLahir, measureDate), [child.tglLahir, measureDate]);
  const lengthHeightLabel = ageAtMeasure <= 24 ? 'Panjang Badan (cm)' : 'Tinggi Badan (cm)';
  const lengthHeightStatusLabel = ageAtMeasure <= 24 ? 'Status PB/U' : 'Status TB/U';
  const weightLengthHeightStatusLabel = ageAtMeasure <= 24 ? 'Status BB/PB' : 'Status BB/TB';

  const statusSummary = useMemo(
    () => ({
      bbu: calculateGiziStatus(formData.bb, 'BBU', ageAtMeasure, child.jk),
      tbu: calculateGiziStatus(formData.tb, 'TBU', ageAtMeasure, child.jk, null, formData.caraUkur),
      bbtb: calculateGiziStatus(formData.bb, 'BBTB', ageAtMeasure, child.jk, formData.tb, formData.caraUkur),
      imtu: calculateGiziStatus(formData.bb, 'IMTU', ageAtMeasure, child.jk, formData.tb, formData.caraUkur)
    }),
    [ageAtMeasure, child.jk, formData.bb, formData.caraUkur, formData.tb]
  );

  const monthlyHistory = useMemo(() => {
    const monthlyMap = new Map<string, MeasurementData>();

    history.forEach((item) => {
      if (!item.tglUkur) return;
      const monthKey = item.tglUkur.slice(0, 7);
      const existing = monthlyMap.get(monthKey);
      if (!existing || new Date(item.tglUkur).getTime() > new Date(existing.tglUkur).getTime()) {
        monthlyMap.set(monthKey, item);
      }
    });

    return Array.from(monthlyMap.values()).sort(
      (a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime()
    );
  }, [history]);

  useEffect(() => {
    if (activeMenu !== 'add') return;
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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!child.id) return;

    setLoading(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
        childId: child.id,
        childName: child.nama,
        posyandu: child.posyandu,
        desa: child.desa,
        ...formData,
        ageInMonths: ageAtMeasure,
        createdAt: serverTimestamp()
      });

      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id), {
        currentBB: formData.bb,
        currentTB: formData.tb,
        currentLILA: formData.lila,
        currentLK: formData.lk,
        lastMeasurementDate: formData.tglUkur,
        updatedAt: serverTimestamp()
      });

      await refreshHistory();
      setActiveMenu('history');
    } catch (error: any) {
      console.error('Gagal simpan: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const showVitA = measureDate.getMonth() + 1 === 2 || measureDate.getMonth() + 1 === 8;
  const showAsi = ageAtMeasure >= 0 && ageAtMeasure <= 6;

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <Button type="button" variant="secondary" onClick={onBack} className="mb-4">
            <ArrowLeft className="w-4 h-4" /> Kembali
          </Button>
          <h2 className="text-2xl font-bold text-slate-800">Pengukuran Balita</h2>
          <p className="text-slate-500 text-sm">
            {child.nama} - {getAgeInMonths(child.tglLahir)} Bulan - {child.desa} / {child.posyandu}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={activeMenu === 'history' ? 'primary' : 'secondary'}
            className={activeMenu === 'history' ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
            onClick={() => setActiveMenu('history')}
          >
            Riwayat Penimbangan
          </Button>
          <Button type="button" variant={activeMenu === 'add' ? 'primary' : 'secondary'} onClick={handleStartAdd}>
            <Plus className="w-4 h-4" /> Tambah Pengukuran
          </Button>
        </div>
      </div>

      {activeMenu === 'history' ? (
        <Card className="p-4 overflow-hidden">
          <h3 className="text-sm font-bold text-slate-700 mb-3">Riwayat Penimbangan Bulan ke Bulan</h3>
          {loadingHistory ? (
            <div className="py-12 text-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />Memuat riwayat...
            </div>
          ) : monthlyHistory.length === 0 ? (
            <p className="text-xs text-slate-500">Belum ada riwayat pengukuran.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-200">
                    <th className="text-left py-2 pr-4">Bulan</th>
                    <th className="text-left py-2 pr-4">Tanggal Ukur</th>
                    <th className="text-center py-2 px-2">BB</th>
                    <th className="text-center py-2 px-2">PB/TB</th>
                    <th className="text-center py-2 px-2">LILA</th>
                    <th className="text-center py-2 px-2">LK</th>
                    <th className="text-center py-2 px-2">Status BB/U</th>
                    <th className="text-center py-2 px-2">Status PB/TB-U</th>
                    <th className="text-center py-2 px-2">Status BB/PB atau BB/TB</th>
                    <th className="text-center py-2 px-2">Status IMT/U</th>
                    <th className="text-center py-2 pl-2">Naik BB</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyHistory.map((item) => {
                    const monthLabel = new Date(item.tglUkur).toLocaleDateString('id-ID', {
                      month: 'short',
                      year: 'numeric'
                    });
                    const ageAtHistory = getAgeInMonths(child.tglLahir, new Date(item.tglUkur));
                    const statusBbu = calculateGiziStatus(item.bb, 'BBU', ageAtHistory, child.jk);
                    const statusTbu = calculateGiziStatus(item.tb, 'TBU', ageAtHistory, child.jk, null, item.caraUkur);
                    const statusBbtb = calculateGiziStatus(item.bb, 'BBTB', ageAtHistory, child.jk, item.tb, item.caraUkur);
                    const statusImtu = calculateGiziStatus(item.bb, 'IMTU', ageAtHistory, child.jk, item.tb, item.caraUkur);

                    return (
                      <tr key={item.id || item.tglUkur} className="border-b border-slate-100 last:border-0 text-slate-700">
                        <td className="py-2 pr-4 font-semibold uppercase whitespace-nowrap">{monthLabel}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIndoDate(item.tglUkur)}</td>
                        <td className="py-2 px-2 text-center">{item.bb || '-'}</td>
                        <td className="py-2 px-2 text-center">{item.tb || '-'}</td>
                        <td className="py-2 px-2 text-center">{item.lila || '-'}</td>
                        <td className="py-2 px-2 text-center">{item.lk || '-'}</td>
                        <td className="py-2 px-2 text-center"><StatusBadge status={statusBbu} /></td>
                        <td className="py-2 px-2 text-center"><StatusBadge status={statusTbu} /></td>
                        <td className="py-2 px-2 text-center"><StatusBadge status={statusBbtb} /></td>
                        <td className="py-2 px-2 text-center"><StatusBadge status={statusImtu} /></td>
                        <td className="py-2 pl-2 text-center"><KenaikanBadge status={item.statusNaik} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <InputGroup label="Tanggal Pengukuran">
                <input
                  required
                  type="date"
                  className={inputClass}
                  value={formData.tglUkur}
                  onChange={(event) => setFormData({ ...formData, tglUkur: event.target.value })}
                />
              </InputGroup>

              <InputGroup label="Cara Ukur">
                <input
                  type="text"
                  readOnly
                  className={`${inputClass} bg-slate-100 text-slate-500`}
                  value={formData.caraUkur}
                />
              </InputGroup>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <InputGroup label="Berat Badan (kg)">
                <input
                  required
                  type="number"
                  step="0.01"
                  className={inputClass}
                  value={formData.bb}
                  onChange={(event) => setFormData({ ...formData, bb: event.target.value })}
                />
              </InputGroup>
              <InputGroup label={lengthHeightLabel}>
                <input
                  required
                  type="number"
                  step="0.1"
                  className={inputClass}
                  value={formData.tb}
                  onChange={(event) => setFormData({ ...formData, tb: event.target.value })}
                />
              </InputGroup>
            </div>

            <div className="border-y border-slate-200 py-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 text-xs">
                <div><p className="text-slate-500 mb-1">Status BB/U</p><StatusBadge status={statusSummary.bbu} /></div>
                <div><p className="text-slate-500 mb-1">{lengthHeightStatusLabel}</p><StatusBadge status={statusSummary.tbu} /></div>
                <div><p className="text-slate-500 mb-1">{weightLengthHeightStatusLabel}</p><StatusBadge status={statusSummary.bbtb} /></div>
                <div><p className="text-slate-500 mb-1">Status IMT/U</p><StatusBadge status={statusSummary.imtu} /></div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <InputGroup label="LiLa (cm)">
                <input
                  type="number"
                  step="0.1"
                  className={inputClass}
                  value={formData.lila}
                  onChange={(event) => setFormData({ ...formData, lila: event.target.value })}
                />
              </InputGroup>
              <InputGroup label="Lingkar Kepala (cm)">
                <input
                  type="number"
                  step="0.1"
                  className={inputClass}
                  value={formData.lk}
                  onChange={(event) => setFormData({ ...formData, lk: event.target.value })}
                />
              </InputGroup>
            </div>

            <input type="hidden" value={formData.statusNaik} />

            <InputGroup label="Pitting Edema Bilateral">
              <Select
                value={formData.edema}
                onChange={(event) => setFormData({ ...formData, edema: event.target.value })}
                options={[
                  { value: 'Tidak', label: 'Tidak' },
                  { value: 'Ada (Derajat +1)', label: 'Ada (Derajat +1)' },
                  { value: 'Ada (Derajat +2)', label: 'Ada (Derajat +2)' },
                  { value: 'Ada (Derajat +3)', label: 'Ada (Derajat +3)' }
                ]}
              />
            </InputGroup>

            <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl">
              <InputGroup label="Kelas Ibu Balita?">
                <Select
                  value={formData.kelasIbu}
                  onChange={(event) => setFormData({ ...formData, kelasIbu: event.target.value })}
                  options={[
                    { value: 'Tidak', label: 'Tidak' },
                    { value: 'Ya', label: 'Ya' }
                  ]}
                />
              </InputGroup>
              <InputGroup label="Terima MBG?">
                <Select
                  value={formData.mbg}
                  onChange={(event) => setFormData({ ...formData, mbg: event.target.value })}
                  options={[
                    { value: 'Tidak', label: 'Tidak' },
                    { value: 'Ya', label: 'Ya' }
                  ]}
                />
              </InputGroup>
            </div>

            <div className="space-y-4">
              {showVitA && (
                <div className="bg-amber-50 p-4 rounded-xl border border-amber-100">
                  <InputGroup label="Dapat Vitamin A (Feb/Agu)?">
                    <Select
                      className="bg-white"
                      value={formData.vitA}
                      onChange={(event) => setFormData({ ...formData, vitA: event.target.value })}
                      options={[
                        { value: 'Tidak', label: 'Tidak' },
                        { value: 'Ya', label: 'Ya' }
                      ]}
                    />
                  </InputGroup>
                </div>
              )}

              {showAsi && (
                <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                  <InputGroup label="ASI Eksklusif (0-6 bln)?">
                    <Select
                      className="bg-white"
                      value={formData.asi}
                      onChange={(event) => setFormData({ ...formData, asi: event.target.value })}
                      options={[
                        { value: 'Tidak', label: 'Tidak' },
                        { value: 'Ya', label: 'Ya' }
                      ]}
                    />
                  </InputGroup>
                </div>
              )}
            </div>

            <div className="pt-2 flex gap-3">
              <Button variant="secondary" type="button" onClick={() => setActiveMenu('history')} className="flex-1">
                Kembali ke Riwayat
              </Button>
              <Button variant="primary" type="submit" disabled={loading} className="flex-1">
                Simpan Pengukuran
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
