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
| Frontend | Cloudflare Pages |
| API | Cloudflare Worker berbasis Rust |
| Data utama dan autentikasi | Supabase PostgreSQL + Supabase Auth |
| Replika baca query berat | Neon PostgreSQL melalui private Cloudflare Worker |
| Cache ringkasan | Cloudflare Cache API |
| Metadata invalidasi cache | Cloudflare KV |
| Pembatas login | Upstash Redis |

- Frontend: https://e-posyandu.pages.dev
- API: https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev

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
