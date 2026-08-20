import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const API_MODULES = [
  'frontend/src/api/client.ts',
  'frontend/src/api/httpClient.ts',
  'frontend/src/api/authApi.ts',
  'frontend/src/api/childrenApi.ts',
  'frontend/src/api/measurementApi.ts',
  'frontend/src/api/dashboardApi.ts',
  'frontend/src/api/exportApi.ts',
  'frontend/src/api/syncApi.ts',
  'frontend/src/api/legacyClient.ts'
];
const readApiClient = async () =>
  (await Promise.all(API_MODULES.map((path) => readFile(resolve(root, path), 'utf8')))).join('\n');

async function readSourceTree(path) {
  const absolutePath = resolve(root, path);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const sources = await Promise.all(entries.map(async (entry) => {
    const relativePath = `${path}/${entry.name}`;
    if (entry.isDirectory()) return readSourceTree(relativePath);
    if (!/\.(?:js|mjs|rs|ts|tsx)$/.test(entry.name)) return '';
    return readFile(resolve(root, relativePath), 'utf8');
  }));
  return sources.flat(Infinity).join('\n');
}

test('migration database berurutan dan tercatat sampai versi terbaru', async () => {
  const files = (await readdir(resolve(root, 'database/migrations')))
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .sort();
  const versions = files.map((file) => Number(file.slice(0, 3)));

  assert.deepEqual(versions, Array.from({ length: versions.length }, (_, index) => index + 1));
  assert.equal(files.at(-1), '028_remove_second_step_policies.sql');
  for (const file of files) {
    const sql = (await readFile(resolve(root, 'database/migrations', file), 'utf8')).toLowerCase();
    assert.match(sql, /begin;/, `${file} harus transaksional`);
    assert.match(sql, /commit;/, `${file} harus ditutup dengan commit`);
  }
});

test('RPC profil lama tetap terkunci meskipun tidak lagi dipakai untuk melewati login utama', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/016_auth_profile_fallback.sql'),
    'utf8'
  );
  assert.match(migration, /security definer/);
  assert.match(migration, /users\.user_id = auth\.uid\(\)/);
  assert.match(migration, /and users\.active/);
  assert.match(migration, /revoke all on function public\.eposyandu_current_access_profile\(\) from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_current_access_profile\(\) to authenticated, service_role/);
});

test('RPC browser lama ditutup setelah proxy HttpOnly tersedia', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/017_authenticated_read_fallback.sql'),
    'utf8'
  );
  const client = await readApiClient();
  const securityMigration = await readFile(
    resolve(root, 'database/migrations/027_close_direct_browser_fallback.sql'),
    'utf8'
  );

  assert.match(migration, /security definer/g);
  assert.match(migration, /profile\.user_id = auth\.uid\(\) and profile\.active/g);
  assert.match(migration, /public\.eposyandu_scope_match/);
  assert.match(migration, /revoke all on function public\.eposyandu_self_children_page[\s\S]+from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_self_children_page[\s\S]+to authenticated, service_role/);
  assert.match(securityMigration, /revoke execute on function public\.eposyandu_self_children_page[\s\S]+from authenticated/);
  assert.doesNotMatch(securityMigration, /authenticated_aal2_only|auth\.jwt\(\)->>'aal'/);
  assert.doesNotMatch(client, /eposyandu_self_children_page/);
  assert.doesNotMatch(client, /eposyandu_self_problem_children_page/);
  assert.doesNotMatch(client, /eposyandu_self_exclusive_breastfeeding_page/);
  assert.doesNotMatch(client, /eposyandu_self_dashboard_stats/);
});

