# Oracle API migration gateway

Layanan ini adalah titik masuk native HTTP untuk migrasi bertahap API
E-Posyandu dari Cloudflare Worker ke Oracle Compute. Gelombang pertama
menjalankan `/health`, `/api/health`, `/api/v1/health`,
`/api/v1/health/ready`, dokumen OpenAPI, dan schema GraphQL secara native.
Readiness memeriksa API lama dan worker nutrisi melalui jaringan internal tanpa
membaca data balita. Rute lainnya diteruskan ke API lama melalui
HTTPS, sehingga migrasi dapat diuji tanpa memutus produksi.

Gateway bukan kondisi akhir dan belum mengurangi penggunaan Worker secara
berarti. Endpoint dipindahkan satu per satu ke implementasi native setelah uji
kontrak, autentikasi, pembatasan wilayah, audit, dan sinkronisasi lulus.

Konfigurasi:

- `ORACLE_API_LEGACY_ORIGIN`: origin HTTPS API Cloudflare saat ini.
- `ORACLE_API_PUBLIC_ORIGIN`: origin publik Oracle yang ditulis ke OpenAPI.
- `ORACLE_API_NUTRITION_HEALTH_URL`: default internal
  `http://nutrition-worker:8080/health`; jangan diarahkan ke URL dari input pengguna.
- `ORACLE_API_MIGRATION_PROXY_ENABLED`: `true` selama fase transisi.
- `ORACLE_API_LISTEN_ADDR`: default `0.0.0.0:8081`.
- `ORACLE_REDIS_URL`: koneksi Redis privat untuk cache data dinamis. Jika
  dikonfigurasi, daftar balita, penimbangan, dashboard, dan koleksi dinamis
  dicache selama 60 detik dengan key terpisah per cakupan akses.

Redis bersifat cache sementara, bukan sumber data. Mutasi data menaikkan versi
cache dan PostgreSQL native tetap menjadi satu-satunya sumber kebenaran. Kegagalan
operasi Redis setelah proses berjalan tidak menggagalkan baca/tulis PostgreSQL;
readiness berubah menjadi `degraded` agar gangguan cache tetap terlihat.

Jalankan secara lokal:

```bash
ORACLE_API_LEGACY_ORIGIN='https://e-posyandu-api.example.workers.dev' \
  cargo run --manifest-path services/oracle-api/Cargo.toml
```

Jangan mematikan API Cloudflare atau Render hanya karena health gateway aktif.
Cutover dilakukan setelah seluruh smoke test dan satu pekerjaan Queue selesai.
