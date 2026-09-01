# Oracle API gateway

Layanan ini adalah titik masuk HTTP produksi. Gateway tidak menjalankan domain
balita, penimbangan, akun, realtime, atau monitoring secara langsung; request
domain diteruskan ke microservice pemiliknya melalui gRPC. Jalur migration proxy
tetap tersedia di source untuk rollback darurat, tetapi dinonaktifkan pada
deployment production microservices-only.

Pada arsitektur microservices, `oracle-api` hanya menjadi API gateway. Domain
identity, operations, realtime, monitoring, dan nutrition berjalan sebagai
container terpisah. Browser tetap memakai HTTPS ke gateway; semua komunikasi
antarservice native di jaringan Oracle memakai gRPC/HTTP2 dengan kontrak
protobuf bersama. Queue Cloudflare hanya digunakan sebagai transport durable
untuk job asinkron, bukan sebagai pengganti komunikasi gRPC sinkron.

Konfigurasi:

- `ORACLE_API_LEGACY_ORIGIN`: origin HTTPS API Cloudflare saat ini.
- `ORACLE_API_PUBLIC_ORIGIN`: origin publik Oracle yang ditulis ke OpenAPI.
- `ORACLE_API_DATA_PROCESSING_GRPC_URL`: default internal
  `unix:///run/e-posyandu/data-processing.sock`. Service satu host memakai gRPC di
  atas UDS; isi `http://HOST:50051` bila worker berada di server/platform lain.
  Port internal tidak dipublish ke host. Metadata
  `x-eposyandu-service-token` memakai secret Vault `RUST_WORKER_SHARED_SECRET`.
- `ORACLE_API_MICROSERVICES_ENABLED`: aktifkan delegasi gateway ke service
  identity, operations, realtime, dan monitoring (default Compose `true`).
- `ORACLE_API_IDENTITY_GRPC_URL`, `ORACLE_API_OPERATIONS_GRPC_URL`,
  `ORACLE_API_REALTIME_GRPC_URL`, dan `ORACLE_API_MONITORING_GRPC_URL`:
  default ke socket UDS masing-masing di `/run/e-posyandu`. Gunakan URL
  `http://HOST:PORT` untuk domain service lintas server/platform.
- `ORACLE_API_MIGRATION_PROXY_ENABLED`: harus `false` pada production
  microservices-only. Hanya aktifkan saat rollback terencana.
- `ORACLE_API_LISTEN_ADDR`: default `0.0.0.0:8081`.
- `GET /api/v1/realtime/stream`: SSE perubahan data aplikasi. Event hanya
  memuat metadata perubahan; Oracle menerbitkannya lewat PostgreSQL `NOTIFY`
  dan memfilter cakupan desa/posyandu sebelum dikirim ke browser.
- `ORACLE_REDIS_URL`: koneksi Redis privat untuk cache data dinamis. Jika
  dikonfigurasi, daftar balita, penimbangan, dan koleksi dinamis dicache selama
  5 menit; dashboard operasional dicache selama 60 detik. Key tetap terpisah
  per cakupan akses.

Redis bersifat cache sementara, bukan sumber data. Mutasi data menaikkan versi
cache dan PostgreSQL native tetap menjadi satu-satunya sumber kebenaran. Kegagalan
operasi Redis setelah proses berjalan tidak menggagalkan baca/tulis PostgreSQL;
readiness berubah menjadi `degraded` agar gangguan cache tetap terlihat.

Saat PostgreSQL native aktif, `oracle-api` menjalankan `eposyandu_cleanup_retention`
setiap 24 jam. Item Recycle Bin yang lebih lama dari 30 hari dihapus permanen;
balita yang sudah mencapai 60 bulan tetap dipertahankan lima tahun setelah tanggal
kelulusan operasional, lalu dihapus tepat ketika tanggal retensi tersebut tercapai. Migration
`031_child_data_retention.sql` wajib diterapkan sebelum rilis ini dijalankan.

Jalankan secara lokal:

```bash
ORACLE_API_LEGACY_ORIGIN='https://e-posyandu-api.example.workers.dev' \
  cargo run --manifest-path services/oracle-api/Cargo.toml
```

Jangan mematikan API Cloudflare atau Render hanya karena health gateway aktif.
Cutover dilakukan setelah seluruh smoke test dan satu pekerjaan Queue selesai.
