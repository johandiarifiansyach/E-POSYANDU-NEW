import { mountApp } from './App';
import { reportClientError } from './api/client';
import { initializeColorScheme } from './theme/colorScheme';
import './styles/index.css';

const rootElement = document.getElementById('root');
const SERVICE_WORKER_CACHE_VERSION = 'v14';
const SERVICE_WORKER_MIGRATION_KEY = 'e-posyandu:service-worker-cache-version';

if (!rootElement) throw new Error('Root element tidak ditemukan.');

initializeColorScheme();

window.addEventListener('error', (event) => {
  if (event.filename) {
    try {
      if (new URL(event.filename, window.location.href).origin !== window.location.origin) return;
    } catch {
      return;
    }
  }
  void reportClientError(event.error || new Error('Unhandled window error'), 'window.error');
});

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error('Unhandled promise rejection');
  void reportClientError(error, 'window.unhandledrejection');
});

mountApp(rootElement);

async function resetLocalServiceWorker() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  const cacheKeys = await caches.keys();
  await Promise.all(cacheKeys.filter((key) => key.startsWith('e-posyandu-')).map((key) => caches.delete(key)));

  if (navigator.serviceWorker.controller && !window.sessionStorage.getItem('e-posyandu:local-sw-reset')) {
    window.sessionStorage.setItem('e-posyandu:local-sw-reset', '1');
    window.location.reload();
  }
}

async function removeLegacyServiceWorkerCache() {
  if (window.localStorage.getItem(SERVICE_WORKER_MIGRATION_KEY) === SERVICE_WORKER_CACHE_VERSION) return;

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  const cacheKeys = await caches.keys();
  await Promise.all(cacheKeys.filter((key) => key.startsWith('e-posyandu-')).map((key) => caches.delete(key)));
  window.localStorage.setItem(SERVICE_WORKER_MIGRATION_KEY, SERVICE_WORKER_CACHE_VERSION);
}

if ('serviceWorker' in navigator && import.meta.env.DEV) {
  void resetLocalServiceWorker().catch((error) => {
    console.warn('Pembersihan cache lokal gagal:', error);
  });
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const registerServiceWorker = () => {
      void navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
        .then(async () => {
          const registration = await navigator.serviceWorker.ready;
          const urls = Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href]'))
            .map((element) => element instanceof HTMLScriptElement ? element.src : element.href)
            .filter(Boolean);
          registration.active?.postMessage({ type: 'CACHE_URLS', urls });
        })
        .catch((error) => {
          console.error('Pendaftaran mode offline gagal:', error);
        });
    };

    void removeLegacyServiceWorkerCache()
      .catch((error) => {
        console.warn('Pembersihan cache rilis lama gagal:', error);
      })
      .finally(() => {
        window.setTimeout(registerServiceWorker, 1_500);
      });
  });
}
