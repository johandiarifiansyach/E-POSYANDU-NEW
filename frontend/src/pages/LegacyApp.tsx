import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
    initializeApp,
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged, 
  signOut, 
  Auth
} from '../lib/supabase-compat';
import { 
    getFirestore,
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  serverTimestamp, 
  updateDoc, 
  doc, 
  deleteDoc, 
  getDocs,
  Firestore,
  QuerySnapshot,
  DocumentData,
  QueryDocumentSnapshot,
  orderBy
} from '../lib/supabase-compat';
import { 
  Ruler, LogOut, Plus, Search, MapPin, Clock, Baby,
  Activity, XCircle, ChevronDown, Loader2, LayoutDashboard, 
  Users, Trash2, Menu, RotateCcw, X, Filter, Pencil, FileDown, FileUp, AlertTriangle,
  TrendingDown, AlertCircle, Scale, TrendingUp, Minus,
  Utensils, Gift, ClipboardCheck, Calendar, CheckSquare, History, FileText,
  ChevronLeft, ChevronRight
} from 'lucide-react';
import { WHO_0_TO_5, type Lms } from '../lib/anthropometry-data';

// --- 0. TYPE DEFINITIONS & INTERFACES ---

declare global {
  interface Window {
    XLSX: any;
  }
}

// Data Models
export interface ChildData {
  id?: string;
  nama: string;
  nik: string;
  anakKe: string | number;
  tglLahir: string;
  jk: 'L' | 'P';
  noKK: string;
  hasKK: boolean;
  hasNIK: boolean;
  usiaKehamilan: string | number;
  bbLahir: string | number;
  pbLahir: string | number;
  lkLahir: string | number;
  bukuKIA: string;
  bukuKIAKecil: string;
  imd: string;
  namaOrtu: string;
  nikOrtu: string;
  noHpOrtu: string;
  alamat: string;
  rt: string;
  rw: string;
  desa: string;
  posyandu: string;
  currentBB?: number | string;
  currentTB?: number | string;
  currentLILA?: number | string;
  currentLK?: number | string;
  lastMeasurementDate?: string;
  createdAt?: any;
  createdBy?: string;
  deletedAt?: any | null;
  deleteReason?: string;
  deathDate?: string;
  deathCause?: string;
  deathLocation?: string;
  updatedAt?: any;
  [key: string]: any; 
}

export interface MeasurementData {
  id?: string;
  childId: string;
  childName: string;
  posyandu: string;
  desa: string;
  tglUkur: string;
  bb: number | string;
  tb: number | string;
  lk: number | string;
  lila: number | string;
  edema: string;
  kelasIbu: string;
  mbg: string;
  vitA: string;
  asi: string;
  caraUkur: string;
  statusNaik: 'N' | 'T' | 'B' | 'O';
  ageInMonths: number;
  createdAt?: any;
  updatedAt?: any;
}

export interface MpasiData {
    id?: string;
    childId: string;
    childName: string;
    tglMonitoring: string;
    asi: string;
    makananPokok: string[]; 
    kacang: string[];
    susu: string[];
    daging: string[];
    telur: string[];
    sayurVitA: string[];
    sayurLain: string[];
    intervensiGizi: string;
    createdAt?: any;
}

export interface PmtProgramData {
    id?: string;
    childId: string;
    childName: string;
    category: 'Wasting' | 'Underweight' | 'TidakNaik';
    jenisPmt: 'Pabrikan' | 'Lokal';
    sumberAnggaran: string;
    mitra?: string;
    mitraLain?: string;
    siklusKe: number;
    pmtSesuaiJuknis: 'Ya' | 'Tidak';
    tglPemberian: string;
    status: 'Aktif' | 'Selesai';
    monitorings: Record<number, {
        tgl: string;
        bb: number;
        tb: number;
        caraUkur: string;
        days: boolean[]; // Array of 7 booleans [day1, day2, ..., day7]
        pemantauanKesehatan: 'Ada' | 'Tidak';
        tindakLanjut: 'Dilanjutkan' | 'Selesai' | 'Rujuk RS';
    }>;
    createdAt?: any;
}

export interface ChangeLogData {
    id?: string;
    childId: string;
    childName: string;
    changes: { field: string; oldValue: any; newValue: any }[];
    changedBy: string;
    timestamp: any;
}

export interface UserRole {
  role: string;
  desa: string | null;
  posyandu: string | null;
}

// Config Types
export type Gender = 'L' | 'P';
export type GrowthType = 'BBU' | 'TBU' | 'BBTB' | 'IMTU';

// --- 1. CONFIGURATION & CONSTANTS ---

const app = initializeApp({
    projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6'
});
const auth: Auth = getAuth(app);
export const db: Firestore = getFirestore(app);

export const appId = import.meta.env.VITE_APP_ID || 'siposyandu-377b6';
const XLSX_SCRIPT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

let xlsxLoadPromise: Promise<any> | null = null;

const ensureXlsx = (): Promise<any> => {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLoadPromise) return xlsxLoadPromise;

  xlsxLoadPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${XLSX_SCRIPT_SRC}"]`);
    const script = existingScript || document.createElement('script');

    script.addEventListener('load', () => resolve(window.XLSX), { once: true });
    script.addEventListener('error', () => reject(new Error('Gagal memuat library Excel.')), { once: true });

    if (!existingScript) {
      script.src = XLSX_SCRIPT_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });

  return xlsxLoadPromise;
};

export const DATA_WILAYAH: Record<string, string[]> = {
  "Desa Gumukmas": Array.from({ length: 17 }, (_, i) => `SALAK ${i + 1}`).concat(["SALAK 99"]),
  "Desa Menampu": Array.from({ length: 14 }, (_, i) => `SALAK ${i + 18}`).concat(["SALAK 98"]),
  "Desa Mayangan": Array.from({ length: 11 }, (_, i) => `SALAK ${i + 32}`), 
  "Desa Kepanjen": Array.from({ length: 10 }, (_, i) => `SALAK ${i + 43}`), 
  "Desa Purwoasri": Array.from({ length: 9 }, (_, i) => `SALAK ${i + 53}`)  
};

export const ROLES = {
  KADER: "Kader Posyandu",
  BIDAN: "Bidan Desa",
  GIZI: "Ahli Gizi"
};

const DashboardOverviewPage = React.lazy(() => import('./DashboardOverviewPage'));
const PmtProgramPage = React.lazy(() => import('./PmtProgramPage'));
const ChangeHistoryPage = React.lazy(() => import('./ChangeHistoryPage'));
const ChildrenTablePage = React.lazy(() => import('./ChildrenTablePage'));
const MeasurementPage = React.lazy(() => import('./MeasurementPage'));
const ExclusiveBreastfeedingPage = React.lazy(() => import('./ExclusiveBreastfeedingPage'));

const DASHBOARD_TABS = [
  'dashboard',
  'data_balita',
  'asi_eksklusif',
  'mpasi',
  'problem_underweight',
  'problem_stunting',
  'problem_wasting',
  'problem_tidak_naik',
  'pmt_program',
  'recent',
  'change_history',
  'recycle_bin',
  'measurement'
] as const;

type DashboardTab = typeof DASHBOARD_TABS[number];

const isDashboardTab = (value: string): value is DashboardTab => {
  return (DASHBOARD_TABS as readonly string[]).includes(value);
};

type DashboardHashState = {
  tab: DashboardTab;
  measurementChildId: string | null;
};

const getDashboardHashState = (): DashboardHashState => {
  if (typeof window === 'undefined') return { tab: 'dashboard', measurementChildId: null };
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('measurement/')) {
    const childId = decodeURIComponent(hash.replace(/^measurement\//, ''));
    return { tab: childId ? 'measurement' : 'data_balita', measurementChildId: childId || null };
  }
  return isDashboardTab(hash) ? { tab: hash, measurementChildId: null } : { tab: 'dashboard', measurementChildId: null };
};

export const MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni", 
  "Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

export const YEARS = [2025, 2026, 2027, 2028, 2029, 2030];

// --- KBM STANDARDS ---
const KBM_TABLE: Record<number, number> = {
    1: 800, 2: 900, 3: 800, 4: 600, 5: 500, 
    6: 400, 7: 300, 8: 300, 9: 300, 10: 300,
    11: 200 
};

export const getKBM = (ageInMonths: number): number => {
    if (ageInMonths <= 1) return 800;
    if (ageInMonths > 60) return 200;
    if (ageInMonths >= 11) return 200;
    return KBM_TABLE[ageInMonths] || 200;
};

// --- 2. UTILITY FUNCTIONS ---

const generateRandomDigits = (length: number): string => {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 10);
  }
  return result;
};

export const formatDate = (date: Date | string | undefined): string => {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
};

export const formatIndoDate = (dateString: string | undefined): string => {
    if (!dateString) return '-';
    const d = new Date(dateString);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const formatIndoDateTime = (timestamp: any): string => {
    if (!timestamp) return '-';
    const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const getAgeInMonths = (birthDateString: string, refDate: Date = new Date()): number => {
  if (!birthDateString) return 0;
  const [year, month, day] = birthDateString.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return 0;

  let months = (refDate.getFullYear() - year) * 12 + (refDate.getMonth() - (month - 1));
  if (refDate.getDate() < day) months -= 1;
  return Math.max(months, 0);
};

// --- ANTROPOMETRY: PERMENKES NO. 2 TAHUN 2020 / WHO 0-60 BULAN ---

const toPositiveNumber = (value: number | string | null | undefined): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
};

const calculateLmsZScore = (value: number, [l, m, s]: Lms): number => {
  if (l === 0) return Math.log(value / m) / s;
  return (Math.pow(value / m, l) - 1) / (l * s);
};

const getAdjustedLengthHeight = (value: number, ageMonths: number, caraUkur?: string): number => {
  if (ageMonths <= 24 && caraUkur === 'Berdiri') return value + 0.7;
  if (ageMonths > 24 && caraUkur === 'Terlentang') return value - 0.7;
  return value;
};

export const calculateZScore = (
  val: number | string | undefined,
  type: GrowthType,
  ageMonths: number,
  gender: Gender,
  secondaryVal: number | string | null = null,
  caraUkur?: string
): number | null => {
  const primaryValue = toPositiveNumber(val);
  const age = Math.floor(ageMonths);
  if (primaryValue === null || age < 0 || age > 60) return null;

  if (type === 'BBU') {
    return calculateLmsZScore(primaryValue, WHO_0_TO_5.weightForAge[gender][age]);
  }

  const measuredLengthHeight = toPositiveNumber(secondaryVal);
  const lengthHeight = type === 'TBU' ? primaryValue : measuredLengthHeight;
  if (lengthHeight === null) return null;

  const adjustedLengthHeight = getAdjustedLengthHeight(lengthHeight, age, caraUkur);

  if (type === 'TBU') {
    return calculateLmsZScore(adjustedLengthHeight, WHO_0_TO_5.lengthHeightForAge[gender][age]);
  }

  if (type === 'IMTU') {
    const bmi = primaryValue / Math.pow(adjustedLengthHeight / 100, 2);
    return calculateLmsZScore(bmi, WHO_0_TO_5.bmiForAge[gender][age]);
  }

  const isLength = age <= 24;
  const minimumLengthHeight = isLength ? 45 : 65;
  const standards = isLength ? WHO_0_TO_5.weightForLength : WHO_0_TO_5.weightForHeight;
  const index = Math.round((adjustedLengthHeight - minimumLengthHeight) * 2);
  const standard = standards[gender][index];
  if (!standard) return null;

  return calculateLmsZScore(primaryValue, standard);
};

const getGiziLabel = (zScore: number | null, type: GrowthType): string => {
    if (zScore === null) return "-";
    if (type === 'BBU') {
        if (zScore < -3) return "Berat Sangat Kurang"; if (zScore < -2) return "Berat Kurang"; if (zScore <= 1) return "Berat Normal"; return "Risiko Berat Lebih";
    }
    if (type === 'TBU') {
        if (zScore < -3) return "Sangat Pendek"; if (zScore < -2) return "Pendek"; if (zScore <= 3) return "Normal"; return "Tinggi";
    }
    if (type === 'BBTB' || type === 'IMTU') {
        if (zScore < -3) return "Gizi Buruk"; if (zScore < -2) return "Gizi Kurang"; if (zScore <= 1) return "Gizi Baik"; if (zScore <= 2) return "Risiko Gizi Lebih"; if (zScore <= 3) return "Gizi Lebih"; return "Obesitas";
    }
    return "-";
};

export const calculateGiziStatus = (val: number | string | undefined, type: GrowthType, ageMonths: number, gender: Gender, secondaryVal: number | string | null = null, caraUkur?: string): string => {
    const zScore = calculateZScore(val, type, ageMonths, gender, secondaryVal, caraUkur);
    return getGiziLabel(zScore, type);
};

// --- 3. UI COMPONENTS ---

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`bg-white rounded-2xl shadow-sm border border-slate-200/60 ${className}`}>
    {children}
  </div>
);

export type ButtonVariant = "primary" | "secondary" | "danger" | "dangerFilled" | "ghost" | "actionBlue" | "actionGreen" | "actionRed" | "actionOrange";

