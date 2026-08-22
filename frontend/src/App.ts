import Native, { createRoot } from './runtime/dom';
import {
  expireAuthSession,
  getAuth,
  getCurrentAccessProfile,
  initializeApp,
  restoreAuthSession,
  signInWithPassword,
  signOut
} from './api/authApi';
import { AppLoadingSkeleton } from './ui/skeleton';

type UserRole = {
  role: string;
  desa: string | null;
  posyandu: string | null;
};

type Cleanup = () => void;
type DashboardModule = typeof import('./pages/DashboardApp');

const auth = getAuth(initializeApp({
  projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6'
}));
const STORED_USER_KEY = 'e-posyandu:user';
const IDLE_ACTIVITY_KEY = 'e-posyandu:last-activity';
const IDLE_EXPIRED_KEY = 'e-posyandu:idle-session-expired';
const IDLE_LOGOUT_MS = 30 * 60 * 1000;

function isUserRole(value: unknown): value is UserRole {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.role === 'string' &&
    (typeof candidate.desa === 'string' || candidate.desa === null) &&
    (typeof candidate.posyandu === 'string' || candidate.posyandu === null)
  );
}

function loadStoredUser(): UserRole | null {
  try {
    const raw = window.localStorage.getItem(STORED_USER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUserRole(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredUser(user: UserRole) {
  window.localStorage.setItem(STORED_USER_KEY, JSON.stringify(user));
}

function clearStoredUser() {
  window.localStorage.removeItem(STORED_USER_KEY);
}

function showLoading(container: HTMLElement) {
  container.replaceChildren(AppLoadingSkeleton() as Node);
}

function showStartupError(container: HTMLElement) {
  container.replaceChildren();
  const surface = document.createElement('section');
  surface.className = 'runtime-error-screen';
  surface.setAttribute('role', 'alert');
  const title = document.createElement('h1');
  title.textContent = 'Aplikasi belum dapat dimuat';
  const message = document.createElement('p');
  message.textContent = 'Silakan coba muat ulang halaman.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'runtime-error-retry';
  retry.textContent = 'Muat ulang';
  retry.addEventListener('click', () => window.location.reload());
  surface.append(title, message, retry);
  container.appendChild(surface);
}

function startIdleSession(onExpired: () => Promise<void>): Cleanup {
  let stopped = false;
  let timeoutId: number | undefined;

  const lastActivityAt = () => {
    const saved = Number(window.localStorage.getItem(IDLE_ACTIVITY_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : Date.now();
  };
  const clearIdleTimer = () => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  const scheduleIdleLogout = () => {
    clearIdleTimer();
    const wait = Math.max(0, IDLE_LOGOUT_MS - (Date.now() - lastActivityAt()));
    timeoutId = window.setTimeout(() => void endIdleSession(), wait);
  };
  const expireNow = async () => {
    if (stopped) return;
    stopped = true;
    clearIdleTimer();
    try {
      await onExpired();
    } catch (error) {
      stopped = false;
      window.localStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
      scheduleIdleLogout();
      console.warn('Logout otomatis ditunda:', error);
    }
  };
  const endIdleSession = async () => {
    if (stopped) return;
    if (Date.now() - lastActivityAt() < IDLE_LOGOUT_MS) {
      scheduleIdleLogout();
      return;
    }
    await expireNow();
  };
  const recordActivity = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastActivityAt() >= IDLE_LOGOUT_MS) {
      void endIdleSession();
      return;
    }
    if (now - lastActivityAt() < 1_000) return;
    window.localStorage.setItem(IDLE_ACTIVITY_KEY, String(now));
    scheduleIdleLogout();
  };
  const checkIdleWhenVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastActivityAt() >= IDLE_LOGOUT_MS) {
      void endIdleSession();
      return;
    }
    scheduleIdleLogout();
  };
  const handleSharedSessionChange = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key === IDLE_ACTIVITY_KEY && event.newValue) {
      scheduleIdleLogout();
      return;
    }
    if (event.key === IDLE_EXPIRED_KEY && event.newValue) void expireNow();
  };

  if (!window.localStorage.getItem(IDLE_ACTIVITY_KEY)) {
    window.localStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
  }
  const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
  activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
  window.addEventListener('focus', checkIdleWhenVisible);
  window.addEventListener('storage', handleSharedSessionChange);
  document.addEventListener('visibilitychange', checkIdleWhenVisible);
  scheduleIdleLogout();

  return () => {
    stopped = true;
    clearIdleTimer();
    activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
    window.removeEventListener('focus', checkIdleWhenVisible);
    window.removeEventListener('storage', handleSharedSessionChange);
    document.removeEventListener('visibilitychange', checkIdleWhenVisible);
  };
}

