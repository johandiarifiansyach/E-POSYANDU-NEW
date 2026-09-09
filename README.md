# E-Posyandu Puskesmas Gumukmas

Aplikasi pencatatan balita, pengukuran, ASI eksklusif, MPASI, dan PMT untuk UPTD Puskesmas Gumukmas.

## Struktur Proyek

```text
frontend-react/        Frontend utama React 19 + TSX + TypeScript 7
frontend-react/src/compat/
                       Kontrak API, utilitas, aset, dan data referensi bersama
backend/               API Rust untuk Cloudflare Workers
database/migrations/   Riwayat migrasi PostgreSQL/Supabase
docs/                  Panduan operasional dan monitoring
scripts/               Otomasi database dan pemeliharaan
tests/                 Pengujian kontrak lintas komponen
```

Frontend utama menggunakan React dan TSX dengan kontrak API TypeScript yang
ketat. Halaman, layout, dialog, modal, tabel, filter, feedback, skeleton,
notifikasi, utilitas ikon, dan alur autentikasi berada di `frontend-react/`.
Modul bersama yang sebelumnya berada pada frontend native kini dipindahkan ke
`frontend-react/src/compat/`; modul tersebut hanya dipakai sebagai kontrak,
utilitas, data WHO, dan stylesheet bersama, bukan sebagai renderer native.

## Infrastruktur Produksi

| Bagian | Layanan |
| --- | --- |
| Edge web | Cloudflare DNS/proxy/WAF/DDoS/Turnstile/Tunnel |
| Frontend utama | Container Caddy di Oracle Compute melalui Tunnel |
| API utama | `oracle-api` Rust di Oracle Compute melalui Tunnel |
| Service identity | `identity-service` gRPC privat untuk login, MFA, passkey, dan akun admin |
| Service baca | `read-service` gRPC privat untuk tabel, dashboard, cache, dan analisis read-side |
| Service tulis | `write-service` gRPC privat untuk CRUD, outbox analisis, dan invalidasi cache |
| Service operasional legacy | `operations-service` gRPC rollback-only (Compose profile `legacy`) |
| Service realtime | `realtime-service` gRPC streaming untuk SSE perubahan data |
| Service monitoring | `monitoring-service` gRPC privat untuk metrik admin |
| Service analisis | `analysis-worker` Rust/PyO3 gRPC privat; modul Python tetap menjadi otoritas kalkulasi LMS deterministik, screening risiko logistic, analisis tren grafik, dan deteksi anomali |
| MCP internal | `mcp-service` Rust/Streamable HTTP privat; tools terkontrol membaca ReadService dan mencatat rekomendasi tindak lanjut otomatis melalui WriteService |
| Data utama | Oracle PostgreSQL native; Supabase tetap tersedia sebagai jalur legacy/rollback |
| Sesi dan autentikasi | Identity service dengan PostgreSQL native + SQLite sesi terenkripsi |
| Pekerjaan berat | Rust `data-processing-worker` di Oracle Compute + Cloudflare Queue |
| Komunikasi internal | gRPC/HTTP2 privat antara gateway, identity, read, write, realtime, monitoring, dan data-processing; Queue tetap untuk job asinkron |
| Rollback darurat | Cloudflare Pages + Worker lama, tetap tersedia tetapi bukan jalur normal |
| File job privat | Cloudflare R2 |
| Cache data dinamis (TTL umum 5 menit; dashboard 60 detik) | Redis |
| Cache menu/referensi/feature flag global | Cloudflare KV |
| Sesi sementara dan pembatas login Worker | Upstash Redis |

- Frontend utama: https://eposyandu.app
- Frontend fallback: https://e-posyandu.pages.dev
- API utama: https://api.eposyandu.app
- API fallback: https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev

## Perintah Utama

```bash
npm run dev             # Frontend lokal
npm run frontend:check  # Pemeriksaan TypeScript frontend
npm run worker:test     # Test API Rust
npm run integration:test # Test kontrak migrasi, API, PWA, dan security header
npm run e2e:test        # Test browser desktop dan ponsel
npm run db:migrate      # Terapkan migration yang belum dijalankan
npm run db:backup       # Buat backup PostgreSQL dengan izin file privat
npm run replica:check   # Periksa TypeScript private Neon Read Worker
npm run replica:verify  # Verifikasi sinkronisasi HTTPS dan role read-only
npm run oracle:deploy:api -- ALIAS_SSH DOMAIN_HEALTH # Deploy API Oracle saja
npm run oracle:deploy:identity -- ALIAS_SSH DOMAIN_HEALTH # Deploy identity service saja
npm run oracle:deploy:read -- ALIAS_SSH DOMAIN_HEALTH # Deploy read service saja
npm run oracle:deploy:write -- ALIAS_SSH DOMAIN_HEALTH # Deploy write service saja
npm run oracle:deploy:operations -- ALIAS_SSH DOMAIN_HEALTH # Deploy operations service saja
npm run oracle:deploy:realtime -- ALIAS_SSH DOMAIN_HEALTH # Deploy realtime service saja
npm run oracle:deploy:monitoring -- ALIAS_SSH DOMAIN_HEALTH # Deploy monitoring service saja
npm run oracle:deploy:data-processing -- ALIAS_SSH DOMAIN_HEALTH # Deploy data processing worker saja
npm run oracle:deploy:analysis -- ALIAS_SSH DOMAIN_HEALTH # Deploy analysis-worker Rust/PyO3 saja
npm run oracle:deploy:mcp -- ALIAS_SSH DOMAIN_HEALTH # Deploy MCP internal saja
npm run worker:deploy   # Deploy API ke Cloudflare Worker
npm run worker:deploy:staging # Deploy API staging
npm run pages:deploy    # Build dan deploy frontend ke Cloudflare Pages
```

Untuk menjalankan Worker di komputer sendiri, salin `backend/.dev.vars.example` menjadi `backend/.dev.vars`, isi nilai lokal, lalu jalankan `npm run worker:dev`. Berkas `.dev.vars` tidak pernah masuk Git.

Dokumentasi API tersedia dari endpoint `/api/v1/openapi.json`; konfigurasi backend ada di [backend/README.md](backend/README.md).
Urutan migrasi ada di [database/README.md](database/README.md), sedangkan prosedur rilis dan monitoring ada di [docs/OPERATIONS.md](docs/OPERATIONS.md).
Status pengembangan fitur operasional ada di [docs/ROADMAP.md](docs/ROADMAP.md).
Panduan kepemilikan folder dan penempatan file baru ada di [docs/STRUCTURE.md](docs/STRUCTURE.md).

Pemeriksaan frontend React lokal:

```bash
npm run frontend:react:check
npm run frontend:react:build
npm run frontend:react:test -- --workers=1
```

Seluruh perubahan frontend pada tahap migrasi ini diverifikasi lokal dan tidak
menjalankan deployment otomatis.
# skills-copilot-codespaces-vscode
