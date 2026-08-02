# Peta Produksi Cloudflare

## Kondisi produksi

| Area | Pemilik | Status |
| --- | --- | --- |
| Frontend native TypeScript/HTML5/CSS | Cloudflare Pages | Produksi |
| Login, profil, CRUD, dashboard, tabel, ASI, ekspor | Rust Cloudflare Worker | Produksi |
| PostgreSQL dan Supabase Auth | Supabase | Sumber data tunggal |
| Kalkulasi status gizi dan agregasi dashboard | PostgreSQL RPC dipanggil Worker | Produksi |

## Aturan utama

1. Browser hanya berbicara ke Cloudflare Worker. Secret Key Supabase tidak pernah dikirim ke browser.
2. Worker membatasi kader pada desa dan posyandu akun, desa pada wilayahnya, dan gizi dapat memakai filter desa serta posyandu.
3. Halaman balita dan ASI mengambil maksimal 10 data. Pencarian dilakukan setelah tombol Cari ditekan.
4. Ekspor adalah pengecualian yang disengaja: seluruh data hanya dikirim setelah pengguna memilih ekspor, tetap dengan batasan akses wilayah.

## Rilis berikutnya

1. Jalankan `cargo test` di `backend-rust-worker` setelah mengubah API.
2. Jalankan `npm run worker:deploy` untuk menerbitkan Worker bila API berubah.
3. Jalankan `npm run pages:deploy` untuk menerbitkan frontend bila tampilan atau TypeScript berubah.
4. Uji akun kader, desa, dan gizi setelah perubahan akses atau query data.
