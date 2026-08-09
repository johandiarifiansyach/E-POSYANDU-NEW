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
  assert.equal(files.at(-1), '015_background_grpc_jobs.sql');
  for (const file of files) {
    const sql = (await readFile(resolve(root, 'database/migrations', file), 'utf8')).toLowerCase();
    assert.match(sql, /begin;/, `${file} harus transaksional`);
    assert.match(sql, /commit;/, `${file} harus ditutup dengan commit`);
  }
});

test('dashboard dan daftar balita memakai tanggal acuan umur yang sama', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/013_align_dashboard_child_total.sql'),
    'utf8'
  );

  assert.match(migration, /c\.birth_date <= p_month_end/);
  assert.match(migration, /c\.birth_date > \(p_month_end - interval '60 months'\)::date/);
  assert.doesNotMatch(migration, /c\.birth_date <= p_month_start/);
});

test('dashboard, masalah gizi, dan ASI memakai sumber serta cakupan data yang sama', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/014_unify_dashboard_report_counts.sql'),
    'utf8'
  );
  const dashboard = await readFile(resolve(root, 'frontend/src/pages/DashboardApp.ts'), 'utf8');
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');

  assert.match(migration, /create or replace function public\.eposyandu_problem_children_page/);
  assert.match(migration, /c\.birth_date <= p_month_end/g);
  assert.match(migration, /c\.birth_date > \(p_month_end - interval '60 months'\)::date/g);
  assert.match(migration, /coalesce\(m\.child_id, nullif\(m\.legacy_child_id, ''\)\)/g);
  for (const view of [
    'problem_underweight',
    'problem_stunting',
    'problem_wasting',
    'problem_tidak_naik'
  ]) {
    assert.match(migration, new RegExp(view));
    assert.match(dashboard, new RegExp(`'${view}'`));
  }
  assert.match(client, /query ChildrenPage/);
  assert.match(client, /query ExclusiveBreastfeedingPage/);
});

test('kontrak OpenAPI memuat endpoint operasional utama', async () => {
  const document = await readJson('backend/openapi.json');
  const application = await readJson('package.json');
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.info.version, application.version);
  for (const path of [
    '/api/v1/health',
    '/api/v1/auth/login',
    '/api/v1/graphql',
    '/api/v1/sync',
    '/api/v1/features',
    '/api/v1/client-errors',
    '/api/v1/jobs',
    '/api/v1/jobs/{jobId}',
    '/api/v1/jobs/{jobId}/file'
  ]) {
    assert.ok(document.paths[path], `OpenAPI belum memuat ${path}`);
  }
  assert.equal(
    document.paths['/api/v1/auth/login'].post.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/LoginResponse'
  );
  assert.equal(
    document.components.schemas.LoginResponse.properties.profile.$ref,
    '#/components/schemas/AccessProfile'
  );
});

test('GraphQL hanya untuk baca dan gRPC memakai kontrak internal terpisah', async () => {
  const worker = await readFile(resolve(root, 'backend/src/graphql.rs'), 'utf8');
  const proto = await readFile(resolve(root, 'services/nutrition-grpc/proto/nutrition.proto'), 'utf8');

  assert.match(worker, /OperationDefinition::Mutation/);
  assert.match(worker, /GraphQL hanya tersedia untuk membaca data/);
  assert.match(worker, /api::dispatch\(request, env\)/);
  assert.match(proto, /service NutritionWorker/);
  for (const method of [
    'CalculateBatch',
    'ValidateImport',
    'CalculateReport',
    'PrepareExport',
    'NormalizeSyncBatch',
    'ProcessJob'
  ]) {
    assert.match(proto, new RegExp(`rpc ${method}\\b`));
  }
});

test('pekerjaan berat memakai migration privat, Queue, dan kontrak frontend', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/015_background_grpc_jobs.sql'),
    'utf8'
  );
  const wrangler = await readFile(resolve(root, 'backend/wrangler.toml'), 'utf8');
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');

  assert.match(migration, /create table if not exists public\.background_jobs/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on table public\.background_jobs from anon, authenticated/);
  assert.match(wrangler, /binding = "E_POSYANDU_JOBS"/);
  assert.match(wrangler, /queue = "e-posyandu-jobs"/);
  assert.match(client, /export async function createBackgroundJob/);
  assert.match(client, /export async function waitForBackgroundJob/);
  assert.match(client, /export async function downloadBackgroundJobFile/);
});

test('manifest dan service worker membentuk shell PWA yang dapat dipasang', async () => {
  const manifest = await readJson('frontend/public/manifest.webmanifest');
  const serviceWorker = await readFile(resolve(root, 'frontend/public/service-worker.js'), 'utf8');

  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert.match(serviceWorker, /APP_SHELL/);
  assert.match(serviceWorker, /request\.mode === 'navigate'/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/assets\/'\)/);
});

test('header keamanan frontend mencakup kebijakan utama', async () => {
  const headers = await readFile(resolve(root, 'frontend/public/_headers'), 'utf8');
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
