import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createAdminAccount,
  deleteAdminAccount,
  getAdminAccountsOverview,
  getBackendReadiness,
  updateAdminAccount,
  type AdminAccountInput,
  type AdminAccountPresence,
  type AdminAccountsOverview,
  type BackendReadiness
} from '../../api/adminApi';
import { getAuth, startPasskeyRegistration, verifyPasskeyRegistration } from '../../api/authApi';
import { DATA_WILAYAH } from '../../config/dashboard';
import { SkeletonBlock } from '../../components/base';
import {
  Activity,
  CheckCircle2,
  Clock,
  CloudflareLogo,
  ClipboardCheck,
  Loader2,
  NeonLogo,
  Pencil,
  PostgreSQLLogo,
  RedisLogo,
  RotateCcw,
  Search,
  SupabaseLogo,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
  X
} from '../../ui/icons';
import { completeWebAuthnRegistration, passkeyErrorMessage } from '../../security/webauthn';
import ReactAdminMonitoringPage from './ReactAdminMonitoringPage';

type Role = AdminAccountInput['role'];
type Form = AdminAccountInput & { active: boolean };
type AdminSection = 'overview' | 'accounts' | 'monitoring';

const ROLE_OPTIONS = ['Semua role', 'Administrator', 'Ahli Gizi', 'Bidan Desa', 'Kader Posyandu'];
const ACCOUNT_ROLES: Array<{ value: Role; label: string }> = [
  { value: 'super_admin', label: 'Administrator' },
  { value: 'Ahli Gizi', label: 'Ahli Gizi' },
  { value: 'Bidan Desa', label: 'Bidan Desa' },
  { value: 'Kader Posyandu', label: 'Kader Posyandu' }
];
const initialVillage = Object.keys(DATA_WILAYAH)[0] || '';
const locationData: Record<string, string[]> = DATA_WILAYAH;

const roleName = (role: string | null) => role === 'super_admin' ? 'Administrator' : role || 'Tanpa role';
const accessName = (mode: 'read' | 'write') => mode === 'read' ? 'Hanya Baca' : 'Bisa Edit';
const emptyForm = (): Form => ({
  email: '', username: '', role: 'Kader Posyandu', village: initialVillage,
  posyandu: locationData[initialVillage]?.[0] || '', accessMode: 'write', active: true
});
const accountForm = (account: AdminAccountPresence): Form => ({
  email: account.email || '', username: account.username || '',
  role: (account.role || 'Kader Posyandu') as Role, village: account.village,
  posyandu: account.posyandu, accessMode: account.accessMode || 'write', active: account.active
});
const formatDateTime = (value: string | null) => {
  if (!value) return 'Belum ada aktivitas';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Waktu tidak tersedia';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(date);
};

const serviceLabel = (key: string) => ({
  api: 'API Utama', database: 'Database', authentication: 'Autentikasi', cache: 'Cache',
  queue: 'Antrean', storage: 'Penyimpanan', nutritionWorker: 'Worker Gizi',
  dataProcessingWorker: 'Data Processing Worker', nativeCore: 'Backend Native',
  migrationProxy: 'Jalur Migrasi', 'oracle-api': 'Oracle API Gateway',
  'identity-service': 'Identity Service', 'read-service': 'Read Service',
  'write-service': 'Write Service', 'operations-service': 'Operations Service',
  'realtime-service': 'Realtime Service', 'monitoring-service': 'Monitoring Service',
  'redis-cache': 'Redis Cache', 'data-processing-worker': 'Data Processing Worker',
  'health-proxy': 'Health Proxy', 'oracle-database': 'Database Oracle',
  'supabase-database': 'Database Supabase', 'neon-database': 'Database Neon',
  'edge-api': 'Edge API', 'cloudflare-pages': 'Frontend Cloudflare Pages',
  'cloudflare-queue': 'Queue Cloudflare'
}[key] || key);

const serviceIcon = (key: string) => ({
  'oracle-api': Activity, 'identity-service': Users, 'read-service': ClipboardCheck,
  'write-service': Pencil, 'operations-service': ClipboardCheck, 'realtime-service': Activity,
  'monitoring-service': TrendingUp, 'redis-cache': RedisLogo,
  'data-processing-worker': Activity, 'health-proxy': CheckCircle2,
  'oracle-database': PostgreSQLLogo, 'supabase-database': SupabaseLogo,
  'neon-database': NeonLogo, 'edge-api': CloudflareLogo,
  'cloudflare-pages': CloudflareLogo, 'cloudflare-queue': CloudflareLogo
}[key] || Activity);

