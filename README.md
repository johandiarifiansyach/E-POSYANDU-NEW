# E-Posyandu Puskesmas Gumukmas

Aplikasi pencatatan balita, pengukuran, ASI eksklusif, MPASI, dan PMT untuk UPTD Puskesmas Gumukmas.

## Struktur Proyek

```text
frontend/              Aplikasi dan aset native HTML5, CSS, dan TypeScript
backend/               API Rust untuk Cloudflare Workers
database/migrations/   Riwayat migrasi PostgreSQL/Supabase
docs/                  Panduan operasional dan monitoring
scripts/               Otomasi database dan pemeliharaan
tests/                 Pengujian kontrak lintas komponen
```

## Infrastruktur Produksi

| Bagian | Layanan |
| --- | --- |
| Edge web | Cloudflare DNS/proxy/WAF/DDoS/Turnstile/Tunnel |
| Frontend utama | Container Caddy di Oracle Compute melalui Tunnel |
| API utama | `oracle-api` Rust di Oracle Compute melalui Tunnel |
| Service identity | `identity-service` gRPC privat untuk login, MFA, passkey, dan akun admin |
| Service operasional | `operations-service` gRPC privat untuk CRUD, cache, dan sinkronisasi |
| Service realtime | `realtime-service` gRPC streaming untuk SSE perubahan data |
| Service monitoring | `monitoring-service` gRPC privat untuk metrik admin |
| Data utama | Oracle PostgreSQL native; Supabase tetap tersedia sebagai jalur legacy/rollback |
| Sesi dan autentikasi | Identity service dengan PostgreSQL native + SQLite sesi terenkripsi |
| Pekerjaan berat | Rust `nutrition-grpc` di Oracle Compute + Cloudflare Queue |
| Komunikasi internal | gRPC/HTTP2 privat antara gateway, identity, operations, realtime, monitoring, dan nutrition; Queue tetap untuk job asinkron |
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
npm run oracle:deploy:operations -- ALIAS_SSH DOMAIN_HEALTH # Deploy operations service saja
npm run oracle:deploy:realtime -- ALIAS_SSH DOMAIN_HEALTH # Deploy realtime service saja
npm run oracle:deploy:monitoring -- ALIAS_SSH DOMAIN_HEALTH # Deploy monitoring service saja
npm run oracle:deploy:nutrition -- ALIAS_SSH DOMAIN_HEALTH # Deploy worker gizi saja
npm run worker:deploy   # Deploy API ke Cloudflare Worker
npm run worker:deploy:staging # Deploy API staging
npm run pages:deploy    # Build dan deploy frontend ke Cloudflare Pages
```

Untuk menjalankan Worker di komputer sendiri, salin `backend/.dev.vars.example` menjadi `backend/.dev.vars`, isi nilai lokal, lalu jalankan `npm run worker:dev`. Berkas `.dev.vars` tidak pernah masuk Git.

Dokumentasi API tersedia dari endpoint `/api/v1/openapi.json`; konfigurasi backend ada di [backend/README.md](backend/README.md).
Urutan migrasi ada di [database/README.md](database/README.md), sedangkan prosedur rilis dan monitoring ada di [docs/OPERATIONS.md](docs/OPERATIONS.md).
Status pengembangan fitur operasional ada di [docs/ROADMAP.md](docs/ROADMAP.md).
Panduan kepemilikan folder dan penempatan file baru ada di [docs/STRUCTURE.md](docs/STRUCTURE.md).

Seluruh antarmuka memakai HTML5, CSS, dan TypeScript dengan elemen DOM browser langsung. Tidak ada React, JSX/TSX, virtual DOM, atau runtime rekonsiliasi.
# skills-copilot-codespaces-vscode
