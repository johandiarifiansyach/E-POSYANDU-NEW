# Nutrition gRPC Worker

Layanan Rust internal untuk pekerjaan berat E-Posyandu. Browser tidak pernah
memanggil gRPC secara langsung. REST Cloudflare Worker membuat job, Cloudflare
Queue menahannya, pull consumer mengambil job secara berurutan, lalu gRPC
memprosesnya tanpa membebani endpoint login dan CRUD.

## Pekerjaan yang didukung

| Job | RPC | Hasil |
| --- | --- | --- |
| `import_validation` | `ValidateImport` | Pemeriksaan NIK, tanggal, BB, TB, umur, duplikat, dan cakupan wilayah |
| `nutrition_report` | `CalculateReport` | Ringkasan BB/U, TB/U, BB/TB, underweight, stunting, dan wasting |
| `export_file` | `PrepareExport` | Berkas XLSX atau PDF beserta checksum SHA-256 |
| `system_sync` | `NormalizeSyncBatch` | Data sinkronisasi yang sudah dinormalisasi dan divalidasi |

`ProcessJob` menjadi pintu masuk Queue untuk keempat jenis job tersebut.
RPC khusus tetap tersedia agar layanan internal lain dapat memakai kontrak
yang lebih terstruktur.

## Menjalankan lokal

```bash
cp services/nutrition-grpc/.env.example services/nutrition-grpc/.env
set -a
source services/nutrition-grpc/.env
set +a
npm run grpc:dev
```

Alamat bawaan adalah `127.0.0.1:50051`. Tanpa
`QUEUE_CONSUMER_ENABLED=true`, service hanya membuka server gRPC dan tidak
membaca Cloudflare Queue.

Binary lokal/systemd bernama `nutrition-grpc-standalone`. Binary container cloud
bernama `nutrition-grpc-cloud`; binary ini membuka health check HTTP pada
`$PORT` dan menjaga server gRPC tetap privat pada `127.0.0.1:50051`.

## Mengaktifkan Queue consumer

Isi environment berikut pada host privat layanan Rust:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_QUEUE_ID`
- `CLOUDFLARE_QUEUES_API_TOKEN` dengan izin Queues Edit
- `EPOSYANDU_API_URL`
- `RUST_WORKER_SHARED_SECRET`, sama dengan secret Cloudflare Worker
- `GRPC_URL`, biasanya `http://127.0.0.1:50051`

Consumer memperbarui progres pada 5%, 85%, 95%, dan 100%. Job gagal dicoba
ulang maksimal tiga kali. Hasil validasi, laporan, dan sinkronisasi disimpan
sebagai JSON di PostgreSQL. Hasil XLSX/PDF disimpan secara privat ke R2; job
ekspor akan gagal dengan pesan yang jelas bila binding R2 belum diaktifkan.

Payload dibatasi 10.000 baris per job kalkulasi atau validasi dan 100.000
baris per ekspor. Untuk impor yang lebih besar, REST harus membaginya menjadi
beberapa job agar penggunaan memori dan waktu proses tetap terkendali.

## Container

Build image dari root repository agar data standar antropometri ikut masuk:

```bash
docker build -f services/nutrition-grpc/Dockerfile -t e-posyandu-nutrition-grpc .
```

Container berjalan sebagai pengguna non-root. Platform hosting hanya membuka
port HTTP `$PORT` untuk health check, sedangkan gRPC tetap berada di
`127.0.0.1:50051` di dalam container. Environment Queue tetap diberikan sebagai
secret dari platform hosting, bukan dimasukkan ke image.

## Hosting Oracle Compute

Oracle Compute menjadi target utama untuk worker pekerjaan berat. Cloudflare
Queue, R2, API Worker, Supabase PostgreSQL, dan Supabase Auth tetap berada pada
layanan masing-masing; Oracle hanya menjalankan Queue consumer dan kalkulasi
Rust. Browser tidak pernah terhubung ke VM Oracle.

Konfigurasi siap-deploy ada di [`deploy/oracle`](../../deploy/oracle/README.md).
Deployment memakai image yang sama pada ARM64, container non-root/read-only,
Caddy untuk satu-satunya endpoint publik `/health`, dan restart otomatis Docker.
Port gRPC `50051` serta health internal `8080` tidak diterbitkan ke host.

```bash
npm run grpc:deploy:oracle -- eposyandu-oracle nutrition.example.go.id
npm run grpc:connect:oracle -- https://nutrition.example.go.id/health
```

Jalankan satu Queue consumer aktif saja. Render atau LaunchAgent macOS baru boleh
dimatikan setelah Oracle sehat dan satu job uji berhasil sampai status selesai.

## Layanan gratis di macOS

Bila belum memakai host container berbayar, worker dapat dijalankan sebagai
LaunchAgent pada Mac ini. Layanan otomatis dimulai setelah pengguna masuk dan
diulang oleh macOS bila proses berhenti:

```bash
npm run grpc:activate:macos
```

Pada aktivasi pertama, buat Cloudflare API Token dengan izin
`Account > Queues > Edit`. Perintah aktivasi membaca token tanpa menampilkannya,
memverifikasi akses Queue, lalu menyimpannya hanya di konfigurasi privat.

Konfigurasi privat dibaca dari
`~/.config/e-posyandu/nutrition-grpc.env`. Mac harus menyala dan terhubung ke
internet agar pekerjaan Queue diproses. Cara ini cocok sebagai aktivasi awal,
tetapi bukan pengganti host selalu aktif untuk penggunaan 24 jam.

Binary dan runner dipasang ke `~/Library/Application Support/EPosyandu` agar
LaunchAgent tidak memerlukan izin akses ke folder Documents. Jalankan ulang
`npm run grpc:install:macos` setiap kali kode service Rust diperbarui.

## Hosting Render sementara

Container menjalankan health check HTTP dan server gRPC privat pada proses yang
sama. Queue consumer hanya menghubungi gRPC melalui `127.0.0.1`, sehingga RPC
internal tidak dibuka ke internet. PostgreSQL tetap berada di Supabase dan
Cloudflare Worker tetap menjadi API utama.

Blueprint [`render.yaml`](../../render.yaml) menyiapkan web service Docker gratis
di region Singapore. Masukkan lima environment rahasia ketika Render meminta
nilainya. Polling kosong dibatasi setiap 15 detik dan satu pull memproses maksimal
dua job agar penggunaan CPU, RAM, serta operasi Queue tetap ringan.

Setelah deploy pertama selesai, sambungkan URL Render ke Cloudflare. Perintah ini
memeriksa health check, menyimpan URL sebagai secret, lalu deploy ulang backend.
Cron Cloudflare kemudian mengunjunginya setiap 10 menit agar layanan sementara
tidak tidur:

```bash
npm run grpc:connect:render -- https://NAMA-SERVICE.onrender.com
```

Gunakan hanya satu web service gratis agar jatah bulanan Render cukup. Bila secret
`RUST_WORKER_HEALTH_URL` belum dibuat, cron aman dilewati dan tidak memengaruhi
API utama. Service Render hanya menjadi cadangan sementara bila instance Oracle
belum tersedia. Jangan menjalankan Render dan Oracle bersamaan dalam waktu lama.
