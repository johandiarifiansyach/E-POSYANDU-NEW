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

Migrasi `027_close_direct_browser_fallback.sql` mencabut RPC fallback browser lama. Setelah migrasi ini, browser wajib memakai cookie HttpOnly melalui Pages/Worker; token Supabase tidak disimpan atau dikirim oleh JavaScript aplikasi.

Migrasi `028_remove_second_step_policies.sql` membersihkan kebijakan autentikasi dua langkah lama bila versi awal migrasi 027 sempat diterapkan pada suatu environment. Migration ini tidak membuka kembali RPC browser.

Migrasi `032_native_auth_tables.sql` hanya membuat tabel persiapan autentikasi
native di PostgreSQL Oracle: credential Argon2id, session, revocation,
presence, rate limit, challenge passkey/MFA, passkey, faktor TOTP, recovery
code, dan token email. Migration ini tidak mengisi atau mengubah
`public.app_users`, sehingga role, desa, posyandu, `access_mode`, dan status
akun tetap sama. Pengisian credential dan pengalihan login dilakukan pada tahap
terpisah setelah validasi staging.

Migrasi `033_native_auth_profiles.sql` menyalin profil akun yang sudah ada ke
`public.auth_profiles` di PostgreSQL Oracle dan membuat trigger sinkronisasi
dari `public.app_users`. Supabase tetap aktif sebagai sumber identitas/login;
tidak ada akun yang dinonaktifkan atau dihapus sebelum pengujian migrasi
selesai. Nilai role, desa, posyandu, `access_mode`, dan status akun disalin
apa adanya.

Migrasi `034_native_auth_credential_dual_run.sql` menyiapkan status perpindahan
credential. Identity service masih memverifikasi password melalui Supabase,
lalu hanya setelah login berhasil menulis hash Argon2id ke
`public.auth_credentials` Oracle secara atomik bersama status `migrated`.
Kegagalan penulisan tidak memblokir login lama, dan Supabase tidak dinonaktifkan
selama tahap dual-run ini.

Setelah identity service Oracle-first diaktifkan, akun non-administrator yang
memiliki baris `auth_credentials` diverifikasi langsung di Oracle. Akun yang
belum memiliki credential tetap memakai Supabase dan otomatis di-hash ke Oracle
setelah login berhasil. Password yang salah pada credential Oracle tidak pernah
jatuh kembali ke Supabase. `super_admin` sementara tetap pada jalur Supabase
sampai verifier MFA/passkey native selesai dipindahkan, sehingga perlindungan
administrator tidak berkurang.

Pada tahap dual-run berikutnya, `ORACLE_API_NATIVE_ADMIN_CREDENTIAL_SHADOW_ENABLED`
menyimpan hash Argon2id administrator ke `auth_credentials` setelah password
berhasil diverifikasi Supabase. Ini hanya persiapan credential; `super_admin`
tetap memerlukan MFA/passkey Supabase dan belum memakai hash Oracle untuk masuk.
Jika penulisan shadow gagal, login administrator tetap berjalan seperti biasa.

Migration `035_native_admin_security_dual_run.sql` menyiapkan status dual-run
MFA/passkey administrator. Identity service hanya menyimpan jumlah dan status
metadata faktor yang dikembalikan Supabase; secret TOTP, credential passkey,
dan kunci publik tidak dicatat pada tahap ini. Verifier Supabase tetap aktif
sampai implementasi verifier native lulus uji perangkat dan uji pemulihan.

Migration `036_python_dashboard_input_projection.sql` menambahkan snapshot
input dashboard yang terproyeksi dan ter-scope di PostgreSQL. Fungsi ini hanya
menghasilkan baris mentah yang dibutuhkan Python serta hitungan teknis
(jumlah balita/baris pengukuran); status WHO, N/T/O/B, ASI, risiko, edukasi,
dan agregasi klinis tetap dihitung oleh Python.

Migration `037_python_analysis_materialized_results.sql` menambahkan antrean
outbox dan tabel `measurement_analysis`. Trigger pada seluruh tabel balita,
pengukuran, ASI/MPASI, PMT, riwayat perubahan, dan tombstone memasukkan child
yang berubah ke antrean tanpa menahan transaksi utama. Worker Python mengambil
riwayat pengukuran yang sudah tersimpan, menghitung WHO, skor-z, N/T/O/B, ASI,
risiko, edukasi, dan sinyal pertumbuhan, kemudian menyimpan hasil beserta
versi cakupan ke PostgreSQL. Pembacaan halaman Rust memakai proyeksi
`eposyandu_materialized_children_page`/`eposyandu_materialized_exclusive_breastfeeding_page`;
baris yang belum selesai ditandai `analysisPending` dan tidak diberi nilai
turunan palsu. Grafik tetap selalu dirender oleh Python melalui gRPC.

