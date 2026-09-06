# Analysis Service

Service Python privat untuk kalkulasi antropometri WHO secara deterministik,
screening risiko berbasis model logistic ringan, analisis tren grafik pertumbuhan,
dan deteksi anomali kualitas data. Service ini menjadi pemilik kalkulasi status
gizi; machine learning hanya memberikan prediksi/sinyal skrining tambahan dan
tidak mengubah status WHO resmi.

## Kontrak

`proto/analysis.proto` menyediakan `eposyandu.analysis.v1.AnalysisService`.
RPC `CalculateBatch` menerima data pengukuran (beserta riwayat opsional) dan
mengembalikan skor-z/status BB/U, TB/U, BB/TB, IMT/U, LILA/U, LK/U, deteksi
anomali, status kenaikan berat N/T/O/B, klasifikasi ASI eksklusif 0–6 bulan,
serta prediksi risiko stunting, wasting, dan underweight. Status N/T/O/B
dihitung dari berat mentah, urutan tanggal, dan ambang kenaikan usia (bukan
label lama dari browser). ASI hanya berstatus eksklusif (Ya) bila seluruh
jawaban usia 0, 1, 2, 3, 4, 5, dan 6 bulan adalah Ya. Setiap panggilan gRPC wajib
mengirim metadata `x-eposyandu-service-token` yang sama dengan
`RUST_WORKER_SHARED_SECRET`.

RPC `AnalyzeDataset` menerima baris mentah anak, pengukuran, serta parameter
periode/cakupan dan mengembalikan agregasi dashboard, filter/paginasi tabel,
dan klasifikasi ASI. RPC ini adalah satu-satunya pemilik statistik kesehatan,
filter status, pengurutan, dan agregasi klinis. PostgreSQL dapat melakukan
proyeksi kolom, filter periode/cakupan, dan hitungan baris teknis melalui
`eposyandu_dashboard_dataset`; gateway Rust memvalidasi sesi/scope dan
meneruskan snapshot itu. Nilai hitungan teknis tidak pernah dipakai sebagai
pengganti perhitungan Python.

RPC `RenderGrowthChart` menerima titik riwayat dan mengembalikan SVG grafik
WHO berbahasa Indonesia. Gateway operasi menyediakan endpoint HTTP
terautentikasi `/api/v1/analysis/anthropometry` (batch status),
`/api/v1/analysis/dashboard-stats` (agregasi), `/api/v1/children/page`
(filter/paginasi Python), `/api/v1/exclusive-breastfeeding/page` (ASI), dan
`/api/v1/analysis/growth-chart` (SVG). Dengan begitu tabel, ekspor tabel,
dashboard, ASI, dan grafik memakai hasil Python tanpa menghitung atau
memfilter ulang di browser. Saat Python tidak tersedia, UI melaporkan layanan
belum tersedia atau menampilkan halaman Python yang telah di-cache; tidak ada
fallback klasifikasi WHO/N/T/O/B lokal.

## Menjalankan dengan Docker

```bash
docker build -f services/analysis-service/Dockerfile -t e-posyandu-analysis-service .
docker run --rm \
  -e RUST_WORKER_SHARED_SECRET=secret-uji \
  -e ANALYSIS_GRPC_ADDR=unix:///tmp/analysis.sock \
  -p 8082:8082 \
  e-posyandu-analysis-service
```

Pada Compose Oracle service memakai UDS
`unix:///run/e-posyandu/analysis.sock`, sedangkan health check HTTP berada pada
port privat `8082`. Tabel LMS dibundel dari tabel WHO yang sudah diverifikasi.
Model screening runtime berjalan tanpa dependensi ML besar (standard library
Python saja), sehingga jejak RAM/CPU tetap rendah dan tidak ada data anak yang
dikirim ke layanan eksternal. Pelatihan eksperimen offline menggunakan
`numpy`, `pandas`, `scikit-learn`, dan `joblib` melalui skrip di `training/`;
dependensi berat tersebut tidak dimuat oleh server produksi.

### Skalabilitas agregasi

Service memakai cache TTL/LRU proses untuk hasil agregasi dashboard. Kunci cache
dibuat dari seluruh parameter dan baris mentah yang diterima, sehingga perubahan
data otomatis membuat hasil baru; TTL menjadi batas keamanan tambahan. Cache ini
hanya menyimpan angka agregasi dashboard, bukan respons tabel yang berisi
identitas balita. Penilaian setiap balita juga memiliki cache turunan terpisah,
sehingga pada refresh berikutnya hanya anak yang berubah yang menjalankan ulang
WHO dan screening.

