import { useEffect, useRef, useState } from 'react';
import {
  expireAuthSession,
  getCurrentAccessProfile,
  getAuth as getAuthInstance,
  initializeApp,
  isAuthenticationError,
  onAuthStateChanged,
  restoreAuthSession,
  signInWithPassword,
  signOut,
  type AccessProfile,
  type Auth,
  type MfaPendingSignIn,
  type SignInResult
} from '../api/authApi';
import type { DashboardUser } from '../types';
import { AppLoadingSkeleton, LoginLoadingSkeleton } from '../components/base/LoadingSkeletons';
import LoginPage from '../pages/LoginPage';
import MfaPage, { type AuthenticatedResult } from '../pages/MfaPage';
import MaintenancePage from '../pages/MaintenancePage';
import AdminInvitePage from '../pages/AdminInvitePage';
import DashboardPage from '../pages/DashboardPage';

type Phase = 'loading' | 'login' | 'mfa' | 'dashboard' | 'activation' | 'error';

type StoredUser = DashboardUser;

const STORED_USER_KEY = 'e-posyandu:user';
const IDLE_ACTIVITY_KEY = 'e-posyandu:last-activity';
const IDLE_EXPIRED_KEY = 'e-posyandu:idle-session-expired';
const IDLE_LOGOUT_MS = 30 * 60 * 1000;

const auth: Auth = getAuthInstance(initializeApp({
  projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6'
}));

function isStoredUser(value: unknown): value is StoredUser {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.role === 'string'
    && (typeof candidate.desa === 'string' || candidate.desa === null)
    && (typeof candidate.posyandu === 'string' || candidate.posyandu === null)
    && (candidate.accessMode === undefined || candidate.accessMode === 'read' || candidate.accessMode === 'write');
}

function loadStoredUser(): StoredUser | null {
  try {
    const raw = window.localStorage.getItem(STORED_USER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredUser(parsed)
      ? { ...parsed, accessMode: parsed.accessMode === 'read' ? 'read' : 'write' }
      : null;
  } catch {
    return null;
  }
}

function saveStoredUser(user: StoredUser) {
  window.localStorage.setItem(STORED_USER_KEY, JSON.stringify(user));
}

function clearStoredUser() {
  window.localStorage.removeItem(STORED_USER_KEY);
}

function profileToUser(profile: AccessProfile): StoredUser {
  return {
    role: profile.role,
    desa: profile.desa,
    posyandu: profile.posyandu,
    accessMode: profile.accessMode || 'write'
  };
}

function hasAdminActivationHash() {
  if (!window.location.hash.startsWith('#')) return false;
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  return parameters.get('type') === 'invite'
    || (parameters.get('type') === 'recovery' && window.location.pathname === '/admin/activate');
}

function readAdminActivationTokens(): { accessToken: string; refreshToken: string } | null {
  if (!window.location.hash.startsWith('#')) return null;
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const type = parameters.get('type');
  const isInvite = type === 'invite';
  const isRecovery = type === 'recovery' && window.location.pathname === '/admin/activate';
  if (!isInvite && !isRecovery) return null;
  const accessToken = parameters.get('access_token') || '';
  const refreshToken = parameters.get('refresh_token') || '';
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

function clearAdminActivationHash() {
  if (window.location.hash) window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
}

function startIdleSession(onExpired: () => Promise<void>) {
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
    } catch (cause) {
      stopped = false;
      window.localStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
      scheduleIdleLogout();
      console.warn('Logout otomatis ditunda:', cause);
    }
  };
  const scheduleIdleLogout = () => {
    clearIdleTimer();
    const wait = Math.max(0, IDLE_LOGOUT_MS - (Date.now() - lastActivityAt()));
    timeoutId = window.setTimeout(() => void endIdleSession(), wait);
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
  const checkVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastActivityAt() >= IDLE_LOGOUT_MS) {
      void endIdleSession();
      return;
    }
    scheduleIdleLogout();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key === IDLE_ACTIVITY_KEY && event.newValue) scheduleIdleLogout();
    if (event.key === IDLE_EXPIRED_KEY && event.newValue) void endIdleSession();
  };

  if (!window.localStorage.getItem(IDLE_ACTIVITY_KEY)) {
    window.localStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now()));
  }
  const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
  activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
  window.addEventListener('focus', checkVisibility);
  window.addEventListener('storage', handleStorage);
  document.addEventListener('visibilitychange', checkVisibility);
  scheduleIdleLogout();

  return () => {
    stopped = true;
    clearIdleTimer();
    activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
    window.removeEventListener('focus', checkVisibility);
    window.removeEventListener('storage', handleStorage);
    document.removeEventListener('visibilitychange', checkVisibility);
  };
}

function StartupError({ onRetry }: { onRetry: () => void }) {
  return <section className="runtime-error-screen" role="alert">
    <h1>Aplikasi belum dapat dimuat</h1>
    <p>Silakan coba muat ulang halaman.</p>
    <button type="button" className="runtime-error-retry" onClick={onRetry}>Muat ulang</button>
  </section>;
}

