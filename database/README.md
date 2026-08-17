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

Migrasi `013_align_dashboard_child_total.sql` menyamakan tanggal acuan umur dashboard dan daftar balita pada hari terakhir bulan laporan, sehingga nilai S selalu sesuai jumlah balita aktif usia 0-59 bulan.

Migrasi `014_unify_dashboard_report_counts.sql` menyatukan relasi balita lama dan baru, pemilihan penimbangan bulanan terbaru, cakupan wilayah, serta aturan umur untuk dashboard, daftar masalah gizi, dan ASI eksklusif. Daftar masalah gizi dihitung dan dipaginasi di PostgreSQL agar angka total sama dengan dashboard tanpa membaca seluruh data ke browser.

Migrasi `015_background_grpc_jobs.sql` menambahkan tabel status pekerjaan berat untuk Cloudflare Queue dan gRPC. Payload dan hasil hanya dapat dibaca `service_role`, dilindungi RLS, memakai idempotency key, memiliki masa berlaku, dan dicatat dalam audit operasional.

Migrasi `020_read_replica_children_page.sql` menambahkan fungsi baca terpaginasikan untuk replika Neon. Fungsi ini hanya menerima konteks role dan wilayah yang sudah divalidasi Rust Worker; fungsi tidak dapat menulis data. Supabase tetap menjadi primary dan satu-satunya tujuan autentikasi, CRUD, audit, serta sinkronisasi offline.

Migrasi `027_require_mfa_aal2.sql` menambahkan kebijakan RLS restriktif AAL2 dan mencabut RPC fallback browser lama. Setelah migrasi ini, browser wajib memakai cookie HttpOnly melalui Pages/Worker; token Supabase tidak disimpan atau dikirim oleh JavaScript aplikasi.

## Supabase primary dan Neon read replica

Neon dipakai sebagai replika baca asinkron untuk dashboard, daftar balita, masalah gizi, ASI eksklusif, dan ekspor pengukuran. Semua perubahan tetap masuk ke Supabase. Aplikasi otomatis kembali membaca Supabase bila Neon belum aktif atau gagal merespons. Keterlambatan replikasi dipantau secara operasional; setelah mutasi, akun penulis sementara diarahkan ke primary agar perubahan langsung terlihat.

Aktivasi dilakukan sekali setelah migration terbaru diterapkan pada Supabase:

```bash
SOURCE_DATABASE_URL='postgresql://session-pooler-supabase-port-5432' \
NEON_DATABASE_URL='postgresql://owner-neon-direct' \
NEON_READER_DATABASE_URL='postgresql://role-baca-neon' \
npm run replica:bootstrap
```

Ketiga URL bersifat rahasia dan tidak boleh disimpan ke Git. `SOURCE_DATABASE_URL` disarankan memakai **Session Pooler Supabase port 5432** agar komputer tanpa koneksi IPv6 tetap dapat membuat snapshot. Jangan memakai Transaction Pooler port 6543. `NEON_DATABASE_URL` memakai koneksi direct milik owner, sedangkan `NEON_READER_DATABASE_URL` boleh memakai endpoint pooled dan digunakan private Neon Read Worker untuk query laporan.

Skrip hanya menyalin tabel `children`, `measurements`, `mpasi_logs`, dan `eposyandu_growth_lms`. Skrip juga menyiapkan state sinkronisasi, fungsi internal dengan allowlist, membuat role query tetap read-only, memeriksa snapshot awal, dan menolak target yang sama dengan source. Setelah bootstrap, private Worker mengambil perubahan `children`, `measurements`, `mpasi_logs`, serta tombstone penghapusan melalui HTTPS setiap lima menit. Tidak ada publication, replication slot, atau subscription antardatabase.

Isi secret private Worker setelah snapshot:

```bash
cd services/neon-read-worker
npx wrangler secret put NEON_DATABASE_URL
npx wrangler secret put NEON_SYNC_DATABASE_URL
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put READ_REPLICA_SHARED_SECRET
npm run deploy
```

`NEON_DATABASE_URL` wajib memakai role baca. `NEON_SYNC_DATABASE_URL` memakai role owner dan hanya tersimpan di Worker privat. `SUPABASE_SECRET_KEY` adalah secret key backend, bukan publishable key. Pemeriksaan berikutnya dapat dijalankan tanpa membuat resource baru:

```bash
SOURCE_DATABASE_URL='postgresql://session-pooler-supabase-port-5432' \
NEON_DATABASE_URL='postgresql://owner-neon-direct' \
NEON_READER_DATABASE_URL='postgresql://role-baca-neon' \
npm run replica:verify
```

Sinkronisasi HTTPS bersifat asinkron. Karena itu angka pada Neon dapat tertinggal paling lama sekitar lima menit. Setelah pengguna menambah, mengubah, atau menghapus data, Rust Worker memaksa pembacaan akun tersebut ke Supabase selama enam menit agar perubahan langsung terlihat. Neon tidak boleh dipromosikan otomatis menjadi tujuan tulis aplikasi.

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
  and relname in ('children', 'measurements', 'mpasi_logs', 'pmt_programs', 'audit_events', 'background_jobs');
```

Tabel aplikasi hanya diberikan kepada `service_role`. Peran `anon` dan `authenticated` tidak menerima grant tabel, sehingga browser wajib melewati Rust Worker. Kebijakan RLS tetap dipertahankan sebagai lapisan keamanan tambahan.

## Aturan migrasi berikutnya

- Buat berkas baru dengan nomor berurutan dan bungkus perubahan dalam `begin`/`commit`.
- Gunakan `if exists` atau `if not exists` bila aman agar pemulihan mudah diperiksa.
- Tambahkan baris versi baru ke `schema_migrations` pada akhir transaksi.
- Jangan menyimpan password, URL database, atau key Supabase di SQL.
- Perubahan destruktif harus diuji di staging dan memiliki rencana backup/pemulihan.