Permintaan dataset dijalankan melalui antrean worker Python berbatas. Nilai
defaultnya dua worker dan 16 slot antrean; ketika antrean penuh service memberi
status `RESOURCE_EXHAUSTED` sehingga gateway tidak membuat beban tak terbatas.
Pengaturan dapat disesuaikan melalui `ANALYSIS_DATASET_WORKERS`,
`ANALYSIS_DATASET_QUEUE_SIZE`, `ANALYSIS_DATASET_QUEUE_TIMEOUT_SECONDS`,
`ANALYSIS_DASHBOARD_CACHE_SIZE`, `ANALYSIS_DASHBOARD_CACHE_TTL_SECONDS`,
`ANALYSIS_ASSESSMENT_CACHE_SIZE`, dan `ANALYSIS_ASSESSMENT_CACHE_TTL_SECONDS`.

### Proyeksi hasil ke PostgreSQL

Dengan `ANALYSIS_PERSISTENCE_ENABLED=true`, service juga menjalankan worker
outbox. Trigger migration 037 menerima perubahan dari semua tabel balita,
pengukuran, MPASI, PMT, riwayat, dan penghapusan; Rust tidak menunggu worker
sebelum menyimpan data utama. Worker Python membaca riwayat lengkap child,
menghitung ulang hanya child yang berubah, lalu menyimpan hasil ke
`measurement_analysis` bersama fingerprint sumber, versi hasil, dan versi
cakupan. Rust dapat membaca proyeksi itu langsung dari PostgreSQL/Redis tanpa
mengulang kalkulasi WHO pada setiap request. Setel `ANALYSIS_DATABASE_URL`
(atau `ORACLE_DATABASE_URL`) dan `ANALYSIS_PERSISTENCE_INTERVAL_SECONDS` sesuai
lingkungan. Grafik dan analisis pertumbuhan detail tetap melewati RPC Python.

Setiap item mengembalikan `analysis_json` berisi `anomaly`, `risk`,
`nutritionConcern`, `nutritionEducation`, `weightGainStatus`,
`weightGainMinimumGrams`, `exclusiveBreastfeedingStatus`, dan `graphAnalysis`.
`nutritionEducation` dipakai ketika status WHO belum menunjukkan masalah: ia
memilih materi pemberian makan Buku KIA 2024 sesuai kelompok usia dan tingkat
sinyal skrining tertinggi, lengkap dengan persentase, rujukan halaman, dan
poster Isi Piringku Kemenkes sesuai kelompok usia. Poster hanya materi
pendamping; status gizi tetap dihitung deterministik dengan standar WHO. Untuk
bayi 0–5 bulan, korpus juga mencantumkan materi ASI eksklusif dari halaman
resmi Ayo Sehat Kemenkes yang diberikan sebagai rujukan web.
Jika status WHO sudah menunjukkan masalah, `nutritionConcern` mengganti kartu
prediksi dengan panduan yang dipilih berdasarkan status: gizi kurang/berat
kurang, pendek/stunting, gizi buruk, atau gizi lebih/obesitas. Bagian ini
menambahkan edukasi dan tindak lanjut dari materi tatalaksana yang diberikan,
menyertakan sumber lokal dan rujukan resmi, serta menjaga agar obat, formula
terapi, dan dosis klinis tidak diresepkan oleh aplikasi.
`graphAnalysis` membaca riwayat bertanggal yang sama dengan
titik pada grafik, lalu mengembalikan ringkasan, tren berat/tinggi/LILA/lingkar
kepala, perubahan rata-rata per bulan, kesimpulan, dan saran tindak lanjut.
Model `growth-trend-logistic-v1` adalah baseline logistic yang transparan dan
ringan, bukan model klinis terlatih; hasilnya tetap harus dikonfirmasi oleh
tenaga kesehatan.

## Pengujian lokal

Modul kalkulasi tidak membutuhkan `grpcio` untuk diuji:

```bash
python3 -m unittest discover -s services/analysis-service/tests -p 'test_*.py'
```

Stub Python gRPC dibuat pada tahap image dengan `grpcio-tools`; source tree
tidak menyimpan hasil generated agar kontrak selalu berasal dari proto.
