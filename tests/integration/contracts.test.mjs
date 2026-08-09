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
    '/api/v1/health/ready',
    '/api/v1/auth/login',
    '/api/v1/graphql',
    '/api/v1/sync',
    '/api/v1/features',
    '/api/v1/monitoring/status',
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

test('environment database dipisahkan dan penulisan non-production dilindungi', async () => {
  const worker = await readFile(resolve(root, 'backend/src/lib.rs'), 'utf8');
  const wrangler = await readFile(resolve(root, 'backend/wrangler.toml'), 'utf8');
  const checker = await readFile(
    resolve(root, 'scripts/environment/check-database-isolation.sh'),
    'utf8'
  );

  assert.match(worker, /fn enforce_environment_write_guard/);
  assert.match(worker, /shared_production/);
  assert.match(wrangler, /PRODUCTION_SUPABASE_PROJECT_REF/);
  assert.match(checker, /development, staging, dan production masih memakai project Supabase yang sama/);
});

test('monitoring worker tersimpan di KV dan MQTT ditunda sampai ada IoT', async () => {
  const worker = await readFile(resolve(root, 'backend/src/lib.rs'), 'utf8');
  const decision = await readFile(resolve(root, 'docs/decisions/001-mqtt-deferred.md'), 'utf8');
  const r2 = await readFile(resolve(root, 'scripts/storage/prepare-r2.sh'), 'utf8');

  assert.match(worker, /NUTRITION_WORKER_FAILURE_THRESHOLD/);
  assert.match(worker, /monitoring:nutrition-worker:v1/);
  assert.match(worker, /send_monitoring_alert/);
  assert.match(worker, /R2_SOFT_LIMIT_BYTES/);
  assert.match(worker, /monitor_and_cleanup_r2/);
  assert.match(decision, /MQTT baru dievaluasi ketika tersedia perangkat IoT nyata/);
  assert.match(r2, /e-posyandu-files/);
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

test('riwayat perubahan dimuat langsung, dibatasi, dan rincian diproses bertahap', async () => {
  const worker = await readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8');
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');
  const dashboard = await readFile(resolve(root, 'frontend/src/pages/DashboardApp.ts'), 'utf8');

  assert.match(worker, /for id_chunk in ids\.chunks\(75\)/);
  assert.match(
    worker,
    /resource == Resource::ChangeLogs\s*&& !export_request\s*&& first_query\(&query, "page"\)\.is_some\(\)/
  );
  assert.match(client, /export async function getChangeHistory/);
  assert.match(client, /collections\/change_logs\?order=timestamp%7Cdesc&page=/);
  assert.match(dashboard, /getChangeHistory\(changeHistoryPage, 10\)/);
  assert.match(dashboard, /setChangeHistoryError/);
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

test('deployment diperiksa berkala dan backup hanya disimpan dalam bentuk terenkripsi', async () => {
  const smokeScript = await readFile(
    resolve(root, 'scripts/operations/smoke-deployment.mjs'),
    'utf8'
  );
  const smokeWorkflow = await readFile(
    resolve(root, '.github/workflows/deployment-smoke.yml'),
    'utf8'
  );
  const backupWorkflow = await readFile(
    resolve(root, '.github/workflows/database-backup.yml'),
    'utf8'
  );
  const ciWorkflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');

  assert.match(smokeScript, /SMOKE_REQUIRE_SECURITY_HEADERS/);
  assert.match(smokeScript, /history\.items\.length <= 10/);
  assert.match(smokeWorkflow, /17 \*\/6 \* \* \*/);
  assert.match(backupWorkflow, /aes-256-cbc/);
  assert.match(backupWorkflow, /BACKUP_ENCRYPTION_PASSWORD/);
  assert.match(backupWorkflow, /verify-backup\.sh/);
  assert.match(backupWorkflow, /retention-days: 14/);
  assert.doesNotMatch(backupWorkflow, /upload-artifact[\s\S]+e-posyandu\.dump(?:\n|$)/);
  assert.match(ciWorkflow, /npm run check/);
  assert.match(ciWorkflow, /services\/nutrition-grpc/);
});

test('sinkronisasi offline mendeteksi konflik dan tidak menimpa perubahan diam-diam', async () => {
  const store = await readFile(resolve(root, 'frontend/src/services/offlineStore.ts'), 'utf8');
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');
  const dashboard = await readFile(resolve(root, 'frontend/src/pages/DashboardApp.ts'), 'utf8');
  const worker = await readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8');

  assert.match(store, /const CONFLICT_STORE = 'conflicts'/);
  assert.match(store, /export async function recordSyncConflict/);
  assert.match(client, /function handleSyncConflict/);
  assert.match(client, /function rebaseNextMutation/);
  assert.match(client, /export async function resolveSyncConflict/);
  assert.match(client, /expectedVersion/);
  assert.match(dashboard, /Gunakan Data Saya/);
  assert.match(dashboard, /Gunakan Data Server/);
  assert.match(worker, /serverDocument/);
  assert.match(worker, /expectedUpdatedAt/);
});

test('monitoring terpadu dan load test Queue gRPC memiliki batas aman', async () => {
  const monitor = await readFile(resolve(root, 'scripts/operations/monitor-system.mjs'), 'utf8');
  const monitorWorkflow = await readFile(resolve(root, '.github/workflows/system-monitor.yml'), 'utf8');
  const queueLoad = await readFile(resolve(root, 'scripts/operations/load-queue.mjs'), 'utf8');
  const grpcLoad = await readFile(resolve(root, 'services/nutrition-grpc/src/bin/load.rs'), 'utf8');
  const loadWorkflow = await readFile(resolve(root, '.github/workflows/load-test.yml'), 'utf8');

  assert.match(monitor, /health\/ready/);
  assert.match(monitor, /nutrition-worker/);
  assert.match(monitorWorkflow, /7,37 \* \* \* \*/);
  assert.match(queueLoad, /LOAD_ACCESS_TOKEN/);
  assert.match(queueLoad, /Math\.min\(50/);
  assert.match(grpcLoad, /LOAD_GRPC_CONCURRENCY/);
  assert.match(grpcLoad, /"p95": p95/);
  assert.match(loadWorkflow, /environment: load-test/);
});

test('backup diverifikasi dan restore drill memeriksa isi database', async () => {
  const verify = await readFile(resolve(root, 'scripts/database/verify-backup.sh'), 'utf8');
  const restore = await readFile(resolve(root, 'scripts/database/restore-drill.sh'), 'utf8');

  assert.match(verify, /pg_restore --list/);
  assert.match(verify, /schema_migrations/);
  assert.match(restore, /Tabel public\.children tidak ditemukan setelah restore/);
  assert.match(restore, /latest_migration/);
});
