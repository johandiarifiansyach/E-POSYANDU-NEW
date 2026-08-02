# Status Komponen Sistem

Dokumen ini membedakan komponen yang sudah aktif, fondasi yang sudah tersedia, dan fitur yang belum boleh diaktifkan sebelum kebutuhan produk serta perlindungan datanya jelas.

| No. | Komponen | Status | Keterangan |
| --- | --- | --- | --- |
| 1 | Service Worker | Aktif | Cache aset, offline shell, dan pembaruan cache rilis tersedia. |
| 2 | Database Migration | Aktif | Migration bernomor, registry `schema_migrations`, runner, dan Git. |
| 3 | Audit Log | Aktif | Login, CRUD, ekspor XLS, dan perubahan role/wilayah dicatat. |
| 4 | Request ID dan structured logging | Aktif | `X-Request-ID`, latency, route, status, dan environment. |
| 5 | Testing | Aktif | Unit Rust, integration contract, serta E2E desktop/ponsel. Cakupan ditambah setiap perubahan fitur. |
| 6 | Monitoring | Aktif | Error, latency, cache hit, dan panduan pemantauan egress tersedia. Alarm otomatis masih tahap berikutnya. |
| 7 | Backup dan restore | Aktif | Script backup dan restore drill non-production tersedia. Penjadwalan mengikuti kebijakan penyimpanan data. |
| 8 | CI/CD | Siap diaktifkan | Build, test, migration, dan deploy otomatis tersedia; membutuhkan GitHub secrets dan `AUTO_DEPLOY=true`. |
| 9 | Feature flag | Aktif | Konfigurasi KV dapat diubah tanpa deploy untuk fitur yang sudah ditanam dalam kode. |
| 10 | OpenAPI | Aktif | Kontrak REST tersedia di `/api/v1/openapi.json` dan diperiksa oleh test. |
| 11 | Health check | Aktif | `/api/v1/health` ringan dan tidak membaca data balita. |
| 12 | Security headers | Aktif | CSP, HSTS, Referrer Policy, CORS terbatas, dan header browser lain. |
| 13 | PWA installable | Aktif | Manifest, standalone mode, icon, service worker, dan offline shell. |
| 14 | Accessibility | Berjalan | Bahasa dokumen, label form, keyboard, skip link, fokus, dan live region tersedia; audit WCAG penuh tetap berkala. |
| 15 | Error tracking | Aktif | Error frontend terautentikasi masuk structured log backend tanpa data formulir. |
| 16 | Background job/queue | Ditunda | Diaktifkan saat ukuran ekspor, PDF, atau email sudah memerlukan proses asinkron. |
| 17 | Cloudflare R2 | Ditunda | Binding disiapkan, tetapi baru diaktifkan ketika upload berkas privat tersedia. |
| 18 | Notification system | Ditunda | Memerlukan aturan penerima, persetujuan, dan kebijakan data sebelum implementasi. |
| 19 | Webhook | Ditunda | Memerlukan sistem tujuan, signing secret, retry, dan allowlist. |
| 20 | Multi-language | Ditunda | Bahasa Indonesia tetap bahasa tunggal sampai kebutuhan pengguna terkonfirmasi. |
| 21 | Data export | Aktif | XLS/XLSX dan CSV aktif; permintaan data ekspornya diaudit serta tetap dibatasi cakupan wilayah akun. |
| 22 | User feedback | Ditunda | Form bug/saran akan dibuat setelah tujuan penerima dan retensi laporan ditetapkan. |

Prioritas berikutnya adalah menambah alarm monitoring, memperluas E2E ke CRUD dan sinkronisasi offline, serta menjalankan restore drill pertama di staging. Queue, R2, notifikasi, webhook, i18n, dan feedback tidak diaktifkan hanya untuk menambah komponen karena masing-masing membawa biaya serta tanggung jawab keamanan baru.
