// Bump whenever the deployed shell changes so browsers discard stale login bundles.
const CACHE_NAME = 'e-posyandu-shell-v44';
const APP_SHELL = [
  '/index.html',
  '/manifest.webmanifest',
  '/logo-puskesmas-32981.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.svg'
];
const APP_SHELL_PATHS = new Set(APP_SHELL);

function isSafeStaticResponse(response) {
  return Boolean(
    response
    && response.ok
    && response.type === 'basic'
    && !response.redirected
  );
}

async function putSafeResponse(cacheKey, response) {
  if (!isSafeStaticResponse(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(cacheKey, response.clone());
}

self.addEventListener('install', (event) => {
  // Keep the installation small. Hashed JavaScript and CSS are cached when the
  // browser requests them, so deployments cannot mix bundles across versions.
  event.waitUntil(Promise.all(APP_SHELL.map(async (path) => {
    const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
    if (!isSafeStaticResponse(response)) throw new Error(`Aset aplikasi tidak valid: ${path}`);
    await putSafeResponse(path, response);
  })));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CLEAR_APP_SHELL_CACHE') return;
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('e-posyandu-')).map((key) => caches.delete(key))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname === '/service-worker.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const contentType = response.headers.get('Content-Type') || '';
          if (!isSafeStaticResponse(response) || !contentType.includes('text/html')) return response;
          event.waitUntil(putSafeResponse('/index.html', response));
          return response;
        })
        .catch(async () => (await caches.match('/index.html')) || Response.error())
    );
    return;
  }

  const isHashedAsset = url.pathname.startsWith('/assets/');

  if (isHashedAsset) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        event.waitUntil(putSafeResponse(request, response));
        return response;
      }))
    );
    return;
  }

  if (!APP_SHELL_PATHS.has(url.pathname)) return;

  event.respondWith(fetch(request)
    .then((response) => {
      event.waitUntil(putSafeResponse(request, response));
      return response;
    })
    .catch(async () => (await caches.match(request)) || Response.error()));
});