const serviceTone = (key: string) => ({
  'oracle-api': 'blue', 'identity-service': 'cyan', 'read-service': 'indigo',
  'write-service': 'blue', 'operations-service': 'indigo', 'realtime-service': 'pink',
  'monitoring-service': 'orange', 'redis-cache': 'red', 'data-processing-worker': 'orange',
  'health-proxy': 'slate', 'oracle-database': 'postgres', 'supabase-database': 'green',
  'neon-database': 'purple', 'edge-api': 'orange', 'cloudflare-pages': 'orange',
  'cloudflare-queue': 'orange'
}[key] || 'blue');

const serviceOnline = (component: Record<string, unknown>) => {
  if (component.enabled === false || component.configured === false) return false;
  if (component.reachable === false || component.databaseReachable === false) return false;
  return !['unavailable', 'unhealthy', 'down', 'disabled'].includes(String(component.status || '').toLowerCase());
};
const serviceDetail = (component: Record<string, unknown>) => {
  const detail = component.primary || component.origin || component.managedBy || component.provider || component.protocol || component.status;
  return detail ? String(detail).replace(/-/g, ' ') : 'Terhubung ke backend aplikasi';
};
const statusEntries = (value: unknown): Array<[string, Record<string, unknown>]> =>
  Object.entries(value && typeof value === 'object' ? value as Record<string, unknown> : {})
    .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]) && typeof entry[1] === 'object');

function ServiceStatusGroups({ readiness, loading }: { readiness: BackendReadiness | null; loading: boolean }) {
  const groups = [
    { key: 'frontend', title: 'Frontend & layanan Cloudflare', entries: statusEntries(readiness?.components?.frontendServices) },
    { key: 'oracle', title: 'Backend Oracle · layanan internal', entries: statusEntries(readiness?.components?.oracleServices) },
    { key: 'databases', title: 'Layanan database', entries: statusEntries(readiness?.components?.databases) }
  ];
  return <div className="admin-service-grid">
    {loading && groups.every((group) => group.entries.length === 0)
      ? <div className="admin-loading-state"><Loader2 className="h-5 w-5 animate-spin" /> Memeriksa backend...</div>
      : groups.map((group) => <div key={group.key} className="admin-service-group">
        <h4>{group.title}</h4>
        <div className="admin-service-group-grid">
          {group.entries.length === 0 ? <p className="admin-service-empty">Status belum tersedia.</p> : group.entries.map(([key, component]) => {
            const online = serviceOnline(component);
            const ServiceIcon = serviceIcon(key);
            return <article key={key} className="admin-service-card">
              <span className={`admin-service-icon is-${serviceTone(key)} ${online ? 'is-online' : 'is-offline'}`}><ServiceIcon className="h-5 w-5" /></span>
              <div><strong>{serviceLabel(key)}</strong><p>{serviceDetail(component)}</p></div>
              <span className={`admin-service-state ${online ? 'is-online' : 'is-offline'}`}>{online ? 'Online' : 'Offline'}</span>
            </article>;
          })}
        </div>
      </div>)}
  </div>;
}

export type ReactAdminBackendPageProps = { user?: Record<string, unknown> };

