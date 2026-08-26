# Rencana akun admin dan perubahan nama role

Status: **Dieksekusi dan akun administrator aktif pada 25 Agustus 2026**

## Tujuan

Menambahkan akun administrator aplikasi dengan kontrol akses ketat dan mengganti label
`Admin Gizi` menjadi `Ahli Gizi`.

## Hasil perubahan

- Label tampilan `Admin Gizi` diubah menjadi `Ahli Gizi`.
- Undangan akun administrator penuh dikirim ke email pribadi pemilik. Pemilik
  menetapkan password sendiri dari tautan undangan; password tidak dibuat oleh
  operator dan tidak disimpan dalam repository atau dokumen.
- Hak akses penuh diberikan melalui role backend `super_admin`, bukan hanya melalui
  menu frontend.
- Untuk `super_admin`, MFA wajib:
  - passkey sebagai metode utama;
  - TOTP sebagai metode cadangan;
  - recovery code disimpan secara offline;
  - security key dapat ditambahkan kemudian.
- Aktivitas admin, perubahan role, ekspor, dan penghapusan dicatat dalam audit log.
- Session admin hanya aktif setelah MFA berhasil dan dapat dicabut melalui logout.
- Hak akses ini hanya berlaku untuk aplikasi; tidak memberikan akses PostgreSQL
  superuser atau Oracle Cloud root.
- Menu profil Administrator menyediakan halaman penuh `Administrasi Backend`
  untuk status layanan serta pemantauan online/offline seluruh akun. Endpoint
  halaman tersebut tetap mewajibkan `super_admin` dan MFA terverifikasi.
- Status online berarti aktivitas terautentikasi dalam tiga menit terakhir.
  Penyimpanan presence memakai hash ID akun dan hash sesi, bukan token mentah.

## Pembagian role dan cakupan data

Jumlah pengguna tidak dibuat menjadi role terpisah. Setiap akun memiliki role dan
scope wilayah pada backend, misalnya `puskesmas_id`, `desa_id`, dan `posyandu_id`.

| Nilai role backend | Jumlah setelah eksekusi | Cakupan akses |
| --- | ---: | --- |
| `super_admin` | 1 akun baru | Seluruh scope data aplikasi, pengguna, ekspor, dan audit |
| `Ahli Gizi` | 1 akun lama | Pemantauan dan pengelolaan data gizi pada puskesmas/wilayah yang ditugaskan |
| `Bidan Desa` | 5 akun lama | Data balita dan penimbangan pada desa masing-masing |
| `Kader Posyandu` | 63 akun lama | Input dan pembaruan data pada posyandu masing-masing |

Migration `029_super_admin_access.sql` hanya menambahkan nilai `super_admin` pada
constraint dan fungsi pembatasan scope. Migration itu tidak memiliki perintah
`UPDATE app_users`. Verifikasi sesudah migration memastikan seluruh 69 akun lama
tetap memiliki role yang sama: 63 `Kader Posyandu`, 5 `Bidan Desa`, dan 1
`Ahli Gizi`.

Kader dan bidan tidak dapat melihat data di wilayah lain secara default. Perubahan
role, perpindahan wilayah, ekspor, dan penghapusan data memerlukan audit log serta
kontrol backend.

## Rencana alur login satu box

Frontend menggunakan satu kotak login untuk seluruh pengguna:

```text
Username/email + password
          |
          v
Backend memvalidasi kredensial dan membaca role dari database
          |
          +-- super_admin --> Passkey ATAU TOTP --> Buat session
          |
          +-- ahli_gizi ----> Buat session
          +-- bidan_desa ---> Buat session
          +-- kader_posyandu -> Buat session
```

- Challenge passkey/TOTP untuk `super_admin` ditentukan backend setelah kredensial
  berhasil diverifikasi.
- Frontend tidak boleh menentukan hak akses hanya dari teks username karena dapat
  dilewati atau dimanipulasi.
- Untuk sementara, `ahli_gizi`, `bidan_desa`, dan `kader_posyandu` masuk langsung
  setelah password berhasil. MFA untuk role tersebut dapat diaktifkan pada tahap
  berikutnya karena tetap menangani data kesehatan.
- UI tetap satu box; layar passkey/TOTP hanya muncul secara kondisional untuk
  `super_admin`.

## Catatan password

Permintaan awal adalah mempertahankan password yang sama saat perubahan nama. Tidak ada
password yang disimpan di dokumen ini. Sebelum hak `super_admin` diberikan, password
sebaiknya diganti menjadi password unik yang kuat dan disimpan di password manager.

## Status eksekusi dan aktivasi pemilik

1. ~~Ubah label `Admin Gizi` menjadi `Ahli Gizi`.~~ Selesai tanpa mengubah nilai
   role akun lama.
2. ~~Buat akun baru dengan username `admin`, nama tampilan `Administrator`, dan
   role backend `super_admin`.~~ Selesai pada Oracle primary.
3. ~~Kirim undangan aman ke email administrator.~~ Selesai; email terkonfirmasi
   saat tautan pertama diklik. Redirect awal salah menuju `localhost:3000`
   karena Site URL Supabase production belum dikonfigurasi ke domain production.
4. ~~Pemilik menyelesaikan callback pemulihan pada `/admin/activate` dan
   menetapkan password unik minimal 14 karakter.~~ Selesai.
5. ~~Pemilik mendaftarkan TOTP dan memverifikasi kode pertama.~~ Selesai;
   backend Auth mencatat tepat satu faktor TOTP berstatus `verified` dan audit
   Oracle mencatat hasil `mfa_verified`. Sepuluh recovery code sudah dibuat dan
   hanya ditampilkan sekali; penyimpanannya secara offline menjadi tanggung
   jawab pemilik.
6. Dukungan passkey memakai endpoint Supabase Passkeys (`/auth/v1/passkeys/*`),
   bukan endpoint MFA `/auth/v1/factors`. Fitur Passkeys pada project Supabase
   Auth production masih `disabled`, sehingga harus diaktifkan pada Dashboard
   sebelum passkey dapat didaftarkan. TOTP tetap menjadi faktor MFA cadangan.
7. ~~Setelah login berhasil, pastikan pojok kanan atas menampilkan
   `Administrator`.~~ Selesai dan diverifikasi dari dashboard production.

Tidak ada password, token undangan, secret MFA, atau recovery code yang dicatat
dalam dokumen ini.
