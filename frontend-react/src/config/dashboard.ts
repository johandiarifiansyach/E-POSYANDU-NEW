/** React-facing role, location, and dashboard constants. */
export const DATA_WILAYAH = {
  'Desa Gumukmas': Array.from({ length: 17 }, (_, index) => `SALAK ${index + 1}`).concat(['SALAK 99']),
  'Desa Menampu': Array.from({ length: 14 }, (_, index) => `SALAK ${index + 18}`).concat(['SALAK 98']),
  'Desa Mayangan': Array.from({ length: 11 }, (_, index) => `SALAK ${index + 32}`),
  'Desa Kepanjen': Array.from({ length: 10 }, (_, index) => `SALAK ${index + 43}`),
  'Desa Purwoasri': Array.from({ length: 9 }, (_, index) => `SALAK ${index + 53}`)
} as const;

export const ROLES = {
  KADER: 'Kader Posyandu',
  BIDAN: 'Bidan Desa',
  GIZI: 'Ahli Gizi',
  SUPER_ADMIN: 'super_admin'
} as const;

export function isFullAccessRole(role: string): boolean {
  return role === ROLES.GIZI || role === ROLES.SUPER_ADMIN;
}

export const DASHBOARD_TABS = [
  'dashboard', 'data_balita', 'asi_eksklusif', 'mpasi',
  'problem_underweight', 'problem_stunting', 'problem_wasting',
  'problem_tidak_naik', 'pmt_program', 'recent', 'change_history',
  'recycle_bin', 'add_child', 'measurement', 'admin_backend', 'admin_monitoring'
] as const;

export const COMPACT_SIDEBAR_MEDIA_QUERY = '(min-width: 768px), (orientation: landscape) and (min-width: 560px)';

export const MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
] as const;

export const YEARS = [2025, 2026, 2027, 2028, 2029, 2030] as const;
