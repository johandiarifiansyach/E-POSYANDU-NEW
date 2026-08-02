import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));

test('migration database berurutan dan tercatat sampai versi terbaru', async () => {
  const files = (await readdir(resolve(root, 'database/migrations')))
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .sort();
  const versions = files.map((file) => Number(file.slice(0, 3)));

  assert.deepEqual(versions, Array.from({ length: versions.length }, (_, index) => index + 1));
  assert.equal(files.at(-1), '012_pmt_baseline_measurements.sql');
  for (const file of files) {
    const sql = (await readFile(resolve(root, 'database/migrations', file), 'utf8')).toLowerCase();
    assert.match(sql, /begin;/, `${file} harus transaksional`);
    assert.match(sql, /commit;/, `${file} harus ditutup dengan commit`);
  }
});

test('kontrak OpenAPI memuat endpoint operasional utama', async () => {
  const document = await readJson('backend-rust-worker/openapi.json');
  const application = await readJson('package.json');
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.info.version, application.version);
  for (const path of [
    '/api/v1/health',
    '/api/v1/auth/login',
    '/api/v1/sync',
    '/api/v1/features',
    '/api/v1/client-errors'
  ]) {
    assert.ok(document.paths[path], `OpenAPI belum memuat ${path}`);
  }
});

test('manifest dan service worker membentuk shell PWA yang dapat dipasang', async () => {
  const manifest = await readJson('public/manifest.webmanifest');
  const serviceWorker = await readFile(resolve(root, 'public/service-worker.js'), 'utf8');

  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert.match(serviceWorker, /APP_SHELL/);
  assert.match(serviceWorker, /request\.mode === 'navigate'/);
  assert.match(serviceWorker, /CACHE_URLS/);
});

test('header keamanan frontend mencakup kebijakan utama', async () => {
  const headers = await readFile(resolve(root, 'public/_headers'), 'utf8');
  for (const header of [
    'Content-Security-Policy:',
    'Strict-Transport-Security:',
    'Referrer-Policy:',
    'X-Content-Type-Options:',
    'Permissions-Policy:'
  ]) {
    assert.match(headers, new RegExp(header));
  }
});
