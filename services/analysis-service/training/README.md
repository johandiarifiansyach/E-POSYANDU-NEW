# Pelatihan lokal model status pertumbuhan

`train_growth_models.py` dipakai hanya untuk eksperimen/offline dari ekspor XLSX yang sudah dianonimkan. Artefaknya **tidak dimuat oleh service production dan tidak melakukan deploy**.

## Yang dilatih

Empat classifier terpisah dibuat dari pengukuran antropometri:

- `underweight_problem`: BB/U `Kurang` atau `Sangat Kurang`
- `stunting_problem`: TB/U `Pendek` atau `Sangat Pendek`
- `wasting_problem`: BB/TB `Gizi Kurang` atau `Gizi Buruk`
- `overweight_problem`: BB/TB `Gizi Lebih` atau `Obesitas`

Label tersebut adalah klasifikasi pada pengukuran yang sama, bukan diagnosis dan bukan prediksi kondisi klinis di masa depan. Data `NIK` dan `Nama` tidak dipakai sebagai fitur. Karena identitas anak dianonimkan, pemisahan train/test mengelompokkan tanggal lahir+jenis kelamin jika tersedia.

Fitur ASI eksklusif sengaja dinonaktifkan dari baseline training generik. Model
berfokus pada antropometri dan riwayat pengukuran; parser ASI yang tersisa di
kode hanya untuk pemulihan fitur di masa depan setelah tersedia ID anonim yang
konsisten.

## Pelatihan tren kohort

`train_growth_trend_models.py` membaca laporan kohort dengan blok tujuh baris
per anak (baris atas berat, baris bawah tinggi), lalu membuat fitur perubahan
berat/tinggi antarbulan dan laju kenaikannya. Empat target memprediksi apakah
status WHO pada pengukuran berikutnya masuk kategori masalah. Status WHO tetap
dihitung deterministik; target ini bukan diagnosis dan belum tervalidasi sebagai
risiko klinis masa depan.

```bash
python services/analysis-service/training/train_growth_trend_models.py \
  --xlsx /path/Laporan-KOHORT.xlsx \
  --output-dir /tmp/eposyandu-ml-training-trend \
  --year 2026
```

## Materi edukasi

PDF tatalaksana dan peraturan diindeks per halaman menggunakan TF-IDF. Indeks ini hanya untuk mengambil kutipan dari materi yang disetujui; ia bukan model generatif dan setiap rekomendasi tetap memerlukan telaah ahli gizi. Pedoman gizi buruk yang berupa scan dapat dimasukkan melalui hasil OCR dengan marker `===== PAGE N =====`.

## Sinyal riwayat pada analisis aplikasi

Analisis aplikasi memakai status WHO terbaru sebagai patokan deterministik.
Untuk balita yang belum masuk kategori masalah, risiko skrining diperkuat oleh
arah z-score BB/U, PB/TB/U, dan BB/PB atau BB/TB sepanjang riwayat, status
kenaikan berat `N`/`T` (atau selisih berat bila label lama kosong), serta status
masalah pada pengukuran sebelumnya. Jika status terbaru sudah bermasalah,
kartu prediksi tidak ditampilkan; edukasi dan tindak lanjut menampilkan ringkasan
status terakhir, arah z-score, dan pola N/T. ASI tidak menjadi fitur model
antropometri generik.

## Menjalankan ulang secara lokal

Gunakan environment offline yang memiliki `pandas`, `openpyxl`, `pypdf`, `scikit-learn`, dan `joblib` (bukan requirements runtime production):

```bash
python services/analysis-service/training/train_growth_models.py \
  --xlsx /path/Daftar-Anak-Berdasarkan-Status-Gizi.xlsx \
  --output-dir /tmp/eposyandu-ml-training \
  --guideline /path/pedoman.pdf \
  --guideline-text /path/pedoman-ocr.txt
```

Output utama adalah `growth_status_models.joblib`, `metrics.json`, dan
`metadata.json`. Pelatihan tren menghasilkan `growth_trend_models.joblib`,
`trend_metrics.json`, dan `trend_metadata.json`.
