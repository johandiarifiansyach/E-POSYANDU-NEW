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
anomali, serta prediksi risiko stunting, wasting, dan underweight. Setiap panggilan gRPC wajib
mengirim metadata `x-eposyandu-service-token` yang sama dengan
`RUST_WORKER_SHARED_SECRET`.

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
Model screening berjalan tanpa dependensi ML besar (standard library Python
saja), sehingga jejak RAM/CPU tetap rendah dan tidak ada data anak yang dikirim
ke layanan eksternal.

Setiap item mengembalikan `analysis_json` berisi `anomaly`, `risk`, dan
`graphAnalysis`. `graphAnalysis` membaca riwayat bertanggal yang sama dengan
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
