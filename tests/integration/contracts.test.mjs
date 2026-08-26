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

test('label akun gizi konsisten sebagai Ahli Gizi dan role lama tidak diubah', async () => {
  const [frontend, backend, dashboard, roleMigration, adminMigration] = await Promise.all([
    readSourceTree('frontend/src'),
    readSourceTree('backend/src'),
    readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8'),
    readFile(resolve(root, 'database/migrations/003_app_users.sql'), 'utf8'),
    readFile(resolve(root, 'database/migrations/029_super_admin_access.sql'), 'utf8')
  ]);

  assert.doesNotMatch(`${frontend}\n${backend}`, /Admin Gizi/);
  assert.match(dashboard, /const accountName[\s\S]+: ROLES\.GIZI;/);
  assert.match(roleMigration, /role in \('Kader Posyandu', 'Bidan Desa', 'Ahli Gizi'\)/);
  assert.match(adminMigration, /role in \('Kader Posyandu', 'Bidan Desa', 'Ahli Gizi', 'super_admin'\)/);
  assert.doesNotMatch(adminMigration, /update\s+(?:public\.)?app_users/i);
});

test('callback pemulihan admin hanya dipakai pada path aktivasi khusus', async () => {
  const app = await readFile(resolve(root, 'frontend/src/App.ts'), 'utf8');

  assert.match(app, /callbackType === 'invite'/);
  assert.match(
    app,
    /callbackType === 'recovery' && window\.location\.pathname === '\/admin\/activate'/
  );
  assert.match(app, /window\.history\.replaceState/);
});

test('migration database berurutan dan tercatat sampai versi terbaru', async () => {
  const files = (await readdir(resolve(root, 'database/migrations')))
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .sort();
  const versions = files.map((file) => Number(file.slice(0, 3)));

  assert.deepEqual(versions, Array.from({ length: versions.length }, (_, index) => index + 1));
  assert.equal(files.at(-1), '031_child_data_retention.sql');
  for (const file of files) {
    const sql = (await readFile(resolve(root, 'database/migrations', file), 'utf8')).toLowerCase();
    assert.match(sql, /begin;/, `${file} harus transaksional`);
    assert.match(sql, /commit;/, `${file} harus ditutup dengan commit`);
  }
});

test('retensi anak diproses di server dan tidak menghapus data sebelum waktunya', async () => {
  const [migration, worker, oracleDb, oracleMain] = await Promise.all([
    readFile(resolve(root, 'database/migrations/031_child_data_retention.sql'), 'utf8'),
    readFile(resolve(root, 'backend/src/lib.rs'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/src/native_db.rs'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/src/main.rs'), 'utf8')
  ]);

  assert.match(migration, /v_recycle_cutoff\s+timestamptz\s+:=[\s\S]+interval '30 days'/i);
  assert.match(migration, /v_post_graduation_cutoff\s+date\s+:=[\s\S]+interval '5 years'/i);
  assert.match(migration, /c\.deleted_at\s+is not null[\s\S]+c\.deleted_at\s+<\s+v_recycle_cutoff/i);
  assert.match(migration, /c\.birth_date\s+is not null[\s\S]+c\.birth_date\s+\+\s+interval '60 months'/i);
  assert.match(migration, /c\.birth_date\s+\+\s+interval '60 months'\s+<=\s+v_post_graduation_cutoff/);
  assert.match(migration, /create or replace function public\.eposyandu_cleanup_retention/);
  assert.match(migration, /grant execute on function public\.eposyandu_cleanup_retention/);
  assert.match(migration, /sync_tombstones/);
  assert.match(worker, /rpc\/eposyandu_cleanup_retention/);
  assert.match(worker, /child_retention_cleanup/);
  assert.match(oracleDb, /eposyandu_cleanup_retention/);
  assert.match(oracleMain, /RETENTION_CLEANUP_INTERVAL/);
});

