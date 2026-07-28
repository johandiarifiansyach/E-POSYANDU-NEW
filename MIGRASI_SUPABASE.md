# Migrasi Firebase ke Supabase (Tanpa Kehilangan Data)

Dokumen ini menjelaskan migrasi Firestore ke Supabase dengan strategi aman:
1. Export semua koleksi dari Firestore.
2. Import ke Supabase.
3. Verifikasi jumlah data.
4. Cutover frontend ke Supabase.

## 1) Persiapan

1. Buat project Supabase baru.
2. Jalankan SQL schema di Supabase SQL Editor:
   - `backend/supabase/schema.sql`
3. Salin `.env.example` menjadi `.env` lalu isi nilai yang sesuai.
4. Simpan service account Firebase sebagai file JSON lokal (contoh: `./secrets/firebase-service-account.json`).

## 2) Export dari Firestore

Perintah:

```bash
npm run migrate:export
```

Skrip akan otomatis mendeteksi semua sub-koleksi di path:
- `artifacts/<FIREBASE_APP_ID>/public/data/*`

Jika ingin membatasi hanya koleksi tertentu, set env opsional:

```bash
FIRESTORE_COLLECTIONS=children,measurements npm run migrate:export
```

Output default ada di:
- `migration-data/firestore-export/children.json`
- `migration-data/firestore-export/measurements.json`
- `migration-data/firestore-export/mpasi_logs.json`
- `migration-data/firestore-export/pmt_programs.json`
- `migration-data/firestore-export/change_logs.json`
- `migration-data/firestore-export/summary.json`

## 3) Import ke Supabase

Perintah:

```bash
npm run migrate:import
```

Import bersifat idempotent dengan `upsert`, jadi aman dijalankan ulang.

## 4) Verifikasi Data

Perintah:

```bash
npm run migrate:verify
```

Skrip memeriksa jumlah dokumen per koleksi antara hasil export dan tabel `documents` di Supabase.

## 5) Cutover Aplikasi

Aplikasi frontend sekarang memakai adapter Supabase kompatibel Firestore API:
- `src/lib/supabaseCompat.ts`
- `src/App.tsx`

Backend terpisah ada di:
- `backend/src/server.mjs`
- `backend/scripts/migrate/`
- `backend/supabase/schema.sql`

Pastikan env frontend terisi:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Lalu jalankan:

```bash
npm run dev
```

## 6) Strategi No-Data-Loss yang Disarankan

1. Freeze write singkat: hentikan input baru 5-10 menit sebelum cutover.
2. Jalankan lagi `migrate:export` dan `migrate:import` untuk delta terakhir.
3. Jalankan `migrate:verify`.
4. Aktifkan aplikasi yang sudah pakai Supabase.
5. Simpan backup folder `migration-data/firestore-export` sebagai arsip rollback.

## Catatan Penting

- Adapter melakukan polling setiap 3 detik untuk mensimulasikan listener real-time.
- Data disimpan pada tabel `documents` sebagai JSONB per koleksi untuk menjaga fleksibilitas skema Firestore.
- Jika ingin performa lebih tinggi, fase berikutnya adalah normalisasi ke tabel khusus (`children`, `measurements`, dst) setelah cutover stabil.