Migration `039_age_group_filters.sql` menyatukan filter kelompok umur di
PostgreSQL, Rust, Python, dashboard, seluruh tabel balita, ASI, MPASI, PMT,
masalah gizi, riwayat perubahan, recycle bin, dan ekspor SigiZI. Pilihan meliputi bayi baru lahir
(termasuk prematur), 0--5, 6, 0--11, 0--23, 6--11, 6--23, 12--23, 6--59,
12--59, 24--59, serta 0--59 bulan. Filter diterapkan sebelum paginasi agar
total dan isi halaman konsisten; umur dihitung terhadap tanggal akhir periode
laporan. Overload ekspor SigiZI menjaga cohort yang dipilih tanpa mengubah
fungsi ekspor lama selama rolling migration.

Migration `040_dashboard_asi_cohort.sql` menambahkan cohort ASI enam bulan
yang independen dari filter umur dashboard. Dengan demikian pembanding `S`
ASI selalu seluruh balita aktif berusia tepat 6 bulan dalam wilayah yang
diizinkan, sementara Python menentukan numerator `Ya` dari riwayat jawaban
ASI yang tersedia (termasuk balita tanpa penimbangan antropometri). Proyeksi
juga mengirim riwayat ASI ringkas agar klasifikasi progresif 0--6 bulan tetap
akurat tanpa memuat seluruh riwayat ke browser.

Migration `041_age_group_59_and_mpasi_fixed_cohort.sql` mengganti seluruh
cohort umum yang sebelumnya berakhir pada 60 bulan menjadi berakhir pada 59
bulan. WHO tetap memakai referensi pertumbuhan 0--60 bulan untuk perhitungan
dan grafik. Filter umur pada halaman MPASI dihapus dari UI dan API memaksa
cohort program 6--23 bulan; halaman ASI hanya menerima cohort 0--5 bulan atau
tepat 6 bulan.

Migration `042_read_snapshot_fallback.sql` menambahkan pembacaan snapshot
dashboard terakhir untuk jalur fallback Rust. Jika versi cakupan terbaru
belum selesai diproses Python atau layanan analisis sedang tidak tersedia,
Rust tetap mengembalikan hasil persisten terakhir dengan penanda `snapshotStale`
agar UI dapat memberi tahu pengguna; snapshot lama tidak menggantikan proses
penyegaran Python.

Migration `043_incremental_analysis_fingerprints.sql` menambahkan kontrak
`input_hash` dan `source_version` pada `measurement_analysis`. Worker Python
memakai hash per pengukuran untuk melewati WHO/ML yang inputnya identik,
mempertahankan `analysis_version` untuk replay idempoten, dan hanya menghapus
baris yang memang tidak lagi memiliki pengukuran valid. Versi sumber mencakup
child, riwayat pengukuran, ASI/MPASI, dan PMT child tersebut sehingga perubahan
tercatat tanpa menginvalidasi anak lain.

Migration `044_read_path_indexes.sql` mengoptimalkan jalur baca Rust tanpa
mengubah sumber kebenaran Python. PostgreSQL menambah indeks partial untuk
daftar balita aktif, indeks urutan/pencarian nama, indeks lookup pengukuran dan
MPASI per child, indeks riwayat/PMT, serta indeks versi hasil
`measurement_analysis` dan periode `dashboard_analysis`. Semua halaman tetap
wajib memakai `page`/`size`; tabel hasil Python dan snapshot dashboard dibaca
langsung oleh Rust melalui query terparameterisasi. Planner PostgreSQL hanya
diberi `ANALYZE` setelah indeks dibuat—tidak ada perhitungan WHO ulang pada
migrasi.

Migration `045_fix_materialized_children_page_total.sql` memperbaiki fallback
`total` pada fungsi halaman materialized. Nilai JSONB kini memakai fallback
JSONB yang benar, sehingga fungsi tidak gagal saat dipanggil dan Rust dapat
membaca hasil status gizi Python tanpa menandai seluruh halaman sebagai
`analysisPending`.

