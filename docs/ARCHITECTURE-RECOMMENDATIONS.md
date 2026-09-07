# Rekomendasi Arsitektur Rust–Python

Dokumen ini adalah acuan kerja bertahap untuk menutup kelemahan teknis Rust
dan Python pada E-Posyandu. Poin dikerjakan satu per satu, diuji lokal, dan
tidak otomatis dideploy.

## 1. Pastikan jalur baca tidak bergantung pada Python

```text
Rust → Redis
       ↓ miss
     PostgreSQL hasil analisis
       ↓ belum ada
     hasil terakhir yang valid / status diperbarui
```

Jangan tampilkan error “Cache halaman Python belum tersedia”. Jika Python
sedang sibuk, Rust harus mengembalikan snapshot terakhir atau skeleton, bukan
halaman kosong.

## 2. Gunakan transaksi dan outbox

```text
Rust menyimpan data mentah
        ↓
PostgreSQL commit + analysis_outbox dalam transaksi yang sama
        ↓
Python worker memproses data terdampak
        ↓
hasil analisis disimpan ke PostgreSQL
        ↓
cache versi lama dianggap stale
```

Dengan demikian tidak ada data mentah yang tersimpan tanpa tugas analisis.

## 3. Python hanya memproses data terdampak

Python tidak menghitung ulang seluruh database. Proses hanya untuk:

- balita yang baru ditambah atau diubah;
- riwayat pengukuran anak tersebut;
- ASI/MPASI anak tersebut;
- agregasi desa, posyandu, dan periode yang terdampak.

Gunakan `input_hash`, `source_version`, dan `analysis_version` agar proses
idempoten dan tidak menghitung data yang sama dua kali.

## 4. Optimalkan Python secara selektif

- Gunakan NumPy untuk perhitungan numerik batch jika profiling membuktikan perlu.
- Gunakan Pandas/Polars untuk statistik dan pelatihan offline, bukan setiap request.
- Gunakan worker multiprocessing untuk batch besar.
- Gunakan cache hasil WHO dan hasil grafik.
- Simpan grafik yang sudah dibuat agar tidak dirender ulang setiap kali dibuka.

## 5. Optimalkan Rust dan PostgreSQL

- Connection pooling.
- Prepared statement.
- Indeks untuk `unit_id`, `desa_id`, `posyandu_id`, `measurement_date`, dan kelompok umur.
- Pagination wajib; jangan mengambil 30 ribu pengukuran sekaligus.
- Materialized result table untuk tabel balita dan dashboard.
- Query agregasi sederhana tetap dikerjakan PostgreSQL.

## 6. Perkuat batas Rust–Python

Gunakan protobuf/gRPC dengan:

- schema versioning;
- backward compatibility;
- timeout;
- retry terbatas;
- circuit breaker;
- validasi request dan response;
- generated client yang sama versinya.

## 7. Tutup kelemahan operasional

Tambahkan monitoring untuk:

- cache hit/miss;
- waktu query PostgreSQL;
- waktu analisis Python;
- panjang antrean;
- jumlah retry dan dead-letter;
- penggunaan CPU/RAM;
- hasil analisis stale;
- kegagalan grafik.

Jika Python tidak sehat, Rust tetap melayani data hasil analisis terakhir.

## 8. Deployment dan keamanan

- Rust dan Python dijalankan sebagai service/container terpisah.
- Health check dan readiness check.
- Rolling atau blue-green deployment.
- Migrasi database backward-compatible.
- Secret gRPC hanya di jaringan internal.
- Backup PostgreSQL dan uji pemulihan berkala.

## 9. Pengujian skala nyata

Uji dengan minimal:

- 3.700 balita;
- 30.000 pengukuran;
- banyak kader mengakses bersamaan;
- Python mati sementara;
- Redis kosong;
- antrean analisis menumpuk;
- perubahan data bersamaan.

Target akhirnya:

```yaml
Read normal       : Rust → Redis/PostgreSQL
Write perubahan   : Rust → PostgreSQL → Queue
Analysis          : Python worker
Persistence       : PostgreSQL
Realtime          : PostgreSQL NOTIFY → Rust → SSE
Graph             : Python → cache/database
```

Rust tidak dibebani analitik dan Python tidak dibebani seluruh request
pengguna. Kompleksitas dua bahasa dikendalikan melalui kontrak gRPC, worker,
versioning, cache, dan monitoring.

## Pemisahan service yang diterapkan

Gateway `oracle-api` tetap menjadi satu-satunya endpoint HTTPS publik. Di
jaringan internal, request dipisah berdasarkan tanggung jawab:

```text
Browser → oracle-api
             ├─ identity-service   (login, MFA, akun)
             ├─ read-service       (GET tabel/dashboard + POST analisis)
             ├─ write-service      (POST/PATCH/DELETE mutasi + outbox)
             ├─ realtime-service   (PostgreSQL NOTIFY → SSE)
             ├─ monitoring-service (metrik operasional)
             └─ analysis-worker    (Rust/PyO3 → CPython untuk analitik)
```

`read-service` dibangun dengan `ORACLE_API_NATIVE_WRITES_ENABLED=false`, dan
`write-service` dengan `ORACLE_API_NATIVE_READS_ENABLED=false`; pembatasan ini
berlaku di gateway, kontrak gRPC, dan domain handler. `operations-service`
masih ada pada Compose profile `legacy` untuk rollback, tetapi tidak ikut
jalur produksi. Transport satu host menggunakan UDS `/run/e-posyandu/read.sock`
dan `/run/e-posyandu/write.sock`; URL TCP tetap tersedia untuk pemisahan VM.

## MCP Server (diimplementasikan lokal, belum dideploy)

