# Migrasi PostgreSQL

Folder `migrations` adalah sumber resmi struktur database E-Posyandu. Jalankan berkas sesuai nomor, satu kali, dan jangan mengubah migrasi yang sudah diterapkan di production.

## Urutan penerapan

1. Buat backup database.
2. Terapkan migrasi di staging dari `001_native_schema.sql` sampai migrasi terbaru.
3. Jalankan pemeriksaan SQL di bawah.
4. Uji login, tambah balita, penimbangan, edit, hapus, dan sinkronisasi offline.
5. Terapkan migrasi yang sama di production sebelum Worker baru diterbitkan.

Migrasi `010_sync_versioning_and_audit.sql` menambahkan nomor versi data, audit backend, dan tabel `schema_migrations`. Migrasi ini wajib selesai sebelum Worker yang memiliki endpoint `POST /api/v1/sync` digunakan.

Migrasi `011_operational_audit.sql` menambahkan metadata audit, audit login dan ekspor, serta trigger perubahan role/wilayah akun. Terapkan melalui `DATABASE_URL='...' npm run db:migrate`; script akan melewati versi yang sudah tercatat.

Migrasi `012_pmt_baseline_measurements.sql` menyimpan tanggal, berat, dan tinggi awal program PMT agar evaluasi mingguan tidak berubah ketika data balita diperbarui.

## Pemeriksaan

```sql
select version, description, applied_at
from public.schema_migrations
order by version;

select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and column_name = 'version'
order by table_name;

select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('children', 'measurements', 'mpasi_logs', 'pmt_programs', 'audit_events');
```

Tabel aplikasi hanya diberikan kepada `service_role`. Peran `anon` dan `authenticated` tidak menerima grant tabel, sehingga browser wajib melewati Rust Worker. Kebijakan RLS tetap dipertahankan sebagai lapisan keamanan tambahan.

## Aturan migrasi berikutnya

- Buat berkas baru dengan nomor berurutan dan bungkus perubahan dalam `begin`/`commit`.
- Gunakan `if exists` atau `if not exists` bila aman agar pemulihan mudah diperiksa.
- Tambahkan baris versi baru ke `schema_migrations` pada akhir transaksi.
- Jangan menyimpan password, URL database, atau key Supabase di SQL.
- Perubahan destruktif harus diuji di staging dan memiliki rencana backup/pemulihan.