test('RPC tulis browser lama dicabut dan sinkronisasi kembali melalui API', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/018_authenticated_measurement_write_fallback.sql'),
    'utf8'
  );
  const client = await readApiClient();
  const securityMigration = await readFile(
    resolve(root, 'database/migrations/027_close_direct_browser_fallback.sql'),
    'utf8'
  );

  assert.match(migration, /security definer/);
  assert.match(migration, /users\.user_id = auth\.uid\(\)/);
  assert.match(migration, /public\.eposyandu_location_allowed/);
  assert.match(migration, /Hanya ringkasan pengukuran balita yang dapat diperbarui/);
  assert.match(migration, /on conflict \(idempotency_key, action, resource, document_id\) do nothing/g);
  assert.match(migration, /revoke all on function public\.eposyandu_self_sync_measurement_batch\(jsonb\) from public, anon/);
  assert.match(migration, /grant execute on function public\.eposyandu_self_sync_measurement_batch\(jsonb\) to authenticated, service_role/);
  assert.match(client, /supportsMeasurementMutation/);
  assert.match(client, /apiRequest<SyncResponse>\('\/sync'/);
  assert.doesNotMatch(client, /eposyandu_self_sync_measurement_batch/);
  assert.match(securityMigration, /revoke execute on function public\.eposyandu_self_sync_measurement_batch\(jsonb\) from authenticated/);
});

test('fallback penimbangan menyimpan LILA kosong untuk bayi di bawah tiga bulan', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/026_allow_infant_lila_null.sql'),
    'utf8'
  );

  assert.match(migration, /ageInMonths[\s\S]+< 3/);
  assert.match(migration, /LiLA tidak diukur pada bayi usia 0 sampai 2 bulan/);
  assert.match(migration, /nullif\(v_data->>'lila', ''\)::numeric/);
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
  assert.match(bootstrap, /Session Pooler port 5432/);
  assert.match(bootstrap, /validate_connection "SOURCE_DATABASE_URL" "\$SOURCE_DATABASE_URL" true/);
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
  const dashboard = await readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8');
  const client = await readApiClient();

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
  const client = await readApiClient();
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
    '/api/v1/auth/logout',
    '/api/v1/auth/session',
    '/api/v1/graphql',
    '/api/v1/sync',
    '/api/v1/features',
    '/api/v1/monitoring/status',
    '/api/v1/client-errors',
    '/api/v1/security/csp-report',
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
  assert.ok(document.components.securitySchemes.sessionCookie);
  assert.ok(!('access_token' in document.components.schemas.LoginResponse.properties));
  assert.ok(!('refresh_token' in document.components.schemas.LoginResponse.properties));
  assert.ok(!('mfa' in document.components.schemas.LoginResponse.properties));
  assert.equal(
    document.components.schemas.LoginResponse.properties.profile.$ref,
    '#/components/schemas/AccessProfile'
  );
});

