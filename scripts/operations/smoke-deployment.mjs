import assert from 'node:assert/strict';

const frontendBase = process.env.SMOKE_FRONTEND_URL?.trim();
const apiBase = process.env.SMOKE_API_URL?.trim();
const accessToken = process.env.SMOKE_ACCESS_TOKEN?.trim();
const sessionCookie = process.env.SMOKE_SESSION_COOKIE?.trim();
const expectedDatabase = process.env.SMOKE_EXPECTED_DATABASE?.trim() || 'oracle-postgresql';
const requireSecurityHeaders = process.env.SMOKE_REQUIRE_SECURITY_HEADERS !== 'false';

assert(frontendBase, 'SMOKE_FRONTEND_URL wajib diisi.');
assert(apiBase, 'SMOKE_API_URL wajib diisi.');
assert(
  ['oracle-postgresql', 'supabase'].includes(expectedDatabase),
  'SMOKE_EXPECTED_DATABASE harus oracle-postgresql atau supabase.'
);

const timeoutMs = 20_000;
const checked = [];

async function rawRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      'X-Request-ID': `smoke-${crypto.randomUUID()}`,
      ...options.headers
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function request(url, options = {}) {
  const response = await rawRequest(url, options);
  assert(response.ok, `${url} mengembalikan HTTP ${response.status}.`);
  return response;
}

function authenticationHeaders() {
  if (sessionCookie) return { Cookie: sessionCookie };
  if (accessToken) return { Authorization: `Bearer ${accessToken}` };
  return {};
}

function endpoint(base, path) {
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return new URL(path.replace(/^\//, ''), normalized).toString();
}

const frontendResponse = await request(frontendBase);
const html = await frontendResponse.text();
assert.match(html, /<html[^>]+lang=["']id["']/i, 'Bahasa dokumen frontend bukan Indonesia.');
assert.match(html, /<div[^>]+id=["']root["']/i, 'Root aplikasi frontend tidak ditemukan.');
checked.push('frontend');

if (requireSecurityHeaders) {
  for (const header of [
    'content-security-policy',
    'reporting-endpoints',
    'strict-transport-security',
    'referrer-policy',
    'x-content-type-options'
  ]) {
    assert(frontendResponse.headers.get(header), `Header keamanan ${header} tidak ditemukan.`);
  }
  const csp = frontendResponse.headers.get('content-security-policy') ?? '';
  assert.match(csp, /object-src 'none'/, 'CSP belum memblokir object/embed.');
  assert.match(csp, /frame-ancestors 'none'/, 'CSP belum mencegah clickjacking.');
  assert.match(csp, /report-uri \/api\/v1\/security\/csp-report/, 'Endpoint laporan CSP belum aktif.');
  assert(!csp.includes("'unsafe-eval'"), 'CSP masih mengizinkan unsafe-eval.');
  checked.push('security-headers');
}

const healthResponse = await request(endpoint(apiBase, '/api/v1/health'));
const health = await healthResponse.json();
assert.equal(health.ok, true, 'Health check API tidak sehat.');
assert.equal(health.database, expectedDatabase, 'API tidak terhubung ke database yang diharapkan.');
checked.push('api-health');

const openApiResponse = await request(endpoint(apiBase, '/api/v1/openapi.json'));
const openApi = await openApiResponse.json();
assert.equal(openApi.openapi, '3.1.0', 'Dokumen OpenAPI tidak valid.');
assert(openApi.paths?.['/api/v1/health'], 'Endpoint health tidak tercatat di OpenAPI.');
checked.push('openapi');

const authHeaders = authenticationHeaders();
if (Object.keys(authHeaders).length > 0) {
  const sessionResponse = await request(endpoint(apiBase, '/api/v1/auth/session'), {
    headers: authHeaders
  });
  const session = await sessionResponse.json();
  assert(session.user?.id, 'Sesi terautentikasi tidak mengembalikan user ID.');
  assert(session.profile?.role, 'Sesi terautentikasi tidak mengembalikan role.');
  assert(!('accessToken' in session), 'Endpoint sesi membocorkan access token.');
  assert(!('refreshToken' in session), 'Endpoint sesi membocorkan refresh token.');
  checked.push('authenticated-session');

  const historyResponse = await request(
    endpoint(apiBase, '/api/v1/collections/change_logs?order=timestamp%7Cdesc&page=1&size=10'),
    { headers: authHeaders }
  );
  const history = await historyResponse.json();
  assert(Array.isArray(history.items), 'Respons riwayat tidak memiliki daftar data.');
  assert(history.items.length <= 10, 'Riwayat membaca lebih dari 10 data per halaman.');
  assert.equal(history.page, 1, 'Nomor halaman riwayat tidak sesuai.');
  assert.equal(history.size, 10, 'Ukuran halaman riwayat tidak sesuai.');
  assert(Number(history.total) >= history.items.length, 'Jumlah total riwayat tidak valid.');
  checked.push('authenticated-history-page');
} else {
  const rejectedSession = await rawRequest(endpoint(apiBase, '/api/v1/auth/session'));
  assert(
    rejectedSession.status === 401 || rejectedSession.status === 403,
    `Endpoint sesi tanpa kredensial seharusnya ditolak, tetapi mengembalikan HTTP ${rejectedSession.status}.`
  );
  assert.match(
    rejectedSession.headers.get('cache-control') ?? '',
    /no-store/,
    'Respons penolakan sesi boleh tersimpan di cache.'
  );
  checked.push('unauthenticated-session-rejected');
  checked.push('authenticated-check-skipped-no-ephemeral-credential');
}

console.log(JSON.stringify({ event: 'deployment_smoke', ok: true, checked }));
