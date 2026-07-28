import React, { useState } from 'react';
import { signInAnonymously, Auth } from '../lib/supabase-compat';

const ROLES = {
  KADER: 'Kader Posyandu',
  BIDAN: 'Bidan Desa',
  GIZI: 'Ahli Gizi'
};

const DATA_WILAYAH: Record<string, string[]> = {
  'Desa Gumukmas': Array.from({ length: 17 }, (_, i) => `SALAK ${i + 1}`).concat(['SALAK 99']),
  'Desa Menampu': Array.from({ length: 14 }, (_, i) => `SALAK ${i + 18}`).concat(['SALAK 98']),
  'Desa Mayangan': Array.from({ length: 11 }, (_, i) => `SALAK ${i + 32}`),
  'Desa Kepanjen': Array.from({ length: 10 }, (_, i) => `SALAK ${i + 43}`),
  'Desa Purwoasri': Array.from({ length: 9 }, (_, i) => `SALAK ${i + 53}`)
};

type UserRole = {
  role: string;
  desa: string | null;
  posyandu: string | null;
};

const LoginPage: React.FC<{ onLogin: (user: UserRole) => void; auth: Auth }> = ({ onLogin, auth }) => {
  const [role, setRole] = useState<string>(ROLES.KADER);
  const [selectedDesa, setSelectedDesa] = useState<string>(Object.keys(DATA_WILAYAH)[0]);
  const [selectedPosyandu, setSelectedPosyandu] = useState<string>(DATA_WILAYAH[Object.keys(DATA_WILAYAH)[0]][0]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setErrorMsg(null);

    let userData: UserRole = { role, desa: null, posyandu: null };
    if (role === ROLES.KADER) {
      userData.desa = selectedDesa;
      userData.posyandu = selectedPosyandu;
    } else if (role === ROLES.BIDAN) {
      userData.desa = selectedDesa;
      userData.posyandu = null;
    }

    try {
      await signInAnonymously(auth);
      onLogin(userData);
    } catch (error: any) {
      console.error('Gagal masuk: ' + error.message);
      setErrorMsg('Gagal Login: ' + error.message + '. Cek koneksi aplikasi.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden">
          <div className="bg-emerald-600 p-8 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-white/20 rounded-full mb-4 backdrop-blur-sm p-2">
              <img src="/logo-puskesmas-32981.svg" alt="Logo Puskesmas Gumukmas" className="w-10 h-10 object-contain" />
            </div>
            <h1 className="text-2xl font-bold text-white">E-Posyandu</h1>
            <p className="text-white font-medium text-sm mt-1">UPTD Puskesmas Gumukmas</p>
            <p className="text-emerald-100 text-xs mt-1">Sistem Informasi Gizi & Kesehatan Ibu Anak</p>
          </div>
          <div className="p-8 space-y-6">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Pilih Peran Akses</label>
            <div className="relative w-full">
              <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full appearance-none bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 pr-8 transition-shadow">
                {Object.values(ROLES).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <span className="pointer-events-none absolute right-3 top-3 text-slate-400">▾</span>
            </div>

            {(role === ROLES.KADER || role === ROLES.BIDAN) && (
              <>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Pilih Desa</label>
                <div className="relative w-full">
                  <select
                    value={selectedDesa}
                    onChange={(e) => {
                      setSelectedDesa(e.target.value);
                      setSelectedPosyandu(DATA_WILAYAH[e.target.value][0]);
                    }}
                    className="w-full appearance-none bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 pr-8 transition-shadow"
                  >
                    {Object.keys(DATA_WILAYAH).map((desa) => <option key={desa} value={desa}>{desa}</option>)}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-3 text-slate-400">▾</span>
                </div>
              </>
            )}

            {role === ROLES.KADER && (
              <>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Pilih Posyandu</label>
                <div className="relative w-full">
                  <select
                    value={selectedPosyandu}
                    onChange={(e) => setSelectedPosyandu(e.target.value)}
                    className="w-full appearance-none bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 pr-8 transition-shadow"
                  >
                    {DATA_WILAYAH[selectedDesa].map((posyandu) => <option key={posyandu} value={posyandu}>{posyandu}</option>)}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-3 text-slate-400">▾</span>
                </div>
              </>
            )}

            {errorMsg && <div className="bg-rose-50 border border-rose-100 p-3 rounded-xl text-rose-600 text-xs break-all"><strong>Error:</strong> {errorMsg}</div>}

            <button onClick={handleLogin} disabled={loading} className="w-full justify-center mt-4 px-4 py-2.5 rounded-xl font-medium text-xs transition-all duration-200 flex items-center justify-center gap-2 focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm active:scale-95 bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:from-emerald-600 hover:to-teal-700 shadow-emerald-200/50 focus:ring-emerald-100">
              {loading ? 'Memproses...' : 'Masuk Dashboard'}
            </button>
          </div>
          <div className="bg-slate-50 px-8 py-4 text-center text-xs text-slate-400">&copy; 2026 UPTD Puskesmas Gumukmas</div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
