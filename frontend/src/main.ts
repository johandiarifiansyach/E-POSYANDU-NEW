import { mountApp } from './App';
import { reportClientError } from './api/dashboardApi';
import { initializeColorScheme } from './theme/colorScheme';
import { setupProblemReporter } from './ui/problemReporter';
import './styles/index.css';

const rootNode = document.getElementById('root');
const SERVICE_WORKER_CACHE_VERSION = 'v38';
const SERVICE_WORKER_MIGRATION_KEY = 'e-posyandu:service-worker-cache-version';

if (!rootNode) throw new Error('Root element tidak ditemukan.');
const rootElement: HTMLElement = rootNode;

initializeColorScheme();

const problemReporter = setupProblemReporter({
  report: (payload) => reportClientError(payload.error, `${payload.source}.manual`, { suppressErrors: false })
});

window.addEventListener('error', (event) => {
  if (event.filename) {
    try {
      if (new URL(event.filename, window.location.href).origin !== window.location.origin) return;
    } catch {
      return;
    }
  }
  problemReporter.capture(event.error || new Error(event.message || 'Unhandled window error'), 'window.error');
  void reportClientError(event.error || new Error('Unhandled window error'), 'window.error');
});

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error('Unhandled promise rejection');
  problemReporter.capture(error, 'window.unhandledrejection');
  void reportClientError(error, 'window.unhandledrejection');
});

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

   if (registrations.length > 0 || navigator.serviceWorker.controller) {
    window.location.reload();
    throw new Error('Service worker lama direset. Halaman dimuat ulang.');
  }
}

async function bootstrap() {
  if ('serviceWorker' in navigator && import.meta.env.DEV) {
    await resetLocalServiceWorker();
  } else if ('serviceWorker' in navigator) {
    await removeLegacyServiceWorkerCache();
  }

  mountApp(rootElement);
}

void bootstrap().catch((error) => {
  if (error instanceof Error && error.message === 'Service worker lama direset. Halaman dimuat ulang.') {
    return;
  }
  console.warn('Bootstrap aplikasi gagal bersih:', error);
  mountApp(rootElement);
});

if ('serviceWorker' in navigator && import.meta.env.DEV) {
  void resetLocalServiceWorker().catch((error) => {
    console.warn('Pembersihan cache lokal gagal:', error);
  });
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const registerServiceWorker = () => {
      void navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
        .then(() => {
          // Keep the service worker lean on low-spec devices; browser HTTP cache handles hashed assets.
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
