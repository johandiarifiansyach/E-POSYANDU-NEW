import Native, { useEffect, useMemo, useState } from '../runtime/dom';
import {
    createAdminAccount, deleteAdminAccount, getAdminAccountsOverview, getBackendReadiness,
    updateAdminAccount, type AdminAccountInput, type AdminAccountPresence,
    type AdminAccountsOverview, type BackendReadiness
} from '../api/adminApi';
import { DATA_WILAYAH } from '../config/dashboard';
import AdminMonitoringPanel from './AdminMonitoringPanel';
import {
    Activity, CheckCircle2, Clock, Loader2, Pencil, RotateCcw, Search, Trash2,
    UserPlus, Users, X
} from '../ui/icons';

type AccountRole = AdminAccountInput['role'];
type AccountForm = AdminAccountInput & { active: boolean };
type AdminSection = 'overview' | 'accounts' | 'monitoring';

const ROLE_OPTIONS = ['Semua role', 'Administrator', 'Ahli Gizi', 'Bidan Desa', 'Kader Posyandu'];
const ADMIN_SECTIONS: Array<{ value: AdminSection; label: string }> = [
    { value: 'overview', label: 'Ringkasan' },
    { value: 'accounts', label: 'Manajemen Akun' },
    { value: 'monitoring', label: 'Monitoring' }
];
const ACCOUNT_ROLES: Array<{ value: AccountRole; label: string }> = [
    { value: 'super_admin', label: 'Administrator' },
    { value: 'Ahli Gizi', label: 'Ahli Gizi' },
    { value: 'Bidan Desa', label: 'Bidan Desa' },
    { value: 'Kader Posyandu', label: 'Kader Posyandu' }
];
const villages = Object.keys(DATA_WILAYAH);
const locationData: Record<string, string[]> = DATA_WILAYAH;
const initialVillage = villages[0] || '';

const emptyForm = (): AccountForm => ({
    email: '', username: '', role: 'Kader Posyandu', village: initialVillage,
    posyandu: locationData[initialVillage]?.[0] || '', accessMode: 'write', active: true
});
const roleLabel = (role: string | null) => role === 'super_admin' ? 'Administrator' : (role || 'Tanpa role');
const accessLabel = (mode: 'read' | 'write') => mode === 'read' ? 'Hanya Baca' : 'Bisa Edit';
const formatDateTime = (value: string | null) => {
    if (!value) return 'Belum ada aktivitas';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Waktu tidak tersedia';
    return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta'
    }).format(date);
};
const serviceLabel = (key: string) => ({
    api: 'API Utama', database: 'Database', authentication: 'Autentikasi', cache: 'Cache',
    queue: 'Antrean', storage: 'Penyimpanan', nutritionWorker: 'Worker Gizi',
    nativeCore: 'Backend Native', migrationProxy: 'Jalur Migrasi'
}[key] || key);
const serviceOnline = (component: Record<string, unknown>) => {
    if (component.enabled === false || component.configured === false) return false;
    if (component.reachable === false || component.databaseReachable === false) return false;
    return !['unavailable', 'unhealthy', 'down', 'disabled'].includes(String(component.status || '').toLowerCase());
};
const serviceDetail = (component: Record<string, unknown>) => {
    const detail = component.primary || component.origin || component.managedBy || component.provider || component.status;
    return detail ? String(detail).replace(/-/g, ' ') : 'Terhubung ke backend aplikasi';
};
const accountToForm = (account: AdminAccountPresence): AccountForm => ({
    email: account.email || '', username: account.username || '',
    role: (account.role || 'Kader Posyandu') as AccountRole,
    village: account.village, posyandu: account.posyandu,
    accessMode: account.accessMode || 'write', active: account.active
});