MCP Server menjadi lapisan asisten terkontrol untuk kader dan
Ahli Gizi. MCP tidak menjadi jalur baca utama frontend, tidak menghitung ulang
hasil analisis, dan tidak mengakses PostgreSQL secara langsung.

```text
AI assistant / kader → MCP Server → Read Service / Write Service
                                      ↓
                              Redis / PostgreSQL
                                      ↓
                              Python Analysis Worker
```

### Fungsi baca

- `get_child_summary` — ringkasan balita dari hasil Python.
- `list_children` — daftar berdasarkan usia, lokasi, status gizi, dan N/T/O/B.
- `get_growth_history` — riwayat pengukuran dan tren pertumbuhan.
- `get_measurement_analysis` — WHO, z-score, risiko, dan analisis Python.
- `get_dashboard_summary` — ringkasan agregasi dashboard.
- `get_breastfeeding_status` — status ASI eksklusif usia 0–5/6 bulan.
- `get_mpasi_status` — status MPASI usia 6–23 bulan.
- `get_pmt_status` — riwayat dan status PMT.
- `get_recommendation_history` — riwayat rekomendasi tindak lanjut.
- `get_recommendation` — pratinjau keputusan tindak lanjut otomatis dari
  sinyal hasil analisis Python; kader tidak memilih kode.
- `get_growth_chart` — grafik yang sudah dibuat Python.

### Fungsi edukasi

- `get_education` — edukasi sesuai usia dan status gizi.
- `get_risk_recommendation` — rekomendasi tindak lanjut dari risiko yang dihitung Python.
- `get_feeding_guidance` — ASI, MPASI, Isi Piringku, dan pemberian makan.
- `search_guideline` — materi WHO/Kemenkes yang telah disetujui.
- `generate_cadre_script` — bahasa sederhana untuk kader.
- `record_education_delivery` — pencatatan bahwa edukasi telah diberikan.

### Fungsi pencatatan

- `record_recommendation` — kunjungan, observasi, tindakan, rencana, atau rujukan;
  kode dan kalimat dipilih sistem dari sinyal Python agar kader tidak perlu
  memilih kode atau mengetik manual. Status T mendapat rekomendasi edukasi
  khusus dan pemantauan lebih dekat.
- `update_recommendation` — perubahan catatan sesuai kewenangan.
- `record_referral` — pencatatan rujukan tanpa diagnosis.
- `request_report_export` — permintaan laporan melalui job asynchronous.

Role `Ahli Gizi`/`super_admin` dapat membuat, mengedit, dan menyetujui
rekomendasi tindak lanjut. Kader dapat membuat catatan dalam scope desa/Posyandu-nya. Semua
mutasi melewati `write-service`, konfirmasi, dan audit log.

MCP tidak boleh menghitung WHO, z-score, N/T/O/B, status gizi, atau risiko;
membuat diagnosis/resep; mengubah hasil Python; melewati pembatasan lokasi;
atau mengirim NIK mentah ke model AI eksternal. Hasil MCP selalu diberi label
edukasi/screening, bukan diagnosis.

Implementasi tahap pertama berada di `services/mcp-service`. Endpoint `POST /mcp`
memakai JSON-RPC 2.0 melalui Streamable HTTP dan `GET /health` untuk
health check dasar. Tool yang aktif saat ini adalah `list_children`,
`get_child_summary`, `get_measurement_analysis`, `get_education`,
`get_dashboard_summary`, `get_growth_chart`, `get_breastfeeding_status`,
`get_mpasi_status`, `get_pmt_status`, `get_recommendation_history`,
`get_recommendation`,
`record_recommendation`, dan `record_education_delivery`.

Service memerlukan `MCP_SHARED_SECRET` dan token gRPC internal dari OCI Vault,
menolak Origin di luar `MCP_ALLOWED_ORIGINS`, membatasi ukuran payload dan
pagination, serta tidak mempublikasikan port melalui Caddy/Cloudflare.
Operasi tulis selalu memerlukan `confirmed=true`; role, scope wilayah,
transaksi, outbox, dan audit tetap ditegakkan oleh WriteService. Tool edukasi
dan analisis hanya meneruskan payload ke Python melalui ReadService sehingga
MCP tidak membuat aturan klinis baru. Tool lain seperti pencarian pedoman,
skrip kader, rujukan terstruktur, dan ekspor job tetap menjadi tahap lanjutan.
Service sudah diuji lokal dan belum dijalankan pada deployment produksi.
Compose menempatkannya pada profile `mcp`; deployment `all` tidak otomatis
menyalakan adapter ini sebelum secret MCP disiapkan.

## Status pengerjaan

- Poin 1: implementasi lokal tersedia; belum dideploy.
- Poin 2: implementasi lokal tersedia; persistensi snapshot dashboard memakai
  queue Python berbatas dan retry; belum dideploy.
- Poin 3: implementasi lokal tersedia; worker hanya memproses child yang
  terdampak, memakai `input_hash` dan `source_version`, serta mempertahankan
  `analysis_version` ketika input tidak berubah; belum dideploy.
- Poin 4: implementasi lokal tersedia; operasi LMS dan hasil SVG grafik memakai
  cache bounded process-local, sedangkan NumPy/Pandas/Polars dipisahkan untuk
  batch/offline melalui requirements training; belum dideploy.
- Poin 5: implementasi lokal tersedia; Rust memakai pool PostgreSQL berbatas
  dengan timeout tunggu/buat/recycle dan prepared statement cache, sedangkan
  migrasi 044 menambah indeks jalur baca untuk paging, join riwayat, hasil
  Python, dan snapshot dashboard; belum dideploy.
- Poin 6–9: belum dikerjakan dan harus dilakukan bertahap setelah poin
  sebelumnya diverifikasi.