export default function AuthGate() {
  if (import.meta.env.VITE_MAINTENANCE_MODE === 'true') {
    return <MaintenancePage onRetry={() => window.location.reload()} />;
  }
  return <AuthenticatedGate />;
}

function AuthenticatedGate() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<StoredUser | null>(null);
  const [pending, setPending] = useState<MfaPendingSignIn | null>(null);
  const phaseRef = useRef(phase);
  const mountedRef = useRef(true);
  phaseRef.current = phase;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const stopAuth = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser || phaseRef.current !== 'dashboard' || !mountedRef.current) return;
      clearStoredUser();
      setUser(null);
      setPhase('login');
    });
    return stopAuth;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      if (hasAdminActivationHash()) {
        setPhase('activation');
        return;
      }
      if (window.localStorage.getItem(IDLE_EXPIRED_KEY)) {
        await expireAuthSession(auth);
        clearStoredUser();
        window.localStorage.removeItem(IDLE_ACTIVITY_KEY);
        window.localStorage.removeItem(IDLE_EXPIRED_KEY);
        if (!cancelled) setPhase('login');
        return;
      }

      const session = await restoreAuthSession(auth);
      const storedUser = loadStoredUser();
      if (!session) {
        clearStoredUser();
        if (!cancelled) setPhase('login');
        return;
      }
      if (!navigator.onLine) {
        if (storedUser) {
          setUser(storedUser);
          setPhase('dashboard');
        } else setPhase('login');
        return;
      }
      try {
        const profile = await getCurrentAccessProfile();
        if (!cancelled) {
          const nextUser = profileToUser(profile);
          saveStoredUser(nextUser);
          setUser(nextUser);
          setPhase('dashboard');
        }
      } catch (cause) {
        console.warn('Profil akun belum dapat diperbarui:', cause);
        if (isAuthenticationError(cause)) {
          clearStoredUser();
          await expireAuthSession(auth);
          if (!cancelled) setPhase('login');
          return;
        }
        if (!cancelled) {
          if (storedUser) {
            setUser(storedUser);
            setPhase('dashboard');
          } else setPhase('login');
        }
      }
    };
    void initialize().catch((cause) => {
      console.error('Bootstrap autentikasi gagal:', cause);
      if (!cancelled) setPhase('error');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (phase !== 'dashboard') return undefined;
    return startIdleSession(async () => {
      window.localStorage.setItem(IDLE_EXPIRED_KEY, String(Date.now()));
      await expireAuthSession(auth);
      clearStoredUser();
      window.localStorage.removeItem(IDLE_ACTIVITY_KEY);
      if (!mountedRef.current) return;
      setUser(null);
      setPhase('login');
    });
  }, [phase]);

  const completeAuthentication = async (result: AuthenticatedResult) => {
    const profile = result.profile || await getCurrentAccessProfile();
    const nextUser = profileToUser(profile);
    window.localStorage.removeItem(IDLE_EXPIRED_KEY);
    saveStoredUser(nextUser);
    setUser(nextUser);
    setPending(null);
    setPhase('dashboard');
  };

  const handleLogin = async (username: string, password: string, turnstileToken?: string) => {
    const result = await signInWithPassword(auth, username, password, turnstileToken);
    if (result.mfaRequired) {
      setPending(result);
      setPhase('mfa');
      return;
    }
    await completeAuthentication({ profile: result.profile, recoveryCodes: [] });
  };

  const handleCancelMfa = async () => {
    await signOut(auth).catch(() => undefined);
    clearStoredUser();
    setPending(null);
    setPhase('login');
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      clearStoredUser();
      window.localStorage.removeItem(IDLE_ACTIVITY_KEY);
      window.localStorage.removeItem(IDLE_EXPIRED_KEY);
      setUser(null);
      setPhase('login');
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : 'Tidak dapat keluar dari aplikasi.');
    }
  };

  if (phase === 'activation') {
    const tokens = readAdminActivationTokens();
    if (!tokens) return <StartupError onRetry={() => window.location.reload()} />;
    return <AdminInvitePage
      {...tokens}
      onComplete={async (result: SignInResult) => {
        clearAdminActivationHash();
        if (result.mfaRequired) {
          setPending(result);
          setPhase('mfa');
          return;
        }
        await completeAuthentication({ profile: result.profile, recoveryCodes: [] });
      }}
      onCancel={async () => { clearAdminActivationHash(); await signOut(auth).catch(() => undefined); clearStoredUser(); setPhase('login'); }}
    />;
  }
  if (phase === 'loading') return <AppLoadingSkeleton />;
  if (phase === 'error') return <StartupError onRetry={() => window.location.reload()} />;
  if (phase === 'login') return <LoginPage onLogin={handleLogin} />;
  if (phase === 'mfa' && pending) {
    return <MfaPage auth={auth} pending={pending} onAuthenticated={completeAuthentication} onCancel={handleCancelMfa} />;
  }
  if (phase === 'dashboard' && user) {
    return <DashboardPage user={user} onLogout={handleLogout} />;
  }
  return <LoginLoadingSkeleton includeTurnstile={Boolean(import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim())} />;
}
