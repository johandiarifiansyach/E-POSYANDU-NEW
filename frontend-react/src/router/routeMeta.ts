export type RouteId = 'login' | 'mfa' | 'dashboard' | 'activation' | 'maintenance';

export type RouteMeta = Readonly<{
  id: RouteId;
  title: string;
  requiresSession: boolean;
  requiresAdmin: boolean;
}>;

export const routeMeta: Readonly<Record<RouteId, RouteMeta>> = {
  login: { id: 'login', title: 'Masuk', requiresSession: false, requiresAdmin: false },
  mfa: { id: 'mfa', title: 'Verifikasi Administrator', requiresSession: true, requiresAdmin: true },
  dashboard: { id: 'dashboard', title: 'Dashboard', requiresSession: true, requiresAdmin: false },
  activation: { id: 'activation', title: 'Aktivasi Undangan', requiresSession: false, requiresAdmin: false },
  maintenance: { id: 'maintenance', title: 'Pemeliharaan Sistem', requiresSession: false, requiresAdmin: false }
};

export function routeForPath(pathname: string): RouteMeta {
  if (pathname === '/admin/activate') return routeMeta.activation;
  if (pathname.startsWith('/login')) return routeMeta.login;
  if (pathname.startsWith('/maintenance')) return routeMeta.maintenance;
  return routeMeta.dashboard;
}
