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

## Supabase primary dan Neon read replica

Neon dipakai sebagai replika baca asinkron untuk dashboard, daftar balita, masalah gizi, ASI eksklusif, dan ekspor pengukuran. Semua perubahan tetap masuk ke Supabase. Aplikasi otomatis kembali membaca Supabase bila Neon belum aktif atau gagal merespons. Keterlambatan replikasi dipantau secara operasional; setelah mutasi, akun penulis sementara diarahkan ke primary agar perubahan langsung terlihat.

Aktivasi dilakukan sekali setelah migration terbaru diterapkan pada Supabase:

```bash
SOURCE_DATABASE_URL='postgresql://koneksi-direct-supabase' \
NEON_DATABASE_URL='postgresql://owner-neon-direct' \
NEON_READER_DATABASE_URL='postgresql://role-baca-neon' \
npm run replica:bootstrap
```

Ketiga URL bersifat rahasia dan tidak boleh disimpan ke Git. `SOURCE_DATABASE_URL` serta `NEON_DATABASE_URL` wajib memakai koneksi direct karena dipakai untuk logical replication. `NEON_READER_DATABASE_URL` boleh memakai endpoint pooled dan menjadi satu-satunya URL database yang diberikan kepada private Neon Read Worker.

Skrip hanya mereplikasi tabel `children`, `measurements`, `mpasi_logs`, dan `eposyandu_growth_lms`. Skrip juga membuat role Worker tetap read-only, memeriksa salinan awal, dan menolak target yang sama dengan source. Pemeriksaan berikutnya dapat dijalankan tanpa membuat resource baru:

```bash
SOURCE_DATABASE_URL='postgresql://koneksi-direct-supabase' \
NEON_DATABASE_URL='postgresql://owner-neon-direct' \
NEON_READER_DATABASE_URL='postgresql://role-baca-neon' \
npm run replica:verify
```

Logical replication bersifat asinkron. Karena itu angka pada Neon dapat tertinggal sesaat. Setelah pengguna menambah, mengubah, atau menghapus data, Rust Worker memaksa pembacaan akun tersebut ke Supabase selama 30 detik agar perubahan langsung terlihat. Neon tidak boleh dipromosikan otomatis menjadi tujuan tulis.

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
