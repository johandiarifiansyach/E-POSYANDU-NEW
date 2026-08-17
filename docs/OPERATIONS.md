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

Resource Cloudflare staging juga wajib terpisah. Konfigurasi saat ini memakai
KV `staging-E_POSYANDU_CACHE`, Queue `e-posyandu-jobs-staging`, bucket R2
`e-posyandu-files-staging`, dan Pages `e-posyandu-staging`. Staging dimulai
dengan `READ_REPLICA_MODE=primary-only`; jangan menambahkan service binding
Neon staging sebelum replika staging dan secret-nya benar-benar tersedia.

Jangan deploy frontend atau Worker staging sebelum `npm run env:check`
berhasil. Perintah itu harus menerima tiga URL Supabase yang berbeda. Project
development dan staging tidak boleh diisi data identitas atau kesehatan nyata.

Salin template frontend yang sesuai menjadi file lokal tanpa akhiran `.example`. Nilai `VITE_*` bersifat publik; secret service-role tidak boleh berada di frontend.

## Urutan rilis

1. Jalankan `npm run check` dan `npm run build`.
2. Terapkan migrasi PostgreSQL terbaru di staging.
3. Bila replika Neon dipakai, deploy private Neon Read Worker staging sebelum Rust Worker staging.
4. Jalankan `npm run worker:deploy:staging` dan `npm run pages:deploy:staging`.
5. Uji alur online, offline, konflik edit, fallback replika, dan request berulang.
6. Terapkan migrasi di production.
7. Deploy private Neon Read Worker production sebelum menjalankan `npm run worker:deploy`, lalu deploy Pages.

Worker dan migration `027` menutup akses RPC browser langsung. Uji login,
kata sandi salah, refresh sesi, pembatasan percobaan, logout, dan pemulihan akun
di staging. Frontend production memanggil `/api` di domain Pages; `_worker.js`
meneruskannya ke API sehingga cookie `__Host-e-posyandu-session` tetap
first-party di Safari/mobile.

Workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) menjalankan TypeScript check, contract test, unit test Rust, build, dan E2E Chrome/Safari desktop serta ponsel. Deploy production baru aktif setelah repository variable `AUTO_DEPLOY=true` dan secret `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, serta `CLOUDFLARE_ACCOUNT_ID` tersedia pada GitHub Environment `production`. Setelah deploy, smoke test memeriksa frontend, security headers termasuk endpoint laporan CSP, health API, OpenAPI, dan penolakan akses tanpa sesi.

Smoke test production juga berjalan setiap enam jam melalui `deployment-smoke.yml`. Pemeriksaan manual dapat dijalankan tanpa kredensial:

```bash
SMOKE_FRONTEND_URL='https://e-posyandu.pages.dev' \
SMOKE_API_URL='https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev' \
npm run deployment:smoke
```

Untuk staging, `SMOKE_SESSION_COOKIE` opsional dapat diisi sesaat dengan pasangan nama/nilai cookie sesi, misalnya `__Host-e-posyandu-session=...`. Alternatif kompatibilitasnya adalah `SMOKE_ACCESS_TOKEN`. Keduanya menambahkan pemeriksaan endpoint sesi serta riwayat terautentikasi dan memastikan token tidak muncul di respons. Kredensial ini berumur pendek: jangan simpan sebagai file, log, atau secret jangka panjang. Workflow terjadwal tetap menguji penolakan sesi anonim ketika secret tidak tersedia.

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

## Replika baca Neon

Supabase adalah primary dan satu-satunya database yang menerima login, CRUD, audit, serta sinkronisasi offline. Neon menerima snapshot awal dan perubahan inkremental melalui Supabase Data API HTTPS untuk pekerjaan baca yang berat. Jalur ini dipakai karena endpoint direct Supabase bersifat IPv6 dan tidak dapat dijangkau oleh subscription Neon; endpoint pooler tidak mendukung logical replication. Rust Worker tetap memeriksa token, role, desa, dan posyandu sebelum meneruskan RPC yang diizinkan ke private Neon Read Worker melalui Cloudflare Service Binding.

Urutan aktivasi production:

1. Terapkan seluruh migration, termasuk `020_read_replica_children_page.sql`, pada Supabase.
2. Buat project/database Neon kosong serta role login khusus baca.
3. Jalankan `npm run replica:bootstrap` menggunakan tiga URL rahasia seperti pada `database/README.md`. Gunakan Supabase Session Pooler port 5432 sebagai source agar snapshot dapat berjalan melalui IPv4. Perintah ini membuat snapshot melalui komputer pengelola dan aman diulang pada schema Neon yang sudah lengkap.
4. Isi koneksi baca, koneksi sinkronisasi, dan sumber HTTPS pada private Worker:

```bash
cd services/neon-read-worker
npx wrangler secret put NEON_DATABASE_URL
npx wrangler secret put NEON_SYNC_DATABASE_URL
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put READ_REPLICA_SHARED_SECRET
npm run deploy
```

5. Isi secret yang sama pada Rust Worker, lalu deploy ulang API:

```bash
cd backend
npx wrangler secret put READ_REPLICA_SHARED_SECRET
npm run deploy
```

Untuk staging, tambahkan `--env staging` pada perintah Wrangler. Semua nilai tersebut disimpan sebagai Worker secrets dan tidak boleh masuk Git atau frontend. `NEON_DATABASE_URL` memakai role read-only; `NEON_SYNC_DATABASE_URL` milik owner hanya dipakai handler terjadwal. Service Binding tidak mengekspos Neon Read Worker ke internet dan harus dibuat lebih dahulu sebelum Rust Worker yang merujuk binding tersebut diterbitkan.

Mode operasi ditentukan oleh `READ_REPLICA_MODE`:

- `prefer-replica`: baca berat menuju Neon dan otomatis fallback ke Supabase.
- `primary-only`: seluruh baca kembali ke Supabase tanpa mengubah kode atau data.

Setelah mutasi berhasil, user terkait dipaksa membaca Supabase selama 6 menit. Cache daftar dan dashboard juga diinvalisasi. Waktu ini melewati interval sinkronisasi lima menit sehingga pengguna selalu melihat perubahan sendiri tanpa membuat setiap pembacaan mengenai primary.

### Mode baca darurat

Setiap sesi yang berhasil diverifikasi oleh Supabase menyimpan salinan scope akses ke KV menggunakan hash SHA-256 token, bukan token mentah. Salinan hanya berisi user ID, role, desa, dan posyandu yang diperlukan untuk pembatasan data. Masa berlakunya mengikuti waktu kedaluwarsa JWT dengan batas maksimum satu jam dan terus diperbarui selama Supabase sehat.

Saat Supabase gagal dijangkau, mengembalikan `429`, atau `5xx`, backend boleh memakai scope tersebut hanya untuk `GET` dan query GraphQL baca. Data tetap dibatasi sesuai role serta wilayah lalu dibaca dari Neon. Scope hanya dibuat dari sesi yang sebelumnya berhasil diverifikasi Supabase. Status `401` atau `403` tidak pernah memakai fallback karena dapat menunjukkan token atau izin yang tidak sah. Login baru, refresh token, CRUD, sinkronisasi tulis, audit, dan seluruh perubahan data tetap bergantung pada Supabase serta tidak pernah dialihkan ke Neon.

Mode ini menjaga daftar dan dashboard tetap dapat dibuka dalam gangguan singkat, bukan menjadikan Neon primary kedua. Bila sesi belum pernah diverifikasi, JWT sudah kedaluwarsa, KV tidak tersedia, replika belum siap, atau gangguan berlangsung lebih dari satu jam, pengguna harus menunggu Supabase pulih. Pantau event `emergency_read_session`; setiap event harus mencantumkan `writes: blocked` dan tidak boleh berisi token atau data balita.

Periksa kondisi replika dengan `npm run replica:verify`. Pantau `lastSuccessAt` dan `lagSeconds` pada health private Worker, error `replica_sync_failed`, fallback `read_router_fallback`, compute Neon, dan egress Supabase. Sinkronisasi hanya mengambil baris yang berubah dengan overlap lima detik serta aman diulang. Bila lag melebihi 15 menit, set `READ_REPLICA_MODE=primary-only` terlebih dahulu; jangan mengarahkan operasi tulis aplikasi ke Neon.

Pemeriksaan terpadu tersedia pada `GET /api/v1/health/ready`. Endpoint ini memeriksa konfigurasi database, KV, Queue, R2, dan status nutrition worker tanpa membaca data balita. GitHub Actions menjalankannya pada Senin-Jumat pukul 07.07-16.00 WIB bersama pemeriksaan frontend dan health Render melalui `system-monitor.yml`. Pemeriksaan manual tetap dapat dijalankan kapan saja.

Jalankan pemeriksaan yang sama dari komputer pengelola dengan:

```bash
npm run monitor:system
```

Laporan JSON dapat disimpan dengan `MONITOR_OUTPUT_PATH=/lokasi/laporan.json`. Hasil terjadwal disimpan sebagai artifact GitHub selama 14 hari agar tren kegagalan dapat ditelusuri.

Error JavaScript setelah pengguna login dikirim ke `POST /api/v1/client-errors`. Payload hanya berisi jenis error, route tanpa query, sumber, dan frame stack; pesan error serta data formulir tidak dikirim.

Pelanggaran Content Security Policy dikirim browser ke `POST /api/v1/security/csp-report`. Endpoint publik ini membatasi isi 16 KiB dan 60 laporan per IP per jam. Log hanya menyimpan directive, disposition, status HTTP, URL dokumen tanpa kredensial/query/fragment, serta origin sumber yang diblokir. IP mentah, `script-sample`, policy lengkap, referrer, NIK, dan isi form tidak dicatat.

Cron memeriksa `RUST_WORKER_HEALTH_URL` setiap 10 menit pada Senin-Jumat pukul 07.00-16.00 WIB. Di luar jam tersebut Render dibiarkan sleep. Status disimpan di KV dan dibaca dashboard hanya oleh Admin Gizi. Untuk alarm di luar aplikasi, isi secret HTTPS `MONITORING_ALERT_WEBHOOK_URL`, atau isi `RESEND_API_KEY`, `MONITORING_ALERT_EMAIL_TO`, dan `ERROR_REPORT_EMAIL_FROM`. Alarm dikirim saat kegagalan ketiga dan sekali lagi saat layanan pulih, tanpa membawa data balita.

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

Uji restore bulanan bersifat opt-in karena akan membuat ulang schema aplikasi `public` pada database target. Schema internal dan event trigger Supabase tidak disentuh. Data `public.app_users` tetap ada di archive terenkripsi, tetapi sengaja tidak dimuat pada drill karena bergantung pada pengguna `auth.users` milik project sumber. Isi `RESTORE_DATABASE_URL` dan salinan `BACKUP_ENCRYPTION_PASSWORD` pada Environment `staging`, lalu set `ENABLE_MONTHLY_RESTORE_DRILL=true`. Uji restore juga dapat dipicu manual dengan opsi `run_restore_drill`. Database target wajib khusus pengujian dan tidak boleh berisi data aktif.

Sebelum dienkripsi, workflow menjalankan `npm run db:backup:verify -- <file.dump>` untuk memastikan archive dapat dibaca serta memuat tabel `children`, `measurements`, dan `schema_migrations`. Setelah restore, drill kembali memeriksa tabel wajib, jumlah data, dan migration terbaru. Jangan menyalakan kedua variable jadwal sebelum seluruh secret tersedia; workflow sengaja gagal tertutup bila satu secret kosong.

## Load test Queue dan gRPC

Load test gRPC lokal memakai data sintetis tanpa identitas nyata:

```bash
LOAD_GRPC_REQUESTS=50 \
LOAD_GRPC_CONCURRENCY=8 \
LOAD_GRPC_ITEMS=250 \
npm run grpc:load
```

Alur production lengkap REST -> Queue -> worker gRPC diuji secara manual melalui workflow `load-test.yml`. Buat GitHub Environment `load-test`, lalu isi secret `LOAD_SUPABASE_URL`, `LOAD_SUPABASE_PUBLISHABLE_KEY`, `LOAD_TEST_EMAIL`, dan `LOAD_TEST_PASSWORD`. Email dan kata sandi harus milik akun khusus pengujian yang memiliki akses Admin Gizi. Workflow membuat access token baru pada awal setiap pengujian, sehingga token sesi yang kedaluwarsa tidak perlu disimpan. Setelah itu pilih **Actions > Queue and gRPC Load Test > Run workflow**. Batas keras script adalah 50 job, paralel 10, dan 1.000 data sintetis per job agar pengujian tidak menghabiskan kuota gratis secara tidak sengaja.

## Konflik sinkronisasi offline

Setiap update dan hapus membawa `version` serta `updatedAt` yang terakhir dilihat perangkat. Server mengembalikan `409` dan dokumen terkini bila data sudah berubah. Perubahan pada kolom berbeda digabung otomatis dengan three-way merge. Bila perangkat dan server mengubah kolom yang sama, aplikasi menyimpan konflik di IndexedDB dan meminta pengguna memilih **Gunakan Data Saya** atau **Gunakan Data Server**. Antrean tetap idempotent dan hanya mengirim satu perubahan per dokumen dalam setiap batch, sehingga urutan perubahan tidak terbalik.

## Penyimpanan

PostgreSQL tetap menjadi sumber data tunggal. IndexedDB menyimpan cache dan antrean offline per perangkat. Cloudflare Cache API dan KV hanya menyimpan ringkasan/versi cache. Upstash Redis hanya menyimpan hash pembatas login.

Cloudflare R2 aktif untuk hasil ekspor besar dan lampiran privat. Jalur upload worker dibatasi 50 MB, berkas hanya dapat diunduh oleh pemilik job atau Admin Gizi, dan PostgreSQL hanya menyimpan metadata objek.

Bucket memakai kelas Standard. Objek sementara `jobs/` kedaluwarsa setelah 7 hari. Cron Worker memeriksa kapasitas bersama jadwal jam kerja; ketika total mencapai 9 GiB, file job tertua dihapus sampai kapasitas turun ke 8 GiB. Batas pengaman ini sengaja lebih rendah dari jatah gratis 10 GB. Lampiran permanen tidak dihapus otomatis.

Saat membuat environment Cloudflare baru, aktivasi akun R2 dilakukan satu kali melalui Dashboard, lalu jalankan:

```bash
npm run r2:prepare
```

Kemudian deploy Worker dan pastikan endpoint monitoring menampilkan `r2Configured: true`. Admin Gizi menerima peringatan bila kapasitas tidak dapat diturunkan karena file yang tersisa bukan file sementara.

MQTT sengaja tidak dipasang sebelum ada timbangan digital atau sensor IoT. Keputusan dan syarat keamanannya tercatat di `docs/decisions/001-mqtt-deferred.md`.