export function mountApp(container: HTMLElement): Cleanup {
  let disposed = false;
  let viewCleanup: Cleanup | undefined;

  const replaceView = (mount: () => Cleanup | void) => {
    viewCleanup?.();
    viewCleanup = mount() || undefined;
  };

  const renderLogin = async () => {
    if (disposed) return;
    window.localStorage.removeItem(IDLE_ACTIVITY_KEY);
    showLoading(container);
    const { mountLoginPage } = await import('./pages/LoginPage');
    if (disposed) return;
    replaceView(() => mountLoginPage(container, {
      onLogin: async (username, password, turnstileToken) => {
        const dashboardModule = import('./pages/DashboardApp');
        const login = await signInWithPassword(auth, username, password, turnstileToken);
        const profile = login.profile || await getCurrentAccessProfile();
        const user = { role: profile.role, desa: profile.desa, posyandu: profile.posyandu };
        window.localStorage.removeItem(IDLE_EXPIRED_KEY);
        saveStoredUser(user);
        await renderDashboard(user, dashboardModule);
      }
    }));
  };

  const clearSession = async () => {
    await signOut(auth);
    clearStoredUser();
    window.localStorage.removeItem(IDLE_ACTIVITY_KEY);
    window.localStorage.removeItem(IDLE_EXPIRED_KEY);
  };

  const expireSession = async () => {
    window.localStorage.setItem(IDLE_EXPIRED_KEY, String(Date.now()));
    await expireAuthSession(auth);
    clearStoredUser();
    window.localStorage.removeItem(IDLE_ACTIVITY_KEY);
  };

  const renderDashboard = async (user: UserRole, preload?: Promise<DashboardModule>) => {
    if (disposed) return;
    showLoading(container);
    const { Dashboard } = await (preload || import('./pages/DashboardApp'));
    if (disposed) return;
    replaceView(() => {
      const root = createRoot(container);
      const logout = async () => {
        try {
          await clearSession();
          await renderLogin();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : 'Tidak dapat keluar dari aplikasi.');
        }
      };
      root.render(() => Native.createElement(Dashboard, { user, onLogout: logout }));
      const stopIdleSession = startIdleSession(async () => {
        await expireSession();
        await renderLogin();
      });
      return () => {
        stopIdleSession();
        root.unmount();
      };
    });
  };

  const initialize = async () => {
    showLoading(container);
    if (window.localStorage.getItem(IDLE_EXPIRED_KEY)) {
      await expireSession();
      await renderLogin();
      return;
    }
    const session = await restoreAuthSession(auth);
    const storedUser = loadStoredUser();
    if (!session) {
      clearStoredUser();
      await renderLogin();
      return;
    }
    if (!navigator.onLine) {
      if (storedUser) await renderDashboard(storedUser);
      else await renderLogin();
      return;
    }
    try {
      const profile = await getCurrentAccessProfile();
      const user = { role: profile.role, desa: profile.desa, posyandu: profile.posyandu };
      saveStoredUser(user);
      await renderDashboard(user);
    } catch (error) {
      console.warn('Profil akun belum dapat diperbarui:', error);
      if (storedUser) await renderDashboard(storedUser);
      else await renderLogin();
    }
  };

  void initialize().catch((error) => {
    console.error('Bootstrap aplikasi gagal:', error);
    if (!disposed) showStartupError(container);
  });
  return () => {
    disposed = true;
    viewCleanup?.();
    container.replaceChildren();
  };
}

export default mountApp;
