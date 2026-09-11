// Oracle is the production primary. The legacy Worker remains an explicit,
// read-only fallback for transient gateway failures.
const PRODUCTION_API_ORIGIN = 'https://api.eposyandu.app';
const PRODUCTION_API_FALLBACK_ORIGIN = 'https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev';
const STAGING_API_ORIGIN = 'https://e-posyandu-api-staging.eposyandu-puskesmas-gumukmas.workers.dev';
const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAINTENANCE_GATEWAY_STATUSES = new Set([500, 502, 503, 504]);
// During the Oracle microservices migration an existing browser may still
// carry a valid legacy Cloudflare session.  Transport failures can still use
// the legacy origin for safe read requests, but an authorization failure must
// never fall back: doing so can make a legacy cookie look valid and then fail
// on the Oracle operations service, sending the user through a login loop.
const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504]);

function safeConfiguredOrigin(value, fallback) {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    const cleanPath = url.pathname === '' || url.pathname === '/';
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !cleanPath) {
      return fallback;
    }
    return url.origin;
  } catch {
    return fallback;
  }
}

function upstreamOrigin(hostname, env) {
  if (hostname.includes('e-posyandu-staging.pages.dev')) {
    return safeConfiguredOrigin(env.STAGING_API_ORIGIN, STAGING_API_ORIGIN);
  }
  return safeConfiguredOrigin(env.PRODUCTION_API_ORIGIN, PRODUCTION_API_ORIGIN);
}

function fallbackOrigin(hostname, env, primaryOrigin) {
  if (hostname.includes('e-posyandu-staging.pages.dev')) return null;
  const fallback = safeConfiguredOrigin(
    env.PRODUCTION_API_FALLBACK_ORIGIN,
    PRODUCTION_API_FALLBACK_ORIGIN
  );
  return fallback === primaryOrigin ? null : fallback;
}

function isApiPath(pathname) {
  return pathname === '/api/health' || pathname.startsWith('/api/v1/');
}

function isDocumentRequest(request, pathname) {
  if (request.method.toUpperCase() !== 'GET') return false;
  if (pathname === '/maintenance.html') return false;
  const accept = request.headers.get('Accept') || '';
  return pathname === '/'
    || pathname.endsWith('.html')
    || accept.includes('text/html')
    || request.headers.get('Sec-Fetch-Mode') === 'navigate';
}

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function maintenanceCacheSeconds(env) {
  const value = Number.parseInt(String(env.MAINTENANCE_HEALTH_CACHE_SECONDS || '15'), 10);
  return Number.isFinite(value) ? Math.min(120, Math.max(5, value)) : 15;
}

function healthCacheKey(request) {
  const url = new URL('/__e_posyandu_origin_health__', request.url);
  return new Request(url.toString(), { method: 'GET' });
}

async function readHealthCache(request) {
  if (typeof caches === 'undefined' || !caches.default) return null;
  try {
    const cached = await caches.default.match(healthCacheKey(request));
    if (!cached) return null;
    const payload = await cached.json();
    return typeof payload.healthy === 'boolean' ? payload.healthy : null;
  } catch {
    return null;
  }
}

async function writeHealthCache(request, healthy, seconds) {
  if (typeof caches === 'undefined' || !caches.default) return;
  try {
    const response = new Response(JSON.stringify({ healthy }), {
      headers: {
        'Cache-Control': `public, max-age=${seconds}`,
        'Content-Type': 'application/json'
      }
    });
    await caches.default.put(healthCacheKey(request), response);
  } catch {
    // The maintenance decision must not depend on the optional edge cache.
  }
}

async function probeOriginHealth(origin) {
  try {
    const target = new URL('/api/health', origin);
    const response = await fetch(new Request(target.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-E-Posyandu-Health-Probe': 'pages'
      }
    }));
    // A response such as 401/404 still proves that the origin is reachable;
    // only gateway/upstream failures should activate the maintenance page.
    return !MAINTENANCE_GATEWAY_STATUSES.has(response.status);
  } catch {
    return false;
  }
}

