# Keamanan E-Posyandu

## Kontrol yang diterapkan di kode

- Data sesi dan respons API tidak boleh disimpan oleh service worker.
- Cache offline sensitif dienkripsi, terikat ke ID akun, dan dihapus saat logout atau saat sesi akun berubah.
- CSP membatasi skrip ke aplikasi dan Cloudflare Turnstile. SheetJS 0.20.3 ikut dibundel ke aset aplikasi sehingga browser tidak memuat kode Excel dari CDN pihak ketiga.
- Renderer DOM menolak HTML mentah, atribut event berbentuk teks, URL executable, dan nilai CSS yang dapat memuat sumber eksternal.
- Impor identitas hanya menerima `.xls`/`.xlsx` maksimal 10 MB dengan signature file yang sesuai. `.xlsm` ditolak dan macro tidak dibaca.
- Sel spreadsheet yang menyerupai formula selalu ditulis sebagai teks.
- Mutasi API dibatasi 256 KB, karakter kontrol ditolak, dan panjang teks divalidasi ulang di server.
- Dependabot memantau npm, Cargo, dan GitHub Actions. CI menolak kerentanan npm tingkat tinggi atau kritis.

## Pengaturan GitHub yang wajib diaktifkan manual

Kode tidak dapat mengubah pengaturan repository. Pada repository GitHub, pastikan:

1. Visibility diatur ke **Private**.
2. Ruleset cabang `main` dan `staging` mewajibkan pull request dan status check `quality` serta `end-to-end`.
3. Force push dan penghapusan cabang dilindungi.
4. Dependabot alerts, Dependabot security updates, dan secret scanning/push protection diaktifkan bila tersedia pada paket akun.
5. Akses kolaborator ditinjau berkala dan menggunakan autentikasi dua faktor.
6. Secret produksi hanya disimpan pada GitHub Environments/Cloudflare secrets, tidak di repository atau artefak build.

## Batas perlindungan malware

Frontend tidak dapat mendeteksi keylogger, ekstensi browser berbahaya, atau malware pada perangkat petugas. Perangkat operasional tetap harus diperbarui, menggunakan endpoint protection, akun OS khusus, dan browser tanpa ekstensi yang tidak diperlukan.

Pemindaian antivirus/ClamAV untuk file baru dapat ditambahkan setelah tersedia backend karantina. Jangan mengirim data produksi atau NIK ke pemindai pihak ketiga tanpa penilaian privasi dan perjanjian pemrosesan data.
