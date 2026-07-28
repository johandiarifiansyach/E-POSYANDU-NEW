# FastAPI + PostgreSQL Native

Backend ini menggantikan akses langsung frontend ke Supabase. Data disimpan pada tabel PostgreSQL relasional:

- `children`
- `measurements`
- `mpasi_logs`
- `pmt_programs` dan `pmt_monitorings`
- `change_logs` dan `change_log_entries`

Frontend tetap memakai antrean IndexedDB saat offline. Saat koneksi kembali, perubahan dikirim ke FastAPI. WebSocket `/api/v1/realtime` memberi tahu pengguna lain untuk memuat ulang tabel yang berubah.

## Persiapan

1. Salin `.env.example` menjadi `.env` di folder ini.
2. Isi `DATABASE_URL` dengan URL PostgreSQL dari menu **Connect** Supabase. URL biasa yang diawali `postgresql://` dapat langsung digunakan.
3. Jalankan isi `sql/001_native_schema.sql` sekali di Supabase SQL Editor.
4. Buat virtual environment dan pasang dependensi:

```bash
cd backend-python
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Cutover Sekaligus

Jalankan ketika input baru dihentikan sementara. Tabel lama `documents` tidak dihapus sehingga tetap menjadi rollback dan arsip.

```bash
cd backend-python
.venv/bin/python -m app.migrate_documents
.venv/bin/python -m app.verify_migration
```

Verifikasi harus menampilkan jumlah yang sama untuk `children`, `measurements`, `mpasi_logs`, `pmt_programs`, dan `change_logs`. Data riwayat yang merujuk balita yang telah dihapus permanen tetap dipindahkan sebagai arsip dan tidak muncul pada daftar balita aktif.

Empat tanggal lahir dan empat tanggal pengukuran lama yang tidak valid tetap disimpan dalam kolom `*_date_raw`; data tersebut dapat diperbaiki dari aplikasi tanpa kehilangan nilai awalnya.

## Menjalankan Lokal

```bash
cd backend-python
.venv/bin/uvicorn app.main:app --reload --port 8000
```

API health check tersedia di `http://localhost:8000/api/health` dan dokumentasi API di `http://localhost:8000/docs`.

Vite otomatis meneruskan `/api` dan WebSocket ke `localhost:8000` ketika `VITE_API_URL` tidak diisi.

## Deploy Produksi

Deploy folder `backend-python` sebagai Docker web service pada penyedia yang mendukung WebSocket. `Dockerfile`, `Procfile`, dan `render.yaml` sudah tersedia. Set environment berikut pada layanan backend:

```text
DATABASE_URL=postgresql://...
CORS_ORIGINS=https://delicate-lolly-9a37f0.netlify.app
```

Setelah endpoint `/api/health` backend dapat diakses, set variabel environment Netlify berikut lalu deploy ulang frontend:

```text
VITE_API_URL=https://alamat-api-anda.example.com
```

Jangan deploy build frontend baru sebelum `VITE_API_URL` menunjuk ke FastAPI yang sehat. Build Netlify yang sedang aktif tetap menggunakan Supabase sampai cutover ini dilakukan.

## Pengujian

```bash
cd backend-python
.venv/bin/python -m unittest discover -s tests -v
```

## Keamanan

Mekanisme login aplikasi saat ini masih berupa pemilihan peran lokal, sama seperti sebelum migrasi. Sebelum API dibuka untuk penggunaan publik, tambahkan akun kader/bidan/gizi dan autentikasi berbasis token agar peran tidak dapat dipilih bebas dari browser.
