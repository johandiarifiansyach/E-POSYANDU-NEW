# Rencana Migrasi Cloudflare dan PostgreSQL Oracle

Status: **Rencana — jangan dieksekusi tanpa persetujuan pada jadwal hari libur**

Dokumen ini menyimpan gambaran migrasi bertahap. Dokumen ini bukan instruksi
untuk menjalankan deployment, menghapus database, atau mengubah layanan
production saat ini.

## Tujuan akhir

- Frontend dilayani oleh Cloudflare Pages.
- Backend Rust tetap berjalan di Oracle melalui Cloudflare Tunnel/WAF.
- PostgreSQL Oracle menjadi satu-satunya database utama untuk data aplikasi.
- Neon dan tabel aplikasi Supabase menjadi replika read-only untuk mengurangi
  beban pembacaan pada Oracle.
- OCI Object Storage menyimpan backup; replika tidak dianggap sebagai pengganti
  backup.

## Tahap 1 — Memindahkan frontend ke Cloudflare

Topologi sementara:

```text
Cloudflare Pages
       |
Cloudflare Tunnel/WAF
       |
Backend Rust Oracle
       |
Supabase primary --> Neon read-only
```

Ruang lingkup tahap ini:

1. Memindahkan frontend ke Cloudflare Pages tanpa mengubah database utama.
2. Menyesuaikan domain API, same-origin proxy, CORS, cookie sesi, CSP, dan HTTPS.
3. Menguji login, logout otomatis, CRUD, penimbangan, identitas bayi, laporan,
   ekspor, serta perilaku desktop dan seluler.
4. Mempertahankan PostgreSQL read-only Oracle lama sebagai jalur rollback sampai
   tahap ini dinyatakan stabil.

Gerbang kelulusan:

- Frontend dan API sehat selama periode observasi yang disepakati.
- Cookie/sesi tetap first-party dan login tidak mengalami regresi.
- Tidak ada ketergantungan produksi yang belum teridentifikasi pada frontend
  Oracle lama.

## Tahap 2 — Menghapus replika lama Oracle

Topologi sementara:

```text
Cloudflare Pages --> Backend Rust Oracle --> Supabase primary
                                               |
                                               +--> Neon read-only
```

Urutan aman:

1. Memastikan Supabase tetap menjadi satu-satunya database writable.
2. Memastikan pembacaan berat yang sesuai sudah dapat diarahkan ke Neon.
3. Menghentikan dan menonaktifkan job/timer snapshot PostgreSQL read-only
   Oracle.
4. Membuat dump terakhir, memverifikasinya, dan menyimpannya di lokasi backup.
5. Mengamati production tanpa replika Oracle selama masa validasi.
6. Menghapus database/volume replika lama hanya setelah rollback tidak lagi
   memerlukannya dan ada persetujuan eksplisit.

Supabase dan Neon tidak boleh sama-sama menerima penulisan pada tahap ini.
Supabase adalah primary sementara; Neon hanya melayani pembacaan yang dapat
menerima replication lag.

## Tahap 3 — Oracle menjadi database utama

Topologi akhir yang direncanakan:

```text
Cloudflare Pages
       |
Cloudflare Tunnel/WAF
       |
Backend Rust Oracle
       |
PostgreSQL Oracle PRIMARY
       |-- logical replication --> Neon READ ONLY
       +-- logical replication --> Supabase READ ONLY (tabel aplikasi)

PostgreSQL Oracle --> backup --> OCI Object Storage
```

Urutan tingkat tinggi:

1. Menambahkan OCI Block Volume terpisah dengan kapasitas dan performa yang
   memadai; primary baru tidak ditempatkan pada sisa root disk yang sempit.
2. Membuat PostgreSQL primary baru tanpa menimpa replika/backup lama.
3. Menyalin skema lengkap dan data dari Supabase, termasuk sequence, function,
   trigger, indeks, dan kebijakan akses yang masih diperlukan.
4. Mengubah backend Rust dari akses Supabase Data API menjadi koneksi PostgreSQL
   Oracle langsung dengan connection pool terbatas.
5. Menjalankan validasi data dan dual-read, kemudian write freeze singkat untuk
   sinkronisasi akhir dan cutover.
6. Mengaktifkan logical replication dari Oracle ke Neon dan ke tabel aplikasi
   terpilih di Supabase.
7. Mengarahkan laporan/query berat ke replika, sementara operasi tulis dan
   pembacaan yang harus langsung konsisten tetap menuju Oracle.
8. Menjalankan backup, restore drill, observasi, dan masa rollback sebelum
   membersihkan sumber lama.

## Pembagian beban setelah migrasi

| Tujuan | Database |
| --- | --- |
| Tambah, ubah, dan hapus data | Oracle primary |
| Pembacaan tepat setelah penulisan | Oracle primary |
| Laporan, statistik, dan ekspor berat | Neon read-only |
| Pembacaan umum yang boleh tertunda | Supabase read-only |
| Backup terjadwal dan pemulihan | OCI Object Storage |

Backend harus memilih jalur baca secara eksplisit. Keberadaan replika tidak
mengurangi beban Oracle jika seluruh query masih diarahkan ke primary.

