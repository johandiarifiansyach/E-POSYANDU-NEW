# Status Komponen Sistem

Dokumen ini membedakan komponen yang sudah aktif, fondasi yang sudah tersedia, dan fitur yang belum boleh diaktifkan sebelum kebutuhan produk serta perlindungan datanya jelas.

| No. | Komponen | Status | Keterangan |
| --- | --- | --- | --- |
| 1 | Service Worker | Aktif | Cache aset, offline shell, dan pembaruan cache rilis tersedia. |
| 2 | Database Migration | Aktif | Migration bernomor, registry `schema_migrations`, runner, dan Git. |
| 3 | Audit Log | Aktif | Login, CRUD, ekspor XLS, dan perubahan role/wilayah dicatat. |
| 4 | Request ID dan structured logging | Aktif | `X-Request-ID`, latency, route, status, dan environment. |
| 5 | Testing | Aktif | Unit Rust, integration contract, E2E desktop/ponsel, serta smoke test deployment setiap enam jam. |
| 6 | Monitoring | Aktif | Error, latency, cache hit, readiness seluruh komponen setiap 30 menit, status KV, peringatan Ahli Gizi, dan alarm eksternal opsional. |
| 7 | Backup dan restore | Siap diaktifkan | Backup terenkripsi, verifikasi archive, dan restore drill tersedia; jadwal menunggu secret database production/staging. |
| 8 | CI/CD | Siap diaktifkan | Build, test, migration, dan deploy otomatis tersedia; membutuhkan GitHub secrets dan `AUTO_DEPLOY=true`. |
| 9 | Feature flag | Aktif | Konfigurasi KV dapat diubah tanpa deploy untuk fitur yang sudah ditanam dalam kode. |
| 10 | OpenAPI | Aktif | Kontrak REST tersedia di `/api/v1/openapi.json` dan diperiksa oleh test. |
| 11 | Health check | Aktif | `/api/v1/health` ringan dan tidak membaca data balita. |
| 12 | Security headers | Aktif | CSP, HSTS, Referrer Policy, CORS terbatas, dan header browser lain. |
| 13 | PWA installable | Aktif | Manifest, standalone mode, icon, service worker, dan offline shell. |
| 14 | Accessibility | Aktif dan diuji | Bahasa dokumen, label form, keyboard, skip link, fokus, live region, serta audit otomatis WCAG AA pada Chrome/Safari desktop dan ponsel tersedia; audit manual tetap berkala. |
| 15 | Error tracking | Aktif | Error frontend terautentikasi masuk structured log backend tanpa data formulir. |
| 16 | Background job/queue | Siap deploy Oracle | Cloudflare Queue dan `data-processing-worker` menangani validasi impor, ekspor, sinkronisasi, dan orkestrasi job; kalkulasi WHO sepenuhnya berada di `analysis-service` Python. |
| 17 | Cloudflare R2 | Aktif | Upload/download privat, retensi 7 hari, dan pengaman kapasitas 9 GiB ke 8 GiB aktif. |
| 18 | Notification system | Aktif terbatas | Peringatan worker tersedia untuk Ahli Gizi; webhook/email eksternal bersifat opsional. |
| 19 | Webhook | Ditunda | Memerlukan sistem tujuan, signing secret, retry, dan allowlist. |
| 20 | Multi-language | Ditunda | Bahasa Indonesia tetap bahasa tunggal sampai kebutuhan pengguna terkonfirmasi. |
| 21 | Data export | Aktif | XLS/XLSX dan CSV aktif; permintaan data ekspornya diaudit serta tetap dibatasi cakupan wilayah akun. |
| 22 | User feedback | Ditunda | Form bug/saran akan dibuat setelah tujuan penerima dan retensi laporan ditetapkan. |
| 23 | Sesi HttpOnly | Siap diuji staging | BFF same-origin, cookie HttpOnly, Turnstile, rate limiter, dan penutupan RPC browser tersedia; verifikasi dua langkah tidak digunakan. |
| 24 | Tata kelola privasi | Baseline siap disahkan | Inventaris data, akses, retensi 25 tahun RME, ekspor, hak subjek, dan respons insiden terdokumentasi; pengesahan Puskesmas/Dinas tetap wajib. |
| 25 | Pelaporan CSP | Siap diuji staging | Endpoint same-origin membatasi ukuran/laju dan membuang query, referrer, script sample, serta IP mentah. |
| 26 | Perhitungan dan analisis gizi Python | Tahap 2 diimplementasikan — belum deploy/validasi klinis | `analysis-service` Python menghitung indikator WHO dengan rumus LMS deterministik, lalu menambahkan screening risiko logistic ringan, analisis tren grafik, deteksi anomali kualitas data, popup hasil analisis, dan penanda anomali pada grafik pertumbuhan. Prediksi/tren bersifat advisory, bukan diagnosis, dan tetap menunggu evaluasi klinis sebelum dipakai sebagai keputusan kesehatan. |