export const Button: React.FC<{children: React.ReactNode; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; variant?: ButtonVariant; className?: string; disabled?: boolean; type?: "button" | "submit" | "reset"; title?: string;}> = ({ children, onClick, variant = "primary", className = "", disabled = false, type = "button", title="" }) => {
  const baseStyle = "px-4 py-2.5 rounded-xl font-medium text-xs transition-all duration-200 flex items-center justify-center gap-2 focus:ring-4 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm active:scale-95";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:from-emerald-600 hover:to-teal-700 shadow-emerald-200/50 focus:ring-emerald-100",
    secondary: "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:text-slate-900 focus:ring-slate-100",
    danger: "bg-rose-50 text-rose-600 hover:bg-rose-100 focus:ring-rose-50 border border-rose-100",
    dangerFilled: "bg-gradient-to-r from-rose-500 to-pink-600 text-white hover:from-rose-600 hover:to-pink-700 shadow-rose-200/50 focus:ring-rose-200", 
    ghost: "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-emerald-600 shadow-none",
    actionBlue: "bg-blue-50 text-blue-600 hover:bg-blue-100 hover:text-blue-700 border border-blue-100 px-3 py-2",
    actionGreen: "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-700 border border-emerald-100 px-3 py-2",
    actionRed: "bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-700 border border-rose-100 px-3 py-2",
    actionOrange: "bg-orange-50 text-orange-600 hover:bg-orange-100 hover:text-orange-700 border border-orange-100 px-3 py-2",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${baseStyle} ${variants[variant]} ${className}`}>
      {disabled && <Loader2 className="w-3 h-3 animate-spin" />}
      {children}
    </button>
  );
};

export const InputGroup: React.FC<{label: string; children: React.ReactNode; error?: string;}> = ({ label, children, error }) => (
  <div className="space-y-2">
    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</label>
    {children}
    {error && <p className="text-xs text-rose-500">{error}</p>}
  </div>
);

export const Select: React.FC<{value: string | number; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void; options: {value: string | number; label: string}[]; disabled?: boolean; required?: boolean; className?: string;}> = ({ value, onChange, options, disabled, required = false, className = "" }) => (
  <div className="relative w-full">
    <select value={value} onChange={onChange} disabled={disabled} required={required} className={`w-full appearance-none bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 pr-8 disabled:bg-slate-100 disabled:text-slate-400 transition-shadow ${className}`}>
      {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
    <ChevronDown className="absolute right-3 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
  </div>
);

export const Badge: React.FC<{ children: React.ReactNode; color?: "emerald" | "blue" | "pink" | "slate" | "amber" }> = ({ children, color = "emerald" }) => {
  const colors = { emerald: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200", blue: "bg-blue-100 text-blue-700 ring-1 ring-blue-200", pink: "bg-pink-100 text-pink-700 ring-1 ring-pink-200", slate: "bg-slate-100 text-slate-600 ring-1 ring-slate-200", amber: "bg-amber-100 text-amber-700 ring-1 ring-amber-200" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${colors[color]}`}>{children}</span>;
};

export const KenaikanBadge: React.FC<{ status: string | null }> = ({ status }) => {
    if (!status) return <span className="text-slate-300">-</span>;
    let color = "bg-slate-100 text-slate-700", label = status;
    switch(status) {
        case 'N': color = "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200"; label = "N (Naik)"; break;
        case 'T': color = "bg-rose-100 text-rose-700 ring-1 ring-rose-200"; label = "T (Tidak Naik)"; break;
        case 'B': color = "bg-blue-100 text-blue-700 ring-1 ring-blue-200"; label = "B (Baru)"; break;
        case 'O': color = "bg-slate-100 text-slate-600 ring-1 ring-slate-200"; label = "O (Tidak Hadir)"; break;
        default: label = status;
    }
    return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}`}>{label}</span>;
};

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
    if (status === "-" || !status) return <span className="text-slate-300">-</span>;
    let color = "bg-slate-100 text-slate-700";
    if (["Berat Normal", "Normal", "Gizi Baik"].includes(status)) color = "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200";
    if (["Berat Kurang", "Pendek", "Gizi Kurang", "Risiko Berat Lebih", "Risiko Gizi Lebih"].includes(status)) color = "bg-amber-100 text-amber-700 ring-1 ring-amber-200";
    if (["Berat Sangat Kurang", "Sangat Pendek", "Gizi Buruk", "Obesitas"].includes(status)) color = "bg-rose-100 text-rose-700 ring-1 ring-rose-200";
    if (["Tinggi", "Gizi Lebih"].includes(status)) color = "bg-blue-100 text-blue-700 ring-1 ring-blue-200";
    return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${color}`}>{status}</span>;
};

// --- 4. MODALS & SCREENS (Defined BEFORE Dashboard and App) ---

const MpasiModal: React.FC<{child: ChildData; onClose: () => void}> = ({ child, onClose }) => {
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
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
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
            onClose();
        } catch (error) { console.error(error); } finally { setLoading(false); }
    };

    const CheckItem: React.FC<{label: string, desc: string, checked: boolean, onChange: (v: boolean) => void}> = ({label, desc, checked, onChange}) => (
        <div className={`p-3 rounded-xl border transition-all cursor-pointer ${checked ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200 hover:border-emerald-200'}`} onClick={() => onChange(!checked)}>
            <div className="flex items-start gap-3">
                <div className={`w-5 h-5 rounded border flex items-center justify-center mt-0.5 ${checked ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-slate-300'}`}>
                    {checked && <ClipboardCheck className="w-3.5 h-3.5" />}
                </div>
                <div><h4 className={`text-sm font-semibold ${checked ? 'text-emerald-900' : 'text-slate-700'}`}>{label}</h4><p className="text-xs text-slate-500 mt-0.5">{desc}</p></div>
            </div>
        </div>
    );

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm overflow-y-auto">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="bg-orange-500 p-6 rounded-t-3xl text-white flex justify-between items-start">
                    <div><h2 className="text-xl font-bold">Pemantauan MPASI</h2><p className="text-orange-100 text-sm mt-1">{child.nama} (6-23 Bulan)</p></div>
                    <button onClick={onClose}><XCircle className="w-6 h-6 text-white/80 hover:text-white"/></button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-6">
                    <InputGroup label="Tanggal Monitoring"><input type="date" required className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={formData.tglMonitoring} onChange={e => setFormData({...formData, tglMonitoring: e.target.value})} /></InputGroup>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <InputGroup label="Masih Diberi ASI?"><Select value={formData.asi} onChange={e => setFormData({...formData, asi: e.target.value})} options={[{value: 'Ya', label: 'Ya'}, {value: 'Tidak', label: 'Tidak'}]} /></InputGroup>
                        <InputGroup label="Intervensi Gizi (MT/Formula)?"><Select value={formData.intervensiGizi} onChange={e => setFormData({...formData, intervensiGizi: e.target.value})} options={[{value: 'Ya', label: 'Ya'}, {value: 'Tidak', label: 'Tidak'}]} /></InputGroup>
                    </div>
                    <div className="space-y-3">
                        <label className="text-xs font-bold text-slate-500 uppercase">Komposisi Makanan (Centang jika dikonsumsi)</label>
                        <div className="grid grid-cols-1 gap-3">
                            <CheckItem checked={formData.makananPokok} onChange={v => setFormData({...formData, makananPokok: v})} label="Makanan Pokok" desc="Serealia (nasi, mie, jagung, roti), Umbi-umbian (kentang, ubi)" />
                            <CheckItem checked={formData.kacang} onChange={v => setFormData({...formData, kacang: v})} label="Kacang-kacangan" desc="Tempe, tahu, kacang hijau, kacang tanah, kedelai" />
                            <CheckItem checked={formData.susu} onChange={v => setFormData({...formData, susu: v})} label="Produk Susu Hewani" desc="Susu cair, bubuk, formula, yogurt, keju" />
                            <CheckItem checked={formData.daging} onChange={v => setFormData({...formData, daging: v})} label="Daging-dagingan" desc="Ayam, ikan, daging merah, hati, jeroan, seafood" />
                            <CheckItem checked={formData.telur} onChange={v => setFormData({...formData, telur: v})} label="Telur" desc="Telur ayam, puyuh, bebek" />
                            <CheckItem checked={formData.sayurVitA} onChange={v => setFormData({...formData, sayurVitA: v})} label="Buah & Sayur Kaya Vit A" desc="Pepaya, mangga, wortel, bayam, kangkung, daun katuk/kelor" />
                            <CheckItem checked={formData.sayurLain} onChange={v => setFormData({...formData, sayurLain: v})} label="Buah & Sayur Lainnya" desc="Pisang, jeruk, semangka, buncis, terong, kecambah" />
                        </div>
                    </div>
                    <div className="flex gap-3 pt-4"><Button variant="secondary" onClick={onClose} className="flex-1">Batal</Button><Button variant="primary" type="submit" disabled={loading} className="flex-1 bg-orange-600 hover:bg-orange-700">Simpan Data MPASI</Button></div>
                </form>
            </div>
        </div>
    );
};

const PmtModal: React.FC<{child: ChildData; category: 'Wasting' | 'Underweight' | 'TidakNaik'; onClose: () => void}> = ({ child, category, onClose }) => {
    const [formData, setFormData] = useState({ 
        jenisPmt: 'Pabrikan', 
        sumberAnggaran: 'Dana Desa', 
        mitra: '',
        mitraLain: '',
        tglPemberian: formatDate(new Date()),
        siklusKe: 1,
        pmtSesuaiJuknis: 'Ya'
    });
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault(); setLoading(true);
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
                siklusKe: Number(formData.siklusKe),
                pmtSesuaiJuknis: formData.pmtSesuaiJuknis,
                status: 'Aktif', 
                monitorings: {}, 
                createdAt: serverTimestamp() 
            }); 
            onClose(); 
        } catch (error) { console.error(error); } finally { setLoading(false); }
    };
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
                <div className="bg-rose-600 p-6 rounded-t-3xl text-white flex justify-between items-start">
                    <div><h2 className="text-xl font-bold">Pemberian PMT</h2><p className="text-rose-100 text-sm mt-1">{child.nama} • Kategori: {category}</p></div>
                    <button onClick={onClose}><XCircle className="w-6 h-6 text-white/80 hover:text-white"/></button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-6">
                    <InputGroup label="Siklus Ke-"><input type="number" required min="1" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={formData.siklusKe} onChange={e => setFormData({...formData, siklusKe: Number(e.target.value)})} /></InputGroup>
                    <InputGroup label="Jenis PMT"><Select value={formData.jenisPmt} onChange={e => setFormData({...formData, jenisPmt: e.target.value})} options={[{value:'Pabrikan', label:'Pabrikan'}, {value:'Lokal', label:'Lokal'}]} /></InputGroup>
                    <InputGroup label="Sumber Anggaran"><Select value={formData.sumberAnggaran} onChange={e => setFormData({...formData, sumberAnggaran: e.target.value})} options={[{value:'Dana Desa', label:'Dana Desa'}, {value:'DAK Non Fisik', label:'DAK Non Fisik'}, {value:'APBD', label:'APBD'}, {value:'Mitra', label:'Mitra'}]} /></InputGroup>
                    
                    {formData.sumberAnggaran === 'Mitra' && (
                        <>
                            <InputGroup label="Nama Mitra"><input type="text" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" placeholder="Contoh: CSR Perusahaan A" value={formData.mitra} onChange={e => setFormData({...formData, mitra: e.target.value})} /></InputGroup>
                            {formData.mitra === 'Lainnya' && <InputGroup label="Mitra Lainnya"><input type="text" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={formData.mitraLain} onChange={e => setFormData({...formData, mitraLain: e.target.value})} /></InputGroup>}
                        </>
                    )}

                    <InputGroup label="PMT Sesuai Juknis?"><Select value={formData.pmtSesuaiJuknis} onChange={e => setFormData({...formData, pmtSesuaiJuknis: e.target.value as 'Ya'|'Tidak'})} options={[{value:'Ya', label:'Ya'}, {value:'Tidak', label:'Tidak'}]} /></InputGroup>
                    <InputGroup label="Tanggal Mulai Pemberian"><input type="date" required className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={formData.tglPemberian} onChange={e => setFormData({...formData, tglPemberian: e.target.value})} /></InputGroup>
                    <div className="flex gap-3 pt-4"><Button variant="secondary" onClick={onClose} className="flex-1">Batal</Button><Button variant="dangerFilled" type="submit" disabled={loading} className="flex-1">Simpan Program</Button></div>
                </form>
            </div>
        </div>
    );
};