/** Strict React administrator console with complete account, passkey, and service parity. */
export default function ReactAdminBackendPage({ user }: ReactAdminBackendPageProps) {
  const [overview, setOverview] = useState<AdminAccountsOverview | null>(null);
  const [readiness, setReadiness] = useState<BackendReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [section, setSection] = useState<AdminSection>('overview');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('Semua role');
  const [editor, setEditor] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<AdminAccountPresence | null>(null);
  const [passkeySaving, setPasskeySaving] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const [nextOverview, nextReadiness] = await Promise.all([getAdminAccountsOverview(), getBackendReadiness()]);
      setOverview(nextOverview); setReadiness(nextReadiness); setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Administrasi backend tidak dapat dimuat.');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void load(true); };
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('online', refresh);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', refresh); };
  }, [load]);

  useEffect(() => {
    if (!editor && !deleting) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) { if (deleting) setDeleting(null); else setEditor(null); }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; document.addEventListener('keydown', close);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', close); };
  }, [editor, deleting, saving]);

  const accounts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('id-ID');
    return (overview?.accounts || []).filter((account) => {
      const text = [account.username, account.email, roleName(account.role), account.village, account.posyandu, accessName(account.accessMode)].filter(Boolean).join(' ').toLocaleLowerCase('id-ID');
      return (roleFilter === 'Semua role' || roleName(account.role) === roleFilter) && (!query || text.includes(query));
    });
  }, [overview, roleFilter, search]);
  const selectedAccount = editor && editor !== 'new' ? overview?.accounts.find((account) => account.userId === editor) : null;
  const isNew = editor === 'new';
  const roleNeedsVillage = form.role === 'Kader Posyandu' || form.role === 'Bidan Desa';

  const openCreate = () => { setSection('accounts'); setForm(emptyForm()); setEditor('new'); setDeleting(null); setError(null); setNotice(null); };
  const openEdit = (account: AdminAccountPresence) => { setForm(accountForm(account)); setEditor(account.userId); setDeleting(null); setError(null); setNotice(null); };
  const changeRole = (role: Role) => setForm((current) => {
    if (role === 'super_admin' || role === 'Ahli Gizi') return { ...current, role, village: null, posyandu: null, accessMode: role === 'super_admin' ? 'write' : current.accessMode };
    const village = current.village || initialVillage;
    return { ...current, role, village, posyandu: role === 'Kader Posyandu' ? (current.posyandu || locationData[village]?.[0] || '') : null };
  });

  const saveAccount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editor) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const payload: AdminAccountInput = {
        email: form.email.trim(), username: form.username.trim().toLowerCase(), role: form.role,
        village: roleNeedsVillage ? form.village : null, posyandu: form.role === 'Kader Posyandu' ? form.posyandu : null,
        accessMode: form.role === 'super_admin' ? 'write' : form.accessMode, ...(isNew ? {} : { active: form.active })
      };
      const result = isNew ? await createAdminAccount(payload) : await updateAdminAccount(editor, payload);
      setNotice(result.message || (isNew ? 'Akun dibuat dan undangan aktivasi telah dikirim.' : 'Perubahan akun tersimpan.'));
      setEditor(null); await load(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Perubahan akun tidak dapat disimpan.'); }
    finally { setSaving(false); }
  };

  const removeAccount = async () => {
    if (!deleting) return;
    setSaving(true); setError(null);
    try { await deleteAdminAccount(deleting.userId); setNotice(`Akun ${deleting.username || deleting.email || ''} berhasil dihapus.`); setDeleting(null); await load(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Akun tidak dapat dihapus.'); }
    finally { setSaving(false); }
  };

  const registerPasskey = async () => {
    if (passkeySaving) return;
    setPasskeySaving(true); setError(null); setNotice(null);
    try {
      const challenge = await startPasskeyRegistration();
      const ceremony = await completeWebAuthnRegistration(challenge);
      const result = await verifyPasskeyRegistration(getAuth(), ceremony.challengeId, ceremony.credential);
      setNotice(result.recoveryCodes?.length ? 'Passkey berhasil didaftarkan. Simpan recovery code secara offline.' : 'Passkey berhasil didaftarkan untuk akun Administrator.');
    } catch (cause) { setError(passkeyErrorMessage(cause, 'create')); }
    finally { setPasskeySaving(false); }
  };

  const summary = overview?.summary || { total: 0, active: 0, online: 0, offline: 0 };
  return <div className="admin-backend-page" data-react-admin-backend="true">
    <section className="admin-backend-hero"><div className="admin-backend-hero-copy"><span className="admin-backend-access-badge"><CheckCircle2 className="h-4 w-4" />Akses administrator</span><h2>Administrasi Backend</h2><p>Kelola akun, role, batas wilayah, hak baca/edit, serta pantau layanan dan aktivitas akun.</p></div><button type="button" className="admin-backend-refresh" onClick={() => void load(true)} disabled={refreshing} aria-label="Perbarui status backend">{refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}<span>{refreshing ? 'Memperbarui' : 'Perbarui'}</span></button></section>
    {error ? <div role="alert" className="admin-backend-error"><strong>Permintaan belum berhasil.</strong><span>{error}</span></div> : null}
    {notice ? <div role="status" className="admin-backend-notice"><CheckCircle2 className="h-4 w-4" /><span>{notice}</span></div> : null}
    <nav className="admin-backend-tabs" role="tablist" aria-label="Menu administrasi backend">{(['overview', 'accounts', 'monitoring'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={section === item} className={section === item ? 'is-active' : ''} onClick={() => { setSection(item); if (item !== 'accounts') setEditor(null); }}>{item === 'overview' ? 'Ringkasan' : item === 'accounts' ? 'Manajemen Akun' : 'Monitoring'}</button>)}</nav>
    {section === 'overview' ? <>
      <section className="admin-backend-summary" aria-label="Ringkasan akun">{[['Total akun', summary.total, 'blue'], ['Sedang online', summary.online, 'green'], ['Offline', summary.offline, 'slate'], ['Akun aktif', summary.active, 'purple']].map(([label, value, tone]) => <article key={String(label)} className={`admin-summary-card is-${tone}`}><span>{label}</span><strong>{loading ? '—' : value}</strong></article>)}</section>
      <section className="admin-backend-section admin-security-section"><div className="admin-section-heading"><div><h3>Keamanan Administrator</h3><p>Passkey dikelola melalui WebAuthn dan digunakan untuk mengaktifkan akses penuh.</p></div><button type="button" className="admin-primary-action" onClick={() => void registerPasskey()} disabled={passkeySaving}>{passkeySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{passkeySaving ? 'Mendaftarkan…' : 'Daftarkan passkey'}</button></div></section>
      <section className="admin-backend-section"><div className="admin-section-heading"><div><h3>Status layanan</h3><p>{readiness?.environment || 'Memeriksa koneksi layanan...'}</p></div>{readiness ? <span className={`admin-system-badge ${readiness.ok ? 'is-online' : 'is-offline'}`}><span className="admin-presence-dot" />{readiness.ok ? 'Sistem siap' : 'Perlu perhatian'}</span> : null}</div><ServiceStatusGroups readiness={readiness} loading={loading} /></section>
    </> : section === 'monitoring' ? <ReactAdminMonitoringPage user={user as any} /> : <section className="admin-backend-section admin-account-section"><div className="admin-section-heading admin-account-heading"><div><h3>Manajemen akun</h3><p>Online berarti ada aktivitas aplikasi dalam {Math.round((overview?.onlineWindowSeconds || 180) / 60)} menit terakhir.</p></div><div className="admin-heading-actions"><span className="admin-account-count"><Users className="h-4 w-4" />{accounts.length} akun</span><button type="button" className="admin-add-account" onClick={openCreate}><UserPlus className="h-4 w-4" />Tambah akun</button></div></div>
      <div className="admin-account-toolbar"><label className="admin-search-control"><Search className="h-4 w-4" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari username, email, wilayah, atau hak akses" aria-label="Cari akun" /></label><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="Filter role akun">{ROLE_OPTIONS.map((role) => <option key={role}>{role}</option>)}</select></div>
      <div className="admin-account-table-wrap"><table className="admin-account-table"><thead><tr><th>Akun</th><th>Role & wilayah</th><th>Hak akses</th><th>Status akun</th><th>Aktivitas terakhir</th><th>Tindakan</th></tr></thead><tbody>{loading && accounts.length === 0 ? Array.from({ length: 6 }, (_, index) => <tr key={`loading-${index}`} aria-hidden="true"><td colSpan={6}><SkeletonBlock className="h-8 w-full" /></td></tr>) : accounts.length === 0 ? <tr><td colSpan={6} className="admin-table-empty">Tidak ada akun yang sesuai.</td></tr> : accounts.map((account) => <tr key={account.userId}><td><div className="admin-account-identity"><span className="admin-account-avatar">{(account.username || account.email || 'A').charAt(0).toUpperCase()}</span><div><strong>{account.username || 'Tanpa username'}</strong><p>{account.email || 'Email tidak tersedia'}</p></div></div></td><td><strong className="admin-role-label">{roleName(account.role)}</strong><p className="admin-account-scope">{[account.village, account.posyandu].filter(Boolean).join(' · ') || 'Akses global'}</p></td><td><span className={`admin-access-mode is-${account.accessMode}`}>{accessName(account.accessMode)}</span></td><td><div className="admin-status-stack"><span className={`admin-presence-badge is-${account.presenceStatus}`}><span className="admin-presence-dot" />{account.presenceStatus === 'online' ? 'Online' : 'Offline'}</span><span className={`admin-active-label ${account.active ? 'is-active' : 'is-inactive'}`}>{account.active ? 'Akun aktif' : 'Akun nonaktif'}</span></div></td><td><div className="admin-last-seen"><Clock className="h-4 w-4" /><span>{formatDateTime(account.lastSeenAt)}</span></div></td><td><div className="admin-row-actions"><button type="button" disabled={account.isCurrentAccount} onClick={() => openEdit(account)} title={account.isCurrentAccount ? 'Akun yang sedang digunakan dilindungi' : 'Edit akun'}><Pencil className="h-4 w-4" /><span>Edit</span></button><button type="button" className="is-danger" disabled={account.isCurrentAccount} onClick={() => setDeleting(account)} title="Hapus akun"><Trash2 className="h-4 w-4" /><span>Hapus</span></button></div></td></tr>)}</tbody></table></div><p className="admin-checked-at">Diperiksa {formatDateTime(overview?.checkedAt || null)} · diperbarui otomatis setiap 30 detik</p>
    </section>}
    {editor ? <div className="admin-account-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditor(null); }}><form className="admin-account-editor admin-account-modal" onSubmit={saveAccount} role="dialog" aria-modal="true" aria-labelledby="admin-account-editor-title"><div className="admin-editor-heading"><div><h4 id="admin-account-editor-title">{isNew ? 'Tambah akun baru' : `Edit ${selectedAccount?.username || selectedAccount?.email || 'akun'}`}</h4><p>{isNew ? 'Undangan aktivasi akan dikirim ke email.' : 'Perubahan hak akses akan membatalkan sesi lama akun ini.'}</p></div><button type="button" className="admin-editor-close" disabled={saving} onClick={() => setEditor(null)} aria-label="Tutup formulir"><X className="h-4 w-4" /></button></div><div className="admin-editor-grid"><label><span>Email</span><input required type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></label><label><span>Username</span><input required minLength={3} maxLength={32} pattern="[a-z0-9][a-z0-9._-]{2,31}" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value.toLowerCase() }))} /></label><label><span>Role</span><select value={form.role} onChange={(event) => changeRole(event.target.value as Role)}>{ACCOUNT_ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label><label><span>Hak akses data</span><select value={form.role === 'super_admin' ? 'write' : form.accessMode} disabled={form.role === 'super_admin'} onChange={(event) => setForm((current) => ({ ...current, accessMode: event.target.value as 'read' | 'write' }))}><option value="write">Bisa Edit</option><option value="read">Hanya Baca</option></select></label>{roleNeedsVillage ? <label><span>Desa</span><select required value={form.village || ''} onChange={(event) => setForm((current) => ({ ...current, village: event.target.value, posyandu: current.role === 'Kader Posyandu' ? (locationData[event.target.value]?.[0] || '') : null }))}>{Object.keys(DATA_WILAYAH).map((village) => <option key={village}>{village}</option>)}</select></label> : null}{form.role === 'Kader Posyandu' ? <label><span>Posyandu</span><select required value={form.posyandu || ''} onChange={(event) => setForm((current) => ({ ...current, posyandu: event.target.value }))}>{(locationData[form.village || initialVillage] || []).map((posyandu) => <option key={posyandu}>{posyandu}</option>)}</select></label> : null}{!isNew ? <label className="admin-active-control"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} /><span>Akun aktif</span></label> : null}</div><div className="admin-editor-actions"><button type="button" className="admin-secondary-action" onClick={() => setEditor(null)} disabled={saving}>Batal</button><button type="submit" className="admin-primary-action" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{saving ? (isNew ? 'Mengirim…' : 'Menyimpan…') : (isNew ? 'Kirim undangan' : 'Simpan perubahan')}</button></div></form></div> : null}
    {deleting ? <div className="admin-account-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDeleting(null); }}><section className="admin-delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="admin-delete-account-title"><span className="admin-delete-icon"><Trash2 className="h-6 w-6" /></span><div className="admin-delete-copy"><h4 id="admin-delete-account-title">Hapus akun?</h4><p>Akses akun akan dihapus permanen dan tindakan ini tidak dapat dibatalkan.</p></div><div className="admin-delete-account-summary"><span className="admin-account-avatar">{(deleting.username || deleting.email || 'A').charAt(0).toUpperCase()}</span><div><strong>{deleting.username || 'Tanpa username'}</strong><p>{deleting.email || 'Email tidak tersedia'}</p></div></div><div className="admin-delete-modal-actions"><button type="button" className="admin-secondary-action" disabled={saving} onClick={() => setDeleting(null)}>Batal</button><button type="button" className="admin-danger-action" disabled={saving} onClick={() => void removeAccount()}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{saving ? 'Menghapus…' : 'Ya, hapus akun'}</button></div></section></div> : null}
  </div>;
}