test('mode akses akun menjaga akun lama tetap tulis dan memblokir fallback mutasi hanya-baca', async () => {
  const migration = await readFile(
    resolve(root, 'database/migrations/030_account_access_management.sql'),
    'utf8'
  );

  assert.match(migration, /access_mode text not null default 'write'/);
  assert.match(migration, /access_mode in \('read', 'write'\)/);
  assert.match(migration, /users\.access_mode = 'write'/);
  assert.doesNotMatch(migration, /update\s+(?:public\.)?app_users\s+set/i);
  assert.match(migration, /after update of role, village, posyandu, access_mode, active/);
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
  assert.match(client, /\/children\/page\?\$\{parameters\.toString\(\)\}/);
  assert.match(client, /\/exclusive-breastfeeding\/page\?\$\{parameters\.toString\(\)\}/);
  assert.doesNotMatch(client, /query ChildrenPage/);
  assert.doesNotMatch(client, /query ExclusiveBreastfeedingPage/);
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
    '/api/v1/auth/invite/complete',
    '/api/v1/auth/mfa/enroll',
    '/api/v1/auth/mfa/challenge',
    '/api/v1/auth/mfa/verify',
    '/api/v1/auth/passkey/registration/options',
    '/api/v1/auth/passkey/registration/verify',
    '/api/v1/auth/passkey/authentication/options',
    '/api/v1/auth/passkey/authentication/verify',
    '/api/v1/auth/logout',
    '/api/v1/auth/session',
    '/api/v1/auth/presence',
    '/api/v1/admin/accounts',
    '/api/v1/admin/accounts/{userId}',
    '/api/v1/admin/monitoring/stream',
    '/api/v1/realtime/stream',
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
  assert.deepEqual(Object.keys(document.paths['/api/v1/auth/session']).sort(), ['get']);
  assert.ok(document.paths['/api/v1/admin/accounts'].get);
  assert.ok(document.paths['/api/v1/admin/accounts'].post);
  assert.ok(document.paths['/api/v1/admin/accounts/{userId}'].patch);
  assert.ok(document.paths['/api/v1/admin/accounts/{userId}'].delete);
  assert.ok(document.paths['/api/v1/admin/monitoring/stream'].get.responses['200'].content['text/event-stream']);
  assert.ok(document.paths['/api/v1/realtime/stream'].get.responses['200'].content['text/event-stream']);
  assert.ok(document.components.securitySchemes.sessionCookie);
  const authenticatedLogin = document.components.schemas.AuthenticatedLoginResponse;
  assert.ok(!('access_token' in authenticatedLogin.properties));
  assert.ok(!('refresh_token' in authenticatedLogin.properties));
  assert.equal(
    authenticatedLogin.properties.profile.$ref,
    '#/components/schemas/AccessProfile'
  );
  assert.equal(document.components.schemas.MfaPendingLoginResponse.properties.mfaRequired.const, true);
});

