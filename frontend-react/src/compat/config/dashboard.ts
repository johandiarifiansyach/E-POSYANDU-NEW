export const DATA_WILAYAH = {
    "Desa Gumukmas": Array.from({ length: 17 }, (_, i) => `SALAK ${i + 1}`).concat(["SALAK 99"]),
    "Desa Menampu": Array.from({ length: 14 }, (_, i) => `SALAK ${i + 18}`).concat(["SALAK 98"]),
    "Desa Mayangan": Array.from({ length: 11 }, (_, i) => `SALAK ${i + 32}`),
    "Desa Kepanjen": Array.from({ length: 10 }, (_, i) => `SALAK ${i + 43}`),
    "Desa Purwoasri": Array.from({ length: 9 }, (_, i) => `SALAK ${i + 53}`)
};

export const ROLES = {
    KADER: "Kader Posyandu",
    BIDAN: "Bidan Desa",
    GIZI: "Ahli Gizi",
    SUPER_ADMIN: "super_admin"
};

export function isFullAccessRole(role: string): boolean {
    return role === ROLES.GIZI || role === ROLES.SUPER_ADMIN;
}

export const DASHBOARD_TABS = [
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
    'add_child',
    'measurement',
    'admin_backend'
];

export const COMPACT_SIDEBAR_MEDIA_QUERY = '(min-width: 768px), (orientation: landscape) and (min-width: 560px)';

export const MONTHS = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

export const YEARS = [2025, 2026, 2027, 2028, 2029, 2030];