Migration `048_postgres_hot_path_maintenance.sql` menambahkan indeks partial
untuk cohort balita aktif, program PMT aktif, serta antrean analisis pending dan
processing. Migration ini juga menurunkan ambang autovacuum pada tabel yang
sering berubah. PostgreSQL tetap menjalankan autovacuum otomatis; pada host
Oracle, timer `eposyandu-postgresql-maintenance.timer` menjalankan `VACUUM
(ANALYZE)` pada tabel hasil/antrean setiap jam agar bloat dan statistik planner
tetap terkendali.

Sebelum menambah indeks atau mengubah query produksi, ukur query jalur panas di
staging dengan `EXPLAIN (ANALYZE, BUFFERS)`. Jangan menjalankan `EXPLAIN
ANALYZE` pada mutasi atau endpoint yang dapat memproses seluruh populasi tanpa
batas karena perintah tersebut benar-benar mengeksekusi query.

Pooler PostgreSQL bersifat opsional. Semua service sudah memakai pool koneksi
berbatas (`ORACLE_DATABASE_POOL_SIZE`, default 5), sehingga untuk ukuran saat
ini PgBouncer belum diperlukan. Jika jumlah instance atau koneksi idle mulai
mendekati `max_connections`, pasang PgBouncer pada jaringan privat lalu arahkan
`ORACLE_DATABASE_URL` ke listener PgBouncer; pool aplikasi tetap dipertahankan
dan mode transaction pooling hanya boleh dipakai setelah seluruh transaksi
aplikasi tidak bergantung pada session state.

Partitioning pengukuran belum diaktifkan karena volume saat ini masih sekitar
30 ribu baris. Partitioning baru dipertimbangkan ketika tabel mencapai jutaan
baris dan query rentang waktu menunjukkan sequential scan/bloat. Migrasi tersebut
harus dibuat sebagai proyek terpisah: buat tabel partitioned baru, salin data
bertahap, validasi foreign key dan fungsi Python, lalu lakukan cutover yang
dapat di-rollback—bukan mengubah tabel production secara langsung.

Migration `049_analysis_outbox_notify.sql` memasang trigger `AFTER INSERT` pada
`analysis_outbox` yang mengirim `pg_notify` ke channel
`e_posyandu_analysis_outbox` setelah transaksi sumber berhasil commit. Rust
analysis-worker mendengarkan channel ini untuk membangunkan scheduler; polling
interval tetap dipakai sebagai safety-net ketika koneksi LISTEN belum tersedia.
Satu wake memproses batch job terbatas (`ANALYSIS_PERSISTENCE_BATCH_SIZE`,
default 8). Kegagalan memakai exponential backoff 2, 4, 8, 16, hingga maksimum
300 detik sebelum dead-letter setelah lima percobaan.

Penulisan snapshot dashboard dari RPC Python tidak menghambat request. Hasil
agregasi dimasukkan ke antrean worker berbatas dan ditulis ke
`dashboard_analysis` secara asinkron; kegagalan koneksi dicoba ulang secara
terbatas. Jika antrean sedang penuh, respons kalkulasi tetap dikirim dan
snapshot akan diperbarui pada permintaan berikutnya.

ASI eksklusif diproses Python sebagai konteks progresif: usia 0 bulan tanpa
jawaban dicatat sebagai `Ya`, jawaban `Ya` pada bulan berikutnya mengisi
bulan-bulan sebelumnya secara turunan, sedangkan jawaban `Tidak` eksplisit
tetap menang. Status lengkap tetap memerlukan seluruh rentang 0--6 bulan
terisi `Ya`; usia dan konteks turunannya disimpan pada `measurement_analysis`.

Migrasi `050` dan `051` menyelaraskan agregat dashboard dengan tabel balita.
Dashboard membaca fungsi `eposyandu_dashboard_materialized_stats` yang memakai
kelompok umur, periode, lokasi, dan baris pengukuran terbaru yang sama dengan
proyeksi tabel. Nilai klinis (status gizi, kenaikan berat badan, dan ASI) tetap
berasal dari `measurement_analysis` yang ditulis Worker Python; PostgreSQL
hanya melakukan agregasi baca sehingga snapshot lama tidak menimpa perubahan
terbaru.

Migrasi `052` menyamakan pembilang kartu ASI eksklusif dengan tabel ASI. Tabel
menentukan kelompok 6 bulan pada tanggal penimbangan di dalam bulan laporan,
sehingga dashboard memakai baris pengukuran positif dari cohort yang sama
(termasuk bila ada dua kunjungan tercatat); denominator kartu tetap seluruh
anak yang berusia tepat 6 bulan pada akhir bulan laporan.

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