test('administrasi akun dan monitoring realtime hanya tersedia untuk administrator', async () => {
  const [oracleAuth, oracleMain, metrics, dashboard, page, monitoringPanel, client] = await Promise.all([
    readFile(resolve(root, 'services/oracle-api/src/native_auth.rs'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/src/main.rs'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/src/system_metrics.rs'), 'utf8'),
    readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8'),
    readFile(resolve(root, 'frontend/src/pages/AdminBackendPage.ts'), 'utf8'),
    readFile(resolve(root, 'frontend/src/pages/AdminMonitoringPanel.ts'), 'utf8'),
    readFile(resolve(root, 'frontend/src/api/legacyClient.ts'), 'utf8')
  ]);

  assert.match(oracleMain, /\/api\/v1\/admin\/accounts/);
  assert.match(oracleMain, /\/api\/v1\/auth\/presence/);
  assert.match(oracleMain, /\/api\/v1\/admin\/monitoring\/stream/);
  assert.match(oracleMain, /\/api\/v1\/realtime\/stream/);
  assert.match(oracleAuth, /auth\/v1\/passkeys\/registration\/options/);
  assert.match(oracleAuth, /auth\/v1\/passkeys\/authentication\/verify/);
  assert.doesNotMatch(oracleAuth, /auth\/v1\/factors.*webauthn/);
  assert.match(client, /startPasskeyRegistration/);
  assert.match(client, /startPasskeyAuthentication/);
  assert.match(oracleMain, /Sse::new\(events\)/);
  assert.match(oracleMain, /realtime_data_stream/);
  assert.match(oracleMain, /ADMIN_MONITORING_CONNECTION_LIMIT/);
  assert.match(oracleAuth, /!is_super_admin\(&session\.profile\.role\) \|\| !session\.mfa_verified/);
  assert.match(oracleAuth, /presence-user:\{user_id\}/);
  assert.match(oracleAuth, /presence-session:\{session_identifier\}/);
  assert.match(oracleAuth, /"userId": user_id/);
  assert.match(oracleAuth, /"isCurrentAccount": user_id == session\.profile\.user_id/);
  assert.match(dashboard, /user\.role === ROLES\.SUPER_ADMIN && Native\.createElement\("button"/);
  assert.match(dashboard, /Administrasi Backend/);
  assert.match(page, /data-admin-backend-page/);
  assert.match(page, /Online berarti ada aktivitas aplikasi dalam/);
  assert.match(page, /admin-backend-tabs/);
  assert.match(page, /admin-account-modal-backdrop/);
  assert.match(page, /activeSection === 'monitoring'/);
  assert.match(monitoringPanel, /new EventSource\(getAdminMonitoringStreamUrl\(\)/);
  assert.match(monitoringPanel, /source\?\.close\(\)/);
  assert.match(monitoringPanel, /visibilitychange/);
  assert.match(monitoringPanel, /MAX_POINTS = 60/);
  assert.match(metrics, /\/proc\/stat/);
  assert.match(metrics, /\/proc\/meminfo/);
  assert.doesNotMatch(metrics, /environ|cmdline|app_users|health_records/);
  assert.match(client, /reportAccountPresence/);
  assert.match(client, /getAdminMonitoringStreamUrl/);
  assert.match(client, /subscribeToRealtime/);
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
  assert.match(worker, /redis_set_text\(env, &key, payload, ttl\)/);
  assert.match(worker, /jwt_expiration_seconds/);
  assert.match(worker, /fn is_emergency_read_route/);
  assert.match(worker, /path == "\/api\/v1\/graphql"/);
  assert.match(worker, /fn upstream_is_unavailable/);
  assert.match(worker, /status == 429 \|\| status >= 500/);
  assert.match(worker, /"writes": "primary-only"/);
  assert.match(worker, /Layanan utama sedang tidak tersedia\. Perubahan data belum dapat dikirim/);
});

test('data dinamis memakai primary dan cache Redis terversi dengan TTL terpisah', async () => {
  const worker = await readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8');
  const dashboard = await readFile(resolve(root, 'frontend/src/app/dashboard.ts'), 'utf8');
  const dashboardStart = worker.indexOf('async fn dashboard(');
  const dashboardEnd = worker.indexOf('async fn ', dashboardStart + 1);
  const dashboardRoute = worker.slice(
    dashboardStart,
    dashboardEnd === -1 ? undefined : dashboardEnd,
  );

  assert.ok(dashboardStart >= 0, 'route dashboard tidak ditemukan');
  assert.match(dashboardRoute, /rpc\(env, "eposyandu_dashboard_stats"/);
  assert.doesNotMatch(dashboardRoute, /read_rpc\(env/);
  assert.match(worker, /DYNAMIC_CACHE_TTL_SECONDS: u64 = 5 \* 60/);
  assert.match(worker, /DASHBOARD_CACHE_TTL_SECONDS: u64 = 60/);
  assert.match(worker, /dynamic_cache_ttl_seconds/);
  assert.match(worker, /DYNAMIC_CACHE_VERSION_KEY/);
  assert.match(worker, /dynamic_cache_key/);
  assert.match(worker, /redis_commands/);
  assert.match(worker, /\/api\/v1\/collections\//);
  assert.match(dashboard, /e-posyandu:dashboard-stats:v4/);
  assert.match(dashboard, /isDashboardTab/);
});

test('monitoring worker tersimpan di Redis dan MQTT ditunda sampai ada IoT', async () => {
  const worker = await readFile(resolve(root, 'backend/src/lib.rs'), 'utf8');
  const decision = await readFile(resolve(root, 'docs/decisions/001-mqtt-deferred.md'), 'utf8');
  const r2 = await readFile(resolve(root, 'scripts/storage/prepare-r2.sh'), 'utf8');

  assert.match(worker, /NUTRITION_WORKER_FAILURE_THRESHOLD/);
  assert.match(worker, /monitoring:nutrition-worker:v1/);
  assert.match(worker, /redis_set_text/);
  assert.match(worker, /send_monitoring_alert/);
  assert.match(worker, /R2_SOFT_LIMIT_BYTES/);
  assert.match(worker, /monitor_and_cleanup_r2/);
  assert.match(decision, /MQTT baru dievaluasi ketika tersedia perangkat IoT nyata/);
  assert.match(r2, /e-posyandu-files/);
});

test('KV hanya memuat cache global dan Redis memuat data dinamis', async () => {
  const [worker, api, wrangler, compose, nativeCache] = await Promise.all([
    readFile(resolve(root, 'backend/src/lib.rs'), 'utf8'),
    readFile(resolve(root, 'backend/src/api/mod.rs'), 'utf8'),
    readFile(resolve(root, 'backend/wrangler.toml'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/compose.yaml'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/src/native_cache.rs'), 'utf8')
  ]);

  const kvUses = `${worker}\n${api}`.match(/\.kv\("E_POSYANDU_CACHE"\)/g) ?? [];
  assert.equal(kvUses.length, 2, 'KV hanya boleh dipakai untuk status konfigurasi dan feature flag global');
  assert.match(api, /const FEATURE_FLAGS_KEY: &str = "feature:flags:v1"/);
  assert.match(wrangler, /Data balita\/penimbangan memakai Redis TTL 5 menit/);
  assert.match(wrangler, /dashboard operasional memakai TTL 60 detik/);
  assert.match(compose, /ORACLE_REDIS_URL: redis:\/\/redis-cache:6379/);
  assert.match(compose, /redis:7\.4\.10-alpine/);
  assert.match(compose, /--maxmemory-policy\s+- volatile-lru/);
  assert.match(compose, /subnet: 10\.89\.0\.0\/24/);
  assert.match(compose, /subnet: 10\.89\.1\.0\/24/);
  assert.match(nativeCache, /DYNAMIC_CACHE_TTL_SECONDS: u64 = 5 \* 60/);
  assert.match(nativeCache, /DASHBOARD_CACHE_TTL_SECONDS: u64 = 60/);
  assert.match(nativeCache, /DYNAMIC_CACHE_VERSION_KEY/);
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

test('komunikasi antar layanan memakai gRPC pada jaringan privat', async () => {
  const [client, compose, oracleDockerfile, nutritionDockerfile] = await Promise.all([
    readFile(resolve(root, 'services/oracle-api/src/nutrition_client.rs'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/compose.yaml'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/Dockerfile'), 'utf8'),
    readFile(resolve(root, 'services/nutrition-grpc/Dockerfile'), 'utf8')
  ]);

  assert.match(client, /NutritionWorkerClient/);
  assert.match(client, /HealthClient/);
  assert.match(client, /x-eposyandu-service-token/);
  assert.match(client, /ORACLE_API_NUTRITION_GRPC_URL/);
  assert.match(compose, /GRPC_ADDR: \$\{GRPC_ADDR:-unix:\/\/\/run\/e-posyandu\/nutrition\.sock\}/);
  assert.match(compose, /- "50051"/);
  assert.doesNotMatch(compose, /- "(?:0\.0\.0\.0|127\.0\.0\.1):50051/);
  assert.match(oracleDockerfile, /services\/eposyandu-proto/);
  assert.match(nutritionDockerfile, /services\/eposyandu-proto/);
  const nutritionLib = await readFile(resolve(root, 'services/nutrition-grpc/src/lib.rs'), 'utf8');
  assert.match(nutritionLib, /service_auth_interceptor/);
  assert.match(nutritionLib, /x-eposyandu-service-token/);
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

test('deployment Oracle mengisolasi layanan dan tidak menaruh secret dalam image', async () => {
  const [
    compose,
    caddy,
    bootstrap,
    deploy,
    apiDeploy,
    nutritionDeploy,
    connector,
    envExample,
    dockerfile,
    cloudWorker,
    vaultMaterializer,
    nativeDatabase,
    databaseMigration,
    databaseBackup,
    databaseBackupUnit,
    backupEnv
  ] = await Promise.all([
    readFile(resolve(root, 'deploy/oracle/compose.yaml'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/Caddyfile'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/bootstrap.sh'), 'utf8'),
    readFile(resolve(root, 'scripts/services/deploy-oracle-nutrition-worker.sh'), 'utf8'),
    readFile(resolve(root, 'scripts/services/deploy-oracle-api.sh'), 'utf8'),
    readFile(resolve(root, 'scripts/services/deploy-oracle-nutrition.sh'), 'utf8'),
    readFile(resolve(root, 'scripts/services/connect-oracle-nutrition-worker.sh'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/nutrition-grpc.env.example'), 'utf8'),
    readFile(resolve(root, 'services/nutrition-grpc/Dockerfile'), 'utf8'),
    readFile(resolve(root, 'services/nutrition-grpc/src/bin/cloud.rs'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/vault/eposyandu-vault-env.py'), 'utf8'),
    readFile(resolve(root, 'services/oracle-api/src/native_db.rs'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/postgresql/eposyandu-postgresql-migrate.py'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/postgresql/eposyandu-postgresql-backup.py'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/postgresql/eposyandu-postgresql-backup.service'), 'utf8'),
    readFile(resolve(root, 'deploy/oracle/backup/eposyandu-backup.env.example'), 'utf8')
  ]);

  assert.match(compose, /GRPC_ADDR: \$\{GRPC_ADDR:-unix:\/\/\/run\/e-posyandu\/nutrition\.sock\}/);
  assert.match(compose, /ORACLE_API_NUTRITION_GRPC_URL: \$\{ORACLE_API_NUTRITION_GRPC_URL:-unix:\/\/\/run\/e-posyandu\/nutrition\.sock\}/);
  assert.match(compose, /\/var\/lib\/e-posyandu\/grpc:\/run\/e-posyandu:rw,z/);
  assert.match(compose, /ORACLE_API_MICROSERVICES_ENABLED: \$\{ORACLE_API_MICROSERVICES_ENABLED:-true\}/);
  assert.match(compose, /ORACLE_API_MIGRATION_PROXY_ENABLED: "false"/);
  assert.match(compose, /expose:[\s\S]*"50051"/);
  assert.match(compose, /image: docker\.io\/library\/caddy:2\.10\.2-alpine/);
  assert.match(compose, /read_only: true/g);
  assert.match(compose, /cap_drop:\s+- ALL/g);
  assert.match(compose, /no-new-privileges:true/g);
  assert.doesNotMatch(compose, /^\s{2}frontend:/m);
  assert.doesNotMatch(compose, /e-posyandu-frontend|ORACLE_FRONTEND_/);
  assert.match(compose, /cloudflare\/cloudflared:2026\.7\.2/);
  assert.match(compose, /profiles:\s+- cloudflare-tunnel/);
  assert.match(compose, /TUNNEL_TOKEN_FILE: \/run\/secrets\/cloudflare-tunnel-token/);
  assert.match(compose, /127\.0\.0\.1:2000:2000/);
  assert.match(compose, /ORACLE_PUBLIC_BIND:-0\.0\.0\.0/);
  assert.match(compose, /host\.containers\.internal:10\.89\.0\.1/);
  assert.match(compose, /host\.docker\.internal:10\.89\.0\.1/);
  assert.doesNotMatch(compose, /-\s*["']?(?:50051|8080):/);
  assert.match(caddy, /@health path \/health/);
  assert.match(caddy, /respond "Rute tidak ditemukan" 404/);
  assert.match(caddy, /:8088/);
  assert.match(caddy, /Listener internal Tunnel hanya meneruskan request ke API/);
  assert.match(caddy, /reverse_proxy oracle-api:8081/);
  assert.doesNotMatch(caddy, /@api host api\.eposyandu\.app/);
  assert.doesNotMatch(caddy, /host (?:www\.)?eposyandu\.app|reverse_proxy frontend/);
  assert.match(caddy, /header_up -CF-Connecting-IP/);
  assert.match(bootstrap, /install -m 0600 .*nutrition-grpc\.env/);
  assert.match(bootstrap, /ORACLE_API_NATIVE_AUTH_ENABLED/);
  assert.match(bootstrap, /ORACLE_API_NATIVE_READS_ENABLED/);
  assert.match(bootstrap, /ORACLE_API_NATIVE_WRITES_ENABLED/);
  assert.match(bootstrap, /ORACLE_API_MIGRATION_PROXY_ENABLED/);
  const nativeMode = await readFile(resolve(root, 'deploy/oracle/oracle-native-mode.sh'), 'utf8');
  assert.match(nativeMode, /up --detach --force-recreate --remove-orphans/);
  assert.match(bootstrap, /compose_command=\(podman-compose\)/);
  assert.match(bootstrap, /dnf install --assumeyes container-tools oracle-epel-release-el9/);
  assert.match(bootstrap, /firewall-cmd --query-service=http/);
  assert.match(bootstrap, /firewall-cmd --permanent --query-service=https/);
  assert.doesNotMatch(bootstrap, /firewall-cmd --reload/);
  assert.match(bootstrap, /for build_service in[\s\S]+build "\$build_service"/);
  assert.match(bootstrap, /up --detach --no-build --remove-orphans/);
  assert.match(bootstrap, /up --detach --no-deps --build "\$deployment_service"/);
  assert.match(bootstrap, /deployment_service="\$\{4:-all\}"/);
  assert.match(bootstrap, /Rilis baru gagal; memulihkan konfigurasi Oracle sebelumnya/);
  assert.match(bootstrap, /up --detach --remove-orphans/);
  assert.match(bootstrap, /-H "Host: \$health_host" http:\/\/127\.0\.0\.1\/health/);
  assert.match(bootstrap, /--resolve "\$health_host:443:127\.0\.0\.1"/);
  assert.match(bootstrap, /127\.0\.0\.1:8081\/api\/v1\/health\/ready/);
  assert.match(bootstrap, /grep -Fq '\"ok\":true'/);
  assert.match(deploy, /ssh -o BatchMode=yes -o ConnectTimeout=10/);
  assert.match(deploy, /mktemp -d/);
  assert.match(deploy, /COPYFILE_DISABLE=1 tar/);
  assert.match(deploy, /deploy_service="\$\{3:-all\}"/);
  assert.match(deploy, /services\/eposyandu-proto/);
  assert.match(apiDeploy, /oracle-api/);
  assert.match(nutritionDeploy, /nutrition-worker/);
  assert.match(vaultMaterializer, /oracle_api_values\["RUST_WORKER_SHARED_SECRET"\]/);
  assert.match(deploy, /--no-xattrs/);
  assert.match(deploy, /--no-mac-metadata/);
  assert.match(deploy, /--no-fflags/);
  assert.doesNotMatch(deploy, /ORACLE_FRONTEND_|\bfrontend\b/);
  assert.match(connector, /secret put RUST_WORKER_HEALTH_URL/);
  assert.doesNotMatch(envExample, /RUST_WORKER_SHARED_SECRET=/);
  assert.match(dockerfile, /USER eposyandu/);
  assert.match(dockerfile, /FROM docker\.io\/library\/rust:1\.97-slim-bookworm/);
  assert.match(dockerfile, /FROM docker\.io\/library\/debian:bookworm-slim/);
  assert.match(cloudWorker, /SignalKind::terminate\(\)/);
  assert.match(cloudWorker, /nutrition worker menerima sinyal shutdown/);
  assert.match(vaultMaterializer, /OCI_SECRET_CLOUDFLARE_TUNNEL_TOKEN_ID/);
  assert.match(vaultMaterializer, /cloudflare-tunnel-token/);
  assert.match(vaultMaterializer, /ORACLE_DATABASE_URL/);
  assert.match(nativeDatabase, /deadpool_postgres/);
  assert.match(nativeDatabase, /ORACLE_DATABASE_POOL_SIZE/);
  assert.match(databaseMigration, /--format=custom/);
  assert.match(databaseMigration, /fingerprints_source/);
  assert.match(databaseMigration, /alter database.*rename to/si);
  assert.match(databaseBackup, /--compress=zstd:9/);
  assert.match(databaseBackup, /pg_restore/);
  assert.match(databaseBackup, /--cipher-algo/);
  assert.match(databaseBackup, /cleanup_old_backups/);
  assert.match(databaseBackup, /OCI_BACKUP_RETENTION_DAYS/);
  assert.match(backupEnv, /OCI_BACKUP_RETENTION_DAYS=30/);
  assert.match(databaseBackupUnit, /ReadWritePaths=\/var\/lib\/pgsql\/backup/);
  assert.doesNotMatch(`${compose}\n${dockerfile}`, /CLOUDFLARE_QUEUES_API_TOKEN=/);
  assert.doesNotMatch(compose, /TUNNEL_TOKEN:/);
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
  assert.match(headers, /publickey-credentials-create=\(self\)/);
  assert.match(headers, /publickey-credentials-get=\(self\)/);
  assert.doesNotMatch(headers, /publickey-credentials-(?:create|get)=\(\)/);
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

test('oracle api hanya menjadi gateway dan domain service berjalan terpisah', async () => {
  const compose = await readFile(resolve(root, 'deploy/oracle/compose.yaml'), 'utf8');
  const proto = await readFile(resolve(root, 'services/eposyandu-proto/proto/microservices.proto'), 'utf8');
  const gateway = await readFile(resolve(root, 'services/oracle-api/src/platform_client.rs'), 'utf8');
  const domain = await readFile(resolve(root, 'services/oracle-domain/src/lib.rs'), 'utf8');
  const dockerfile = await readFile(resolve(root, 'services/oracle-domain/Dockerfile'), 'utf8');
  for (const service of ['identity-service', 'operations-service', 'realtime-service', 'monitoring-service']) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'));
  }
  assert.match(compose, /identity\.sock/);
  assert.match(compose, /operations\.sock/);
  assert.match(compose, /realtime\.sock/);
  assert.match(compose, /monitoring\.sock/);
  assert.match(proto, /service IdentityService/);
  assert.match(proto, /service OperationsService/);
  assert.match(proto, /service RealtimeService/);
  assert.match(proto, /service MonitoringService/);
  assert.match(gateway, /ORACLE_API_MICROSERVICES_ENABLED/);
  assert.match(gateway, /IdentityServiceClient/);
  assert.match(gateway, /OperationsServiceClient/);
  assert.match(gateway, /RealtimeServiceClient/);
  assert.match(gateway, /MonitoringServiceClient/);
  assert.match(gateway, /unix:\/\/\/run\/e-posyandu/);
  assert.match(gateway, /service_health/);
  assert.match(domain, /pub struct IdentityDomain/);
  assert.match(domain, /pub struct OperationsDomain/);
  assert.match(domain, /pub struct RealtimeDomain/);
  assert.match(domain, /pub struct MonitoringDomain/);
  assert.match(dockerfile, /ARG SERVICE_DIR/);
  assert.match(dockerfile, /ARG SERVICE_BIN/);
  assert.match(compose, /\/var\/lib\/e-posyandu\/grpc:\/run\/e-posyandu:rw,z/);
  assert.match(compose, /GRPC_ADDR:-unix:\/\/\/run\/e-posyandu\/nutrition\.sock/);
  assert.match(await readFile(resolve(root, 'services/eposyandu-proto/src/lib.rs'), 'utf8'), /parse_listen_address/);
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
  const oracleAuth = await readFile(resolve(root, 'services/oracle-api/src/native_auth.rs'), 'utf8');
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
  assert.doesNotMatch(client, /VITE_SUPABASE/);
  assert.doesNotMatch(client, /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\([^)]*(?:accessToken|refreshToken)/);
  assert.match(client, /credentials: 'include'/);
  assert.match(worker, /__Host-e-posyandu-session/);
  assert.match(worker, /HttpOnly; Secure; SameSite=Strict/);
  assert.doesNotMatch(worker, /MFA_ENFORCEMENT|mfa_is_required|jwt_assurance_level/);
  assert.match(client, /auth\/mfa/);
  assert.match(client, /enrollMfaFactor/);
  assert.match(client, /verifyMfaFactor/);
  assert.match(oracleAuth, /mfa_verified: !requires_mfa/);
  assert.match(oracleAuth, /jwt_aal\(&verified\.access_token\)/);
  assert.match(oracleAuth, /admin_recovery_codes/);
  assert.match(pagesProxy, /isApiPath/);
  assert.match(pagesProxy, /env\.ASSETS\.fetch/);
  assert.match(pagesProxy, /env\.PRODUCTION_API_ORIGIN/);
  assert.match(pagesProxy, /env\.PRODUCTION_API_FALLBACK_ORIGIN/);
  assert.match(pagesProxy, /safeConfiguredOrigin/);
  assert.match(pagesProxy, /SAFE_RETRY_METHODS/);
  assert.match(pagesProxy, /RETRYABLE_GATEWAY_STATUSES/);
  assert.match(pagesProxy, /X-E-Posyandu-Fallback/);
  assert.doesNotMatch(pagesProxy, /SAFE_RETRY_METHODS\.has\([^)]*POST/);
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
  assert.match(skeleton, /login-loading-shell/);
  assert.match(skeleton, /login-loading-card/);
  assert.match(skeleton, /app-table-loading-row/);
  assert.match(skeleton, /AdminAccountTableSkeleton/);
  const initializeBlock = app.slice(app.indexOf('const initialize = async'));
  assert.match(initializeBlock, /const activation = consumeAdminActivationTokens\(\);/);
  assert.match(initializeBlock, /showLoading\(container\);/);
  assert.ok(initializeBlock.indexOf('const activation = consumeAdminActivationTokens();') < initializeBlock.indexOf('showLoading(container);'));
  assert.doesNotMatch(initializeBlock, /else showLoginLoading\(container\)/);
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
