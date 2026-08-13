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
  assert.equal(files.at(-1), '020_read_replica_children_page.sql');
  for (const file of files) {
    const sql = (await readFile(resolve(root, 'database/migrations', file), 'utf8')).toLowerCase();
    assert.match(sql, /begin;/, `${file} harus transaksional`);
    assert.match(sql, /commit;/, `${file} harus ditutup dengan commit`);
  }
});

test('fallback autentikasi hanya dapat membaca profil akun sendiri yang masih aktif', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/016_auth_profile_fallback.sql'),
    'utf8'
  );
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');

  assert.match(migration, /security definer/);
  assert.match(migration, /users\.user_id = auth\.uid\(\)/);
  assert.match(migration, /and users\.active/);
  assert.match(migration, /revoke all on function public\.eposyandu_current_access_profile\(\) from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_current_access_profile\(\) to authenticated, service_role/);
  assert.match(client, /rest\/v1\/rpc\/eposyandu_current_access_profile/);
});

test('fallback baca darurat tetap dibatasi role dan wilayah akun aktif', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/017_authenticated_read_fallback.sql'),
    'utf8'
  );
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');

  assert.match(migration, /security definer/g);
  assert.match(migration, /profile\.user_id = auth\.uid\(\) and profile\.active/g);
  assert.match(migration, /public\.eposyandu_scope_match/);
  assert.match(migration, /revoke all on function public\.eposyandu_self_children_page[\s\S]+from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_self_children_page[\s\S]+to authenticated, service_role/);
  assert.match(client, /eposyandu_self_children_page/);
  assert.match(client, /eposyandu_self_problem_children_page/);
  assert.match(client, /eposyandu_self_exclusive_breastfeeding_page/);
  assert.match(client, /eposyandu_self_dashboard_stats/);
});

test('fallback tulis penimbangan bersifat atomik dan hanya menerima kolom ringkasan aman', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/018_authenticated_measurement_write_fallback.sql'),
    'utf8'
  );
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');

  assert.match(migration, /security definer/);
  assert.match(migration, /users\.user_id = auth\.uid\(\)/);
  assert.match(migration, /public\.eposyandu_location_allowed/);
  assert.match(migration, /Hanya ringkasan pengukuran balita yang dapat diperbarui/);
  assert.match(migration, /on conflict \(idempotency_key, action, resource, document_id\) do nothing/g);
  assert.match(migration, /revoke all on function public\.eposyandu_self_sync_measurement_batch\(jsonb\) from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_self_sync_measurement_batch\(jsonb\) to authenticated, service_role/);
  assert.match(client, /supportsAuthenticatedMeasurementFallback/);
  assert.match(client, /eposyandu_self_sync_measurement_batch/);
  assert.match(client, /if \(!isNetworkError\(error\)\) throw error/);
});

test('helper akses wilayah dipulihkan untuk jalur penimbangan terautentikasi', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/019_restore_location_access_helper.sql'),
    'utf8'
  );

  assert.match(migration, /create or replace function public\.eposyandu_location_allowed/);
  assert.match(migration, /users\.user_id = auth\.uid\(\)/);
  assert.match(migration, /users\.role = 'Ahli Gizi'/);
  assert.match(migration, /users\.role = 'Bidan Desa' and users\.village = p_village/);
  assert.match(migration, /users\.role = 'Kader Posyandu'/);
  assert.match(migration, /revoke all on function public\.eposyandu_location_allowed\(text, text\) from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_location_allowed\(text, text\) to authenticated, service_role/);
});

