# Standar Pertumbuhan WHO

E-Posyandu memakai WHO Child Growth Standards 2006/2007 untuk BB/U, PB atau TB/U, BB/PB atau BB/TB, IMT/U, LILA/U, dan LK/U. Data LMS disimpan di dalam aplikasi agar penilaian tetap tersedia tanpa mengirim data anak ke layanan eksternal.

Sumber primer dan checksum setiap workbook WHO dicatat dalam [`who-growth-standards.provenance.json`](./who-growth-standards.provenance.json). Pada 17 Agustus 2026, seluruh baris LMS lokal dibandingkan secara tepat dengan 18 workbook resmi WHO dan tidak ditemukan perbedaan.

## Ruang lingkup

- Indikator menurut umur umum tersedia dari lahir sampai 60 bulan selesai.
- LILA/U hanya tersedia mulai 3 sampai 60 bulan. WHO MGRS baru mengumpulkan lingkar lengan pada anak berumur setidaknya 3 bulan, sehingga aplikasi tidak meminta atau menampilkan hasil LILA pada usia 0–2 bulan.
- LK/U tersedia sejak lahir sampai 60 bulan.
- Untuk anak sampai 24 bulan, kurva memakai panjang badan telentang. Bila diukur berdiri, aplikasi menambahkan 0,7 cm. Di atas 24 bulan, kurva memakai tinggi badan berdiri; bila diukur telentang, aplikasi mengurangi 0,7 cm.

## Interpretasi dan batas klinis

Kurva dan skor-z dihitung dengan rumus LMS WHO. Label BB/U, PB/TB-U, BB/PB-TB, dan IMT/U mengikuti ambang antropometri Permenkes No. 2 Tahun 2020 yang mengadopsi standar WHO. Label LILA/U dan LK/U merupakan penyajian posisi skor-z terhadap distribusi WHO (`< -3 SD`, `-3 sampai < -2 SD`, `-2 sampai +2 SD`, dan `> +2 SD`); hasil ini adalah alat skrining, bukan diagnosis tunggal.

Perubahan data acuan hanya boleh dilakukan melalui perubahan yang menyertakan:

1. tautan sumber primer WHO dan checksum artefak baru;
2. hasil pembandingan seluruh baris, bukan sampel;
3. pembaruan golden tests untuk kedua jenis kelamin, titik batas umur, dan transisi panjang/tinggi;
4. tinjauan tenaga gizi sebelum diterapkan ke production.

Jalankan `npm run standards:verify` untuk memastikan file data lokal belum berubah dan frontend, Worker, serta layanan gRPC memakai tabel antropometri yang identik.
