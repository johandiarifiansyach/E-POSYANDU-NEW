# Neon Read Worker

Worker privat ini melayani query baca berat dari replika Neon. Browser tidak
boleh mengakses Worker ini secara langsung; Rust API memanggilnya melalui
Cloudflare Service Binding setelah autentikasi dan pembatasan wilayah selesai.

## Tanggung jawab

- Menjalankan hanya operasi RPC yang ada dalam allowlist.
- Memakai role PostgreSQL khusus baca dengan `default_transaction_read_only`.
- Tidak menangani login, mutasi, audit log, atau sinkronisasi offline.
- Mengembalikan kegagalan agar Rust API dapat beralih ke Supabase primary.

## Konfigurasi

Salin `.dev.vars.example` menjadi `.dev.vars` hanya untuk pengembangan lokal,
kemudian isi:

- `NEON_DATABASE_URL`: koneksi Neon milik role `eposyandu_replica_reader`.
- `READ_REPLICA_SHARED_SECRET`: rahasia internal yang sama dengan Rust API.

Rahasia produksi dan staging harus diisi melalui `wrangler secret put`, bukan
disimpan dalam Git. Urutan aktivasi dan pemulihan tersedia di
[`docs/OPERATIONS.md`](../../docs/OPERATIONS.md).

## Perintah

```bash
npm run replica:check
npm run replica:dev
npm run replica:deploy:staging
npm run replica:deploy
```
