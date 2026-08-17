# Status Komponen Sistem

Dokumen ini membedakan komponen yang sudah aktif, fondasi yang sudah tersedia, dan fitur yang belum boleh diaktifkan sebelum kebutuhan produk serta perlindungan datanya jelas.

| No. | Komponen | Status | Keterangan |
| --- | --- | --- | --- |
| 1 | Service Worker | Aktif | Cache aset, offline shell, dan pembaruan cache rilis tersedia. |
| 2 | Database Migration | Aktif | Migration bernomor, registry `schema_migrations`, runner, dan Git. |
| 3 | Audit Log | Aktif | Login, CRUD, ekspor XLS, dan perubahan role/wilayah dicatat. |
| 4 | Request ID dan structured logging | Aktif | `X-Request-ID`, latency, route, status, dan environment. |
| 5 | Testing | Aktif | Unit Rust, integration contract, E2E desktop/ponsel, serta smoke test deployment setiap enam jam. |
| 6 | Monitoring | Aktif | Error, latency, cache hit, readiness seluruh komponen setiap 30 menit, status KV, peringatan Admin Gizi, dan alarm eksternal opsional. |
| 7 | Backup dan restore | Siap diaktifkan | Backup terenkripsi, verifikasi archive, dan restore drill tersedia; jadwal menunggu secret database production/staging. |
| 8 | CI/CD | Siap diaktifkan | Build, test, migration, dan deploy otomatis tersedia; membutuhkan GitHub secrets dan `AUTO_DEPLOY=true`. |
| 9 | Feature flag | Aktif | Konfigurasi KV dapat diubah tanpa deploy untuk fitur yang sudah ditanam dalam kode. |
| 10 | OpenAPI | Aktif | Kontrak REST tersedia di `/api/v1/openapi.json` dan diperiksa oleh test. |
| 11 | Health check | Aktif | `/api/v1/health` ringan dan tidak membaca data balita. |
| 12 | Security headers | Aktif | CSP, HSTS, Referrer Policy, CORS terbatas, dan header browser lain. |
| 13 | PWA installable | Aktif | Manifest, standalone mode, icon, service worker, dan offline shell. |
| 14 | Accessibility | Aktif dan diuji | Bahasa dokumen, label form, keyboard, skip link, fokus, live region, serta audit otomatis WCAG AA pada Chrome/Safari desktop dan ponsel tersedia; audit manual tetap berkala. |
| 15 | Error tracking | Aktif | Error frontend terautentikasi masuk structured log backend tanpa data formulir. |
| 16 | Background job/queue | Aktif | Cloudflare Queue dan worker gRPC menangani validasi impor, laporan, ekspor, dan sinkronisasi berat. |
| 17 | Cloudflare R2 | Aktif | Upload/download privat, retensi 7 hari, dan pengaman kapasitas 9 GiB ke 8 GiB aktif. |
| 18 | Notification system | Aktif terbatas | Peringatan worker tersedia untuk Admin Gizi; webhook/email eksternal bersifat opsional. |
| 19 | Webhook | Ditunda | Memerlukan sistem tujuan, signing secret, retry, dan allowlist. |
| 20 | Multi-language | Ditunda | Bahasa Indonesia tetap bahasa tunggal sampai kebutuhan pengguna terkonfirmasi. |
| 21 | Data export | Aktif | XLS/XLSX dan CSV aktif; permintaan data ekspornya diaudit serta tetap dibatasi cakupan wilayah akun. |
| 22 | User feedback | Ditunda | Form bug/saran akan dibuat setelah tujuan penerima dan retensi laporan ditetapkan. |
| 23 | Sesi HttpOnly | Siap diuji staging | BFF same-origin, cookie HttpOnly, Turnstile, rate limiter, dan penutupan RPC browser tersedia; verifikasi dua langkah tidak digunakan. |
| 24 | Tata kelola privasi | Baseline siap disahkan | Inventaris data, akses, retensi 25 tahun RME, ekspor, hak subjek, dan respons insiden terdokumentasi; pengesahan Puskesmas/Dinas tetap wajib. |
| 25 | Pelaporan CSP | Siap diuji staging | Endpoint same-origin membatasi ukuran/laju dan membuang query, referrer, script sample, serta IP mentah. |

Prioritas berikutnya adalah mengisi secret backup/restore dan token akun uji pada GitHub Environment, menuntaskan project Supabase development dan staging yang terpisah, serta memperluas strict TypeScript secara bertahap. MQTT tetap ditunda sampai tersedia perangkat IoT nyata.
