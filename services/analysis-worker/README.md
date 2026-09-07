# Analysis worker (Rust + PyO3)

`analysis-worker` adalah pilihan deployment PyO3 (opsi 2). Binary Rust ini
menyediakan kontrak `AnalysisService` melalui gRPC/UDS atau TCP, memeriksa
token service, health check, dan menjalankan loop outbox di latar belakang.

Semua keputusan analitik tetap berada di CPython yang dimuat melalui PyO3:

- `who.py` untuk tabel LMS WHO, z-score, dan status gizi;
- `ml.py` untuk N/T/O/B, risiko, edukasi, dan analisis tren;
- `analytics.py` untuk tabel/dashboard/agregasi;
- `charts.py` untuk grafik pertumbuhan SVG;
- `persistence.py` untuk menyimpan proyeksi dan versi hasil ke PostgreSQL.

Rust tidak menghitung ulang indikator dan tidak menyimpan hasil analitik
sendiri. Ia hanya mengubah pesan protobuf menjadi JSON, memanggil fungsi
Python, lalu mengubah hasilnya kembali ke protobuf. Loop outbox memanggil
`process_outbox_once_json` secara bounded; beberapa instance worker dapat
berbagi antrean PostgreSQL karena klaim memakai `FOR UPDATE SKIP LOCKED`.

## Pemeriksaan lokal

```bash
cargo check --manifest-path services/analysis-worker/Cargo.toml
cargo build --locked --release --manifest-path services/analysis-worker/Cargo.toml
PYTHONPATH=services/analysis-service python3 -m unittest discover \
  -s services/analysis-service/tests -p 'test_*.py'
```

Compose Oracle menjalankan worker dengan socket
`/run/e-posyandu/analysis.sock`, image `e-posyandu-analysis-worker:oracle`, dan
`PYTHONPATH=/app/services/analysis-service`. Service Python gRPC lama tetap ada
sebagai sumber rollback, tetapi tidak dijalankan bersamaan karena akan
menggunakan socket yang sama.