Prioritas berikutnya adalah mengisi secret backup/restore dan token akun uji pada GitHub Environment, menuntaskan project Supabase development dan staging yang terpisah, serta memperluas strict TypeScript secara bertahap. MQTT tetap ditunda sampai tersedia perangkat IoT nyata.

## Implementasi tahap 1–2 analisis gizi Python

Kalkulator WHO tahap 1 sudah diimplementasikan sebagai container
`services/analysis-service`. Service ini belum dideploy ke produksi pada tahap
ini. Tahap 2 sudah ditanam dalam kode tetapi belum diaktifkan/di-rollout ke
produksi pada dokumen ini. Evaluasi klinis, dataset berlabel, dan verifikasi
staging tetap wajib sebelum hasil screening dipakai sebagai keputusan medis.

### Topologi yang direncanakan

```text
Frontend
   |
oracle-api --> data-processing-worker -- gRPC/UDS --> analysis-service Python
   |                                             |
   +--> PostgreSQL Oracle                       +--> tabel LMS lokal
                                                 (tanpa akses database)
```

- `analysis-service` memakai Python dengan gRPC privat sebagai pelaksana
  kalkulasi status gizi WHO tahap 1. Akurasi ditentukan oleh implementasi
  standar WHO, dataset uji, dan validasi Ahli Gizi—bukan semata-mata oleh
  bahasa pemrograman.
- Kalkulasi WHO (BB/U, TB/U, BB/TB, IMT/U, LILA/LK, z-score, dan status gizi)
  harus menggunakan rumus matematika Python yang deterministik. Kalkulasi ini
  tidak menggunakan machine learning dan menjadi hasil resmi aplikasi.
- Komunikasi antarlayanan pada host Oracle menggunakan Unix Domain Socket;
  komunikasi lintas server/platform menggunakan gRPC melalui TCP.
- `data-processing-worker` mendelegasikan batch kalkulasi melalui gRPC/UDS ke
  service ini ketika `ANALYSIS_GRPC_ENABLED=true`; tidak ada kalkulator WHO
  lokal atau fallback Rust.
- Hasil cepat dapat dikembalikan untuk ditampilkan pada popup setelah
  penimbangan. Analisis berat atau batch dapat diproses melalui Queue dan tidak
  boleh menahan penyimpanan data utama.
- Popup hasil penimbangan sekarang memuat status BB/U, TB/U, BB/TB, LILA/LK,
  nilai z-score dari WHO, penjelasan sederhana, screening risiko, anomali,
  waktu proses, serta catatan bahwa hasil bukan diagnosis medis. Saat Queue
  belum tersedia, deteksi cepat tinggi turun tetap ditampilkan dan status
  layanan diberi peringatan.
- Grafik pertumbuhan pada popup dirender oleh `analysis-service` Python sebagai
  SVG menggunakan tabel LMS WHO yang sama dengan kalkulasi status. Label
  berbahasa Indonesia, kurva -3/-2/median/+2/+3 SD, dan titik riwayat dikirim
  melalui endpoint terautentikasi. Browser memasang SVG secara aman; Canvas
  lokal hanya menjadi fallback ketika service Python belum tersedia. Riwayat
  titik yang sama juga dikirim ke Python untuk ringkasan tren, perubahan rata-rata
  per bulan, kesimpulan, dan saran yang tampil di bawah grafik. Pemeriksaan tidak
  menggunakan AI/LLM atau layanan analitik pihak ketiga.
- Modul `ml.py` menjalankan screening logistic yang explainable untuk risiko
  stunting, wasting, dan underweight. Ia bukan pengganti kalkulasi WHO dan
  bukan AI generatif/LLM. Aturan kualitas juga mendeteksi tinggi turun,
  duplikasi tanggal, serta outlier median/MAD pada pengukuran berulang.
- Modul yang sama menjalankan baseline `growth-trend-logistic-v1` untuk membaca
  arah berat, tinggi, LILA, dan lingkar kepala dari riwayat grafik. Koefisiennya
  transparan dan ringan; confidence, kesimpulan, serta saran ditampilkan
  sebagai skrining dan bukan diagnosis.
