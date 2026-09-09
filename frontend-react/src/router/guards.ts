import type { DashboardUser } from '../types';
import type { RouteMeta } from './routeMeta';

export function canAccessRoute(route: RouteMeta, user: DashboardUser | null) {
  if (route.requiresSession && !user) return false;
  if (route.requiresAdmin && user?.role !== 'super_admin') return false;
  return true;
}

export function fallbackPath(route: RouteMeta, user: DashboardUser | null) {
  if (canAccessRoute(route, user)) return null;
  return user ? '/' : '/login';
}