## Pengecualian Supabase Auth

Selama Supabase Auth masih digunakan, project Supabase tidak sepenuhnya
read-only: layanan Auth tetap menulis pengguna, token, dan sesi pada skema
`auth`. Yang dibuat read-only pada tahap awal adalah tabel data aplikasi.

Ada dua pilihan untuk tahap lanjutan:

1. Supabase Auth tetap writable, sedangkan tabel aplikasi Supabase hanya
   menerima replikasi dan akses baca; atau
2. autentikasi dipindahkan ke Oracle agar seluruh database Supabase benar-benar
   read-only.

Pilihan autentikasi harus diputuskan dan diuji terpisah sebelum cutover tahap 3.

## Pengamanan dan rollback wajib

- Tidak menjalankan migrasi pada hari pelayanan aktif.
- Menetapkan jadwal, penanggung jawab, jendela pemeliharaan, dan kriteria batal.
- Menyediakan dump tervalidasi dan melakukan restore drill sebelum penghapusan.
- Tidak menghapus database lama pada hari yang sama dengan cutover.
- Menjaga hanya satu database writable pada setiap tahap.
- Memantau replication lag; replika tidak dipakai untuk read-after-write.
- Menerapkan perubahan DDL dan sinkronisasi sequence secara terkoordinasi karena
  logical replication tidak menanganinya secara otomatis.
- Menyiapkan prosedur mengembalikan frontend, backend, dan database ke kondisi
  tahap sebelumnya.

## Kondisi sebelum pelaksanaan

Rencana ini awalnya hanya disimpan untuk pelaksanaan pada hari libur. Catatan
pelaksanaan di bawah memperbarui status dokumen setelah ketiga tahap dijalankan.
Oracle kini menjadi primary writable untuk data inti; Supabase Auth dan jalur
job Queue/R2 masih dipertahankan selama masa transisi serta rollback.

## Catatan pelaksanaan tahap 1 — 24 Agustus 2026

Tahap pertama mulai dijalankan tanpa menyentuh database:

- Frontend production berhasil dibuild dan dipublikasikan ke project Pages
  `e-posyandu`.
- Deployment production dapat diakses melalui `e-posyandu.pages.dev` dan
  custom domain utama `eposyandu.app`.
- Proxy same-origin `/api/health` berhasil meneruskan request ke Oracle API dan
  mengembalikan status sehat.
- Nameserver authoritative sudah beralih ke Cloudflare dan record apex
  `eposyandu.app` diarahkan ke Pages; binding custom domain apex sudah aktif.
- Binding `www.eposyandu.app` sudah ditambahkan dan endpoint-nya merespons
  frontend Pages; validasi sertifikatnya masih dapat berstatus `pending` selama
  propagasi.
- Record `api.eposyandu.app` tetap menunjuk ke backend Oracle.
- Database Supabase dan database primary belum diubah.

Record email (`MX`, `TXT`, SPF/DKIM/DMARC) harus tetap dipelihara di zone
Cloudflare jika domain dipakai untuk email.

## Catatan pelaksanaan tahap 2 — 24 Agustus 2026

- Sinkronisasi standby dihentikan dan timer-nya dinonaktifkan.
- Dump custom PostgreSQL standby terenkripsi AES-256 dibuat, diverifikasi
  dengan `pg_restore --list`, dan diunggah ke Object Storage.
- Container, volume data, unit systemd, runtime secret, konfigurasi standby,
  serta executable sinkronisasi dihapus dari Oracle.
- Tiga OCID secret standby dihapus dari konfigurasi Vault host. Secret object
  OCI tidak dihapus otomatis karena penghapusan resource Vault adalah operasi
  terpisah yang tidak diperlukan untuk menghentikan database standby.

## Catatan pelaksanaan tahap 3 — 25 Agustus 2026

- OCI Block Volume 50 GB diformat XFS dan dipasang permanen di
  `/var/lib/pgsql`; PostgreSQL 18 native hanya mendengarkan loopback dan bridge
  container privat.
- Dump PostgreSQL 17 sumber dibuat dengan `pg_dump` 18, dipulihkan ke database
  kandidat, lalu divalidasi menggunakan fingerprint deterministik untuk 15
  tabel, 22 function aplikasi, constraint, serta 69 identitas kompatibilitas.
- Setelah write-freeze singkat, kandidat dipromosikan melalui pertukaran nama
  database. Snapshot sebelum cutover tetap lokal dengan koneksi dinonaktifkan.
- Backend Rust memakai connection pool PostgreSQL native terbatas untuk auth
  gateway dan seluruh jalur data inti. Endpoint job Queue/R2 tetap diproksikan
  ke legacy agar satu job tidak terbagi antara dua penyimpanan.
- Readiness internal dan publik membuktikan primary `oracle-postgresql`, native
  read/write aktif, role aplikasi dapat menjalankan transaksi, serta Cloudflare
  tetap menjadi edge.
- Backup pasca-cutover diverifikasi, dienkripsi AES-256, dan diunggah ke Object
  Storage melalui policy create-only. Database Supabase tidak dihapus pada hari
  cutover karena masih dibutuhkan untuk Auth, job legacy, dan rollback.