- Model baseline sengaja memakai standard library Python agar ringan di server
  Oracle yang sama. Ini adalah inference awal tanpa dataset training klinis;
  hasilnya harus diperlakukan sebagai skrining advisory sampai model
  tervalidasi.
- Dataset training wajib dianonimkan dan memiliki label yang divalidasi Ahli
  Gizi/Puskesmas. Evaluasi harus mencakup train/validation/test berbasis waktu,
  precision, recall, sensitivity, specificity, kalibrasi, dan pemantauan model
  drift.
- Container Python diberi batas CPU/RAM, health check, timeout, dan fallback
  agar machine learning tidak mengganggu service Oracle lain. Hasil popup
  wajib menampilkan tingkat keyakinan, faktor pendukung, waktu model, serta
  keterangan bahwa prediksi bukan diagnosis medis.
- Jika service Python tidak tersedia, frontend tidak menghitung ulang status
  gizi secara mandiri; frontend hanya menampilkan deteksi cepat kualitas data
  dan status layanan tidak tersedia. Status WHO resmi tetap berasal dari
  hasil Python ketika job selesai.
- Data kesehatan tidak boleh ditulis ke log, dikirim ke layanan analitik
  pihak ketiga, atau diproses di luar scope wilayah akun.

### Analisis kartu dashboard berikutnya

- Semua kartu, indikator, dan panel metrik yang tampil di dashboard—bukan
  hanya S, D, N, T, B, dan O—direncanakan dapat dipilih.
- Saat item dashboard dipilih, aplikasi membuka panel detail dan memuat grafik
  tren bulanan serta analisis sesuai filter desa/posyandu dan periode yang
  dipilih. Data detail dimuat secara lazy hanya setelah item dibuka agar
  dashboard awal tetap ringan pada koneksi dan perangkat rendah.
- Cakupan ini mengikuti seluruh indikator yang saat ini ada di dashboard dan
  harus otomatis mencakup indikator baru yang ditambahkan kemudian.
- Contoh kartu D (balita ditimbang) menampilkan jumlah dan persentase tiap
  bulan, pembanding sasaran/total balita, perubahan terhadap bulan sebelumnya,
  serta bulan yang datanya belum lengkap.
- `analysis-service` Python menerima agregat yang sudah dibatasi scope akun,
  lalu mengembalikan ringkasan tren, perubahan bermakna, indikasi anomali,
  dan penjelasan bahasa sederhana untuk ditampilkan bersama chart.
- Analisis agregat tidak boleh mengirim identitas balita ke Python dan tidak
  boleh menampilkan angka yang cakupannya lebih luas dari hak akses akun.
- Kegagalan Python tidak menghilangkan grafik dasar; frontend tetap
  menampilkan agregat resmi dan memberi status bahwa analisis lanjutan tidak
  tersedia.

## Pemisahan `data-processing-service` (sudah dieksekusi)

Pemisahan nama dan tanggung jawab ini sudah diterapkan serta diuji tanpa
mengubah role, desa, posyandu, atau hak akses akun.

- `data-processing-service` menjadi nama layanan dan `data-processing-worker`
  menjadi nama container/binary.
- Setelah pemisahan, layanan tersebut hanya menangani validasi impor, ekspor,
  dan pemrosesan job queue. Perhitungan/status gizi tidak lagi menjadi tanggung
  jawabnya.
- `analysis-service` Python menjadi layanan khusus perhitungan gizi dan
  analisis. Komunikasi internal tetap menggunakan gRPC melalui UDS pada host
  yang sama dan gRPC melalui TCP lintas server/platform.
- Perubahan nama meliputi compose, health check, konfigurasi socket, proto,
  client `oracle-api`, deployment, monitoring, dan dokumentasi.

### Gerbang sebelum eksekusi

1. Menetapkan definisi indikator, ambang risiko, aturan anomali, dan format
   penjelasan bersama Ahli Gizi/Puskesmas.
2. Menyiapkan dataset uji tanpa identitas serta membandingkan hasil Python
   dengan kalkulasi WHO yang sudah ada.
3. Menetapkan batas CPU/RAM container dan health check agar tidak mengganggu
   delapan service Oracle yang sedang berjalan.
4. Menguji fallback lokal, audit akses, retensi hasil, dan rollback di staging.
5. Untuk machine learning, menetapkan versi model, ambang keputusan, baseline
   non-ML, uji bias per kelompok wilayah/usia, dan prosedur rollback sebelum
   prediksi ditampilkan kepada pengguna.
