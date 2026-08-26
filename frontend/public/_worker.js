const PRODUCTION_API_ORIGIN = 'https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev';
const STAGING_API_ORIGIN = 'https://e-posyandu-api-staging.eposyandu-puskesmas-gumukmas.workers.dev';
const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// During the Oracle microservices migration an existing browser may still
// carry a valid legacy Cloudflare session. A 401 from the new gateway is
// therefore retried against the legacy origin for safe read requests; native
// sessions continue to be served by Oracle and mutations are never retried.
const RETRYABLE_GATEWAY_STATUSES = new Set([401, 502, 503, 504]);

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
    PRODUCTION_API_ORIGIN
  );
  return fallback === primaryOrigin ? null : fallback;
}

function isApiPath(pathname) {
  return pathname === '/api/health' || pathname.startsWith('/api/v1/');
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
    if (!isApiPath(incomingUrl.pathname)) return env.ASSETS.fetch(request);

    const primaryOrigin = upstreamOrigin(incomingUrl.hostname, env);
    const fallback = fallbackOrigin(incomingUrl.hostname, env, primaryOrigin);
    const canRetry = SAFE_RETRY_METHODS.has(request.method.toUpperCase()) && fallback;
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
