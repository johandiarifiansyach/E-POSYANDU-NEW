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
│   ├── neon-read-worker/    Gateway privat baca-only menuju replika Neon
│   └── nutrition-grpc/      Worker job berat Rust dan pull consumer Queue
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
- REST dipakai untuk autentikasi, CRUD, sinkronisasi ringan, pembuatan job, progres, dan unduhan. GraphQL hanya untuk query baca dashboard dan laporan terpaginasikan; gRPC hanya untuk validasi, kalkulasi, ekspor, dan normalisasi batch internal.
- Cloudflare Queue hanya membawa ID job. Payload dan status tetap berada di PostgreSQL agar pesan kecil, dapat diulang secara idempoten, dan tidak menyimpan data kesehatan di antrean.
- PostgreSQL Supabase adalah sumber kebenaran dan satu-satunya tujuan tulis aplikasi. Neon menyimpan replika baca asinkron yang diperbarui lewat HTTPS untuk query berat; Rust Worker selalu memvalidasi scope dan otomatis fallback ke Supabase.
- Setiap perubahan struktur database wajib menjadi migration baru di `database/migrations`.
- Jangan menyimpan output build, cache, `.env`, `.dev.vars`, backup, atau credential ke Git.
