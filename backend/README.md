# Backend

Folder ini dipisahkan dari frontend React TSX.

Isi utama:
- `src/server.mjs` untuk API/backend ringan.
- `scripts/migrate/` untuk export, import, dan verifikasi migrasi Firebase ke Supabase.
- `supabase/schema.sql` untuk schema database.

Jalankan backend:

```bash
cd backend
npm install
npm run dev
```

Jalankan skrip migrasi dari root repo atau dari folder ini dengan environment yang sesuai.