test('ringkasan AI pertumbuhan tidak diekspos sebelum layanan siap', async () => {
  const [worker, wrangler, document] = await Promise.all([
    readFile(resolve(root, 'backend/src/lib.rs'), 'utf8'),
    readFile(resolve(root, 'backend/wrangler.toml'), 'utf8'),
    readJson('backend/openapi.json')
  ]);

  assert.ok(!document.paths['/api/v1/ai/growth-summary']);
  assert.ok(!Object.keys(document.components.schemas).some((name) => /GrowthAi|AnonymousGrowth/.test(name)));
  assert.doesNotMatch(worker, /ai\/growth-summary|mod ai/);
  assert.doesNotMatch(wrangler, /OPENAI/);
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

test('Neon mengambil alih baca hanya untuk sesi Supabase yang pernah diverifikasi', async () => {
  const worker = await readFile(resolve(root, 'backend/src/lib.rs'), 'utf8');

  assert.match(worker, /VERIFIED_SCOPE_CACHE_PREFIX/);
  assert.match(worker, /hashed_key\(VERIFIED_SCOPE_CACHE_PREFIX, token\)/);
  assert.match(worker, /expiration_ttl\(ttl\)/);
  assert.match(worker, /jwt_expiration_seconds/);
  assert.match(worker, /fn is_emergency_read_route/);
  assert.match(worker, /path == "\/api\/v1\/graphql"/);
  assert.match(worker, /fn upstream_is_unavailable/);
  assert.match(worker, /status == 429 \|\| status >= 500/);
  assert.match(worker, /"writes": "primary-only"/);
  assert.match(worker, /Layanan utama sedang tidak tersedia\. Perubahan data belum dapat dikirim/);
});

test('ringkasan dashboard memakai primary dan cache browser terversi', async () => {
  const worker = await readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8');
  const dashboard = await readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8');
  const dashboardStart = worker.indexOf('async fn dashboard(');
  const dashboardEnd = worker.indexOf('async fn ', dashboardStart + 1);
  const dashboardRoute = worker.slice(
    dashboardStart,
    dashboardEnd === -1 ? undefined : dashboardEnd,
  );

  assert.ok(dashboardStart >= 0, 'route dashboard tidak ditemukan');
  assert.match(dashboardRoute, /let value = rpc\(env, "eposyandu_dashboard_stats"/);
  assert.doesNotMatch(dashboardRoute, /read_rpc\(env/);
  assert.match(worker, /DASHBOARD_CACHE_VERSION_KEY: &str = "dashboard:version:v3"/);
  assert.match(dashboard, /e-posyandu:dashboard-stats:v4/);
  assert.match(dashboard, /isDashboardTab/);
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
  const client = await readApiClient();

  assert.match(migration, /create table if not exists public\.background_jobs/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on table public\.background_jobs from anon, authenticated/);
  assert.match(wrangler, /binding = "E_POSYANDU_JOBS"/);
  assert.match(wrangler, /queue = "e-posyandu-jobs"/);
  assert.match(wrangler, /queue = "e-posyandu-jobs-development"/);
  assert.match(wrangler, /queue = "e-posyandu-jobs-staging"/);
  assert.match(wrangler, /bucket_name = "e-posyandu-files-development"/);
  assert.match(wrangler, /bucket_name = "e-posyandu-files-staging"/);
  assert.match(wrangler, /id = "79568f3667f04838b1c005b4ebacef15"/);
  assert.match(client, /export async function createBackgroundJob/);
  assert.match(client, /export async function waitForBackgroundJob/);
  assert.match(client, /export async function downloadBackgroundJobFile/);
});

test('deployment Oracle mengisolasi gRPC dan tidak menaruh secret dalam image', async () => {
  const [compose, caddy, bootstrap, deploy, connector, envExample, dockerfile, cloudWorker] = await Promise.all([
    readFile(resolve(root, 'deploy/oracle/compose.yaml'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/Caddyfile'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/bootstrap.sh'), 'utf8'),
    readFile(resolve(root, 'scripts/services/deploy-oracle-nutrition-worker.sh'), 'utf8'),
    readFile(resolve(root, 'scripts/services/connect-oracle-nutrition-worker.sh'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/nutrition-grpc.env.example'), 'utf8'),
    readFile(resolve(root, 'services/nutrition-grpc/Dockerfile'), 'utf8'),
    readFile(resolve(root, 'services/nutrition-grpc/src/bin/cloud.rs'), 'utf8')
  ]);

  assert.match(compose, /GRPC_ADDR: 127\.0\.0\.1:50051/);
  assert.match(compose, /image: docker\.io\/library\/caddy:2\.10\.2-alpine/);
  assert.match(compose, /read_only: true/g);
  assert.match(compose, /cap_drop:\s+- ALL/g);
  assert.match(compose, /no-new-privileges:true/g);
  assert.doesNotMatch(compose, /-\s*["']?(?:50051|8080):/);
  assert.match(caddy, /@health path \/health/);
  assert.match(caddy, /respond "Rute tidak ditemukan" 404/);
  assert.match(bootstrap, /install -m 0600 .*nutrition-grpc\.env/);
  assert.match(bootstrap, /compose_command=\(podman-compose\)/);
  assert.match(bootstrap, /dnf install --assumeyes container-tools oracle-epel-release-el9/);
  assert.match(bootstrap, /firewall-cmd --query-service=http/);
  assert.match(bootstrap, /firewall-cmd --permanent --query-service=https/);
  assert.doesNotMatch(bootstrap, /firewall-cmd --reload/);
  assert.match(bootstrap, /"\$\{compose_command\[@\]\}"[\s\S]+up --detach --build --remove-orphans/);
  assert.match(bootstrap, /-H "Host: \$health_host" http:\/\/127\.0\.0\.1\/health/);
  assert.match(bootstrap, /--resolve "\$health_host:443:127\.0\.0\.1"/);
  assert.match(deploy, /ssh -o BatchMode=yes -o ConnectTimeout=10/);
  assert.match(deploy, /mktemp -d/);
  assert.match(deploy, /COPYFILE_DISABLE=1 tar/);
  assert.match(deploy, /--no-xattrs/);
  assert.match(deploy, /--no-mac-metadata/);
  assert.match(deploy, /--no-fflags/);
  assert.match(connector, /secret put RUST_WORKER_HEALTH_URL/);
  assert.match(envExample, /RUST_WORKER_SHARED_SECRET=replace-/);
  assert.match(dockerfile, /USER eposyandu/);
  assert.match(dockerfile, /FROM docker\.io\/library\/rust:1\.97-slim-bookworm/);
  assert.match(dockerfile, /FROM docker\.io\/library\/debian:bookworm-slim/);
  assert.match(cloudWorker, /SignalKind::terminate\(\)/);
  assert.match(cloudWorker, /nutrition worker menerima sinyal shutdown/);
  assert.doesNotMatch(`${compose}\n${dockerfile}`, /CLOUDFLARE_QUEUES_API_TOKEN=/);
});

test('riwayat perubahan dimuat langsung, dibatasi, dan rincian diproses bertahap', async () => {
  const worker = await readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8');
  const client = await readApiClient();
  const dashboard = await readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8');

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
  const frontendPackage = await readJson('frontend/package.json');
  for (const header of [
    'Content-Security-Policy:',
    'Strict-Transport-Security:',
    'Referrer-Policy:',
    'X-Content-Type-Options:',
    'Permissions-Policy:'
  ]) {
    assert.match(headers, new RegExp(header));
  }
  assert.match(headers, /default-src 'none'/);
  assert.match(headers, /script-src-attr 'none'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /base-uri 'none'/);
  assert.match(headers, /Reporting-Endpoints: csp-endpoint="\/api\/v1\/security\/csp-report"/);
  assert.match(headers, /report-uri \/api\/v1\/security\/csp-report/);
  assert.match(headers, /report-to csp-endpoint/);
  assert.doesNotMatch(headers, /cdnjs\.cloudflare\.com|xlsx\.full\.min\.js/);
  assert.equal(
    frontendPackage.dependencies.xlsx,
    'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'
  );
  assert.doesNotMatch(
    headers,
    /(?:^|;\s*)script-src\s+[^;]*(?:'unsafe-inline'|'unsafe-eval'|https:\/\/\*)/
  );
});

test('kode aplikasi tidak memakai eval atau penyisipan HTML mentah', async () => {
  const source = [
    await readSourceTree('frontend/src'),
    await readFile(resolve(root, 'frontend/public/service-worker.js'), 'utf8'),
    await readSourceTree('backend/src'),
    await readSourceTree('services/neon-read-worker/src'),
    await readSourceTree('services/nutrition-grpc/src')
  ].join('\n');

  assert.doesNotMatch(
    source,
    /\beval\s*\(|new\s+Function\s*\(|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/
  );
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
  assert.match(smokeScript, /SMOKE_SESSION_COOKIE/);
  assert.match(smokeScript, /authenticated-session/);
  assert.match(smokeScript, /unauthenticated-session-rejected/);
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
  const client = await readApiClient();
  const dashboard = await readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8');
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

test('cache sensitif dienkripsi per akun dan login tidak melewati gerbang keamanan', async () => {
  const store = await readFile(resolve(root, 'frontend/src/services/offlineStore.ts'), 'utf8');
  const client = await readApiClient();
  const worker = await readFile(resolve(root, 'backend/src/lib.rs'), 'utf8');
  const pagesProxy = await readFile(resolve(root, 'frontend/public/_worker.js'), 'utf8');

  assert.match(store, /AES-GCM/);
  assert.match(store, /OFFLINE_ENCRYPTION_SESSION_KEY/);
  assert.match(store, /activeOwnerScope/);
  assert.match(store, /initializeOfflineStoreSession/);
  assert.match(store, /resetOfflineStoreWithoutSession/);
  assert.match(client, /await initializeOfflineStoreSession\(session\.uid/);
  assert.match(client, /response = await usernameLoginRequest/);
  assert.doesNotMatch(client, /directSupabaseUsernameLogin/);
  assert.doesNotMatch(client, /localStorage\.getItem\(AUTH_SESSION_KEY\)/);
  assert.doesNotMatch(client, /accessToken|refreshToken|VITE_SUPABASE/);
  assert.match(client, /credentials: 'include'/);
  assert.match(worker, /__Host-e-posyandu-session/);
  assert.match(worker, /HttpOnly; Secure; SameSite=Strict/);
  assert.doesNotMatch(worker, /MFA_ENFORCEMENT|mfa_is_required|jwt_assurance_level/);
  assert.doesNotMatch(client, /auth\/mfa|enrollMfa|verifyMfa|MfaStatus/);
  assert.match(pagesProxy, /isApiPath/);
  assert.match(pagesProxy, /env\.ASSETS\.fetch/);
});

test('laporan CSP diminimalkan, dibatasi ukuran, dan dibatasi laju', async () => {
  const worker = await readFile(resolve(root, 'backend/src/lib.rs'), 'utf8');

  assert.match(worker, /CSP_REPORT_MAX_BODY_BYTES: usize = 16 \* 1024/);
  assert.match(worker, /CSP_REPORT_MAX_ATTEMPTS: u8 = 60/);
  assert.match(worker, /safe_csp_document_url/);
  assert.match(worker, /url\.set_query\(None\)/);
  assert.match(worker, /url\.set_fragment\(None\)/);
  assert.match(worker, /safe_csp_blocked_url/);
  assert.match(worker, /"event": "csp_violation"/);
  assert.doesNotMatch(
    worker.slice(worker.indexOf('fn normalized_csp_report'), worker.indexOf('async fn csp_report')),
    /script-sample|scriptSample|original-policy|originalPolicy|referrer/
  );
});

test('kebijakan privasi mencatat klasifikasi, retensi, dan respons insiden', async () => {
  const privacy = await readFile(resolve(root, 'docs/PRIVACY.md'), 'utf8');

  assert.match(privacy, /UU Nomor 27 Tahun 2022/);
  assert.match(privacy, /Permenkes Nomor 24 Tahun 2022/);
  assert.match(privacy, /Paling singkat 25 tahun sejak kunjungan terakhir/);
  assert.match(privacy, /3 x 24 jam/);
  assert.match(privacy, /wajib disahkan Kepala UPTD Puskesmas Gumukmas/);
  assert.match(privacy, /Fitur AI tetap nonaktif/);
});

test('skeleton awal mengikuti struktur aplikasi tanpa teks persiapan', async () => {
  const skeleton = await readFile(resolve(root, 'frontend/src/ui/skeleton.ts'), 'utf8');
  const app = await readFile(resolve(root, 'frontend/src/App.ts'), 'utf8');

  assert.match(skeleton, /app-loading-sidebar/);
  assert.match(skeleton, /app-loading-topbar/);
  assert.match(skeleton, /app-loading-mobile-dock/);
  assert.doesNotMatch(`${skeleton}\n${app}`, /Menyiapkan aplikasi/);
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
