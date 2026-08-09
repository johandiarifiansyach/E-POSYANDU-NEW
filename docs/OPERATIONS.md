# Operasional dan Monitoring

## Environment

| Environment | Frontend | Worker | Tujuan |
| --- | --- | --- | --- |
| Development | Vite `127.0.0.1:5175` | `wrangler --env development` | Project Supabase khusus development |
| Staging | `e-posyandu-staging.pages.dev` | `e-posyandu-api-staging` | Project Supabase khusus staging |
| Production | `e-posyandu.pages.dev` | `e-posyandu-api` | Project Supabase production untuk kader |

Ketiga environment wajib memakai project Supabase yang berbeda. Worker development dan staging memblokir `POST`, `PATCH`, dan `DELETE` bila `SUPABASE_URL` masih menunjuk project production. Login, laporan error aman, dan GraphQL baca tetap dapat digunakan untuk diagnosis.

Setelah tiga project dibuat, periksa pemisahannya sebelum mengisi secret Cloudflare:

```bash
DEVELOPMENT_SUPABASE_URL='https://project-dev.supabase.co' \
STAGING_SUPABASE_URL='https://project-staging.supabase.co' \
PRODUCTION_SUPABASE_URL='https://project-production.supabase.co' \
npm run env:check
```

Jalankan migration yang sama pada setiap project. Data production tidak disalin ke development; gunakan data uji tanpa identitas nyata.

Variabel, binding KV, dan secret Cloudflare tidak diwariskan antar-environment. Masukkan secret staging secara terpisah:

```bash
cd backend
npx wrangler secret put SUPABASE_URL --env staging
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY --env staging
npx wrangler secret put SUPABASE_SECRET_KEY --env staging
npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
```

Salin template frontend yang sesuai menjadi file lokal tanpa akhiran `.example`. Nilai `VITE_*` bersifat publik; secret service-role tidak boleh berada di frontend.

## Urutan rilis

1. Jalankan `npm run check` dan `npm run build`.
2. Terapkan migrasi PostgreSQL terbaru di staging.
3. Jalankan `npm run worker:deploy:staging` dan `npm run pages:deploy:staging`.
4. Uji alur online, offline, konflik edit, dan request berulang.
5. Terapkan migrasi di production.
6. Jalankan `npm run worker:deploy`, lalu `npm run pages:deploy`.

Workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) menjalankan TypeScript check, contract test, unit test Rust, build, dan E2E desktop/ponsel. Deploy production baru aktif setelah repository variable `AUTO_DEPLOY=true` dan secret `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, serta `CLOUDFLARE_ACCOUNT_ID` tersedia pada GitHub Environment `production`. Setelah deploy, smoke test memeriksa frontend, security headers, health API, dan OpenAPI.

Smoke test production juga berjalan setiap enam jam melalui `deployment-smoke.yml`. Pemeriksaan manual dapat dijalankan tanpa kredensial:

```bash
SMOKE_FRONTEND_URL='https://e-posyandu.pages.dev' \
SMOKE_API_URL='https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev' \
npm run deployment:smoke
```

Untuk staging, `SMOKE_ACCESS_TOKEN` opsional dapat diisi sesaat saat menjalankan manual. Token tersebut menambahkan pemeriksaan endpoint riwayat berautentikasi dan memastikan API tidak mengembalikan lebih dari 10 data per halaman. Jangan simpan access token sebagai file atau secret jangka panjang.

## Audit dan dokumentasi API

Audit database mencatat login berhasil/gagal, CRUD, ekspor XLS, serta perubahan role/wilayah akun. Audit tidak menyimpan kata sandi, token, NIK, KK, nama balita, atau isi formulir. Tabel `audit_events` hanya dapat diakses service role dan administrator database.

Kontrak API tersedia pada `GET /api/v1/openapi.json`. Saat menambah atau mengubah endpoint, perbarui kontrak tersebut; contract test akan gagal bila endpoint operasional utama hilang.

## Feature flag

Feature flag tersimpan sebagai JSON pada key KV `feature:flags:v1`. Fitur yang sudah dipasang dalam keadaan tidak aktif dapat dinyalakan tanpa deploy dengan memperbarui key tersebut pada namespace `E_POSYANDU_CACHE`.

```json
{
  "csvExport": false,
  "largeExports": false,
  "notifications": false,
  "webhooks": false,
  "fileUploads": false
}
```

Nilai yang hilang atau bukan boolean dianggap `false`. Endpoint terautentikasi `GET /api/v1/features` hanya mengembalikan daftar flag yang diizinkan kode.

## Monitoring

Cloudflare Workers Observability aktif 100% di staging dan disampling 10% di production untuk menekan pemakaian log. Log request berbentuk JSON dan berisi `request_id`, route, status, latency, dan environment. Respons API juga mengembalikan header `X-Request-ID` untuk penelusuran error.

Pantau setiap hari pada masa awal rilis:

| Metrik | Lokasi | Tindakan awal |
| --- | --- | --- |
| Error 4xx/5xx dan latency | Cloudflare Workers > Observability | Periksa log berdasarkan `request_id`; waspadai 5xx > 1% atau p95 > 1 detik |
| Cache hit dashboard | Log event `dashboard_cache` | Setelah cache hangat, periksa bila HIT tetap di bawah 60% |
| Request, subrequest, CPU, bandwidth | Cloudflare Workers > Metrics | Cari endpoint dengan lonjakan subrequest atau waktu CPU |
| Egress database | Supabase > Usage | Bandingkan pemakaian harian; periksa ekspor besar dan full sync |
| Login dibatasi | Log status 429 dan Upstash | Pastikan bukan salah konfigurasi Redis atau serangan berulang |
| Nutrition worker | Dashboard Admin Gizi dan key KV `monitoring:nutrition-worker:v1` | Alarm setelah 3 kegagalan beruntun; periksa Render dan Queue |

Jangan menulis NIK, KK, nama balita, token, password, atau isi formulir ke log runtime.

Pemeriksaan terpadu tersedia pada `GET /api/v1/health/ready`. Endpoint ini memeriksa konfigurasi database, KV, Queue, R2, dan status nutrition worker tanpa membaca data balita. GitHub Actions menjalankannya setiap 30 menit bersama pemeriksaan frontend dan health Render melalui `system-monitor.yml`.

Jalankan pemeriksaan yang sama dari komputer pengelola dengan:

```bash
npm run monitor:system
```

Laporan JSON dapat disimpan dengan `MONITOR_OUTPUT_PATH=/lokasi/laporan.json`. Hasil terjadwal disimpan sebagai artifact GitHub selama 14 hari agar tren kegagalan dapat ditelusuri.

Error JavaScript setelah pengguna login dikirim ke `POST /api/v1/client-errors`. Payload hanya berisi jenis error, route tanpa query, sumber, dan frame stack; pesan error serta data formulir tidak dikirim.

Cron memeriksa `RUST_WORKER_HEALTH_URL` setiap 10 menit. Status disimpan di KV dan dibaca dashboard hanya oleh Admin Gizi. Untuk alarm di luar aplikasi, isi secret HTTPS `MONITORING_ALERT_WEBHOOK_URL`, atau isi `RESEND_API_KEY`, `MONITORING_ALERT_EMAIL_TO`, dan `ERROR_REPORT_EMAIL_FROM`. Alarm dikirim saat kegagalan ketiga dan sekali lagi saat layanan pulih, tanpa membawa data balita.

## Backup dan uji restore

Buat backup sebelum migration dan secara terjadwal sesuai kebijakan Puskesmas:

```bash
DATABASE_URL='postgresql://...' npm run db:backup
```

File berada di folder `backups/`, berizin privat, dan tidak masuk Git. Simpan hasil backup pada media terenkripsi dengan akses terbatas. Uji restore harus memakai database non-production yang berbeda:

```bash
RESTORE_DATABASE_URL='postgresql://database-uji' \
CONFIRM_RESTORE_DRILL=RESTORE-TEST \
npm run db:restore-drill -- backups/e-posyandu-YYYYMMDDTHHMMSSZ.dump
```

Lakukan uji restore sedikitnya setiap tiga bulan dan sebelum migration destruktif. Script menolak target yang sama dengan `DATABASE_URL` bila keduanya diberikan. Workflow juga membandingkan fingerprint host, port, pengguna, dan nama database sumber dengan target agar restore tidak dapat diarahkan kembali ke database produksi.

Workflow `database-backup.yml` membuat backup mingguan dan hanya mengunggah dump yang sudah dienkripsi AES-256. Artifact terenkripsi disimpan 14 hari. Aktifkan dengan repository variable `ENABLE_SCHEDULED_BACKUP=true`, lalu isi secret berikut pada GitHub Environment `production`:

- `DATABASE_URL`
- `BACKUP_ENCRYPTION_PASSWORD` minimal 24 karakter acak

Uji restore bulanan bersifat opt-in karena akan membersihkan database target. Isi `RESTORE_DATABASE_URL` dan salinan `BACKUP_ENCRYPTION_PASSWORD` pada Environment `staging`, lalu set `ENABLE_MONTHLY_RESTORE_DRILL=true`. Uji restore juga dapat dipicu manual dengan opsi `run_restore_drill`. Database target wajib khusus pengujian dan tidak boleh berisi data aktif.

Sebelum dienkripsi, workflow menjalankan `npm run db:backup:verify -- <file.dump>` untuk memastikan archive dapat dibaca serta memuat tabel `children`, `measurements`, dan `schema_migrations`. Setelah restore, drill kembali memeriksa tabel wajib, jumlah data, dan migration terbaru. Jangan menyalakan kedua variable jadwal sebelum seluruh secret tersedia; workflow sengaja gagal tertutup bila satu secret kosong.

## Load test Queue dan gRPC

Load test gRPC lokal memakai data sintetis tanpa identitas nyata:

```bash
LOAD_GRPC_REQUESTS=50 \
LOAD_GRPC_CONCURRENCY=8 \
LOAD_GRPC_ITEMS=250 \
npm run grpc:load
```

Alur production lengkap REST -> Queue -> worker gRPC diuji secara manual melalui workflow `load-test.yml`. Buat GitHub Environment `load-test`, isi secret `LOAD_ACCESS_TOKEN` milik akun uji Admin Gizi, lalu pilih **Actions > Queue and gRPC Load Test > Run workflow**. Batas keras script adalah 50 job, paralel 10, dan 1.000 data sintetis per job agar pengujian tidak menghabiskan kuota gratis secara tidak sengaja.

## Konflik sinkronisasi offline

Setiap update dan hapus membawa `version` serta `updatedAt` yang terakhir dilihat perangkat. Server mengembalikan `409` dan dokumen terkini bila data sudah berubah. Perubahan pada kolom berbeda digabung otomatis dengan three-way merge. Bila perangkat dan server mengubah kolom yang sama, aplikasi menyimpan konflik di IndexedDB dan meminta pengguna memilih **Gunakan Data Saya** atau **Gunakan Data Server**. Antrean tetap idempotent dan hanya mengirim satu perubahan per dokumen dalam setiap batch, sehingga urutan perubahan tidak terbalik.

## Penyimpanan

PostgreSQL tetap menjadi sumber data tunggal. IndexedDB menyimpan cache dan antrean offline per perangkat. Cloudflare Cache API dan KV hanya menyimpan ringkasan/versi cache. Upstash Redis hanya menyimpan hash pembatas login.

Cloudflare R2 aktif untuk hasil ekspor besar dan lampiran privat. Jalur upload worker dibatasi 50 MB, berkas hanya dapat diunduh oleh pemilik job atau Admin Gizi, dan PostgreSQL hanya menyimpan metadata objek.

Bucket memakai kelas Standard. Objek sementara `jobs/` kedaluwarsa setelah 7 hari. Cron Worker memeriksa kapasitas setiap 10 menit; ketika total mencapai 9 GiB, file job tertua dihapus sampai kapasitas turun ke 8 GiB. Batas pengaman ini sengaja lebih rendah dari jatah gratis 10 GB. Lampiran permanen tidak dihapus otomatis.

Saat membuat environment Cloudflare baru, aktivasi akun R2 dilakukan satu kali melalui Dashboard, lalu jalankan:

```bash
npm run r2:prepare
```

Kemudian deploy Worker dan pastikan endpoint monitoring menampilkan `r2Configured: true`. Admin Gizi menerima peringatan bila kapasitas tidak dapat diturunkan karena file yang tersisa bukan file sementara.

MQTT sengaja tidak dipasang sebelum ada timbangan digital atau sensor IoT. Keputusan dan syarat keamanannya tercatat di `docs/decisions/001-mqtt-deferred.md`.
