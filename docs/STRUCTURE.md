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
│       └── lib.rs           Entry point Worker, auth, keamanan, dan routing
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
- Setiap perubahan struktur database wajib menjadi migration baru di `database/migrations`.
- Jangan menyimpan output build, cache, `.env`, `.dev.vars`, backup, atau credential ke Git.
