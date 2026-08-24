# Tata Kelola Privasi dan Retensi Data

Status dokumen: **baseline teknis; wajib disahkan Kepala UPTD Puskesmas Gumukmas dan pejabat perlindungan data/pejabat yang ditunjuk sebelum production**.

E-Posyandu memproses data anak dan data kesehatan yang termasuk data pribadi spesifik. Dasar minimum kebijakan ini adalah [UU Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022) serta [Permenkes Nomor 24 Tahun 2022 tentang Rekam Medis](https://jdih.kemkes.go.id/documents/peraturan-menteri-kesehatan-nomor-24-tahun-2022). Dokumen ini bukan pengganti penilaian hukum Dinas Kesehatan.

## Tujuan dan batas pemrosesan

Data hanya boleh dipakai untuk pencatatan pelayanan Posyandu/Puskesmas, pemantauan pertumbuhan, program gizi, pelaporan resmi yang berwenang, kesinambungan pelayanan, keamanan, audit, dan pemulihan sistem. Penggunaan untuk iklan, pelatihan model AI umum, analitik pihak ketiga, penjualan data, atau tujuan lain yang tidak berkaitan dengan pelayanan dilarang.

Fitur AI tetap nonaktif. Jika kelak diaktifkan, backend hanya boleh menerima umur, jenis kelamin, nilai ukur, status WHO, dan pola waktu yang sudah dihilangkan identitasnya. Nama, NIK, nomor KK, alamat, telepon, tanggal lahir lengkap, dan ID database tidak boleh dikirim ke penyedia AI.

## Klasifikasi data

| Kelas | Contoh | Perlindungan minimum |
| --- | --- | --- |
| Sangat terbatas | NIK/KK, identitas anak/orang tua, tanggal lahir, alamat, nomor telepon, pengukuran, status gizi, ASI/MPASI, PMT | Sesi HttpOnly, pembatasan role/wilayah, enkripsi saat transit dan backup, audit akses/perubahan, dilarang masuk log teknis |
| Terbatas | ID akun, role, desa/Posyandu, audit event, request ID | Akses berdasarkan tugas, retensi terbatas, tidak dipublikasikan |
| Internal | konfigurasi operasional tanpa secret, statistik agregat yang tidak dapat mengidentifikasi anak | Hanya personel berwenang |
| Publik | aset aplikasi, dokumentasi umum, standar WHO yang tidak memuat data pasien | Dapat didistribusikan |

Kata sandi, access/refresh token Supabase, kunci enkripsi, dan service-role key tidak boleh disimpan di database aplikasi, log, source code, artifact build, atau browser JavaScript. Token Supabase hanya berada sementara di sesi Redis backend; browser menerima cookie sesi `HttpOnly`. Cloudflare KV hanya berisi konfigurasi global tanpa token.

## Cakupan akses

- Kader Posyandu hanya boleh mengakses data pada desa dan Posyandu penugasannya.
- Bidan Desa hanya boleh mengakses data pada desanya.
- Ahli Gizi memperoleh cakupan lintas wilayah hanya untuk tugas program gizi dan administrasi yang disahkan.
- Administrator infrastruktur tidak otomatis berhak membaca isi data kesehatan. Akses darurat harus beralasan, berbatas waktu, dan tercatat.
- Akun harus individual; akun bersama dilarang. Role/wilayah ditinjau paling sedikit setiap tiga bulan dan akses dicabut segera saat mutasi atau berhenti bertugas.

Pembatasan wajib diterapkan berlapis pada UI, Worker/API, dan Row Level Security database. Menyembunyikan tombol saja bukan kontrol akses.

## Jadwal retensi

| Data | Retensi | Tindakan akhir |
| --- | --- | --- |
| Rekam identitas dan pelayanan/pengukuran elektronik | Paling singkat 25 tahun sejak kunjungan terakhir pasien sesuai Pasal 39 Permenkes 24/2022 | Dimusnahkan hanya melalui prosedur resmi setelah masa minimum berakhir dan setelah legal hold diperiksa |
| Audit perubahan rekam dan akses istimewa | Mengikuti rekam terkait, paling singkat 25 tahun sejak kunjungan terakhir | Pemusnahan bersama rekam terkait setelah persetujuan |
| Profil akun aktif | Selama penugasan | Akses dinonaktifkan segera; jejak audit lama tetap mengikuti retensi rekam |
| Cookie sesi backend | Maksimum 8 jam, dengan logout otomatis setelah 30 menit tanpa aktivitas | Kedaluwarsa/dihapus saat logout; logout juga mengirim `Clear-Site-Data` |
| Cache scope baca darurat | Maksimum 1 jam dan tidak melampaui JWT | Kedaluwarsa otomatis di Redis |
| Cache offline browser | Hanya untuk kelangsungan sesi dan antrean sinkronisasi | Dienkripsi per akun; dihapus saat logout, pergantian akun, sesi hilang, atau inisialisasi berikutnya tanpa kunci sesi |
| File job/ekspor sementara di R2 | 7 hari | Dihapus otomatis; dapat lebih cepat oleh pengaman kapasitas |
| Artifact monitoring dan backup terenkripsi GitHub | 14 hari | Dihapus oleh retensi GitHub; bukan salinan arsip legal utama |
| Laporan error frontend dan CSP | Target maksimum 30 hari | Atur retensi log Cloudflare sebelum production; laporan tidak boleh memuat identitas, query, referrer, IP mentah, atau isi form |
| PNG/PDF/XLS yang sudah diunduh | Di luar kendali aplikasi | Pengguna bertanggung jawab atas penyimpanan dan pengiriman ke sistem resmi; aplikasi tidak mengubah alur ekspor ini |

Tidak ada penghapusan otomatis untuk rekam utama sebelum aturan 25 tahun terpenuhi. Backup berotasi pendek tidak mengurangi kewajiban retensi karena salinan utama tetap dipertahankan. Pemusnahan harus menghasilkan berita acara, mencakup primary, replika, cache, dan backup yang sudah melewati masa rotasinya, serta tidak boleh merusak legal hold.

## Hak subjek data dan koreksi

Permintaan akses, salinan, koreksi, pembatasan, atau penghapusan diterima melalui petugas resmi Puskesmas. Identitas pemohon dan kewenangan orang tua/wali harus diverifikasi. Koreksi dilakukan sebagai perubahan teraudit; riwayat klinis tidak ditimpa tanpa jejak. Permintaan penghapusan dapat dibatasi ketika penyimpanan diwajibkan oleh hukum, tetapi alasan dan hasil keputusan harus disampaikan kepada pemohon.

## Ekspor dan perangkat pengguna

Ekspor XLS SigiZI dapat memuat NIK dan data kesehatan; PNG/PDF dapat memuat identitas serta grafik. File tersebut memang diperlukan untuk unggah ke sistem resmi dan, sesuai keputusan pemilik aplikasi, tidak dienkripsi atau diubah oleh aplikasi setelah diunduh. Petugas harus memakai perangkat dinas, folder lokal terbatas, mengunggah hanya ke tujuan resmi, lalu menghapus salinan lokal ketika tidak lagi diperlukan.

Perangkat bersama wajib memakai akun OS terpisah, kunci layar, enkripsi disk, pembaruan otomatis, endpoint protection, dan browser tanpa ekstensi yang tidak diperlukan. Website tidak dapat mencegah keylogger atau malware yang sudah menguasai perangkat.

## Penanganan insiden

1. Putus akses terdampak tanpa memusnahkan bukti: nonaktifkan akun/token, isolasi perangkat, dan hentikan integrasi yang dicurigai.
2. Catat waktu, sistem, kategori data, jumlah subjek, sumber deteksi, dan tindakan dengan akses terbatas. Jangan menyalin NIK ke tiket umum atau chat.
3. Nilai risiko keselamatan anak, pencurian identitas, perubahan rekam, dan meluasnya akses.
4. Eskalasi segera kepada Kepala Puskesmas, Dinas Kesehatan, pengelola sistem, dan pejabat pelindungan data yang ditunjuk.
5. UU PDP Pasal 46 mensyaratkan pemberitahuan tertulis paling lambat 3 x 24 jam kepada subjek data dan lembaga dalam kegagalan pelindungan data. Isi pemberitahuan mengikuti ketentuan dan arahan pejabat berwenang.
6. Pulihkan dari backup yang sudah diverifikasi, rotasi seluruh secret terkait, pantau penyalahgunaan, dan dokumentasikan akar masalah serta pencegahannya.

## Persetujuan sebelum production

- [ ] Tetapkan secara tertulis pengendali data, prosesor, penanggung jawab teknis, dan kontak insiden.
- [ ] Sahkan tujuan pemrosesan, dasar pemrosesan, pemberitahuan privasi orang tua/wali, serta prosedur hak subjek.
- [ ] Konfirmasi lokasi pemrosesan dan perjanjian dengan Supabase, Cloudflare, GitHub, Neon/Render/Oracle bila dipakai.
- [ ] Tetapkan retensi log Cloudflare maksimal 30 hari dan buktikan penghapusannya.
- [ ] Pisahkan database development, staging, dan production; data production tidak boleh disalin ke pengujian.
- [ ] Jalankan uji restore terenkripsi, uji akses role/wilayah, uji pemulihan akun, pembatasan login, dan simulasi insiden.
- [ ] Lakukan penilaian dampak pelindungan data dan tinjau ulang sedikitnya tahunan atau setiap perubahan besar.

Pemilik persetujuan: Kepala UPTD Puskesmas Gumukmas. Tanggal, nomor dokumen, pejabat pelindungan data, dan tanda tangan harus diisi pada salinan kebijakan yang disahkan; repository tidak dianggap sebagai bukti persetujuan organisasi.
