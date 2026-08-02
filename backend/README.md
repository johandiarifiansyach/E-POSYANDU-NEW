# E-Posyandu Cloudflare Worker

API produksi E-Posyandu berjalan sebagai Cloudflare Worker berbasis Rust. Frontend native HTML5, CSS, dan TypeScript berada di Cloudflare Pages; PostgreSQL dan Supabase Auth tetap menjadi sumber data tunggal.

Alamat produksi:

- Frontend: `https://e-posyandu.pages.dev`
- API: `https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev`

## Prinsip hemat limit

- Tidak ada polling atau realtime.
- CORS preflight dijawab di edge tanpa panggilan ke Supabase.
- Daftar Balita dan ASI Eksklusif memakai pagination maksimal 10 data serta pencarian manual.
- Dashboard dihitung oleh fungsi PostgreSQL dan mengirim angka ringkasan, bukan seluruh data balita.
- Ringkasan dashboard yang sama dicache di Cloudflare Cache API selama 60 detik. Versi invalidasi disimpan di KV dan dinaikkan setiap ada perubahan data.
- Perubahan offline dikirim maksimal 25 item melalui `POST /api/v1/sync`; pengambilan delta memakai cursor `updated_at` dan tombstone penghapusan.
- Setiap mutasi memakai idempotency key, optimistic version, request ID, dan audit backend.
- Ekspor mengambil seluruh data hanya setelah pengguna meminta ekspor dan tetap dibatasi desa/posyandu sesuai peran.
- Endpoint internal `POST /internal/v1/nutrition/batch` tetap tersedia bila kelak diperlukan oleh layanan lain dan wajib memakai HMAC-SHA256.

## Penyimpanan Data

| Layanan | Tugas | Jenis data |
| --- | --- | --- |
| Supabase PostgreSQL | Sumber data utama | Balita, penimbangan, ASI, PMT, akun, dan audit |
| Cloudflare Cache API | Cache ringkasan | Angka dashboard tanpa identitas balita, diisolasi per cakupan dan maksimal 60 detik |
| Cloudflare KV | Metadata cache dan feature flag | Versi invalidasi dashboard dan konfigurasi fitur tanpa token atau hak akses pengguna |
| Upstash Redis | Pembatas login lintas Worker | Hash IP, username, dan pasangan IP-akun dengan masa 1-10 menit |
| Cloudflare R2 | Berkas privat | Foto dan dokumen bila fitur unggah lampiran ditambahkan |

Data medis per balita tidak dicache di KV atau Redis, dan tidak dipindahkan ke R2. PostgreSQL tetap menjadi sumber kebenaran.

## Migrasi Database

SQL produksi berada di [`../database/migrations`](../database/migrations). Jalankan berurutan dari `001` sampai `011` dengan `npm run db:migrate`. Berkas yang sudah dijalankan menjadi riwayat skema dan tidak diubah lagi. Migrasi `009_security_hardening.sql` menutup akses tabel dari browser, `010_sync_versioning_and_audit.sql` menambahkan versioning dan registri migrasi, sedangkan `011_operational_audit.sql` melengkapi audit login, ekspor, dan perubahan role.

Kontrak REST API dapat dibuka pada `GET /api/v1/openapi.json`. Health check tersedia pada `GET /api/v1/health` dan tidak membaca tabel balita, sehingga pemeriksaan rutin tidak menambah egress data medis.

### Mengaktifkan Redis

Buat database Redis di Upstash, lalu masukkan kedua nilai REST API sebagai Cloudflare Worker Secret. Nilainya tidak boleh masuk ke frontend atau Git.

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Tanpa kedua secret tersebut, login tetap berjalan dengan pembatas lokal. Setelah diisi, pembatas login otomatis memakai Redis.

### Mengaktifkan R2

1. Pada Cloudflare Dashboard buka **R2 Object Storage**, setujui aktivasi, lalu buat bucket privat bernama `e-posyandu-files`.
2. Buka komentar `[[r2_buckets]]` pada `wrangler.toml`.
3. Deploy ulang Worker dengan `npm run worker:deploy`.

R2 sengaja belum menerima unggahan dari halaman aplikasi karena E-Posyandu saat ini belum memiliki formulir foto atau dokumen. Binding dan penamaan bucket sudah disiapkan agar fitur lampiran berikutnya dapat ditambahkan tanpa mengubah penyimpanan data utama.

## Menjalankan lokal

```bash
cd backend
cp .dev.vars.example .dev.vars
rustup target add wasm32-unknown-unknown
cargo install worker-build
npx wrangler dev
```

Build memakai mode Worker standar. Kesalahan API ditangani sebagai respons JSON sehingga tidak memerlukan panic recovery pada runtime.

## Secret Cloudflare

Jalankan perintah berikut dari folder ini. Nilai secret akan diminta oleh terminal dan tidak dicatat di Git.

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

`SUPABASE_SECRET_KEY` adalah Secret Key dari Supabase Settings > API Keys. Jangan menggunakan publishable key untuk nilai ini dan jangan menaruhnya di frontend. Secret sudah disimpan pada Cloudflare Worker; file ini hanya menjelaskan cara menggantinya bila diperlukan.

## Deploy bertahap

```bash
npx wrangler deploy
```

Setelah mengubah Worker, jalankan `npm run worker:deploy` dari root proyek. Gunakan `cargo test` sebelum deploy. Rilis staging memakai `npm run worker:deploy:staging`; setiap secret staging wajib dimasukkan dengan opsi `--env staging`.

## Deploy frontend

```bash
npm run pages:deploy
```

Perintah tersebut membangun frontend dengan URL API Worker lalu menerbitkan aset ke proyek Cloudflare Pages `e-posyandu`. Hostname `e-posyandu.pages.dev` harus tetap tercantum di widget Turnstile dan variabel `CORS_ORIGINS` Worker.
