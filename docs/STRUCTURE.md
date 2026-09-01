# Struktur Proyek

Struktur ini memisahkan kode berdasarkan tanggung jawab agar lokasi perubahan mudah ditebak dan setiap folder memiliki satu tujuan utama.

```text
E-POSYANDU/
├── frontend/
│   ├── public/              Aset publik, PWA, header, dan redirect
│   ├── e2e/                 Pengujian browser desktop dan ponsel
│   └── src/
│       ├── api/             Klien REST dan autentikasi
│       ├── components/      Komponen UI yang digunakan ulang
│       ├── config/          Versi aplikasi dan riwayat rilis
│       ├── data/            Data referensi statis
│       ├── pages/           Halaman dan alur utama aplikasi
│       ├── runtime/         Renderer DOM native
│       ├── services/        Penyimpanan dan sinkronisasi lokal
│       ├── styles/          Stylesheet global
│       ├── theme/           Mode terang dan gelap
│       └── ui/              Ikon, tooltip, notifikasi, dan modal bersama
├── backend/
│   ├── data/                Data referensi untuk kalkulasi server
│   ├── scripts/             Generator artefak backend
│   └── src/
│       ├── api/             Endpoint CRUD, sinkronisasi, ekspor, dan cache
│       ├── graphql.rs       Query baca GraphQL dengan scope wilayah yang sama
│       └── lib.rs           Entry point Worker, auth, keamanan, dan routing
├── services/
│   ├── eposyandu-proto/     Kontrak protobuf/gRPC bersama antarservice
│   ├── oracle-api/           API gateway native dan proxy gRPC
│   ├── oracle-domain/        Implementasi domain bersama selama migrasi kode
│   ├── identity-service/     Microservice autentikasi dan administrasi akun
│   ├── operations-service/   Microservice CRUD, cache, dan sinkronisasi
│   ├── realtime-service/     Microservice stream perubahan data
│   ├── monitoring-service/   Microservice metrik operasional admin
│   ├── analysis-service/     Microservice Python kalkulasi WHO deterministik
│   ├── neon-read-worker/    Gateway privat baca-only menuju replika Neon
│   └── data-processing-service/ Worker job berat Rust dan pull consumer Queue
├── deploy/oracle/           Runtime terisolasi dan bootstrap worker Oracle
├── database/migrations/     Migration PostgreSQL berurutan
├── docs/                    Dokumentasi arsitektur dan operasional
├── scripts/database/        Backup, restore, dan penerapan migration
└── tests/integration/       Kontrak lintas frontend, backend, dan database
```

## Aturan Penempatan

- Tambahkan halaman baru ke `frontend/src/pages`.
- Tambahkan komponen yang dipakai beberapa halaman ke `frontend/src/components`.
- Akses jaringan frontend hanya ditambahkan melalui `frontend/src/api`.
- Kode penyimpanan browser dan sinkronisasi lokal ditempatkan di `frontend/src/services`.
- Endpoint backend ditempatkan di `backend/src/api`; `lib.rs` hanya mengurus pintu masuk, autentikasi, keamanan, dan dispatch.
- Browser memakai HTTPS ke gateway untuk autentikasi, CRUD, sinkronisasi ringan,
  progres, dan unduhan. GraphQL hanya untuk query baca dashboard dan laporan
  terpaginasikan. `oracle-api` tidak mengakses implementasi domain saat mode
  microservices aktif; ia meneruskan envelope HTTP internal melalui gRPC ke
  service pemilik domain. Komunikasi service-to-service native memakai
  gRPC/HTTP2 dengan kontrak pada `services/eposyandu-proto`; gRPC tidak pernah
  dibuka langsung ke browser.
- Cloudflare Queue hanya membawa ID job. Payload dan status tetap berada di PostgreSQL agar pesan kecil, dapat diulang secara idempoten, dan tidak menyimpan data kesehatan di antrean.
- PostgreSQL Oracle native adalah sumber kebenaran dan tujuan tulis aplikasi pada mode produksi. Supabase tetap dipertahankan sebagai jalur legacy/rollback, sedangkan Rust Worker dan domain service selalu memvalidasi scope sebelum membaca atau menulis.
- Setiap perubahan struktur database wajib menjadi migration baru di `database/migrations`.
- Jangan menyimpan output build, cache, `.env`, `.dev.vars`, backup, atau credential ke Git.
