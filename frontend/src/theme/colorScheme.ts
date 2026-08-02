export type ColorScheme = 'light' | 'dark';

export const COLOR_SCHEME_STORAGE_KEY = 'e-posyandu:color-scheme';

const listeners = new Set<(scheme: ColorScheme) => void>();
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function isColorScheme(value: string | null): value is ColorScheme {
  return value === 'light' || value === 'dark';
}

export function getStoredColorScheme(): ColorScheme | null {
  const stored = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
  return isColorScheme(stored) ? stored : null;
}

export function getPreferredColorScheme(): ColorScheme {
  return getStoredColorScheme() || (systemThemeQuery.matches ? 'dark' : 'light');
}

export function applyColorScheme(scheme: ColorScheme): void {
  document.documentElement.dataset.theme = scheme;
  document.documentElement.style.colorScheme = scheme;
}

function publishColorScheme(scheme: ColorScheme): void {
  applyColorScheme(scheme);
  listeners.forEach((listener) => listener(scheme));
}

export function saveColorScheme(scheme: ColorScheme): void {
  window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, scheme);
  publishColorScheme(scheme);
}

export function subscribeColorScheme(listener: (scheme: ColorScheme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initializeColorScheme(): () => void {
  publishColorScheme(getPreferredColorScheme());

  const handleSystemThemeChange = (event: MediaQueryListEvent) => {
    if (!getStoredColorScheme()) publishColorScheme(event.matches ? 'dark' : 'light');
  };
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === COLOR_SCHEME_STORAGE_KEY) publishColorScheme(getPreferredColorScheme());
  };

  systemThemeQuery.addEventListener('change', handleSystemThemeChange);
  window.addEventListener('storage', handleStorageChange);

  return () => {
    systemThemeQuery.removeEventListener('change', handleSystemThemeChange);
    window.removeEventListener('storage', handleStorageChange);
  };
}
