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
  --year 2026 \
  --workers 4
```

## Materi edukasi

PDF tatalaksana dan peraturan diindeks per halaman menggunakan TF-IDF. Indeks ini hanya untuk mengambil kutipan dari materi yang disetujui; ia bukan model generatif dan setiap rekomendasi tetap memerlukan telaah ahli gizi. Pedoman gizi buruk yang berupa scan dapat dimasukkan melalui hasil OCR dengan marker `===== PAGE N =====`.

Korpus terstruktur `services/analysis-service/data/kia_2024_feeding_guidance.json` merangkum Buku KIA 2024 untuk bayi dan balita. Korpus tersebut berisi batas usia, tekstur, frekuensi, jumlah contoh MPASI, prinsip keamanan/responsif, serta edukasi berdasarkan tingkat sinyal skrining. Empat poster Isi Piringku Kemenkes (6–8, 9–11, 12–23, dan 24–59 bulan) disimpan sebagai aset frontend dan poin kuncinya ikut diindeks. Setiap bagian menyimpan nomor halaman atau penanda poster dan otomatis ikut diindeks oleh `train_growth_models.py`; isinya adalah materi edukasi/provenance, bukan label target.
Kelompok 0–5 bulan juga memuat rujukan web resmi Ayo Sehat Kemenkes tentang ASI eksklusif 6 bulan; URL, tanggal terbit, dan tanggal akses disimpan agar dapat diaudit.
Korpus yang sama memiliki bagian `problemGuidance` untuk memetakan status WHO
yang sudah bermasalah ke edukasi khusus gizi kurang/berat kurang, stunting,
gizi buruk, dan gizi lebih. Sumber PDF yang Anda berikan dicatat sebagai
provenance; materi ini diambil sebagai panduan terstruktur dan tidak dipakai
sebagai label klinis atau resep otomatis.

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

Gunakan environment offline yang memiliki dependency pada
[`training/requirements.txt`](requirements.txt) (bukan requirements runtime
production). Pandas menjadi backend utama trainer yang sudah ada; Polars boleh
dipakai pada eksperimen/ETL batch yang besar tanpa menambahnya ke image online.

```bash
python -m venv .venv-training
. .venv-training/bin/activate
pip install -r services/analysis-service/training/requirements.txt
```

Kemudian jalankan:

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

## Persiapan pelatihan dari website (belum online-learning otomatis)

Website tetap menjalankan analisis Python setiap kali ada pengukuran. Untuk
menyiapkan pelatihan kandidat dari data yang sudah dianonimkan, lakukan ekspor
terjadwal dari E-Posyandu lalu jalankan trainer ke direktori artefak baru.

```bash
python services/analysis-service/training/train_growth_models.py \
  --xlsx /data/ekspor-e-posyandu-anonim.xlsx \
  --output-dir /data/model-candidate-$(date +%Y%m%d) \
  --guidance-corpus services/analysis-service/data/kia_2024_feeding_guidance.json
```

Pelatihan tidak menimpa model production dan tidak boleh memakai nama/NIK
sebagai fitur. Promosi artefak ke production harus melalui telaah ahli gizi,
validasi split per anak, metrik, dan persetujuan eksplisit. Dengan demikian
analisis dan pengumpulan batch latihan dapat berjalan bersamaan tanpa model
belajar otomatis dari data klinis yang belum ditinjau.

## Optimasi tahap 4

Kalkulasi online tetap deterministik dan ringan. `who.py` menggunakan cache
numerik terbatas untuk operasi LMS berulang, sedangkan `charts.py` menyimpan
SVG yang identik di cache proses terbatas (`ANALYSIS_GRAPH_CACHE_SIZE`, default
256; TTL `ANALYSIS_GRAPH_CACHE_TTL_SECONDS`, default 900 detik). Cache ini
volatile, tidak menulis data kesehatan ke disk, dan dapat dikosongkan saat
standar WHO atau rilis berubah.

NumPy, Pandas, dan Polars hanya dipakai untuk batch/offline: pembersihan ekspor,
statistik, eksperimen, dan pelatihan kandidat. Jangan mengimpor DataFrame pada
jalur request kader. Parser kohort menyediakan `--workers N` dengan process
pool bounded untuk dataset besar; default `1` sehingga tidak membuat proses
tambahan. Batas CPU/RAM harus ditetapkan agar pekerjaan offline tidak
mengganggu service online. Artefak model dan indeks materi disimpan di
direktori output eksperimen, bukan di container produksi secara otomatis.
