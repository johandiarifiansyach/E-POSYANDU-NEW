import assert from 'node:assert/strict';

const frontendBase = process.env.SMOKE_FRONTEND_URL?.trim();
const apiBase = process.env.SMOKE_API_URL?.trim();
const accessToken = process.env.SMOKE_ACCESS_TOKEN?.trim();
const requireSecurityHeaders = process.env.SMOKE_REQUIRE_SECURITY_HEADERS !== 'false';

assert(frontendBase, 'SMOKE_FRONTEND_URL wajib diisi.');
assert(apiBase, 'SMOKE_API_URL wajib diisi.');

const timeoutMs = 20_000;
const checked = [];

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      'X-Request-ID': `smoke-${crypto.randomUUID()}`,
      ...options.headers
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  assert(response.ok, `${url} mengembalikan HTTP ${response.status}.`);
  return response;
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
    'strict-transport-security',
    'referrer-policy',
    'x-content-type-options'
  ]) {
    assert(frontendResponse.headers.get(header), `Header keamanan ${header} tidak ditemukan.`);
  }
  checked.push('security-headers');
}

const healthResponse = await request(endpoint(apiBase, '/api/v1/health'));
const health = await healthResponse.json();
assert.equal(health.ok, true, 'Health check API tidak sehat.');
assert.equal(health.database, 'supabase', 'API tidak terhubung ke database yang diharapkan.');
checked.push('api-health');

const openApiResponse = await request(endpoint(apiBase, '/api/v1/openapi.json'));
const openApi = await openApiResponse.json();
assert.equal(openApi.openapi, '3.1.0', 'Dokumen OpenAPI tidak valid.');
assert(openApi.paths?.['/api/v1/health'], 'Endpoint health tidak tercatat di OpenAPI.');
checked.push('openapi');

if (accessToken) {
  const historyResponse = await request(
    endpoint(apiBase, '/api/v1/collections/change_logs?order=timestamp%7Cdesc&page=1&size=10'),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const history = await historyResponse.json();
  assert(Array.isArray(history.items), 'Respons riwayat tidak memiliki daftar data.');
  assert(history.items.length <= 10, 'Riwayat membaca lebih dari 10 data per halaman.');
  assert.equal(history.page, 1, 'Nomor halaman riwayat tidak sesuai.');
  assert.equal(history.size, 10, 'Ukuran halaman riwayat tidak sesuai.');
  assert(Number(history.total) >= history.items.length, 'Jumlah total riwayat tidak valid.');
  checked.push('authenticated-history-page');
} else {
  checked.push('authenticated-check-skipped');
}

console.log(JSON.stringify({ event: 'deployment_smoke', ok: true, checked }));