export default function AdminBackendPage() {
    const [overview, setOverview] = useState<AdminAccountsOverview | null>(null);
    const [readiness, setReadiness] = useState<BackendReadiness | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('Semua role');
    const [editor, setEditor] = useState<'new' | string | null>(null);
    const [form, setForm] = useState<AccountForm>(emptyForm);
    const [saving, setSaving] = useState(false);
    const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
    const [activeSection, setActiveSection] = useState<AdminSection>('overview');

    useEffect(() => {
        let active = true;
        let intervalId: number | undefined;
        const load = async (quiet = false) => {
            if (!quiet) setRefreshing(true);
            try {
                const [nextOverview, nextReadiness] = await Promise.all([
                    getAdminAccountsOverview(), getBackendReadiness()
                ]);
                if (!active) return;
                setOverview(nextOverview);
                setReadiness(nextReadiness);
                setError(null);
            } catch (loadError) {
                if (active) setError(loadError instanceof Error ? loadError.message : 'Administrasi backend tidak dapat dimuat.');
            } finally {
                if (active) { setLoading(false); setRefreshing(false); }
            }
        };
        const refreshWhenVisible = () => {
            if (document.visibilityState === 'visible' && navigator.onLine) void load(true);
        };
        void load();
        intervalId = window.setInterval(refreshWhenVisible, 30_000);
        document.addEventListener('visibilitychange', refreshWhenVisible);
        window.addEventListener('online', refreshWhenVisible);
        return () => {
            active = false;
            if (intervalId !== undefined) window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', refreshWhenVisible);
            window.removeEventListener('online', refreshWhenVisible);
        };
    }, [refreshKey]);

    useEffect(() => {
        if (editor !== 'new') return;
        const previousOverflow = document.body.style.overflow;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !saving) setEditor(null);
        };
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [editor, saving]);

    const filteredAccounts = useMemo(() => {
        const query = search.trim().toLocaleLowerCase('id-ID');
        return (overview?.accounts || []).filter((account: AdminAccountPresence) => {
            const matchesRole = roleFilter === 'Semua role' || roleLabel(account.role) === roleFilter;
            const searchable = [account.username, account.email, roleLabel(account.role), account.village,
                account.posyandu, accessLabel(account.accessMode)].filter(Boolean).join(' ').toLocaleLowerCase('id-ID');
            return matchesRole && (!query || searchable.includes(query));
        });
    }, [overview, roleFilter, search]);

    const services = Object.entries(readiness?.components || {}).filter(([key]) =>
        ['api', 'database', 'authentication', 'cache', 'queue', 'storage', 'nutritionWorker', 'nativeCore'].includes(key));
    const summary = overview?.summary || { total: 0, active: 0, online: 0, offline: 0 };
    const isNew = editor === 'new';
    const selectedAccount = editor && editor !== 'new'
        ? overview?.accounts.find((account) => account.userId === editor) || null : null;
    const roleNeedsVillage = form.role === 'Kader Posyandu' || form.role === 'Bidan Desa';
    const roleNeedsPosyandu = form.role === 'Kader Posyandu';

    const openCreate = () => {
        setActiveSection('accounts');
        setForm(emptyForm()); setEditor('new'); setDeleteCandidate(null); setError(null); setNotice(null);
    };
    const openEdit = (account: AdminAccountPresence) => {
        setForm(accountToForm(account)); setEditor(account.userId); setDeleteCandidate(null); setError(null); setNotice(null);
    };
    const changeRole = (role: AccountRole) => {
        if (role === 'super_admin' || role === 'Ahli Gizi') {
            setForm((current) => ({ ...current, role, village: null, posyandu: null,
                accessMode: role === 'super_admin' ? 'write' : current.accessMode }));
            return;
        }
        const village = form.village || initialVillage;
        setForm((current) => ({ ...current, role, village,
            posyandu: role === 'Kader Posyandu' ? (current.posyandu || locationData[village]?.[0] || '') : null }));
    };
    const saveAccount = async (event: Event) => {
        event.preventDefault();
        if (!editor) return;
        setSaving(true); setError(null); setNotice(null);
        try {
            const payload: AdminAccountInput = {
                email: form.email.trim(), username: form.username.trim().toLowerCase(), role: form.role,
                village: roleNeedsVillage ? form.village : null,
                posyandu: roleNeedsPosyandu ? form.posyandu : null,
                accessMode: form.role === 'super_admin' ? 'write' : form.accessMode,
                ...(isNew ? {} : { active: form.active })
            };
            const result = isNew ? await createAdminAccount(payload) : await updateAdminAccount(editor, payload);
            setNotice(result.message || (isNew
                ? 'Akun dibuat dan undangan aktivasi telah dikirim melalui email.'
                : 'Perubahan akun tersimpan. Sesi lama akun tersebut telah dibatalkan.'));
            setEditor(null);
            setRefreshKey((value) => value + 1);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Perubahan akun tidak dapat disimpan.');
        } finally { setSaving(false); }
    };
    const removeAccount = async (account: AdminAccountPresence) => {
        setSaving(true); setError(null); setNotice(null);
        try {
            await deleteAdminAccount(account.userId);
            setNotice(`Akun ${account.username || account.email || ''} berhasil dihapus.`);
            setDeleteCandidate(null);
            if (editor === account.userId) setEditor(null);
            setRefreshKey((value) => value + 1);
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : 'Akun tidak dapat dihapus.');
        } finally { setSaving(false); }
    };

    return Native.createElement('div', { className: 'admin-backend-page', 'data-admin-backend-page': 'true' },
        Native.createElement('section', { className: 'admin-backend-hero' },
            Native.createElement('div', { className: 'admin-backend-hero-copy' },
                Native.createElement('span', { className: 'admin-backend-access-badge' },
                    Native.createElement(CheckCircle2, { className: 'h-4 w-4' }), 'Akses backend penuh'),
                Native.createElement('h2', null, 'Administrasi Backend'),
                Native.createElement('p', null, 'Kelola akun, role, batas wilayah, hak baca/edit, serta pantau layanan dan aktivitas akun.')),
            Native.createElement('button', { type: 'button', className: 'admin-backend-refresh',
                onClick: () => setRefreshKey((value) => value + 1), disabled: refreshing,
                'aria-label': 'Perbarui status backend' },
            refreshing ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' })
                : Native.createElement(RotateCcw, { className: 'h-4 w-4' }),
            Native.createElement('span', null, refreshing ? 'Memperbarui' : 'Perbarui'))),
        error && Native.createElement('div', { role: 'alert', className: 'admin-backend-error' },
            Native.createElement('strong', null, 'Permintaan belum berhasil.'), Native.createElement('span', null, error)),
        notice && Native.createElement('div', { role: 'status', className: 'admin-backend-notice' },
            Native.createElement(CheckCircle2, { className: 'h-4 w-4' }), Native.createElement('span', null, notice)),
        Native.createElement('nav', { className: 'admin-backend-tabs', role: 'tablist', 'aria-label': 'Menu administrasi backend' },
            ADMIN_SECTIONS.map((section) => Native.createElement('button', {
                key: section.value,
                type: 'button',
                role: 'tab',
                'aria-selected': activeSection === section.value ? 'true' : 'false',
                className: activeSection === section.value ? 'is-active' : '',
                onClick: () => {
                    setActiveSection(section.value);
                    if (section.value !== 'accounts') setEditor(null);
                }
            }, section.label))),
        activeSection === 'overview' && Native.createElement('section', { className: 'admin-backend-summary', 'aria-label': 'Ringkasan akun' },
            [['Total akun', summary.total, 'blue'], ['Sedang online', summary.online, 'green'],
                ['Offline', summary.offline, 'slate'], ['Akun aktif', summary.active, 'purple']]
                .map(([label, value, tone]) => Native.createElement('article', { key: String(label), className: `admin-summary-card is-${tone}` },
                    Native.createElement('span', null, label), Native.createElement('strong', null, loading ? '—' : value)))),
        activeSection === 'overview' && Native.createElement('section', { className: 'admin-backend-section' },
            Native.createElement('div', { className: 'admin-section-heading' },
                Native.createElement('div', null, Native.createElement('h3', null, 'Status layanan backend'),
                    Native.createElement('p', null, readiness?.environment || 'Memeriksa koneksi layanan...')),
                readiness && Native.createElement('span', { className: `admin-system-badge ${readiness.ok ? 'is-online' : 'is-offline'}` },
                    Native.createElement('span', { className: 'admin-presence-dot' }), readiness.ok ? 'Sistem siap' : 'Perlu perhatian')),
            Native.createElement('div', { className: 'admin-service-grid' },
                loading && services.length === 0
                    ? Native.createElement('div', { className: 'admin-loading-state' }, Native.createElement(Loader2, { className: 'h-5 w-5 animate-spin' }), 'Memeriksa backend...')
                    : services.map(([key, component]) => {
                        const online = serviceOnline(component);
                        return Native.createElement('article', { key, className: 'admin-service-card' },
                            Native.createElement('span', { className: `admin-service-icon ${online ? 'is-online' : 'is-offline'}` }, Native.createElement(Activity, { className: 'h-5 w-5' })),
                            Native.createElement('div', null, Native.createElement('strong', null, serviceLabel(key)), Native.createElement('p', null, serviceDetail(component))),
                            Native.createElement('span', { className: `admin-service-state ${online ? 'is-online' : 'is-offline'}` }, online ? 'Online' : 'Offline'));
                    }))),
        activeSection === 'accounts' && Native.createElement('section', { className: 'admin-backend-section admin-account-section' },
            Native.createElement('div', { className: 'admin-section-heading admin-account-heading' },
                Native.createElement('div', null, Native.createElement('h3', null, 'Manajemen akun'),
                    Native.createElement('p', null, `Online berarti ada aktivitas aplikasi dalam ${Math.round((overview?.onlineWindowSeconds || 180) / 60)} menit terakhir.`)),
                Native.createElement('div', { className: 'admin-heading-actions' },
                    Native.createElement('span', { className: 'admin-account-count' }, Native.createElement(Users, { className: 'h-4 w-4' }), `${filteredAccounts.length} akun`),
                    Native.createElement('button', { type: 'button', className: 'admin-add-account', onClick: openCreate },
                        Native.createElement(UserPlus, { className: 'h-4 w-4' }), 'Tambah akun'))),
            editor && !isNew && Native.createElement('form', { className: 'admin-account-editor', onSubmit: saveAccount },
                Native.createElement('div', { className: 'admin-editor-heading' },
                    Native.createElement('div', null,
                        Native.createElement('h4', null, isNew ? 'Tambah akun baru' : `Edit ${selectedAccount?.username || selectedAccount?.email || 'akun'}`),
                        Native.createElement('p', null, isNew ? 'Undangan aktivasi akan dikirim ke email tanpa membuat kata sandi sementara.' : 'Perubahan hak akses akan membatalkan sesi lama akun ini.')),
                    Native.createElement('button', { type: 'button', className: 'admin-editor-close', onClick: () => setEditor(null), 'aria-label': 'Tutup formulir' }, Native.createElement(X, { className: 'h-4 w-4' }))),
                Native.createElement('div', { className: 'admin-editor-grid' },
                    Native.createElement('label', null, Native.createElement('span', null, 'Email'),
                        Native.createElement('input', { required: true, type: 'email', value: form.email,
                            onChange: (event: Event) => setForm((current) => ({ ...current, email: (event.target as HTMLInputElement).value })) })),
                    Native.createElement('label', null, Native.createElement('span', null, 'Username'),
                        Native.createElement('input', { required: true, minLength: 3, maxLength: 32,
                            pattern: '[a-z0-9][a-z0-9._-]{2,31}', value: form.username,
                            onChange: (event: Event) => setForm((current) => ({ ...current, username: (event.target as HTMLInputElement).value.toLowerCase() })) })),
                    Native.createElement('label', null, Native.createElement('span', null, 'Role'),
                        Native.createElement('select', { value: form.role,
                            onChange: (event: Event) => changeRole((event.target as HTMLSelectElement).value as AccountRole) },
                        ACCOUNT_ROLES.map((role) => Native.createElement('option', { key: role.value, value: role.value }, role.label)))),
                    Native.createElement('label', null, Native.createElement('span', null, 'Hak akses data'),
                        Native.createElement('select', { value: form.role === 'super_admin' ? 'write' : form.accessMode,
                            disabled: form.role === 'super_admin',
                            onChange: (event: Event) => setForm((current) => ({ ...current, accessMode: (event.target as HTMLSelectElement).value as 'read' | 'write' })) },
                        Native.createElement('option', { value: 'write' }, 'Bisa Edit'),
                        Native.createElement('option', { value: 'read' }, 'Hanya Baca'))),
                    roleNeedsVillage && Native.createElement('label', null, Native.createElement('span', null, 'Desa'),
                        Native.createElement('select', { required: true, value: form.village || '', onChange: (event: Event) => {
                            const village = (event.target as HTMLSelectElement).value;
                            setForm((current) => ({ ...current, village,
                                posyandu: current.role === 'Kader Posyandu' ? (locationData[village]?.[0] || '') : null }));
                        } }, villages.map((village) => Native.createElement('option', { key: village, value: village }, village)))),
                    roleNeedsPosyandu && Native.createElement('label', null, Native.createElement('span', null, 'Posyandu'),
                        Native.createElement('select', { required: true, value: form.posyandu || '',
                            onChange: (event: Event) => setForm((current) => ({ ...current, posyandu: (event.target as HTMLSelectElement).value })) },
                        (locationData[form.village || initialVillage] || []).map((posyandu) => Native.createElement('option', { key: posyandu, value: posyandu }, posyandu)))),
                    !isNew && Native.createElement('label', { className: 'admin-active-control' },
                        Native.createElement('input', { type: 'checkbox', checked: form.active,
                            onChange: (event: Event) => setForm((current) => ({ ...current, active: (event.target as HTMLInputElement).checked })) }),
                        Native.createElement('span', null, 'Akun aktif'))),
                Native.createElement('div', { className: 'admin-editor-actions' },
                    Native.createElement('button', { type: 'button', className: 'admin-secondary-action', onClick: () => setEditor(null), disabled: saving }, 'Batal'),
                    Native.createElement('button', { type: 'submit', className: 'admin-primary-action', disabled: saving },
                        saving ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }) : Native.createElement(CheckCircle2, { className: 'h-4 w-4' }),
                        saving ? 'Menyimpan…' : (isNew ? 'Kirim undangan' : 'Simpan perubahan')))),
            Native.createElement('div', { className: 'admin-account-toolbar' },
                Native.createElement('label', { className: 'admin-search-control' }, Native.createElement(Search, { className: 'h-4 w-4' }),
                    Native.createElement('input', { type: 'search', value: search,
                        onChange: (event: Event) => setSearch((event.target as HTMLInputElement).value),
                        placeholder: 'Cari username, email, wilayah, atau hak akses', 'aria-label': 'Cari akun' })),
                Native.createElement('select', { value: roleFilter,
                    onChange: (event: Event) => setRoleFilter((event.target as HTMLSelectElement).value), 'aria-label': 'Filter role akun' },
                ROLE_OPTIONS.map((role) => Native.createElement('option', { key: role, value: role }, role)))),
            Native.createElement('div', { className: 'admin-account-table-wrap' },
                Native.createElement('table', { className: 'admin-account-table' },
                    Native.createElement('thead', null, Native.createElement('tr', null,
                        Native.createElement('th', null, 'Akun'), Native.createElement('th', null, 'Role & wilayah'),
                        Native.createElement('th', null, 'Hak akses'), Native.createElement('th', null, 'Status akun'),
                        Native.createElement('th', null, 'Aktivitas terakhir'), Native.createElement('th', null, 'Tindakan'))),
                    Native.createElement('tbody', null,
                        loading && filteredAccounts.length === 0
                            ? Native.createElement('tr', null, Native.createElement('td', { colSpan: 6, className: 'admin-table-empty' }, 'Memuat akun...'))
                            : filteredAccounts.length === 0
                                ? Native.createElement('tr', null, Native.createElement('td', { colSpan: 6, className: 'admin-table-empty' }, 'Tidak ada akun yang sesuai.'))
                                : filteredAccounts.map((account) => Native.createElement('tr', { key: account.userId },
                                    Native.createElement('td', null, Native.createElement('div', { className: 'admin-account-identity' },
                                        Native.createElement('span', { className: 'admin-account-avatar' }, (account.username || account.email || 'A').charAt(0).toUpperCase()),
                                        Native.createElement('div', null, Native.createElement('strong', null, account.username || 'Tanpa username'),
                                            Native.createElement('p', null, account.email || 'Email tidak tersedia')))),
                                    Native.createElement('td', null, Native.createElement('strong', { className: 'admin-role-label' }, roleLabel(account.role)),
                                        Native.createElement('p', { className: 'admin-account-scope' }, [account.village, account.posyandu].filter(Boolean).join(' · ') || 'Akses global')),
                                    Native.createElement('td', null, Native.createElement('span', { className: `admin-access-mode is-${account.accessMode}` }, accessLabel(account.accessMode))),
                                    Native.createElement('td', null, Native.createElement('div', { className: 'admin-status-stack' },
                                        Native.createElement('span', { className: `admin-presence-badge is-${account.presenceStatus}` }, Native.createElement('span', { className: 'admin-presence-dot' }), account.presenceStatus === 'online' ? 'Online' : 'Offline'),
                                        Native.createElement('span', { className: `admin-active-label ${account.active ? 'is-active' : 'is-inactive'}` }, account.active ? 'Akun aktif' : 'Akun nonaktif'))),
                                    Native.createElement('td', null, Native.createElement('div', { className: 'admin-last-seen' },
                                        Native.createElement(Clock, { className: 'h-4 w-4' }), Native.createElement('span', null, formatDateTime(account.lastSeenAt)))),
                                    Native.createElement('td', null, deleteCandidate === account.userId
                                        ? Native.createElement('div', { className: 'admin-delete-confirm' },
                                            Native.createElement('span', null, 'Hapus permanen?'),
                                            Native.createElement('button', { type: 'button', className: 'is-danger', disabled: saving,
                                                onClick: () => void removeAccount(account) }, saving ? 'Menghapus…' : 'Ya, hapus'),
                                            Native.createElement('button', { type: 'button', disabled: saving, onClick: () => setDeleteCandidate(null) }, 'Batal'))
                                        : Native.createElement('div', { className: 'admin-row-actions' },
                                            Native.createElement('button', { type: 'button', disabled: account.isCurrentAccount,
                                                onClick: () => openEdit(account),
                                                title: account.isCurrentAccount ? 'Akun yang sedang digunakan dilindungi' : 'Edit akun' },
                                            Native.createElement(Pencil, { className: 'h-4 w-4' }), Native.createElement('span', null, 'Edit')),
                                            Native.createElement('button', { type: 'button', className: 'is-danger', disabled: account.isCurrentAccount,
                                                onClick: () => setDeleteCandidate(account.userId),
                                                title: account.isCurrentAccount ? 'Akun yang sedang digunakan tidak dapat dihapus' : 'Hapus akun' },
                                            Native.createElement(Trash2, { className: 'h-4 w-4' }), Native.createElement('span', null, 'Hapus'))))))))),
            overview && Native.createElement('p', { className: 'admin-checked-at' },
                `Diperiksa ${formatDateTime(overview.checkedAt)} · diperbarui otomatis setiap 30 detik`)),
        activeSection === 'monitoring' && Native.createElement(AdminMonitoringPanel, null),
        isNew && Native.createElement('div', {
            className: 'admin-account-modal-backdrop',
            onClick: (event: MouseEvent) => {
                if (event.target === event.currentTarget && !saving) setEditor(null);
            }
        },
        Native.createElement('form', {
            className: 'admin-account-editor admin-account-modal',
            onSubmit: saveAccount,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'admin-create-account-title'
        },
        Native.createElement('div', { className: 'admin-editor-heading' },
            Native.createElement('div', null,
                Native.createElement('h4', { id: 'admin-create-account-title' }, 'Tambah akun baru'),
                Native.createElement('p', null, 'Undangan aktivasi akan dikirim ke email tanpa membuat kata sandi sementara.')),
            Native.createElement('button', { type: 'button', className: 'admin-editor-close', disabled: saving,
                onClick: () => setEditor(null), 'aria-label': 'Tutup formulir tambah akun' }, Native.createElement(X, { className: 'h-4 w-4' }))),
        Native.createElement('div', { className: 'admin-editor-grid' },
            Native.createElement('label', null, Native.createElement('span', null, 'Email'),
                Native.createElement('input', { required: true, type: 'email', autoFocus: true, value: form.email,
                    onChange: (event: Event) => setForm((current) => ({ ...current, email: (event.target as HTMLInputElement).value })) })),
            Native.createElement('label', null, Native.createElement('span', null, 'Username'),
                Native.createElement('input', { required: true, minLength: 3, maxLength: 32,
                    pattern: '[a-z0-9][a-z0-9._-]{2,31}', value: form.username,
                    onChange: (event: Event) => setForm((current) => ({ ...current, username: (event.target as HTMLInputElement).value.toLowerCase() })) })),
            Native.createElement('label', null, Native.createElement('span', null, 'Role'),
                Native.createElement('select', { value: form.role,
                    onChange: (event: Event) => changeRole((event.target as HTMLSelectElement).value as AccountRole) },
                ACCOUNT_ROLES.map((role) => Native.createElement('option', { key: role.value, value: role.value }, role.label)))),
            Native.createElement('label', null, Native.createElement('span', null, 'Hak akses data'),
                Native.createElement('select', { value: form.role === 'super_admin' ? 'write' : form.accessMode,
                    disabled: form.role === 'super_admin',
                    onChange: (event: Event) => setForm((current) => ({ ...current, accessMode: (event.target as HTMLSelectElement).value as 'read' | 'write' })) },
                Native.createElement('option', { value: 'write' }, 'Bisa Edit'),
                Native.createElement('option', { value: 'read' }, 'Hanya Baca'))),
            roleNeedsVillage && Native.createElement('label', null, Native.createElement('span', null, 'Desa'),
                Native.createElement('select', { required: true, value: form.village || '', onChange: (event: Event) => {
                    const village = (event.target as HTMLSelectElement).value;
                    setForm((current) => ({ ...current, village,
                        posyandu: current.role === 'Kader Posyandu' ? (locationData[village]?.[0] || '') : null }));
                } }, villages.map((village) => Native.createElement('option', { key: village, value: village }, village)))),
            roleNeedsPosyandu && Native.createElement('label', null, Native.createElement('span', null, 'Posyandu'),
                Native.createElement('select', { required: true, value: form.posyandu || '',
                    onChange: (event: Event) => setForm((current) => ({ ...current, posyandu: (event.target as HTMLSelectElement).value })) },
                (locationData[form.village || initialVillage] || []).map((posyandu) => Native.createElement('option', { key: posyandu, value: posyandu }, posyandu))))),
        Native.createElement('div', { className: 'admin-editor-actions' },
            Native.createElement('button', { type: 'button', className: 'admin-secondary-action', onClick: () => setEditor(null), disabled: saving }, 'Batal'),
            Native.createElement('button', { type: 'submit', className: 'admin-primary-action', disabled: saving },
                saving ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }) : Native.createElement(UserPlus, { className: 'h-4 w-4' }),
                saving ? 'Mengirim…' : 'Kirim undangan')))));
}
