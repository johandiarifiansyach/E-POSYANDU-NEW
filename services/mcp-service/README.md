# E-Posyandu MCP service

`mcp-service` adalah adapter MCP internal yang menjembatani asisten AI dengan
`ReadService` dan `WriteService`. Service ini tidak mengakses PostgreSQL,
Redis, atau modul Python secara langsung.

## Endpoint

- `POST /mcp` — JSON-RPC 2.0 melalui Streamable HTTP (`initialize`, `ping`,
  `tools/list`, dan `tools/call`).
- `GET /health` — pemeriksaan proses dasar.

Semua request `/mcp` harus membawa `x-eposyandu-mcp-token` yang sama dengan
`MCP_SHARED_SECRET`. Jika `Origin` dikirim, nilainya harus ada di
`MCP_ALLOWED_ORIGINS`. Cookie atau bearer session pengguna diteruskan secara
terbatas ke domain service agar role dan scope desa/Posyandu tetap diperiksa
oleh `NativeAuth`.

## Tools tahap pertama

Read-only: `list_children`, `get_child_summary`, `get_measurement_analysis`,
`get_education`, `get_dashboard_summary`, `get_growth_chart`,
`get_breastfeeding_status`, `get_mpasi_status`, `get_pmt_status`,
`get_recommendation_history`, dan `get_recommendation`.

Write terkontrol: `record_recommendation` dan `record_education_delivery`.
Keduanya wajib `confirmed: true`. `record_recommendation` menerima sinyal
terstruktur hasil analisis Python (misalnya status N/T, jumlah T, risiko,
status gizi, dan kehadiran), lalu memilih kode serta kalimat standar secara
otomatis. Kader tidak memilih kode dan tidak mengetik catatan. Mutasi
diteruskan ke WriteService sehingga transaksi, outbox, pembatasan
role/wilayah, dan audit log tetap menjadi otoritas domain. Nama tool
`follow_up` lama masih diterima sebagai alias kompatibilitas, tetapi kode atau
teks manual dari klien lama diabaikan dan tidak ditampilkan pada registry baru.

`get_recommendation` dapat dipakai untuk melihat keputusan otomatis sebelum
konfirmasi. Jika sinyal belum tersedia, sistem memilih pemantauan rutin
sebagai fallback aman; MCP tidak menghitung ulang WHO/z-score atau membuat
diagnosis.

Pada formulir pemantauan PMT, kolom rekomendasi juga bersifat baca-saja. Nilai
berasal dari hasil Python atau fallback kategori yang aman; tidak ada dropdown
kode rekomendasi untuk kader.

MCP menolak input diagnosis/resep/terapi, meredaksi NIK dan PII dari respons,
dan meneruskan analisis antropometri, risiko, edukasi, serta grafik ke Python
melalui ReadService. Hasil screening tidak pernah diposisikan sebagai
diagnosis.

## Menjalankan lokal

```bash
MCP_SHARED_SECRET='minimal-24-karakter-rahasia' \
RUST_WORKER_SHARED_SECRET='token-service-internal' \
MCP_HTTP_ADDR=127.0.0.1:5160 \
cargo run --locked --manifest-path services/mcp-service/Cargo.toml
```

Compose menempatkan service ini pada profile `mcp` dan tidak mempublikasikan
port melalui Caddy/Cloudflare. Materialisasikan `MCP_SHARED_SECRET` dari OCI
Vault sebelum menjalankan profile tersebut di server.
