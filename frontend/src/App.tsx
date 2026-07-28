import React, { Suspense, useEffect, useState } from 'react';
import { CloudUpload, WifiOff } from 'lucide-react';
import { getPendingMutations, subscribeToOfflineStore } from './lib/offlineStore';
import { Auth, getAuth, initializeApp, onAuthStateChanged, signInAnonymously, signOut, syncPendingMutations } from './lib/supabase-compat';

const auth: Auth = getAuth(
  initializeApp({
    projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6'
  })
);

const LoginPage = React.lazy(() => import('./pages/LoginPage'));
const DashboardPage = React.lazy(() => import('./pages/DashboardPage'));

type UserRole = {
  role: string;
  desa: string | null;
  posyandu: string | null;
};

const STORED_USER_KEY = 'e-posyandu:user';

function isUserRole(value: unknown): value is UserRole {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UserRole>;
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
    const parsed = JSON.parse(raw);
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

function LoadingScreen() {
  return (
    <div className="h-screen w-full flex items-center justify-center bg-slate-50">
      <div className="w-10 h-10 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
    </div>
  );
}

function SyncStatus() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let active = true;
    const refreshPendingCount = async () => {
      const mutations = await getPendingMutations();
      if (active) setPendingCount(mutations.length);
    };
    const handleOnline = () => {
      setOnline(true);
      void syncPendingMutations().then(refreshPendingCount);
    };
    const handleOffline = () => setOnline(false);
    const unsubscribe = subscribeToOfflineStore(() => {
      void refreshPendingCount();
    });

    void refreshPendingCount();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online && pendingCount === 0) return null;

  const label = online
    ? `${pendingCount} perubahan sedang disinkronkan`
    : pendingCount > 0
      ? `Mode offline: ${pendingCount} perubahan tersimpan di perangkat`
      : 'Mode offline';

  return (
    <div className={`fixed bottom-4 right-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-2 border px-3 py-2 text-xs font-semibold shadow-lg ${online ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`} role="status" aria-live="polite">
      {online ? <CloudUpload className="h-4 w-4 animate-pulse" /> : <WifiOff className="h-4 w-4" />}
      <span>{label}</span>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<UserRole | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};

    const restoreSession = async () => {
      const storedUser = loadStoredUser();

      if (storedUser) {
        try {
          await signInAnonymously(auth);
          if (!cancelled) setUser(storedUser);
        } catch (err) {
          console.error('Gagal memulihkan sesi:', err);
          clearStoredUser();
          if (!cancelled) setUser(null);
        }
      }

      if (cancelled) return;

      unsubscribe = onAuthStateChanged(auth, (authUser) => {
        if (!authUser) {
          clearStoredUser();
          setUser(null);
        }
      });

      setInitializing(false);
    };

    void restoreSession();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleLogin = (nextUser: UserRole) => {
    saveStoredUser(nextUser);
    setUser(nextUser);
  };

  const handleLogout = async () => {
    clearStoredUser();
    await signOut(auth);
    setUser(null);
  };

  if (initializing) {
    return <LoadingScreen />;
  }

  return (
    <>
      <Suspense fallback={<LoadingScreen />}>
        {!user ? (
          <LoginPage auth={auth} onLogin={handleLogin} />
        ) : (
          <DashboardPage user={user} onLogout={handleLogout} />
        )}
      </Suspense>
      <SyncStatus />
    </>
  );
}