test('Neon hanya menjadi read replica privat dengan fallback ke Supabase', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/020_read_replica_children_page.sql'),
    'utf8'
  );
  const worker = await readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8');
  const wrangler = await readFile(resolve(root, 'backend/wrangler.toml'), 'utf8');
  const pipeline = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const replicaWorker = await readFile(
    resolve(root, 'services/neon-read-worker/src/index.ts'),
    'utf8'
  );
  const replicaWrangler = await readFile(
    resolve(root, 'services/neon-read-worker/wrangler.toml'),
    'utf8'
  );
  const bootstrap = await readFile(
    resolve(root, 'scripts/database/bootstrap-neon-read-replica.sh'),
    'utf8'
  );
  const verifier = await readFile(
    resolve(root, 'scripts/database/verify-neon-read-replica.sh'),
    'utf8'
  );

  assert.match(migration, /eposyandu_replica_children_page/);
  assert.match(migration, /p_role text default 'Ahli Gizi'/);
  assert.match(worker, /env\.service\("NEON_READ_SERVICE"\)/);
  assert.match(worker, /read_router_fallback/);
  assert.match(worker, /replica:primary-pin:v1/);
  assert.match(wrangler, /binding = "NEON_READ_SERVICE"/);
  assert.match(pipeline, /npm ci --prefix services\/neon-read-worker/);
  assert.ok(
    pipeline.indexOf('name: Deploy private Neon read worker') <
      pipeline.indexOf('npx --yes wrangler --cwd backend deploy --env=""')
  );
  assert.match(replicaWorker, /const READ_OPERATIONS = new Set/);
  assert.match(replicaWorker, /const SYNC_TABLES = \["children", "measurements", "mpasi_logs"\]/);
  assert.match(replicaWorker, /SUPABASE_SECRET_KEY/);
  assert.match(replicaWorker, /\/rest\/v1\//);
  assert.match(replicaWorker, /eposyandu_replica_apply_batch/);
  assert.match(replicaWorker, /eposyandu_replica_apply_tombstones/);
  assert.match(replicaWorker, /async scheduled/);
  assert.match(replicaWrangler, /crons = \["\*\/5 \* \* \* \*"\]/);
  assert.match(replicaWrangler, /workers_dev = false/);
  for (const table of ['children', 'measurements', 'mpasi_logs', 'eposyandu_growth_lms']) {
    assert.match(bootstrap, new RegExp(`public\\.${table}`));
    assert.match(verifier, new RegExp(`\\b${table}\\b`));
  }
  assert.match(bootstrap, /Membuat snapshot awal melalui koneksi lokal/);
  assert.match(bootstrap, /eposyandu_replica_sync_state/);
  assert.match(bootstrap, /eposyandu_replica_apply_batch/);
  assert.match(bootstrap, /eposyandu_replica_apply_tombstones/);
  assert.doesNotMatch(bootstrap, /create publication|create subscription|replication_slot/i);
  assert.doesNotMatch(bootstrap, /grant execute on all functions/i);
  assert.match(bootstrap, /default_transaction_read_only = on/);
  assert.match(bootstrap, /grant select on table/);
  assert.match(bootstrap, /revoke all on function public\.eposyandu_replica_apply_batch/);
  assert.doesNotMatch(bootstrap, /-c\s+"[^"]*:'(?:reader_role)'/);
  assert.match(verifier, /Role %s masih memiliki hak tulis/);
  assert.match(verifier, /Sinkronisasi Neon tertinggal/);
  assert.match(verifier, /eposyandu_dashboard_stats/);
  assert.doesNotMatch(verifier, /-c\s+"[^"]*:'(?:reader_role|relation)'/);
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

test('halaman balita hanya membaca cache untuk ID yang sedang ditampilkan', async () => {
  const client = await readFile(resolve(root, 'frontend/src/api/client.ts'), 'utf8');
  const offlineStore = await readFile(
    resolve(root, 'frontend/src/services/offlineStore.ts'),
    'utf8'
  );
  const cacheRemoteDocuments = offlineStore.slice(
    offlineStore.indexOf('export async function cacheRemoteDocuments'),
    offlineStore.indexOf('export async function queueMutation')
  );

  assert.match(client, /getCachedDocumentsByIds\('children', response\.items\.map/);
  assert.match(cacheRemoteDocuments, /getCachedDocumentsByIds\(tableName, documents\.map/);
  assert.doesNotMatch(cacheRemoteDocuments, /getCachedDocuments\(tableName\)/);
  assert.match(client, /API_REQUEST_TIMEOUT_MS = 20_000/);
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
  assert.match(backupWorkflow, /source-fingerprint/);
  assert.match(backupWorkflow, /Target restore sama dengan database produksi/);
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
  const workerConfig = await readFile(resolve(root, 'backend/wrangler.toml'), 'utf8');
  const queueLoad = await readFile(resolve(root, 'scripts/operations/load-queue.mjs'), 'utf8');
  const grpcLoad = await readFile(resolve(root, 'services/nutrition-grpc/src/bin/load.rs'), 'utf8');
  const loadWorkflow = await readFile(resolve(root, '.github/workflows/load-test.yml'), 'utf8');

  assert.match(monitor, /health\/ready/);
  assert.match(monitor, /nutrition-worker/);
  assert.match(monitorWorkflow, /7,37 0-8 \* \* MON-FRI/);
  assert.match(monitorWorkflow, /0 9 \* \* MON-FRI/);
  assert.match(workerConfig, /\*\/10 0-8 \* \* MON-FRI/);
  assert.match(workerConfig, /0 9 \* \* MON-FRI/);
  assert.match(queueLoad, /LOAD_SUPABASE_URL/);
  assert.match(queueLoad, /LOAD_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(queueLoad, /LOAD_TEST_EMAIL/);
  assert.match(queueLoad, /grant_type=password/);
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
  assert.match(restore, /pg_restore --dbname="\$RESTORE_DATABASE_URL"/);
  assert.match(restore, /drop schema if exists public cascade/);
  assert.match(restore, /--use-list="\$restore_list"/);
  assert.match(restore, /TABLE DATA public app_users/);
  assert.doesNotMatch(restore, /pg_restore[\s\S]+--clean/);
  assert.match(restore, /Tabel public\.children tidak ditemukan setelah restore/);
  assert.match(restore, /latest_migration/);
});