async function shouldServeMaintenance(request, env, incomingUrl) {
  if (!isDocumentRequest(request, incomingUrl.pathname)) return false;
  if (envFlag(env.MAINTENANCE_MODE)) return true;
  if (!envFlag(env.AUTO_MAINTENANCE_ON_HEALTH_FAILURE, true)) return false;

  const cached = await readHealthCache(request);
  if (cached !== null) return !cached;

  const primary = upstreamOrigin(incomingUrl.hostname, env);
  const fallback = fallbackOrigin(incomingUrl.hostname, env, primary);
  let healthy = await probeOriginHealth(primary);
  if (!healthy && fallback) healthy = await probeOriginHealth(fallback);
  await writeHealthCache(request, healthy, maintenanceCacheSeconds(env));
  return !healthy;
}

async function serveMaintenancePage(request, env) {
  const maintenanceUrl = new URL('/maintenance.html', request.url);
  let assetResponse;
  try {
    assetResponse = await env.ASSETS.fetch(new Request(maintenanceUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'text/html' }
    }));
  } catch {
    return new Response('<!doctype html><title>E-Posyandu sedang dipelihara</title><h1>E-Posyandu sedang dipelihara</h1><p>Silakan coba kembali beberapa saat lagi.</p>', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'text/html; charset=UTF-8',
        'Retry-After': '120',
        'X-E-Posyandu-Maintenance': 'active'
      }
    });
  }
  const headers = new Headers(assetResponse.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Content-Type', 'text/html; charset=UTF-8');
  headers.set('Retry-After', '120');
  headers.set('X-E-Posyandu-Maintenance', 'active');
  return new Response(assetResponse.body, {
    status: 503,
    statusText: 'Service Unavailable',
    headers
  });
}

function createUpstreamRequest(request, origin, pathname, search) {
  const target = new URL(`${pathname}${search}`, origin);
  const headers = new Headers(request.headers);
  headers.delete('Host');
  headers.set('X-E-Posyandu-Proxy', 'pages');
  return new Request(target, {
    method: request.method,
    headers,
    body: SAFE_RETRY_METHODS.has(request.method.toUpperCase()) ? undefined : request.body,
    redirect: 'manual'
  });
}

function hasAuthenticatedCredentials(request) {
  if (request.headers.has('Authorization')) return true;
  const cookie = request.headers.get('Cookie') || '';
  // Native sessions use the __Host- prefix in production and the unprefixed
  // name in local development.  Never send an authenticated request to the
  // legacy fallback origin: it cannot validate the native session cookie.
  return /(?:^|;\s*)(?:__Host-)?e-posyandu-session=/.test(cookie);
}

function markFallback(response) {
  const headers = new Headers(response.headers);
  headers.set('X-E-Posyandu-Fallback', 'cloudflare-worker');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    if (!isApiPath(incomingUrl.pathname)) {
      if (await shouldServeMaintenance(request, env, incomingUrl)) {
        return serveMaintenancePage(request, env);
      }
      return env.ASSETS.fetch(request);
    }

    const primaryOrigin = upstreamOrigin(incomingUrl.hostname, env);
    const fallback = fallbackOrigin(incomingUrl.hostname, env, primaryOrigin);
    const canRetry = SAFE_RETRY_METHODS.has(request.method.toUpperCase())
      && fallback
      && !hasAuthenticatedCredentials(request);
    let primaryResponse;

    try {
      primaryResponse = await fetch(
        createUpstreamRequest(request, primaryOrigin, incomingUrl.pathname, incomingUrl.search)
      );
    } catch (error) {
      if (!canRetry) throw error;
      return markFallback(
        await fetch(createUpstreamRequest(request, fallback, incomingUrl.pathname, incomingUrl.search))
      );
    }

    if (!canRetry || !RETRYABLE_GATEWAY_STATUSES.has(primaryResponse.status)) {
      return primaryResponse;
    }

    return markFallback(
      await fetch(createUpstreamRequest(request, fallback, incomingUrl.pathname, incomingUrl.search))
    );
  }
};
