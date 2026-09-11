# Oracle API gateway

Layanan ini adalah titik masuk HTTP produksi. Gateway tidak menjalankan domain
balita, penimbangan, akun, realtime, atau monitoring secara langsung; request
domain diteruskan ke microservice pemiliknya melalui gRPC. Jalur migration proxy
tetap tersedia di source untuk rollback darurat, tetapi dinonaktifkan pada
deployment production microservices-only.

Pada arsitektur microservices, `oracle-api` hanya menjadi API gateway. Domain
identity, read, write, realtime, monitoring, dan nutrition berjalan sebagai
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
  identity, read, write, realtime, dan monitoring (default Compose `true`).
- `ORACLE_API_IDENTITY_GRPC_URL`, `ORACLE_API_READ_GRPC_URL`,
  `ORACLE_API_WRITE_GRPC_URL`, `ORACLE_API_OPERATIONS_GRPC_URL` (rollback),
  `ORACLE_API_REALTIME_GRPC_URL`, dan `ORACLE_API_MONITORING_GRPC_URL`:
  default ke socket UDS masing-masing di `/run/e-posyandu`. Gunakan URL
  `http://HOST:PORT` untuk domain service lintas server/platform.
- `ORACLE_API_MIGRATION_PROXY_ENABLED`: harus `false` pada production
  microservices-only. Hanya aktifkan saat rollback terencana.
- `ORACLE_API_LISTEN_ADDR`: default `0.0.0.0:8081`.
- `ORACLE_API_TOKIO_WORKER_THREADS`: jumlah worker thread runtime Tokio. Jika
  kosong, gateway mengikuti CPU yang tersedia di container/OCI (dengan batas
  aman maksimum `32`); gunakan nilai eksplisit hanya setelah profiling.
- `ORACLE_DATABASE_POOL_SIZE`: batas koneksi PostgreSQL per service (default
  `5`, maksimum `10`). Pool memakai antrean FIFO dan statement cache per
  koneksi agar request tidak membuat koneksi/parse SQL baru setiap kali.
- `ORACLE_DATABASE_POOL_WAIT_TIMEOUT_SECONDS`: batas menunggu slot pool
  (default `2`). `0` menonaktifkan batas waktu.
- `ORACLE_DATABASE_POOL_CREATE_TIMEOUT_SECONDS`: batas membuat koneksi baru
  (default `5`). `0` menonaktifkan batas waktu.
- `ORACLE_DATABASE_POOL_RECYCLE_TIMEOUT_SECONDS`: batas pemeriksaan koneksi
  saat dikembalikan ke pool (default `2`). `0` menonaktifkan batas waktu.
- Response JSON dan stream yang dapat dikompresi dinegosiasikan otomatis dengan
  `Accept-Encoding`: Brotli (`br`) dipilih untuk browser modern dan gzip
  (`gzip`) menjadi fallback. Response yang sudah memiliki `Content-Encoding`,
  SSE, atau tipe yang tidak aman tidak dikompresi ulang.
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

Format key cache native adalah
`e-posyandu:cache:v2:<target>:version:<n>:scope:<sha256>:query:<sha256>`.
`target` tetap terbaca (misalnya `children-page` atau `dashboard-stats`),
sedangkan scope dan query di-hash agar NIK, nama, dan alamat tidak masuk ke
key. Versi berubah setiap mutasi sehingga key versi lama langsung tidak dipakai
dan cukup dibiarkan habis oleh TTL tanpa `FLUSHDB`.

Setiap response saat ini hanya membutuhkan satu key (payload halaman/agregasi
disimpan sebagai satu objek JSON), sehingga pipeline Redis tidak menambah
latensi pada jalur utama. Jika endpoint baru perlu mengambil banyak objek,
gunakan satu `redis::Pipeline`/`MGET` untuk seluruh key tersebut agar tidak
melakukan round-trip per baris.

## Jalur baca PostgreSQL

`native_db.rs` menggunakan pool `deadpool-postgres` berbatas. Query REST, RPC,
enrichment, dan transaksi tulis memakai prepared statement (dengan cache per
koneksi), sedangkan nilai pengguna tetap dikirim sebagai parameter—tidak ada
interpolasi nilai ke SQL. Halaman balita, ASI, MPASI, riwayat, dan dashboard
selalu dipaginasi; Rust membaca fungsi PostgreSQL yang mengambil proyeksi
`measurement_analysis`/`dashboard_analysis` yang telah dihitung Python.

Ukuran pool sengaja dibatasi per service agar jumlah koneksi gabungan pada
host (identity, read, write, operations, dan gateway) tidak menghabiskan
`max_connections` PostgreSQL. Request yang melebihi antrean pool gagal cepat
dengan status layanan sementara, sehingga tidak menahan seluruh runtime.

Migration `044_read_path_indexes.sql` menambahkan indeks jalur panas untuk
scope/umur balita, urutan terbaru, lookup pengukuran/MPASI per child, riwayat,
serta versi hasil Python. Indeks ini hanya mempercepat baca dan tidak mengubah
perhitungan WHO atau status gizi. `ANALYZE` dijalankan di akhir migrasi agar
planner memiliki statistik terbaru.

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
