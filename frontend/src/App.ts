import Native, { createRoot } from './runtime/dom';
import {
  getAuth,
  getCurrentAccessProfile,
  initializeApp,
  restoreAuthSession,
  signInWithPassword,
  signOut
} from './api/client';

type UserRole = {
  role: string;
  desa: string | null;
  posyandu: string | null;
};

type Cleanup = () => void;

const auth = getAuth(initializeApp({
  projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6'
}));
const STORED_USER_KEY = 'e-posyandu:user';
const IDLE_ACTIVITY_KEY = 'e-posyandu:last-activity';
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
  const screen = document.createElement('div');
  screen.className = 'app-loading-screen';
  const panel = document.createElement('div');
  panel.className = 'app-loading-panel';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-label', 'Memuat aplikasi');

  const logo = document.createElement('img');
  logo.className = 'app-loading-logo';
  logo.src = '/logo-puskesmas-32981.svg';
  logo.alt = '';
  logo.width = 46;
  logo.height = 46;

  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'E-Posyandu';
  const status = document.createElement('span');
  status.textContent = 'Menyiapkan aplikasi';
  copy.append(title, status);

  const progress = document.createElement('div');
  progress.className = 'app-loading-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.append(document.createElement('span'));

  panel.append(logo, copy, progress);
  screen.append(panel);
  container.replaceChildren(screen);
}

function startIdleSession(onExpired: () => Promise<void>): Cleanup {
  let stopped = false;
  let timeoutId: number | undefined;

  const lastActivityAt = () => {
    const saved = Number(window.sessionStorage.getItem(IDLE_ACTIVITY_KEY));
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
  const endIdleSession = async () => {
    if (stopped) return;
    if (Date.now() - lastActivityAt() < IDLE_LOGOUT_MS) {
      scheduleIdleLogout();
      return;
    }
    stopped = true;
    clearIdleTimer();
    try {
      await onExpired();
    } catch (error) {
      stopped = false;
      window.sessionStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
      scheduleIdleLogout();
      console.warn('Logout otomatis ditunda:', error);
    }
  };
  const recordActivity = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastActivityAt() >= IDLE_LOGOUT_MS) {
      void endIdleSession();
      return;
    }
    if (now - lastActivityAt() < 1_000) return;
    window.sessionStorage.setItem(IDLE_ACTIVITY_KEY, String(now));
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

  if (!window.sessionStorage.getItem(IDLE_ACTIVITY_KEY)) {
    window.sessionStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
  }
  const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
  activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
  window.addEventListener('focus', checkIdleWhenVisible);
  document.addEventListener('visibilitychange', checkIdleWhenVisible);
  scheduleIdleLogout();

  return () => {
    stopped = true;
    clearIdleTimer();
    activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
    window.removeEventListener('focus', checkIdleWhenVisible);
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
    window.sessionStorage.removeItem(IDLE_ACTIVITY_KEY);
    showLoading(container);
    const { mountLoginPage } = await import('./pages/LoginPage');
    if (disposed) return;
    replaceView(() => mountLoginPage(container, {
      onLogin: async (username, password, turnstileToken) => {
        await signInWithPassword(auth, username, password, turnstileToken);
        const profile = await getCurrentAccessProfile();
        const user = { role: profile.role, desa: profile.desa, posyandu: profile.posyandu };
        saveStoredUser(user);
        await renderDashboard(user);
      }
    }));
  };

  const clearSession = async () => {
    await signOut(auth);
    clearStoredUser();
    window.sessionStorage.removeItem(IDLE_ACTIVITY_KEY);
  };

  const renderDashboard = async (user: UserRole) => {
    if (disposed) return;
    showLoading(container);
    const { Dashboard } = await import('./pages/DashboardApp');
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
        await clearSession();
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

  void initialize();
  return () => {
    disposed = true;
    viewCleanup?.();
    container.replaceChildren();
  };
}

export default mountApp;