const PmtMonitoringModal: React.FC<{program: PmtProgramData; child: ChildData; onClose: () => void}> = ({ program, child, onClose }) => {
    const [week, setWeek] = useState(1);
    const [data, setData] = useState({ 
        tgl: formatDate(new Date()), 
        bb: '', 
        tb: '',
        days: [false, false, false, false, false, false, false],
        pemantauanKesehatan: 'Ada',
        tindakLanjut: 'Dilanjutkan'
    });
    const maxWeeks = program.category === 'Wasting' ? 8 : (program.category === 'Underweight' ? 4 : 2);
    const weeksArr = Array.from({length: maxWeeks}, (_, i) => i + 1);
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
        } else { 
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
        try { 
            if (!program.id) return; 
            const updatedMonitorings = { 
                ...program.monitorings, 
                [week]: { 
                    tgl: data.tgl, 
                    bb: parseFloat(data.bb), 
                    tb: parseFloat(data.tb), 
                    caraUkur: caraUkur,
                    days: data.days,
                    pemantauanKesehatan: data.pemantauanKesehatan as any,
                    tindakLanjut: data.tindakLanjut as any
                } 
            }; 
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'pmt_programs', program.id), { monitorings: updatedMonitorings, updatedAt: serverTimestamp() }); 
            onClose(); 
        } catch (e) { console.error(e); }
    };

    const toggleDay = (idx: number) => {
        const newDays = [...data.days];
        newDays[idx] = !newDays[idx];
        setData({...data, days: newDays});
    };

    return (
         <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
                <div className="bg-indigo-600 p-6 rounded-t-3xl text-white flex justify-between items-start">
                    <div><h2 className="text-xl font-bold">Pemantauan Mingguan</h2><p className="text-indigo-100 text-sm mt-1">{child.nama} • {program.category}</p></div>
                    <button onClick={onClose}><XCircle className="w-6 h-6 text-white/80 hover:text-white"/></button>
                </div>
                <div className="p-6">
                    <div className="flex gap-2 overflow-x-auto pb-4 mb-4 border-b border-slate-100">
                        {weeksArr.map(w => ( <button key={w} onClick={() => setWeek(w)} className={`px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${week === w ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'} ${(program.monitorings && program.monitorings[w]) ? 'ring-2 ring-emerald-400 ring-offset-1' : ''}`}>Minggu {w}</button> ))}
                    </div>
                    <div className="space-y-4">
                        <InputGroup label={`Data Pengukuran Minggu Ke-${week}`}><input type="date" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={data.tgl} onChange={e => setData({...data, tgl: e.target.value})} /></InputGroup>
                        <div className="grid grid-cols-2 gap-4"><InputGroup label="Berat Badan (kg)"><input type="number" step="0.01" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={data.bb} onChange={e => setData({...data, bb: e.target.value})} /></InputGroup><InputGroup label="Tinggi Badan (cm)"><input type="number" step="0.1" className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5" value={data.tb} onChange={e => setData({...data, tb: e.target.value})} /></InputGroup></div>
                        <div className="bg-slate-100 p-3 rounded-lg text-xs text-slate-500">Cara Ukur Otomatis: <strong>{caraUkur}</strong> (Usia: {ageAtMeasure} Bulan)</div>
                        
                        <div className="pt-2">
                            <label className="text-xs font-bold text-slate-500 uppercase block mb-2">Konsumsi PMT (Centang jika dikonsumsi)</label>
                            <div className="grid grid-cols-7 gap-2">
                                {data.days.map((checked, i) => (
                                    <div key={i} onClick={() => toggleDay(i)} className={`cursor-pointer flex flex-col items-center justify-center p-2 rounded-lg border ${checked ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                                        <span className="text-[10px] font-bold mb-1">H-{i+1}</span>
                                        <div className={`w-4 h-4 rounded flex items-center justify-center ${checked ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-300'}`}>
                                            {checked && <CheckSquare className="w-3 h-3" />}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <InputGroup label="Pemantauan Kesehatan">
                                <Select value={data.pemantauanKesehatan} onChange={e => setData({...data, pemantauanKesehatan: e.target.value})} options={[{value:'Ada', label:'Ada'}, {value:'Tidak', label:'Tidak'}]} />
                            </InputGroup>
                            <InputGroup label="Tindak Lanjut">
                                <Select value={data.tindakLanjut} onChange={e => setData({...data, tindakLanjut: e.target.value})} options={[{value:'Dilanjutkan', label:'Dilanjutkan'}, {value:'Selesai', label:'Selesai'}, {value:'Rujuk RS', label:'Rujuk RS'}]} />
                            </InputGroup>
                        </div>

                    </div>
                    <div className="flex gap-3 pt-6"><Button variant="secondary" onClick={onClose} className="flex-1">Tutup</Button><Button variant="primary" onClick={handleSave} className="flex-1 bg-indigo-600 hover:bg-indigo-700">Simpan Minggu {week}</Button></div>
                </div>
            </div>
         </div>
    );
};

const DeleteChildModal: React.FC<{child: ChildData; onClose: () => void; onConfirm: (id: string, deleteData: Partial<ChildData>) => Promise<void>}> = ({ child, onClose, onConfirm }) => {
    const [reason, setReason] = useState('Salah Input');
    const [deathDate, setDeathDate] = useState('');
    const [deathCause, setDeathCause] = useState('');
    const [deathLocation, setDeathLocation] = useState('');
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e: React.FormEvent) => { e.preventDefault(); setLoading(true); const deleteData: Partial<ChildData> = { deleteReason: reason, ...(reason === 'Meninggal Dunia' && { deathDate, deathCause, deathLocation }) }; if (child.id) await onConfirm(child.id, deleteData); setLoading(false); };
    const inputClass = "w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-rose-500 focus:border-rose-500 block p-2.5 transition-colors";
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm overflow-y-auto">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
                <div className="bg-rose-50 p-6 rounded-t-3xl border-b border-rose-100 flex items-start gap-4"><div className="p-2 bg-rose-100 rounded-full text-rose-600"><AlertTriangle className="w-6 h-6" /></div><div><h2 className="text-lg font-bold text-rose-700">Hapus Data Balita</h2><p className="text-sm text-rose-600 mt-1">Data akan dipindahkan ke Recycle Bin.</p></div></div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 mb-4"><p className="text-sm font-semibold text-slate-700">{child.nama}</p><p className="text-xs text-slate-500 font-mono mt-1">{child.nik}</p></div>
                    <InputGroup label="Alasan Menghapus"><Select value={reason} onChange={(e) => setReason(e.target.value)} options={[{value: 'Salah Input', label: 'Salah Input / Langsung Hapus'},{value: 'Pindah Domisili', label: 'Pindah Domisili'},{value: 'Meninggal Dunia', label: 'Meninggal Dunia'}]} /></InputGroup>
                    {reason === 'Meninggal Dunia' && (<div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300"><div className="p-3 bg-rose-50 border border-rose-100 rounded-lg text-xs text-rose-600">Harap lengkapi data kematian untuk pelaporan.</div><InputGroup label="Tanggal Meninggal"><input required type="date" className={inputClass} value={deathDate} onChange={e => setDeathDate(e.target.value)} /></InputGroup><InputGroup label="Penyebab Meninggal"><input required type="text" placeholder="Contoh: Sakit Demam Berdarah" className={inputClass} value={deathCause} onChange={e => setDeathCause(e.target.value)} /></InputGroup><InputGroup label="Lokasi Meninggal"><input required type="text" placeholder="Contoh: RSUD, Rumah" className={inputClass} value={deathLocation} onChange={e => setDeathLocation(e.target.value)} /></InputGroup></div>)}
                    <div className="pt-4 flex gap-3"><Button variant="secondary" onClick={onClose} className="flex-1">Batal</Button><Button variant="dangerFilled" type="submit" disabled={loading} className="flex-1">{loading ? 'Memproses...' : 'Konfirmasi Hapus'}</Button></div>
                </form>
            </div>
        </div>
    );
};

const LegacyAddChildModal: React.FC<{user: UserRole; onClose: () => void; onSuccess: () => void; initialData?: ChildData | null; isEdit?: boolean; allChildren?: ChildData[]}> = ({ user, onClose, onSuccess, initialData = null, isEdit = false, allChildren = [] }) => {
  const [formData, setFormData] = useState<ChildData>({ nama: '', nik: '', anakKe: '', tglLahir: '', jk: 'L', noKK: '', hasKK: true, hasNIK: true, usiaKehamilan: '', bbLahir: '', pbLahir: '', lkLahir: '', bukuKIA: 'Ya', bukuKIAKecil: 'Tidak', imd: 'Ya', namaOrtu: '', nikOrtu: '', noHpOrtu: '', alamat: '', rt: '', rw: '', desa: user.role === ROLES.KADER || user.role === ROLES.BIDAN ? (user.desa || Object.keys(DATA_WILAYAH)[0]) : Object.keys(DATA_WILAYAH)[0], posyandu: user.role === ROLES.KADER ? (user.posyandu || DATA_WILAYAH[Object.keys(DATA_WILAYAH)[0]][0]) : DATA_WILAYAH[user.role === ROLES.BIDAN ? (user.desa || Object.keys(DATA_WILAYAH)[0]) : Object.keys(DATA_WILAYAH)[0]][0] });
  const [loading, setLoading] = useState(false);
  
  useEffect(() => { if (isEdit && initialData) setFormData({ ...initialData, hasKK: true, hasNIK: true }); }, [isEdit, initialData]);
  
  useEffect(() => { 
      if (!isEdit || (isEdit && !formData.hasKK)) { 
          let newKK = formData.noKK; 
          if (!formData.hasKK) newKK = "350904" + generateRandomDigits(10); 
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
              const checkUnique = (nik: string) => !(allChildren || []).some(c => c.nik === nik && c.id !== initialData?.id);

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
  }, [formData.hasNIK, formData.tglLahir, formData.posyandu, isEdit, allChildren, initialData]);

  const handleSubmit = async (e: React.FormEvent) => { 
      e.preventDefault(); 
      setLoading(true); 
      try { 
          if (isEdit && initialData && initialData.id) { 
              // Log Changes
              const changes: {field: string, oldValue: any, newValue: any}[] = [];
              Object.keys(formData).forEach((key) => {
                  const k = key as keyof ChildData;
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

              await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', initialData.id), { ...formData, updatedAt: serverTimestamp() }); 
          } else { 
              const newChildRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), { ...formData, currentBB: formData.bbLahir, currentTB: formData.pbLahir, currentLK: formData.lkLahir, currentLILA: 0, createdAt: serverTimestamp(), createdBy: user.role, deletedAt: null }); 
              // AUTO-FILL FIRST MEASUREMENT FROM BIRTH DATA
              await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), { 
                  childId: newChildRef.id, 
                  childName: formData.nama, 
                  posyandu: formData.posyandu, 
                  desa: formData.desa, 
                  tglUkur: formData.tglLahir, // Use Birth Date
                  bb: formData.bbLahir, // Use Birth Weight
                  tb: formData.pbLahir, // Use Birth Length
                  lk: formData.lkLahir, // Use Birth Head Circumference
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
          onSuccess(); 
          onClose(); 
      } catch (error: any) { 
          console.error("Gagal menyimpan: " + error.message); 
      } finally { 
          setLoading(false); 
      } 
  };
  const inputClass = "w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors";
  return ( <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md overflow-y-auto"> <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"> <div className="sticky top-0 bg-white/80 backdrop-blur-md border-b border-slate-100 p-6 flex justify-between items-center z-10"> <div> <h2 className="text-xl font-bold text-slate-800">{isEdit ? 'Edit Identitas Balita' : 'Registrasi Balita Baru'}</h2> <p className="text-sm text-slate-500">{isEdit ? 'Perbarui data identitas balita' : 'Lengkapi data identitas dan demografi balita'}</p> </div> <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500"><XCircle className="w-6 h-6" /></button> </div> <form onSubmit={handleSubmit} className="p-6 space-y-8"> <div className="bg-emerald-50/50 p-6 rounded-2xl border border-emerald-100 space-y-4"> <div className="flex items-center gap-2 mb-2"> <MapPin className="w-5 h-5 text-emerald-600" /> <h3 className="font-semibold text-emerald-900">Lokasi Pencatatan</h3> </div> <div className="grid grid-cols-1 md:grid-cols-2 gap-6"> <InputGroup label="Desa"> <Select value={formData.desa} onChange={(e) => { const newDesa = e.target.value; setFormData({ ...formData, desa: newDesa, posyandu: DATA_WILAYAH[newDesa][0] }); }} disabled={user.role === ROLES.KADER || user.role === ROLES.BIDAN} options={Object.keys(DATA_WILAYAH).map(d => ({ value: d, label: d }))} /> </InputGroup> <InputGroup label="Posyandu"> <Select value={formData.posyandu} onChange={(e) => setFormData({ ...formData, posyandu: e.target.value })} disabled={user.role === ROLES.KADER} options={DATA_WILAYAH[formData.desa]?.map(p => ({ value: p, label: p })) || []} /> </InputGroup> </div> </div> <div className="grid grid-cols-1 md:grid-cols-2 gap-6"> <InputGroup label="Nama Lengkap Balita"> <input required type="text" className={inputClass} value={formData.nama} onChange={e => setFormData({ ...formData, nama: e.target.value })} /> </InputGroup> <div className="grid grid-cols-2 gap-4"> <InputGroup label="Anak Ke-"> <input required type="number" className={inputClass} value={formData.anakKe} onChange={e => setFormData({ ...formData, anakKe: e.target.value })} /> </InputGroup> <InputGroup label="Jenis Kelamin"> <Select value={formData.jk} onChange={e => setFormData({ ...formData, jk: e.target.value as Gender })} options={[{ value: 'L', label: 'Laki-laki' }, { value: 'P', label: 'Perempuan' }]} /> </InputGroup> </div> </div> <div className="grid grid-cols-1 md:grid-cols-2 gap-6"> <InputGroup label="Tanggal Lahir"> <input required type="date" className={inputClass} value={formData.tglLahir} onChange={e => setFormData({ ...formData, tglLahir: e.target.value })} /> </InputGroup> <InputGroup label="Usia Kehamilan (Minggu)"> <input required type="number" className={inputClass} value={formData.usiaKehamilan} onChange={e => setFormData({ ...formData, usiaKehamilan: e.target.value })} /> </InputGroup> </div> <div className="grid grid-cols-1 md:grid-cols-2 gap-6"> <div className="bg-slate-50 p-4 rounded-xl border border-slate-200"> <div className="flex justify-between items-center mb-2"> <label className="text-xs font-bold text-slate-500 uppercase">No. KK <span className="text-rose-500">*</span></label> <label className="flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700"> <input type="checkbox" className="rounded text-emerald-600 focus:ring-emerald-500" checked={!formData.hasKK} onChange={e => setFormData({...formData, hasKK: !e.target.checked})} /> Tidak punya KK </label> </div> <input type="text" maxLength={16} required={formData.hasKK} readOnly={!formData.hasKK} className={`${inputClass} font-mono tracking-wider ${!formData.hasKK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`} value={formData.noKK} onChange={e => setFormData({ ...formData, noKK: e.target.value.replace(/\D/g, '') })} /> </div> <div className="bg-slate-50 p-4 rounded-xl border border-slate-200"> <div className="flex justify-between items-center mb-2"> <label className="text-xs font-bold text-slate-500 uppercase">NIK Balita <span className="text-rose-500">*</span></label> <label className="flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700"> <input type="checkbox" className="rounded text-emerald-600 focus:ring-emerald-500" checked={!formData.hasNIK} onChange={e => setFormData({...formData, hasNIK: !e.target.checked})} /> Tidak punya NIK </label> </div> <input type="text" maxLength={16} required={formData.hasNIK} readOnly={!formData.hasNIK} className={`${inputClass} font-mono tracking-wider ${!formData.hasNIK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`} value={formData.nik} onChange={e => setFormData({ ...formData, nik: e.target.value.replace(/\D/g, '') })} /> </div> </div> <div className="grid grid-cols-3 gap-4"> <InputGroup label="Berat Lahir (kg)"> <input required type="number" step="0.01" className={inputClass} value={formData.bbLahir} onChange={e => setFormData({ ...formData, bbLahir: e.target.value })} /> </InputGroup> <InputGroup label="Panjang Lahir (cm)"> <input required type="number" step="0.1" className={inputClass} value={formData.pbLahir} onChange={e => setFormData({ ...formData, pbLahir: e.target.value })} /> </InputGroup> <InputGroup label="Lingkar Kepala (cm)"> <input required type="number" step="0.1" className={inputClass} value={formData.lkLahir} onChange={e => setFormData({ ...formData, lkLahir: e.target.value })} /> </InputGroup> </div> <div className="grid grid-cols-3 gap-4"> <InputGroup label="Buku KIA?"> <Select value={formData.bukuKIA} onChange={e => setFormData({ ...formData, bukuKIA: e.target.value })} options={[{value: 'Ya', label: 'Ya'}, {value: 'Tidak', label: 'Tidak'}]} /> </InputGroup> <InputGroup label="Buku KIA Kecil?"> <Select value={formData.bukuKIAKecil} onChange={e => setFormData({ ...formData, bukuKIAKecil: e.target.value })} options={[{value: 'Tidak', label: 'Tidak'}, {value: 'Ya', label: 'Ya'}]} /> </InputGroup> <InputGroup label="IMD?"> <Select value={formData.imd} onChange={e => setFormData({ ...formData, imd: e.target.value })} options={[{value: 'Ya', label: 'Ya'}, {value: 'Tidak', label: 'Tidak'}]} /> </InputGroup> </div> <div className="border-t border-slate-100 pt-4"> <h3 className="font-semibold text-slate-800 mb-4">Data Orang Tua</h3> <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4"> <InputGroup label="Nama Orang Tua"> <input required type="text" className={inputClass} value={formData.namaOrtu} onChange={e => setFormData({ ...formData, namaOrtu: e.target.value })} /> </InputGroup> <InputGroup label="NIK Orang Tua"> <input required type="text" maxLength={16} className={inputClass} value={formData.nikOrtu} onChange={e => setFormData({ ...formData, nikOrtu: e.target.value.replace(/\D/g, '') })} /> </InputGroup> </div> <InputGroup label="Alamat Lengkap"> <textarea rows={2} required className={inputClass} value={formData.alamat} onChange={e => setFormData({ ...formData, alamat: e.target.value })}></textarea> </InputGroup> <div className="grid grid-cols-3 gap-4 mt-4"> <InputGroup label="No HP"> <input type="text" className={inputClass} placeholder="Kosong = No HP Kader" value={formData.noHpOrtu} onChange={e => setFormData({ ...formData, noHpOrtu: e.target.value.replace(/\D/g, '') })} /> </InputGroup> <InputGroup label="RT"> <input required type="text" className={inputClass} value={formData.rt} onChange={e => setFormData({ ...formData, rt: e.target.value.replace(/\D/g, '') })} /> </InputGroup> <InputGroup label="RW"> <input required type="text" className={inputClass} value={formData.rw} onChange={e => setFormData({ ...formData, rw: e.target.value.replace(/\D/g, '') })} /> </InputGroup> </div> </div> <div className="pt-4 flex gap-3 justify-end border-t border-slate-100"> <Button variant="secondary" onClick={onClose} className="w-full md:w-auto">Batal</Button> <Button variant="primary" type="submit" disabled={loading} className="w-full md:w-auto">{isEdit ? 'Perbarui Data' : 'Simpan Data'}</Button> </div> </form> </div> </div> );
};

const AddChildModal: React.FC<{
  user: UserRole;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: ChildData | null;
  isEdit?: boolean;
  allChildren?: ChildData[];
}> = ({ user, onClose, onSuccess, initialData = null, isEdit = false, allChildren = [] }) => {
  const [formData, setFormData] = useState<ChildData>(() => {
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
      jk: '' as Gender,
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isEdit && initialData) setFormData({ ...initialData, hasKK: true, hasNIK: true });
  }, [initialData, isEdit]);

  useEffect(() => {
    if (!formData.hasKK) {
      setFormData((previous) => ({ ...previous, noKK: `350904${generateRandomDigits(10)}` }));
    }
  }, [formData.hasKK]);

  useEffect(() => {
    if (formData.hasNIK || !formData.tglLahir || !formData.posyandu) return;

    const birthDate = new Date(formData.tglLahir);
    const day = String(birthDate.getDate()).padStart(2, '0');
    const month = String(birthDate.getMonth() + 1).padStart(2, '0');
    const year = String(birthDate.getFullYear()).slice(-2);
    const posyanduNumber = formData.posyandu.match(/\d+/)?.[0] || '00';
    const standardNik = `350904${day}${month}${year}00${String(posyanduNumber).padStart(2, '0')}`;
    const specialPosyandu = ['SALAK 61', 'SALAK 98', 'SALAK 99'];
    const nikIsAvailable = (nik: string) => !allChildren.some((child) => child.nik === nik && child.id !== initialData?.id);

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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);

    try {
      if (isEdit && initialData?.id) {
        const changes: { field: string; oldValue: any; newValue: any }[] = [];
        Object.keys(formData).forEach((key) => {
          const field = key as keyof ChildData;
          if (
            JSON.stringify(formData[field]) !== JSON.stringify(initialData[field]) &&
            field !== 'updatedAt' &&
            field !== 'createdAt'
          ) {
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
          ...formData,
          updatedAt: serverTimestamp()
        });
      } else {
        const newChildRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), {
          ...formData,
          currentBB: formData.bbLahir,
          currentTB: formData.pbLahir,
          currentLK: formData.lkLahir,
          currentLILA: 0,
          createdAt: serverTimestamp(),
          createdBy: user.role,
          deletedAt: null
        });

        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'measurements'), {
          childId: newChildRef.id,
          childName: formData.nama,
          posyandu: formData.posyandu,
          desa: formData.desa,
          tglUkur: formData.tglLahir,
          bb: formData.bbLahir,
          tb: formData.pbLahir,
          lk: formData.lkLahir,
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

      onSuccess();
      onClose();
    } catch (error: any) {
      console.error('Gagal menyimpan: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors';
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white/80 backdrop-blur-md border-b border-slate-100 p-6 flex justify-between items-center z-10">
          <div>
            <h2 className="text-xl font-bold text-slate-800">{isEdit ? 'Edit Identitas Balita' : 'Registrasi Balita Baru'}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500" title="Tutup">
            <XCircle className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-8">
          <section className="space-y-4">
            <h3 className="font-semibold text-slate-800">Lokasi Pencatatan</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <InputGroup label="Desa">
                <Select
                  value={formData.desa}
                  onChange={(event) => {
                    const desa = event.target.value;
                    setFormData({ ...formData, desa, posyandu: DATA_WILAYAH[desa][0] });
                  }}
                  disabled={user.role === ROLES.KADER || user.role === ROLES.BIDAN}
                  required
                  options={Object.keys(DATA_WILAYAH).map((desa) => ({ value: desa, label: desa }))}
                />
              </InputGroup>
              <InputGroup label="Posyandu">
                <Select
                  value={formData.posyandu}
                  onChange={(event) => setFormData({ ...formData, posyandu: event.target.value })}
                  disabled={user.role === ROLES.KADER}
                  required
                  options={(DATA_WILAYAH[formData.desa] || []).map((posyandu) => ({ value: posyandu, label: posyandu }))}
                />
              </InputGroup>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="font-semibold text-slate-800">Identitas Balita</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <InputGroup label="Nama Lengkap Balita">
                <input required type="text" className={inputClass} value={formData.nama} onChange={(event) => setFormData({ ...formData, nama: event.target.value })} />
              </InputGroup>
              <div className="grid grid-cols-2 gap-4">
                <InputGroup label="Anak Ke-">
                  <input required min="1" type="number" className={inputClass} value={formData.anakKe} onChange={(event) => setFormData({ ...formData, anakKe: event.target.value })} />
                </InputGroup>
                <InputGroup label="Jenis Kelamin">
                  <Select required value={formData.jk} onChange={(event) => setFormData({ ...formData, jk: event.target.value as Gender })} options={genderOptions} />
                </InputGroup>
              </div>
              <InputGroup label="Tanggal Lahir">
                <input required type="date" className={inputClass} value={formData.tglLahir} onChange={(event) => setFormData({ ...formData, tglLahir: event.target.value })} />
              </InputGroup>
              <InputGroup label="Usia Kehamilan (Minggu)">
                <input required min="1" type="number" className={inputClass} value={formData.usiaKehamilan} onChange={(event) => setFormData({ ...formData, usiaKehamilan: event.target.value })} />
              </InputGroup>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">No. KK</label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700 normal-case">
                    <input type="checkbox" className="rounded text-emerald-600 focus:ring-emerald-500" checked={!formData.hasKK} onChange={(event) => setFormData({ ...formData, hasKK: !event.target.checked })} />
                    Tidak punya KK
                  </label>
                </div>
                <input required={formData.hasKK} readOnly={!formData.hasKK} inputMode="numeric" pattern="[0-9]{16}" maxLength={16} title="No. KK harus 16 digit" type="text" className={`${inputClass} font-mono tracking-wider ${!formData.hasKK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`} value={formData.noKK} onChange={(event) => setFormData({ ...formData, noKK: event.target.value.replace(/\D/g, '') })} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">NIK Balita</label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-emerald-600 font-medium hover:text-emerald-700 normal-case">
                    <input type="checkbox" className="rounded text-emerald-600 focus:ring-emerald-500" checked={!formData.hasNIK} onChange={(event) => setFormData({ ...formData, hasNIK: !event.target.checked })} />
                    Tidak punya NIK
                  </label>
                </div>
                <input required={formData.hasNIK} readOnly={!formData.hasNIK} inputMode="numeric" pattern="[0-9]{16}" maxLength={16} title="NIK balita harus 16 digit" type="text" className={`${inputClass} font-mono tracking-wider ${!formData.hasNIK ? 'bg-slate-200 text-slate-500' : 'bg-white'}`} value={formData.nik} onChange={(event) => setFormData({ ...formData, nik: event.target.value.replace(/\D/g, '') })} />
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="font-semibold text-slate-800">Data Kelahiran</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <InputGroup label="Berat Lahir (kg)">
                <input required min="0.1" type="number" step="0.01" className={inputClass} value={formData.bbLahir} onChange={(event) => setFormData({ ...formData, bbLahir: event.target.value })} />
              </InputGroup>
              <InputGroup label="Panjang Lahir (cm)">
                <input required min="0.1" type="number" step="0.1" className={inputClass} value={formData.pbLahir} onChange={(event) => setFormData({ ...formData, pbLahir: event.target.value })} />
              </InputGroup>
              <InputGroup label="Lingkar Kepala (cm)">
                <input required min="0.1" type="number" step="0.1" className={inputClass} value={formData.lkLahir} onChange={(event) => setFormData({ ...formData, lkLahir: event.target.value })} />
              </InputGroup>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <InputGroup label="Buku KIA">
                <Select required value={formData.bukuKIA} onChange={(event) => setFormData({ ...formData, bukuKIA: event.target.value })} options={yesNoOptions} />
              </InputGroup>
              <InputGroup label="Buku KIA Kecil">
                <Select required value={formData.bukuKIAKecil} onChange={(event) => setFormData({ ...formData, bukuKIAKecil: event.target.value })} options={yesNoOptions} />
              </InputGroup>
              <InputGroup label="IMD">
                <Select required value={formData.imd} onChange={(event) => setFormData({ ...formData, imd: event.target.value })} options={yesNoOptions} />
              </InputGroup>
            </div>
          </section>

          <section className="space-y-4 border-t border-slate-100 pt-6">
            <h3 className="font-semibold text-slate-800">Data Orang Tua</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <InputGroup label="Nama Orang Tua">
                <input required type="text" className={inputClass} value={formData.namaOrtu} onChange={(event) => setFormData({ ...formData, namaOrtu: event.target.value })} />
              </InputGroup>
              <InputGroup label="NIK Orang Tua">
                <input required inputMode="numeric" pattern="[0-9]{16}" maxLength={16} title="NIK orang tua harus 16 digit" type="text" className={`${inputClass} font-mono tracking-wider`} value={formData.nikOrtu} onChange={(event) => setFormData({ ...formData, nikOrtu: event.target.value.replace(/\D/g, '') })} />
              </InputGroup>
            </div>
            <InputGroup label="Alamat Lengkap">
              <textarea required rows={2} className={inputClass} value={formData.alamat} onChange={(event) => setFormData({ ...formData, alamat: event.target.value })} />
            </InputGroup>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <InputGroup label="No. HP">
                <input required inputMode="tel" pattern="[0-9]{8,15}" maxLength={15} title="No. HP harus 8 sampai 15 digit" type="text" className={inputClass} value={formData.noHpOrtu} onChange={(event) => setFormData({ ...formData, noHpOrtu: event.target.value.replace(/\D/g, '') })} />
              </InputGroup>
              <InputGroup label="RT">
                <input required inputMode="numeric" type="text" className={inputClass} value={formData.rt} onChange={(event) => setFormData({ ...formData, rt: event.target.value.replace(/\D/g, '') })} />
              </InputGroup>
              <InputGroup label="RW">
                <input required inputMode="numeric" type="text" className={inputClass} value={formData.rw} onChange={(event) => setFormData({ ...formData, rw: event.target.value.replace(/\D/g, '') })} />
              </InputGroup>
            </div>
          </section>

          <div className="pt-4 flex gap-3 justify-end border-t border-slate-100">
            <Button variant="secondary" onClick={onClose} className="w-full md:w-auto">Batal</Button>
            <Button variant="primary" type="submit" disabled={loading} className="w-full md:w-auto">
              {loading ? 'Menyimpan...' : isEdit ? 'Perbarui Data' : 'Simpan Data'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

const MeasurementModal: React.FC<{child: ChildData; existingData?: MeasurementData | null; onClose: () => void}> = ({ child, onClose }) => {
  const [activeMenu, setActiveMenu] = useState<'history' | 'add'>('history');
  const [formData, setFormData] = useState<Omit<MeasurementData, 'id' | 'childId' | 'childName' | 'posyandu' | 'desa' | 'ageInMonths'>>({
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
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<MeasurementData[]>([]);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        if (!child.id) return;
        const q = query(
          collection(db, 'artifacts', appId, 'public', 'data', 'measurements'),
          where('childId', '==', child.id)
        );
        const snapshot = await getDocs(q);
        const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as MeasurementData));
        data.sort((a, b) => new Date(b.tglUkur).getTime() - new Date(a.tglUkur).getTime());
        setHistory(data);
      } catch (error) {
        console.error('Error fetching history:', error);
      }
    };

    void fetchHistory();
  }, [child.id]);

  useEffect(() => {
    if (!formData.bb || !formData.tglUkur) return;

    const currentWeight = parseFloat(String(formData.bb));
    const currentDate = new Date(formData.tglUkur);
    const prevMeasurement = history.find((m) => new Date(m.tglUkur).getTime() < currentDate.getTime());

    if (!prevMeasurement) {
      setFormData((prev) => ({ ...prev, statusNaik: 'B' }));
      return;
    }

    const prevDate = new Date(prevMeasurement.tglUkur);
    const diffTime = Math.abs(currentDate.getTime() - prevDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 45) {
      setFormData((prev) => ({ ...prev, statusNaik: 'O' }));
      return;
    }

    const prevWeight = parseFloat(String(prevMeasurement.bb));
    const gain = (currentWeight - prevWeight) * 1000;
    const measureAgeInMonths = getAgeInMonths(child.tglLahir, currentDate);
    const minGain = getKBM(measureAgeInMonths);
    const newStatus: 'N' | 'T' = gain >= minGain ? 'N' : 'T';
    setFormData((prev) => ({ ...prev, statusNaik: newStatus }));
  }, [formData.bb, formData.tglUkur, history, child.tglLahir]);

  const measureDate = useMemo(() => new Date(formData.tglUkur), [formData.tglUkur]);
  const ageAtMeasure = useMemo(() => getAgeInMonths(child.tglLahir, measureDate), [child.tglLahir, measureDate]);

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
    if (ageAtMeasure > 24) setFormData((prev) => ({ ...prev, caraUkur: 'Berdiri' }));
    else setFormData((prev) => ({ ...prev, caraUkur: 'Terlentang' }));
  }, [ageAtMeasure, activeMenu]);

  const handleStartAdd = () => {
    setActiveMenu('add');
    setFormData((prev) => ({
      ...prev,
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

      if (child.id) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id), {
          currentBB: formData.bb,
          currentTB: formData.tb,
          currentLILA: formData.lila,
          currentLK: formData.lk,
          lastMeasurementDate: formData.tglUkur,
          updatedAt: serverTimestamp()
        });
      }

      onClose();
    } catch (error: any) {
      console.error('Gagal simpan: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 transition-colors';
  const showVitA = measureDate.getMonth() + 1 === 2 || measureDate.getMonth() + 1 === 8;
  const showAsi = ageAtMeasure >= 0 && ageAtMeasure <= 6;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="bg-emerald-600 p-6 rounded-t-3xl text-white flex justify-between items-start">
          <div>
            <h2 className="text-xl font-bold">Pengukuran Balita</h2>
            <p className="text-emerald-100 text-sm mt-1">{child.nama} • {getAgeInMonths(child.tglLahir)} Bulan</p>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white">
            <XCircle className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-4">
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

          {activeMenu === 'history' ? (
            <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">
              <h3 className="text-sm font-bold text-slate-700 mb-3">Riwayat Penimbangan Bulan ke Bulan</h3>
              {monthlyHistory.length === 0 ? (
                <p className="text-xs text-slate-500">Belum ada riwayat pengukuran.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-200">
                        <th className="text-left py-2 pr-4">Bulan</th>
                        <th className="text-left py-2 pr-4">Tanggal Ukur</th>
                        <th className="text-center py-2 px-2">BB</th>
                        <th className="text-center py-2 px-2">TB</th>
                        <th className="text-center py-2 px-2">LILA</th>
                        <th className="text-center py-2 px-2">LK</th>
                        <th className="text-center py-2 px-2">Status BB/U</th>
                        <th className="text-center py-2 px-2">Status TB/U</th>
                        <th className="text-center py-2 px-2">Status BB/TB</th>
                        <th className="text-center py-2 pl-2">Naik BB</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyHistory.map((h) => {
                        const monthLabel = new Date(h.tglUkur).toLocaleDateString('id-ID', {
                          month: 'short',
                          year: 'numeric'
                        });
                        const ageAtHistory = getAgeInMonths(child.tglLahir, new Date(h.tglUkur));
                        const stBbu = calculateGiziStatus(h.bb, 'BBU', ageAtHistory, child.jk);
                        const stTbu = calculateGiziStatus(h.tb, 'TBU', ageAtHistory, child.jk, null, h.caraUkur);
                        const stBbtb = calculateGiziStatus(h.bb, 'BBTB', ageAtHistory, child.jk, h.tb, h.caraUkur);

                        return (
                          <tr key={h.id || h.tglUkur} className="border-b border-slate-100 last:border-0 text-slate-700">
                            <td className="py-2 pr-4 font-semibold uppercase whitespace-nowrap">{monthLabel}</td>
                            <td className="py-2 pr-4 whitespace-nowrap">{formatIndoDate(h.tglUkur)}</td>
                            <td className="py-2 px-2 text-center">{h.bb || '-'}</td>
                            <td className="py-2 px-2 text-center">{h.tb || '-'}</td>
                            <td className="py-2 px-2 text-center">{h.lila || '-'}</td>
                            <td className="py-2 px-2 text-center">{h.lk || '-'}</td>
                            <td className="py-2 px-2 text-center"><StatusBadge status={stBbu} /></td>
                            <td className="py-2 px-2 text-center"><StatusBadge status={stTbu} /></td>
                            <td className="py-2 px-2 text-center"><StatusBadge status={stBbtb} /></td>
                            <td className="py-2 pl-2 text-center"><KenaikanBadge status={h.statusNaik} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <InputGroup label="Tanggal Pengukuran">
                  <input
                    required
                    type="date"
                    className={inputClass}
                    value={formData.tglUkur}
                    onChange={(e) => setFormData({ ...formData, tglUkur: e.target.value })}
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
                    onChange={(e) => setFormData({ ...formData, bb: e.target.value })}
                  />
                </InputGroup>
                <InputGroup label="Tinggi Badan (cm)">
                  <input
                    required
                    type="number"
                    step="0.1"
                    className={inputClass}
                    value={formData.tb}
                    onChange={(e) => setFormData({ ...formData, tb: e.target.value })}
                  />
                </InputGroup>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <InputGroup label="LiLa (cm)">
                  <input
                    type="number"
                    step="0.1"
                    className={inputClass}
                    value={formData.lila}
                    onChange={(e) => setFormData({ ...formData, lila: e.target.value })}
                  />
                </InputGroup>
                <InputGroup label="Lingkar Kepala (cm)">
                  <input
                    type="number"
                    step="0.1"
                    className={inputClass}
                    value={formData.lk}
                    onChange={(e) => setFormData({ ...formData, lk: e.target.value })}
                  />
                </InputGroup>
              </div>

              <input type="hidden" value={formData.statusNaik} />

              <InputGroup label="Pitting Edema Bilateral">
                <Select
                  value={formData.edema}
                  onChange={(e) => setFormData({ ...formData, edema: e.target.value })}
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
                    onChange={(e) => setFormData({ ...formData, kelasIbu: e.target.value })}
                    options={[
                      { value: 'Tidak', label: 'Tidak' },
                      { value: 'Ya', label: 'Ya' }
                    ]}
                  />
                </InputGroup>
                <InputGroup label="Terima MBG?">
                  <Select
                    value={formData.mbg}
                    onChange={(e) => setFormData({ ...formData, mbg: e.target.value })}
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
                        onChange={(e) => setFormData({ ...formData, vitA: e.target.value })}
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
                        onChange={(e) => setFormData({ ...formData, asi: e.target.value })}
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
          )}
        </div>
      </div>
    </div>
  );
};

const LoginScreen: React.FC<{onLogin: (user: UserRole) => void}> = ({ onLogin }) => {
  const [role, setRole] = useState<string>(ROLES.KADER);
  const [selectedDesa, setSelectedDesa] = useState<string>(Object.keys(DATA_WILAYAH)[0]);
  const [selectedPosyandu, setSelectedPosyandu] = useState<string>(DATA_WILAYAH[Object.keys(DATA_WILAYAH)[0]][0]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true); setErrorMsg(null);
    let userData: UserRole = { role, desa: null, posyandu: null };
    if (role === ROLES.KADER) { userData.desa = selectedDesa; userData.posyandu = selectedPosyandu; } 
    else if (role === ROLES.BIDAN) { userData.desa = selectedDesa; userData.posyandu = null; } 
    else { userData.desa = null; userData.posyandu = null; }
    try { await signInAnonymously(auth); onLogin(userData); } catch (error: any) { console.error("Gagal masuk: " + error.message); setErrorMsg("Gagal Login (Anonim): " + error.message + ". Cek tab Auth di Firebase Console."); } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden">
          <div className="bg-emerald-600 p-8 text-center">
             <div className="inline-flex items-center justify-center w-16 h-16 bg-white/20 rounded-full mb-4 backdrop-blur-sm p-2"><img src="/logo-puskesmas-32981.svg" alt="Logo Puskesmas Gumukmas" className="w-10 h-10 object-contain" /></div>
             <h1 className="text-2xl font-bold text-white">E-Posyandu</h1><p className="text-white font-medium text-sm mt-1">UPTD Puskesmas Gumukmas</p><p className="text-emerald-100 text-xs mt-1">Sistem Informasi Gizi & Kesehatan Ibu Anak</p>
          </div>
          <div className="p-8 space-y-6">
             <InputGroup label="Pilih Peran Akses"><Select value={role} onChange={(e) => setRole(e.target.value)} options={Object.values(ROLES).map(r => ({value: r, label: r}))} /></InputGroup>
             {(role === ROLES.KADER || role === ROLES.BIDAN) && (<InputGroup label="Pilih Desa"><Select value={selectedDesa} onChange={(e) => { setSelectedDesa(e.target.value); setSelectedPosyandu(DATA_WILAYAH[e.target.value][0]); }} options={Object.keys(DATA_WILAYAH).map(d => ({value: d, label: d}))} /></InputGroup>)}
             {role === ROLES.KADER && (<InputGroup label="Pilih Posyandu"><Select value={selectedPosyandu} onChange={(e) => setSelectedPosyandu(e.target.value)} options={DATA_WILAYAH[selectedDesa].map(p => ({value: p, label: p}))} /></InputGroup>)}
             {errorMsg && (<div className="bg-rose-50 border border-rose-100 p-3 rounded-xl text-rose-600 text-xs break-all"><strong>Error:</strong> {errorMsg}</div>)}
             <Button onClick={handleLogin} disabled={loading} className="w-full justify-center mt-4">{loading ? 'Memproses...' : 'Masuk Dashboard'}</Button>
          </div>
          <div className="bg-slate-50 px-8 py-4 text-center text-xs text-slate-400">&copy; 2026 UPTD Puskesmas Gumukmas</div>
        </div>
      </div>
    </div>
  );
};

// --- MAIN DASHBOARD LAYOUT & LOGIC ---

export const Dashboard: React.FC<{user: UserRole; onLogout: () => void}> = ({ user, onLogout }) => {
  const [children, setChildren] = useState<ChildData[]>([]);
  const [monthlyMeasurements, setMonthlyMeasurements] = useState<Record<string, MeasurementData>>({});
  const [previousMonthMeasurements, setPreviousMonthMeasurements] = useState<Record<string, MeasurementData>>({});
  const [previousMonthLoaded, setPreviousMonthLoaded] = useState(false);
  const [pmtPrograms, setPmtPrograms] = useState<PmtProgramData[]>([]);
  const [mpasiLogs, setMpasiLogs] = useState<Record<string, MpasiData>>({});
  const [changeLogs, setChangeLogs] = useState<ChangeLogData[]>([]);
  
  const [editingChild, setEditingChild] = useState<ChildData | null>(null);
  const [childToDelete, setChildToDelete] = useState<ChildData | null>(null); 
  const [childToMpasi, setChildToMpasi] = useState<ChildData | null>(null);
  const [pmtModalData, setPmtModalData] = useState<{child: ChildData, category: 'Wasting' | 'Underweight' | 'TidakNaik'} | null>(null);
  const [pmtMonitoringData, setPmtMonitoringData] = useState<{program: PmtProgramData, child: ChildData} | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState('recent'); 
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => getDashboardHashState().tab); 
  const [measurementChildId, setMeasurementChildId] = useState<string | null>(() => getDashboardHashState().measurementChildId);
  const [measurementBackTab, setMeasurementBackTab] = useState<DashboardTab>('data_balita');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [filterMonth, setFilterMonth] = useState<number>(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState<number>(new Date().getFullYear());
  const [viewDesa, setViewDesa] = useState(user.role === ROLES.GIZI ? '' : (user.desa || ''));
  const [viewPosyandu, setViewPosyandu] = useState(user.role === ROLES.KADER ? (user.posyandu || '') : '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    const syncTabFromHash = () => {
      const hashState = getDashboardHashState();
      setActiveTab(hashState.tab);
      setMeasurementChildId(hashState.measurementChildId);
    };
    window.addEventListener('hashchange', syncTabFromHash);
    return () => window.removeEventListener('hashchange', syncTabFromHash);
  }, []);

  // Fetch Children
  useEffect(() => {
    const childrenCollection = collection(db, 'artifacts', appId, 'public', 'data', 'children');
    const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
    const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
    let q = query(childrenCollection);
    if (scopedDesa && scopedPosyandu) {
      q = query(childrenCollection, where('desa', '==', scopedDesa), where('posyandu', '==', scopedPosyandu));
    } else if (scopedDesa) {
      q = query(childrenCollection, where('desa', '==', scopedDesa));
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      setErrorMsg(null);
      let data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChildData));
      if (user.role === ROLES.KADER) data = data.filter(c => c.posyandu === user.posyandu && c.desa === user.desa);
      else if (user.role === ROLES.BIDAN) data = data.filter(c => c.desa === user.desa);
      const now = new Date().getTime(); const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      data.forEach(async (child) => { if (child.deletedAt && child.id && (now - child.deletedAt.toDate().getTime() > THIRTY_DAYS_MS)) await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', child.id)); });
      data.sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)); 
      setChildren(data); setLoading(false);
    }, (err) => { console.error(err); setErrorMsg("Gagal memuat data: " + err.message); setLoading(false); });
    return () => unsubscribe();
  }, [user, viewDesa, viewPosyandu]);

  // Reset pagination when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchTerm, sortOrder, viewDesa, viewPosyandu, filterMonth, filterYear]);

  // Fetch Change Logs
  useEffect(() => {
      if (activeTab === 'change_history') {
          setLoading(true);
          const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'change_logs'), orderBy('timestamp', 'desc'));
          const unsubscribe = onSnapshot(q, (snapshot) => {
              const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChangeLogData));
              setChangeLogs(logs);
              setLoading(false);
          });
          return () => unsubscribe();
      }
  }, [activeTab]);

  // Fetch Monthly Measurements
  useEffect(() => {
    setLoading(true);
    const m = String(filterMonth).padStart(2, '0'); const y = filterYear; const startStr = `${y}-${m}-01`; const endStr = `${y}-${m}-31`; 
    const measurementsCollection = collection(db, 'artifacts', appId, 'public', 'data', 'measurements');
    const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
    const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
    let q = query(
        measurementsCollection,
        where('tglUkur', '>=', startStr),
        where('tglUkur', '<=', endStr)
    );
    if (scopedDesa && scopedPosyandu) {
      q = query(
        measurementsCollection,
        where('tglUkur', '>=', startStr),
        where('tglUkur', '<=', endStr),
        where('desa', '==', scopedDesa),
        where('posyandu', '==', scopedPosyandu)
      );
    } else if (scopedDesa) {
      q = query(
        measurementsCollection,
        where('tglUkur', '>=', startStr),
        where('tglUkur', '<=', endStr),
        where('desa', '==', scopedDesa)
      );
    }
    const unsubscribe = onSnapshot(q, (snapshot) => {
        const mapping: Record<string, MeasurementData> = {};
        snapshot.docs.forEach((doc) => {
            const data = doc.data() as MeasurementData;
            if (data.tglUkur >= startStr && data.tglUkur <= endStr) mapping[data.childId] = { id: doc.id, ...data };
        });
        setMonthlyMeasurements(mapping); setLoading(false);
    }, (error) => { console.error("Error fetching measurements:", error); setLoading(false); });
    return () => unsubscribe();
  }, [filterMonth, filterYear, user, viewDesa, viewPosyandu]); 

  // Fetch the preceding month only while the dashboard needs the O indicator.
  useEffect(() => {
    if (activeTab !== 'dashboard') {
      setPreviousMonthMeasurements({});
      setPreviousMonthLoaded(false);
      return;
    }

    setPreviousMonthLoaded(false);
    const previousDate = new Date(filterYear, filterMonth - 2, 1);
    const previousYear = previousDate.getFullYear();
    const previousMonth = String(previousDate.getMonth() + 1).padStart(2, '0');
    const startStr = `${previousYear}-${previousMonth}-01`;
    const endStr = `${previousYear}-${previousMonth}-31`;
    const measurementsCollection = collection(db, 'artifacts', appId, 'public', 'data', 'measurements');
    const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
    const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
    let q = query(
      measurementsCollection,
      where('tglUkur', '>=', startStr),
      where('tglUkur', '<=', endStr)
    );

    if (scopedDesa && scopedPosyandu) {
      q = query(
        measurementsCollection,
        where('tglUkur', '>=', startStr),
        where('tglUkur', '<=', endStr),
        where('desa', '==', scopedDesa),
        where('posyandu', '==', scopedPosyandu)
      );
    } else if (scopedDesa) {
      q = query(
        measurementsCollection,
        where('tglUkur', '>=', startStr),
        where('tglUkur', '<=', endStr),
        where('desa', '==', scopedDesa)
      );
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const mapping: Record<string, MeasurementData> = {};
      snapshot.docs.forEach((doc) => {
        const data = doc.data() as MeasurementData;
        const existing = mapping[data.childId];
        if (!existing || data.tglUkur > existing.tglUkur) mapping[data.childId] = { id: doc.id, ...data };
      });
      setPreviousMonthMeasurements(mapping);
      setPreviousMonthLoaded(true);
    }, (error) => {
      console.error('Error fetching previous measurements:', error);
      setPreviousMonthMeasurements({});
      setPreviousMonthLoaded(true);
    });

    return () => unsubscribe();
  }, [activeTab, filterMonth, filterYear, user, viewDesa, viewPosyandu]);

  // Fetch PMT Programs (only active ones)
  useEffect(() => {
      if (activeTab === 'pmt_program') {
          const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'pmt_programs'));
          const unsubscribe = onSnapshot(q, (snapshot) => { setPmtPrograms(snapshot.docs.map(doc => ({id: doc.id, ...doc.data()} as PmtProgramData))); });
          return () => unsubscribe();
      }
  }, [activeTab]);

  // Fetch MPASI Logs
  useEffect(() => {
    if (activeTab === 'mpasi') {
        setLoading(true);
        const m = String(filterMonth).padStart(2, '0');
        const y = filterYear;
        const startStr = `${y}-${m}-01`;
        const endStr = `${y}-${m}-31`; 
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'mpasi_logs'), where('tglMonitoring', '>=', startStr), where('tglMonitoring', '<=', endStr));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const mapping: Record<string, MpasiData> = {};
            snapshot.docs.forEach(doc => { const data = doc.data() as MpasiData; mapping[data.childId] = { id: doc.id, ...data }; });
            setMpasiLogs(mapping); setLoading(false);
        });
        return () => unsubscribe();
    }
  }, [activeTab, filterMonth, filterYear]);

  const filteredByLocation = useMemo<ChildData[]>(() => {
      return children.filter(c => {
          const matchDesa = viewDesa ? c.desa === viewDesa : true;
          const matchPosyandu = viewPosyandu ? c.posyandu === viewPosyandu : true;
          return matchDesa && matchPosyandu;
      });
  }, [children, viewDesa, viewPosyandu]);

  const currentFilterDate = useMemo(() => new Date(filterYear, filterMonth - 1, 1), [filterYear, filterMonth]);

  const activeChildren = useMemo<ChildData[]>(() => filteredByLocation.filter(c => {
      if (c.deletedAt) return false;
      const age = getAgeInMonths(c.tglLahir, currentFilterDate);
      return age >= 0 && age <= 59;
  }), [filteredByLocation, currentFilterDate]);

  const deletedChildren = useMemo<ChildData[]>(() => filteredByLocation.filter(c => c.deletedAt), [filteredByLocation]);
  
  const newInputs = useMemo<ChildData[]>(() => activeChildren.filter(c => {
        if (!c.createdAt) return false;
        const d = c.createdAt.toDate();
        return d.getMonth() + 1 === parseInt(String(filterMonth)) && d.getFullYear() === parseInt(String(filterYear));
  }), [activeChildren, filterMonth, filterYear]);

  const stats = useMemo(() => {
      const S = activeChildren.length;
      const B = newInputs.length;
      const O = previousMonthLoaded
        ? activeChildren.filter((child) => child.id && !previousMonthMeasurements[child.id]).length
        : null;
      const reportMonthEnd = new Date(filterYear, filterMonth, 0);
      const asiTargets = activeChildren.filter((child) => getAgeInMonths(child.tglLahir, reportMonthEnd) === 6);
      let D = 0, N = 0, T = 0, underweight = 0, stunting = 0, wasting = 0, asiEksklusif = 0;
      if (S > 0) {
          activeChildren.forEach(child => {
              if (child.id) {
                  const m = monthlyMeasurements[child.id];
                  if (getAgeInMonths(child.tglLahir, reportMonthEnd) === 6 && m?.asi === 'Ya') asiEksklusif++;
                  if (m && m.bb) {
                      D++; 
                      if (m.statusNaik === 'N') N++; else if (m.statusNaik === 'T') T++;
                      const age = getAgeInMonths(child.tglLahir, new Date(m.tglUkur));
                      if (["Berat Sangat Kurang", "Berat Kurang"].includes(calculateGiziStatus(m.bb, 'BBU', age, child.jk))) underweight++;
                      if (["Sangat Pendek", "Pendek"].includes(calculateGiziStatus(m.tb, 'TBU', age, child.jk, null, m.caraUkur))) stunting++;
                      if (["Gizi Buruk", "Gizi Kurang"].includes(calculateGiziStatus(m.bb, 'BBTB', age, child.jk, m.tb, m.caraUkur))) wasting++;
                  }
              }
          });
      }
      return { 
          S, D, N, T, B, O, asiEksklusif, asiTarget: asiTargets.length, underweight, stunting, wasting, 
          perD: S > 0 ? ((D / S) * 100).toFixed(1) : "0", 
          perN: D > 0 ? ((N / D) * 100).toFixed(1) : "0", 
          perT: D > 0 ? ((T / D) * 100).toFixed(1) : "0",
          perAsiEksklusif: asiTargets.length > 0 ? ((asiEksklusif / asiTargets.length) * 100).toFixed(1) : "0",
          perUnderweight: D > 0 ? ((underweight / D) * 100).toFixed(1) : "0",
          perStunting: D > 0 ? ((stunting / D) * 100).toFixed(1) : "0",
          perWasting: D > 0 ? ((wasting / D) * 100).toFixed(1) : "0"
      };
  }, [activeChildren, filterMonth, filterYear, monthlyMeasurements, newInputs, previousMonthLoaded, previousMonthMeasurements]);

  const handleDeleteConfirm = async (id: string, deleteData: Partial<ChildData>) => { try { await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id), { deletedAt: serverTimestamp(), ...deleteData }); setChildToDelete(null); } catch (e: any) { console.error("Gagal hapus: " + e.message); } };
  const handleRestore = async (id: string | undefined) => { if (!id) return; try { await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id), { deletedAt: null, deleteReason: null, deathDate: null, deathCause: null, deathLocation: null }); } catch (e: any) { console.error("Gagal memulihkan: " + e.message); } };
  const handlePermanentDelete = async (id: string | undefined) => { if (!id) return; try { await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id)); } catch (e: any) { console.error("Gagal hapus permanen: " + e.message); } };

  const handleImportIdentitas = async (e: React.ChangeEvent<HTMLInputElement>) => {
     const file = e.target.files?.[0]; if (!file) return;
     let xlsx: any;
     try {
       xlsx = await ensureXlsx();
     } catch (error: any) {
       console.error(error.message);
       return;
     }
     const reader = new FileReader();
     reader.onload = async (evt) => {
        try {
           const wb = xlsx.read(evt.target?.result, { type: 'binary' });
           const ws = wb.Sheets[wb.SheetNames[0]];
           const data: any[] = xlsx.utils.sheet_to_json(ws);
           let importDesa = user.desa || '', importPosyandu = user.posyandu || '';
           if (user.role === ROLES.GIZI) { if (!viewDesa || !viewPosyandu) return; importDesa = viewDesa; importPosyandu = viewPosyandu; } 
           else if (user.role === ROLES.BIDAN) { if (!viewPosyandu) return; importDesa = user.desa || ''; importPosyandu = viewPosyandu; }
           for (const row of data) {
               const cleanNIK = row['NIK'] ? String(row['NIK']).replace(/'/g, '') : '';
               const cleanKK = row['nomor_KK'] ? String(row['nomor_KK']).replace(/'/g, '') : '';
               const cleanNIKOrtu = row['nik_ortu'] ? String(row['nik_ortu']).replace(/'/g, '') : '';
               const childData: any = {
                 anakKe: row['anak_ke'] || '', tglLahir: row['tgl_lahir'] || '', jk: row['jenis_kelamin'] === 'Laki-laki' ? 'L' : 'P',
                 noKK: cleanKK, nik: cleanNIK, hasKK: !!cleanKK, hasNIK: !!cleanNIK, nama: row['nama_anak'] || '',
                 usiaKehamilan: row['usia_hamil'] || '', bbLahir: row['berat_lahir'] || '', pbLahir: row['panjang_lahir'] || '',
                 lkLahir: row['lingkar_kepala_lahir'] || '', bukuKIA: row['kia'] || 'Tidak', bukuKIAKecil: row['kia_bayi_kecil'] || 'Tidak',
                 imd: row['imd'] || 'Tidak', namaOrtu: row['nama_ortu'] || '', nikOrtu: cleanNIKOrtu, noHpOrtu: row['hp_ortu'] || '',
                 alamat: row['alamat'] || '', rt: row['rt'] || '', rw: row['rw'] || '', desa: importDesa, posyandu: importPosyandu,
                 currentBB: row['berat_lahir'] || '', currentTB: row['panjang_lahir'] || '', currentLILA: 0, currentLK: row['lingkar_kepala_lahir'] || '',
                 createdAt: serverTimestamp(), createdBy: user.role, deletedAt: null
               };
               if (childData.nama && childData.tglLahir) { await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), childData); }
           }
        } catch (error: any) { console.error("Gagal: " + error.message); } finally { if (fileInputRef.current) fileInputRef.current.value = ""; }
     };
     reader.readAsBinaryString(file);
  };

  const handleExportSigizi = async () => {
    const xlsx = await ensureXlsx();
     const headers = ["No", "anak_ke", "tgl_lahir", "jenis_kelamin", "nomor_KK", "NIK", "nama_anak", "usia_hamil", "berat_lahir", "panjang_lahir", "lingkar_kepala_lahir", "kia", "kia_bayi_kecil", "imd", "nama_ortu", "nik_ortu", "hp_ortu", "alamat", "rt", "rw", "hapus", "pindah"];
     const rows = newInputs.map((child, index) => [
       index + 1, child.anakKe, child.tglLahir, child.jk === 'L' ? 'Laki-laki' : 'Perempuan', child.noKK, child.nik, child.nama, child.usiaKehamilan, child.bbLahir, child.pbLahir, child.lkLahir, child.bukuKIA, child.bukuKIAKecil, child.imd, child.namaOrtu, child.nikOrtu, child.noHpOrtu || '-', child.alamat || "", child.rt, child.rw, "", "" 
     ]);
     const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
     const workbook = xlsx.utils.book_new();
     xlsx.utils.book_append_sheet(workbook, worksheet, "Data Balita");
     xlsx.writeFile(workbook, `Format_Identitas_Sigizi_${MONTHS[filterMonth-1]}_${filterYear}.xls`);
  };

  const handleExportPengukuranSigizi = async () => {
    const xlsx = await ensureXlsx();
    const headers = ["No", "NIK", "nama_anak", "TANGGALUKUR", "BERAT", "TINGGI", "LILA", "lingkar_kepala", "Pitting_edema", "CARAUKUR", "vita", "asi_bulan_0", "asi_bulan_1", "asi_bulan_2", "asi_bulan_3", "asi_bulan_4", "asi_bulan_5", "asi_bulan_6", "kelas_ibu_balita", "mbg"];
    const childById = new Map(activeChildren.filter((child) => child.id).map((child) => [child.id as string, child]));
    const measurementsCollection = collection(db, 'artifacts', appId, 'public', 'data', 'measurements');
    const scopedDesa = user.role === ROLES.GIZI ? viewDesa : user.desa;
    const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
    let historyQuery = query(measurementsCollection);

    if (scopedDesa && scopedPosyandu) {
      historyQuery = query(measurementsCollection, where('desa', '==', scopedDesa), where('posyandu', '==', scopedPosyandu));
    } else if (scopedDesa) {
      historyQuery = query(measurementsCollection, where('desa', '==', scopedDesa));
    }

    const historySnapshot = await getDocs(historyQuery);
    const asiByChildAndAge = new Map<string, Map<number, MeasurementData>>();

    historySnapshot.docs.forEach((historyDoc) => {
      const measurement = { id: historyDoc.id, ...historyDoc.data() } as MeasurementData;
      const child = childById.get(measurement.childId);
      if (!child || !measurement.tglUkur) return;

      const ageAtMeasurement = getAgeInMonths(child.tglLahir, new Date(measurement.tglUkur));
      if (ageAtMeasurement < 0 || ageAtMeasurement > 6) return;

      const childAsiHistory = asiByChildAndAge.get(measurement.childId) || new Map<number, MeasurementData>();
      const existing = childAsiHistory.get(ageAtMeasurement);
      if (!existing || measurement.tglUkur > existing.tglUkur) childAsiHistory.set(ageAtMeasurement, measurement);
      asiByChildAndAge.set(measurement.childId, childAsiHistory);
    });

    const rows = activeChildren.map((child, index) => {
      if (!child.id) return [];
      const childId = child.id;
      const m = monthlyMeasurements[childId];
      const hasData = !!m;
      let edemaVal = "";
      if (hasData) {
        if (m.edema === 'Tidak') edemaVal = 'tidak';
        else if (m.edema.includes('+1')) edemaVal = '1';
        else if (m.edema.includes('+2')) edemaVal = '2';
        else if (m.edema.includes('+3')) edemaVal = '3';
      }

      const asiCols = Array.from({ length: 7 }, (_, age) => {
        const asi = asiByChildAndAge.get(childId)?.get(age)?.asi;
        return asi === 'Ya' ? 'ya' : asi === 'Tidak' ? 'tidak' : '';
      });

      return [ index + 1, child.nik, child.nama, hasData ? m.tglUkur : "", hasData ? m.bb : "", hasData ? m.tb : "", hasData ? m.lila : "", hasData ? m.lk : "", edemaVal, hasData ? (m.caraUkur || "").toLowerCase() : "", hasData ? (m.vitA || "Tidak").toLowerCase() : "", ...asiCols, hasData ? (m.kelasIbu || "Tidak").toLowerCase() : "", hasData ? (m.mbg || "Tidak").toLowerCase() : "" ];
    });
    const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Data Pengukuran");
    xlsx.writeFile(workbook, `Format_Ukur_Sigizi_${MONTHS[filterMonth-1]}_${filterYear}.xls`);
  };

  // --- NEW EXPORT FUNCTION FOR TABLES ---
  const handleExportTable = async () => {
      const xlsx = await ensureXlsx();
      
      const headers = ["No", "Nama", "NIK", "Jenis Kelamin", "Tgl Lahir", "Usia (Bln)", "Nama Ortu", "Desa", "Posyandu", "BB (kg)", "PB/TB (cm)", "LILA (cm)", "LK (cm)", "Status Naik", "Status BB/U", "Status PB/TB-U", "Status BB/PB atau BB/TB", "Status IMT/U"];
      
      const rows = displayData.map((child, index) => {
          if (!child.id) return [];
          const m = monthlyMeasurements[child.id];
          const age = getAgeInMonths(child.tglLahir, m?.tglUkur ? new Date(m.tglUkur) : currentFilterDate);
          const st_bbu = calculateGiziStatus(m?.bb, 'BBU', age, child.jk);
          const st_tbu = calculateGiziStatus(m?.tb, 'TBU', age, child.jk, null, m?.caraUkur);
          const st_bbtb = calculateGiziStatus(m?.bb, 'BBTB', age, child.jk, m?.tb, m?.caraUkur);
          const st_imtu = calculateGiziStatus(m?.bb, 'IMTU', age, child.jk, m?.tb, m?.caraUkur);

          return [
              index + 1,
              child.nama,
              child.nik,
              child.jk === 'L' ? 'Laki-laki' : 'Perempuan',
              child.tglLahir,
              age,
              child.namaOrtu,
              child.desa,
              child.posyandu,
              m?.bb || '-',
              m?.tb || '-',
              m?.lila || '-',
              m?.lk || '-',
              m?.statusNaik || '-',
              st_bbu,
              st_tbu,
              st_bbtb,
              st_imtu
          ];
      });

      const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, worksheet, "Data Export");
      
      let filenamePrefix = "Data_Balita";
      if (activeTab === 'problem_underweight') filenamePrefix = "Balita_Underweight";
      if (activeTab === 'problem_stunting') filenamePrefix = "Balita_Stunting";
      if (activeTab === 'problem_wasting') filenamePrefix = "Balita_Wasting";
      if (activeTab === 'problem_tidak_naik') filenamePrefix = "Balita_Tidak_Naik";

      xlsx.writeFile(workbook, `${filenamePrefix}_${MONTHS[filterMonth-1]}_${filterYear}.xls`);
  };

  const handleExportMpasi = async () => {
    const xlsx = await ensureXlsx();
    const headers = ["No", "NIK", "Nama", "tgl_monitoring", "asi", "sereal", "kacang", "susu", "daging/unggas", "telur", "buah_sayur_vita", "buah_sayur_lain", "dapat_intervensi"];
    
    // Helper to convert boolean-ish arrays/strings to 1 or 0
    const toBin = (val: any) => {
        if (val === 'Ya') return 1;
        if (Array.isArray(val) && val.length > 0 && val[0] === 'Ya') return 1;
        return 0;
    };

    const rows = getDisplayData().map((child, index) => {
        if (!child.id) return [];
        const log = mpasiLogs[child.id];
        const hasLog = !!log;
        return [
            index + 1, 
            child.nik, 
            child.nama,
            hasLog ? log.tglMonitoring : "-",
            hasLog ? toBin(log.asi) : 0,
            hasLog ? toBin(log.makananPokok) : 0,
            hasLog ? toBin(log.kacang) : 0,
            hasLog ? toBin(log.susu) : 0,
            hasLog ? toBin(log.daging) : 0,
            hasLog ? toBin(log.telur) : 0,
            hasLog ? toBin(log.sayurVitA) : 0,
            hasLog ? toBin(log.sayurLain) : 0,
            hasLog ? toBin(log.intervensiGizi) : 0
        ];
    });
    
    const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Data MPASI");
    xlsx.writeFile(workbook, `Laporan_MPASI_${MONTHS[filterMonth-1]}_${filterYear}.csv`);
  };

  const handleExportPmt = async () => {
    const xlsx = await ensureXlsx();
    
    const headers = ["nik","nama","tanggal_pemberian_pertama","siklus_ke","jenis_pmt","sumber_anggaran","mitra","mitra_lain","pmt_sesuai_juknis","alasan_pemberian","minggu_ke","tanggal_pemantauan","hari_1","hari_2","hari_3","hari_4","hari_5","hari_6","hari_7","bb","tb","cara_ukur","pemantauan_kesehatan","tindak_lanjut"];
    
    // Helper Maps
    const mapJenisPmt = (val: string) => val === 'Pabrikan' ? 1 : 2;
    const mapSumberAnggaran = (val: string) => {
        if (val === 'DAK Non Fisik') return 1;
        if (val === 'APBD') return 2;
        if (val === 'Mitra') return 3;
        if (val === 'Dana Desa') return 4;
        return 0;
    };
    const mapAlasan = (val: string) => {
        if (val === 'Wasting') return 1;
        if (val === 'Underweight') return 2;
        if (val === 'TidakNaik') return 3;
        return 0;
    };
    const mapCaraUkur = (val: string) => val === 'Berdiri' ? 1 : 2;
    const mapKesehatan = (val: string) => val === 'Ada' ? 1 : 0;
    const mapTindakLanjut = (val: string) => {
        if (val === 'Dilanjutkan') return 1;
        if (val === 'Selesai') return 2;
        if (val === 'Rujuk RS') return 3;
        return 0;
    };
    const mapSesuaiJuknis = (val: string) => val === 'Ya' ? 1 : 0;

    const generateRows = (category: string) => {
        const rows: any[] = [];
        const filteredPrograms = pmtPrograms.filter(p => p.category === category);
        
        filteredPrograms.forEach((prog) => {
            const child = children.find(c => c.id === prog.childId);
            if (!child) return;

            const maxWeeks = prog.category === 'Wasting' ? 8 : (prog.category === 'Underweight' ? 4 : 2);
            
            for (let i = 1; i <= maxWeeks; i++) {
                const m = prog.monitorings?.[i];
                // Only add rows for weeks that have data or filler data
                const rowData = [
                    child.nik,
                    child.nama,
                    prog.tglPemberian,
                    prog.siklusKe || 1,
                    mapJenisPmt(prog.jenisPmt),
                    mapSumberAnggaran(prog.sumberAnggaran),
                    prog.mitra || "",
                    prog.mitraLain || "",
                    mapSesuaiJuknis(prog.pmtSesuaiJuknis),
                    mapAlasan(prog.category),
                    i, // Minggu Ke
                    m ? m.tgl : "",
                    m?.days?.[0] ? 1 : 0,
                    m?.days?.[1] ? 1 : 0,
                    m?.days?.[2] ? 1 : 0,
                    m?.days?.[3] ? 1 : 0,
                    m?.days?.[4] ? 1 : 0,
                    m?.days?.[5] ? 1 : 0,
                    m?.days?.[6] ? 1 : 0,
                    m ? m.bb : "",
                    m ? m.tb : "",
                    m ? mapCaraUkur(m.caraUkur) : "",
                    m ? mapKesehatan(m.pemantauanKesehatan) : "",
                    m ? mapTindakLanjut(m.tindakLanjut) : ""
                ];
                rows.push(rowData);
            }
        });
        return rows;
    };

    const workbook = xlsx.utils.book_new();

    // Sheet 1: Wasting
    const rowsWasting = generateRows('Wasting');
    const wsWasting = xlsx.utils.aoa_to_sheet([headers, ...rowsWasting]);
    xlsx.utils.book_append_sheet(workbook, wsWasting, "Wasting");

    // Sheet 2: Underweight
    const rowsUnderweight = generateRows('Underweight');
    const wsUnderweight = xlsx.utils.aoa_to_sheet([headers, ...rowsUnderweight]);
    xlsx.utils.book_append_sheet(workbook, wsUnderweight, "Underweight");

    // Sheet 3: Tidak Naik (T)
    const rowsTidakNaik = generateRows('TidakNaik');
    const wsTidakNaik = xlsx.utils.aoa_to_sheet([headers, ...rowsTidakNaik]);
    xlsx.utils.book_append_sheet(workbook, wsTidakNaik, "Tidak Naik");

    xlsx.writeFile(workbook, `Laporan_PMT_Lengkap_${MONTHS[filterMonth-1]}_${filterYear}.xls`);
  };

  const getSortedData = (data: ChildData[]) => {
      const sorted = [...data];
      switch (sortOrder) {
        case 'name_asc': return sorted.sort((a, b) => a.nama.localeCompare(b.nama));
        case 'name_desc': return sorted.sort((a, b) => b.nama.localeCompare(a.nama));
        case 'recent': return sorted.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        case 'oldest_input': return sorted.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
        case 'age_oldest': return sorted.sort((a, b) => new Date(a.tglLahir).getTime() - new Date(b.tglLahir).getTime());
        case 'age_youngest': return sorted.sort((a, b) => new Date(b.tglLahir).getTime() - new Date(a.tglLahir).getTime());
        default: return sorted;
      }
  };

  const getDisplayData = (): ChildData[] => {
    switch (activeTab) {
      case 'recycle_bin': return deletedChildren;
      case 'recent': return newInputs; 
      case 'problem_underweight': 
        return activeChildren.filter(c => {
           if (!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m || !m.bb) return false;
           const age = getAgeInMonths(c.tglLahir, new Date(m.tglUkur));
           return ["Berat Sangat Kurang", "Berat Kurang"].includes(calculateGiziStatus(m.bb, 'BBU', age, c.jk));
        });
      case 'problem_stunting': 
        return activeChildren.filter(c => {
           if (!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m || !m.tb) return false;
           const age = getAgeInMonths(c.tglLahir, new Date(m.tglUkur));
           return ["Sangat Pendek", "Pendek"].includes(calculateGiziStatus(m.tb, 'TBU', age, c.jk, null, m.caraUkur));
        });
      case 'problem_wasting': 
        return activeChildren.filter(c => {
           if (!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m || !m.bb || !m.tb) return false;
           const age = getAgeInMonths(c.tglLahir, new Date(m.tglUkur));
           return ["Gizi Buruk", "Gizi Kurang"].includes(calculateGiziStatus(m.bb, 'BBTB', age, c.jk, m.tb, m.caraUkur));
        });
      case 'problem_tidak_naik':
        return activeChildren.filter(c => {
           if (!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m) return false;
           return m.statusNaik === 'T';
        });
      case 'mpasi':
        return activeChildren.filter(c => {
            const age = getAgeInMonths(c.tglLahir, currentFilterDate);
            return age >= 6 && age <= 23;
        });
      default: return activeChildren; 
    }
  };

  const countUnderweight = useMemo(() => activeChildren.filter(c => { if(!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m || !m.bb) return false; const age = getAgeInMonths(c.tglLahir, new Date(m.tglUkur)); return ["Berat Sangat Kurang", "Berat Kurang"].includes(calculateGiziStatus(m.bb, 'BBU', age, c.jk)); }).length, [activeChildren, monthlyMeasurements]);
  const countStunting = useMemo(() => activeChildren.filter(c => { if(!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m || !m.tb) return false; const age = getAgeInMonths(c.tglLahir, new Date(m.tglUkur)); return ["Sangat Pendek", "Pendek"].includes(calculateGiziStatus(m.tb, 'TBU', age, c.jk, null, m.caraUkur)); }).length, [activeChildren, monthlyMeasurements]);
  const countWasting = useMemo(() => activeChildren.filter(c => { if(!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m || !m.bb || !m.tb) return false; const age = getAgeInMonths(c.tglLahir, new Date(m.tglUkur)); return ["Gizi Buruk", "Gizi Kurang"].includes(calculateGiziStatus(m.bb, 'BBTB', age, c.jk, m.tb, m.caraUkur)); }).length, [activeChildren, monthlyMeasurements]);
  const countTidakNaik = useMemo(() => activeChildren.filter(c => { if(!c.id) return false; const m = monthlyMeasurements[c.id]; if (!m) return false; return m.statusNaik === 'T'; }).length, [activeChildren, monthlyMeasurements]);

  const rawDisplayData = getDisplayData().filter(c => c.nama.toLowerCase().includes(searchTerm.toLowerCase()) || c.nik.includes(searchTerm));
  const displayData = getSortedData(rawDisplayData);

  // --- PAGINATION LOGIC ---
  const totalPages = Math.ceil(displayData.length / itemsPerPage);
  const paginatedData = displayData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const measurementChild = useMemo(
    () => children.find((child) => child.id === measurementChildId) || null,
    [children, measurementChildId]
  );

  const handleOpenMeasurementPage = (child: ChildData) => {
    if (!child.id) return;
    const backTab = activeTab === 'measurement' ? measurementBackTab : activeTab;
    setMeasurementBackTab(backTab === 'measurement' ? 'data_balita' : backTab);
    setMeasurementChildId(child.id);
    setActiveTab('measurement');
    const targetHash = `#measurement/${encodeURIComponent(child.id)}`;
    if (window.location.hash !== targetHash) window.location.hash = targetHash;
  };

  const handleBackFromMeasurement = () => {
    const backTab = measurementBackTab === 'measurement' ? 'data_balita' : measurementBackTab;
    setMeasurementChildId(null);
    setActiveTab(backTab);
    if (window.location.hash !== `#${backTab}`) window.location.hash = backTab;
  };

  const SidebarItem: React.FC<{ id: string; label: string; icon: any; onClick?: () => void; count?: number }> = ({ id, label, icon: Icon, onClick, count }) => (
    <button onClick={onClick ? onClick : () => { if (isDashboardTab(id)) { setActiveTab(id); if (window.location.hash !== `#${id}`) window.location.hash = id; } setIsSidebarOpen(false); }} className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 group ${activeTab === id ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-bold shadow-lg shadow-emerald-200/50' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}>
      <div className="flex items-center gap-3"><Icon className={`w-5 h-5 ${activeTab === id ? 'text-white' : 'text-slate-400 group-hover:text-emerald-500'}`} /><span className="text-sm text-left">{label}</span></div>
      {count !== undefined && (<span className={`text-[10px] font-bold px-2 py-0.5 rounded-full min-w-[20px] text-center ${activeTab === id ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>{count}</span>)}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-50/50 font-sans text-slate-900 flex">
      {isSidebarOpen && (<div className="fixed inset-0 bg-slate-900/50 z-40 lg:hidden" onClick={() => setIsSidebarOpen(false)}></div>)}
      <aside className={`fixed lg:sticky top-0 h-screen w-72 bg-white border-r border-slate-200 flex flex-col z-50 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-6 border-b border-slate-100 flex items-center gap-3"><div className="p-1 rounded-xl bg-white shadow-sm border border-emerald-100"><img src="/logo-puskesmas-32981.svg" alt="Logo E-Posyandu" className="w-8 h-8" /></div><div><h1 className="text-lg font-bold text-slate-800 leading-tight">E-Posyandu</h1><p className="text-[10px] font-bold text-emerald-600 uppercase tracking-tight">UPTD Puskesmas Gumukmas</p><p className="text-xs text-slate-400 font-medium tracking-wide">VERSI 2.4</p></div></div>
        <div className="flex-1 overflow-y-auto py-6 px-4 space-y-1">
          <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Menu Utama</p>
          <SidebarItem id="dashboard" label="Dashboard" icon={LayoutDashboard} />
          <SidebarItem id="data_balita" label="Data Balita" icon={Users} count={activeChildren.length} />
          <SidebarItem id="asi_eksklusif" label="ASI Eksklusif" icon={Baby} />
          <SidebarItem id="mpasi" label="MPASI (6-23 Bln)" icon={Utensils} />
          <div className="py-2"></div>
          <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Analisis Gizi (Filter)</p>
          <SidebarItem id="problem_underweight" label="Balita Underweight" icon={TrendingDown} count={countUnderweight} />
          <SidebarItem id="problem_stunting" label="Balita Stunting" icon={Ruler} count={countStunting} />
          <SidebarItem id="problem_wasting" label="Balita Wasting" icon={AlertCircle} count={countWasting} />
          <SidebarItem id="problem_tidak_naik" label="Balita Tidak Naik" icon={Minus} count={countTidakNaik} />
          <SidebarItem id="pmt_program" label="Pemberian PMT" icon={Gift} />
          <div className="py-4"></div>
          <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Manajemen Data</p>
          <SidebarItem id="add_child" label="Tambah Balita" icon={Plus} onClick={() => setShowAddModal(true)} />
          <SidebarItem id="recent" label="Balita Baru Diinput" icon={Clock} count={newInputs.length} />
          <SidebarItem id="change_history" label="Riwayat Perubahan" icon={History} />
          <SidebarItem id="recycle_bin" label="Daftar Dihapus" icon={Trash2} />
        </div>
        <div className="p-4 border-t border-slate-100 bg-slate-50/50"><div className="flex items-center gap-3 mb-4 px-2"><div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 font-bold">{user.role.charAt(0)}</div><div className="overflow-hidden"><p className="text-sm font-bold text-slate-700 truncate">{user.role}</p><p className="text-xs text-slate-500 truncate">{user.desa || 'Semua Wilayah'}</p></div></div><Button variant="ghost" onClick={onLogout} className="w-full justify-start text-rose-600 hover:bg-rose-50 hover:text-rose-700"><LogOut className="w-4 h-4" /> Keluar Sistem</Button></div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
         <header className="bg-white/80 backdrop-blur-xl sticky top-0 z-30 border-b border-slate-200 px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm transition-all duration-300">
            <div className="flex items-center justify-between w-full md:w-auto">
                <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 -ml-2 text-slate-500 hover:bg-slate-100 rounded-lg"><Menu className="w-6 h-6" /></button>
                <div className="md:hidden font-bold text-slate-700">E-Posyandu <span className="text-xs font-normal text-slate-500 block">UPTD Pusk. Gumukmas</span></div>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto">
                <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-200 w-full sm:w-auto shadow-sm">
                    <div className="px-2 text-slate-400"><Clock className="w-4 h-4"/></div>
                    <select value={filterMonth} onChange={(e) => setFilterMonth(parseInt(e.target.value))} className="bg-transparent text-sm font-medium text-slate-700 focus:outline-none cursor-pointer flex-1 sm:flex-none">{MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}</select>
                    <div className="w-px h-4 bg-slate-300 mx-1"></div>
                    <select value={filterYear} onChange={(e) => setFilterYear(parseInt(e.target.value))} className="bg-transparent text-sm font-medium text-slate-700 focus:outline-none cursor-pointer flex-1 sm:flex-none">{YEARS.map(y => <option key={y} value={y}>{y}</option>)}</select>
                </div>
                {user.role === ROLES.GIZI && (<div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-200 w-full sm:w-[200px] shadow-sm"><div className="px-2 text-slate-400"><MapPin className="w-4 h-4"/></div><select value={viewDesa} onChange={(e) => { setViewDesa(e.target.value); setViewPosyandu(''); }} className="bg-transparent text-sm font-medium text-slate-700 focus:outline-none w-full cursor-pointer"><option value="">Semua Desa</option>{Object.keys(DATA_WILAYAH).map(d => <option key={d} value={d}>{d}</option>)}</select></div>)}
                {(user.role === ROLES.GIZI || user.role === ROLES.BIDAN) && (<div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-200 w-full sm:w-[200px] shadow-sm"><div className="px-2 text-slate-400"><MapPin className="w-4 h-4"/></div><select value={viewPosyandu} onChange={(e) => setViewPosyandu(e.target.value)} className="bg-transparent text-sm font-medium text-slate-700 focus:outline-none w-full cursor-pointer"><option value="">Semua Posyandu</option>{(viewDesa ? DATA_WILAYAH[viewDesa] : (user.role === ROLES.BIDAN ? DATA_WILAYAH[user.desa || ''] : []))?.map(p => (<option key={p} value={p}>{p}</option>))}</select></div>)}
            </div>
         </header>

         <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-x-hidden">
            {errorMsg && (<div className="mb-6 bg-rose-50 border border-rose-200 p-4 rounded-xl text-rose-700 flex items-center gap-3"><AlertTriangle className="w-5 h-5 flex-shrink-0" /><p className="text-sm font-medium">{errorMsg}</p></div>)}

            <React.Suspense fallback={<div className="py-12 text-center text-slate-400"><Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />Memuat Halaman...</div>}>
              {activeTab === 'measurement' ? (
                measurementChild ? (
                  <MeasurementPage child={measurementChild} onBack={handleBackFromMeasurement} />
                ) : (
                  <Card className="p-8 text-center text-slate-500">
                    {loading ? 'Memuat data balita...' : 'Data balita tidak ditemukan atau tidak dapat diakses.'}
                  </Card>
                )
              ) : activeTab === 'dashboard' ? (
                <DashboardOverviewPage
                  stats={stats}
                  filterMonth={filterMonth}
                  filterYear={filterYear}
                  viewDesa={viewDesa}
                  viewPosyandu={viewPosyandu}
                />
              ) : activeTab === 'asi_eksklusif' ? (
                <ExclusiveBreastfeedingPage
                  childrenData={activeChildren}
                  currentFilterDate={currentFilterDate}
                  filterMonth={filterMonth}
                  filterYear={filterYear}
                  monthlyMeasurements={monthlyMeasurements}
                />
              ) : activeTab === 'pmt_program' ? (
                <PmtProgramPage
                  childrenData={children}
                  pmtPrograms={pmtPrograms}
                  onExportPmt={handleExportPmt}
                  onOpenMonitoring={(program, child) => setPmtMonitoringData({ program, child })}
                />
              ) : activeTab === 'change_history' ? (
                <ChangeHistoryPage changeLogs={changeLogs} />
              ) : (
                <ChildrenTablePage
                  activeTab={activeTab}
                  currentFilterDate={currentFilterDate}
                  currentPage={currentPage}
                  displayData={displayData}
                  fileInputRef={fileInputRef}
                  filterMonth={filterMonth}
                  filterYear={filterYear}
                  handleExportMpasi={handleExportMpasi}
                  handleExportPengukuranSigizi={handleExportPengukuranSigizi}
                  handleExportSigizi={handleExportSigizi}
                  handleExportTable={handleExportTable}
                  handleImportIdentitas={handleImportIdentitas}
                  handlePermanentDelete={handlePermanentDelete}
                  handleRestore={handleRestore}
                  itemsPerPage={itemsPerPage}
                  loading={loading}
                  monthlyMeasurements={monthlyMeasurements}
                  mpasiLogs={mpasiLogs}
                  paginatedData={paginatedData}
                  searchTerm={searchTerm}
                  setChildToDelete={setChildToDelete}
                  setChildToMpasi={setChildToMpasi}
                  setCurrentPage={setCurrentPage}
                  setEditingChild={setEditingChild}
                  setPmtModalData={setPmtModalData}
                  setSearchTerm={setSearchTerm}
                  onOpenMeasurement={handleOpenMeasurementPage}
                  setShowAddModal={setShowAddModal}
                  setSortOrder={setSortOrder}
                  sortOrder={sortOrder}
                  user={user}
                />
              )}
            </React.Suspense>
         </main>
      </div>

      {showAddModal && (<AddChildModal user={user} onClose={() => setShowAddModal(false)} onSuccess={() => setShowAddModal(false)} allChildren={children} />)}
      {editingChild && (<AddChildModal user={user} isEdit={true} initialData={editingChild} onClose={() => setEditingChild(null)} onSuccess={() => setEditingChild(null)} allChildren={children} />)}
      {childToDelete && (<DeleteChildModal child={childToDelete} onClose={() => setChildToDelete(null)} onConfirm={handleDeleteConfirm} />)}
      {childToMpasi && (<MpasiModal child={childToMpasi} onClose={() => setChildToMpasi(null)} />)}
      {pmtModalData && (<PmtModal child={pmtModalData.child} category={pmtModalData.category} onClose={() => setPmtModalData(null)} />)}
      {pmtMonitoringData && (<PmtMonitoringModal program={pmtMonitoringData.program} child={pmtMonitoringData.child} onClose={() => setPmtMonitoringData(null)} />)}
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<UserRole | null>(null);
  const [initializing, setInitializing] = useState(true);
  useEffect(() => { const initAuth = async () => { try { await signInAnonymously(auth); } catch (err) { console.error("Auth Init Failed:", err); } }; initAuth(); const unsubscribe = onAuthStateChanged(auth, (authUser) => { if (!authUser) setUser(null); setInitializing(false); }); return () => unsubscribe(); }, []);
  if (initializing) return (<div className="h-screen w-full flex items-center justify-center bg-slate-50"><Loader2 className="w-10 h-10 animate-spin text-emerald-600" /></div>);
  if (!user) return <LoginScreen onLogin={setUser} />;
  return <Dashboard user={user} onLogout={() => { signOut(auth); setUser(null); }} />;
}
