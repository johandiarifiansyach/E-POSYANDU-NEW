const PRODUCTION_API_ORIGIN = 'https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev';
const STAGING_API_ORIGIN = 'https://e-posyandu-api-staging.eposyandu-puskesmas-gumukmas.workers.dev';

function upstreamOrigin(hostname) {
  return hostname.includes('e-posyandu-staging.pages.dev')
    ? STAGING_API_ORIGIN
    : PRODUCTION_API_ORIGIN;
}

function isApiPath(pathname) {
  return pathname === '/api/health' || pathname.startsWith('/api/v1/');
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    if (!isApiPath(incomingUrl.pathname)) return env.ASSETS.fetch(request);

    const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, upstreamOrigin(incomingUrl.hostname));
    const headers = new Headers(request.headers);
    headers.delete('Host');
    headers.set('X-E-Posyandu-Proxy', 'pages');
    const upstreamRequest = new Request(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    });
    return fetch(upstreamRequest);
  }
};
