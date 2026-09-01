# Deployment Platform Oracle

Cloudflare Pages menjalankan frontend, sedangkan Oracle menjalankan gateway
`oracle-api`, `identity-service`, `operations-service`, `realtime-service`,
`monitoring-service`, `data-processing-worker`, serta `analysis-service` Python sebagai
origin backend produksi. `analysis-service` hanya menghitung indikator WHO
secara deterministik menggunakan tabel LMS yang dicheck-in, lalu menjalankan
screening risiko logistic ringan, analisis tren grafik, dan deteksi anomali
kualitas data. Screening ini advisory (bukan diagnosis) dan belum menjadi
keputusan klinis otomatis.
PostgreSQL native pada
OCI Block Volume adalah primary writable untuk data inti aplikasi. Supabase
masih menyediakan Auth serta jalur legacy untuk Queue/R2 dan job berkas selama
masa transisi; tabel inti tidak lagi ditulis melalui Supabase.
Cloudflare berada di depan Oracle untuk DNS, proxy/WAF, DDoS, Turnstile,
Tunnel, Queue, R2, serta jalur rollback Worker/Pages. Tidak ada failover tulis
otomatis ke database Oracle.

Urutan migrasi yang aman:

1. Deploy Oracle dengan mode `proxy`, lalu uji API internal.
2. Materialisasi seluruh secret dari OCI Vault dan aktifkan mode `auth`,
   `reads`, lalu `full`; setiap tahap memiliki health check dan rollback.
3. Buat Cloudflare Tunnel menuju listener internal `health-proxy:8088`.
4. Delegasikan DNS ke Cloudflare dan uji login, CRUD, sinkronisasi offline,
   ekspor, Queue/R2, serta grafik dari jaringan desktop dan seluler.
5. Ubah bind publik Oracle menjadi loopback, tutup ingress OCI 80/443, dan
   pertahankan Worker/Pages dalam keadaan tidak menerima trafik normal sebagai
   rollback darurat.

Status produksi sejak 25 Agustus 2026 adalah mode `full`: autentikasi gateway,
pembacaan, dan penulisan data inti memakai backend Oracle dengan koneksi
PostgreSQL native. Endpoint job internal tetap diproksikan sebagai satu unit ke
jalur legacy agar metadata Queue dan berkas R2 tidak terpecah antar-database.

Jangan menghapus Worker Cloudflare atau Pages. Keduanya adalah rollback
darurat, sedangkan Queue dan R2 tetap komponen produksi yang aktif. Pastikan
Hanya satu consumer Queue (`data-processing-worker` Oracle) yang berjalan. Setiap service
dapat dirilis terpisah; deployment service tidak me-restart service lain yang
sedang sehat.

Untuk deployment microservice Oracle, argumen ketiga pada script menentukan
target: `oracle-api`, `identity-service`, `operations-service`, `realtime-service`,
`monitoring-service`, `data-processing-worker`, `analysis-service`, atau `all`.

```bash
# Hanya API native Oracle
npm run oracle:deploy:api -- eposyandu-oracle nutrition.example.go.id

# Hanya data-processing worker
npm run oracle:deploy:data-processing -- eposyandu-oracle nutrition.example.go.id

# Hanya kalkulator WHO Python
npm run oracle:deploy:analysis -- eposyandu-oracle nutrition.example.go.id

# Hanya satu domain service
npm run oracle:deploy:identity -- eposyandu-oracle nutrition.example.go.id
npm run oracle:deploy:operations -- eposyandu-oracle nutrition.example.go.id
npm run oracle:deploy:realtime -- eposyandu-oracle nutrition.example.go.id
npm run oracle:deploy:monitoring -- eposyandu-oracle nutrition.example.go.id
```

Setiap service memakai Dockerfile dan image sendiri. Service yang berada pada
VM yang sama berkomunikasi melalui gRPC di atas UDS pada volume
`/var/lib/e-posyandu/grpc`; endpoint gRPC TCP tetap dapat dipilih dengan
environment URL bila service dipindahkan ke server/platform lain. Compose hanya menjalankan
`up --no-deps` pada target, sehingga Redis, Caddy, Tunnel, dan service lain tidak
ikut di-restart. Migration database dijalankan terpisah sebelum service yang
membutuhkan skema baru dirilis.

Pada rilis penuh, worker mengirim batch pengukuran ke `analysis-service` melalui
`ANALYSIS_GRPC_URL=unix:///run/e-posyandu/analysis.sock` dan
`ANALYSIS_GRPC_ENABLED=true`. Deploy worker saja boleh memakai
`ANALYSIS_GRPC_ENABLED=false` ketika service analisis belum dirilis, tetapi
job `nutrition_report` akan gagal-terkontrol (tanpa fallback kalkulator Rust)
sampai health check kedua service berhasil.

Frontend tidak dibangun atau dijalankan pada VM Oracle. `eposyandu.app` dan
`www.eposyandu.app` dilayani oleh Cloudflare Pages; hanya hostname API dan
health data-processing worker yang diarahkan melalui Tunnel ke Oracle.

## Cache Redis privat

Deployment menjalankan `redis-cache` pada bridge privat terpisah tanpa port
host. `oracle-api` menyimpan hasil baca balita, penimbangan, dan koleksi
dinamis selama 5 menit; dashboard operasional selama 60 detik. Key menyertakan versi serta hash cakupan
peran/desa/posyandu; mutasi data menaikkan versi sehingga hasil lama langsung
ditinggalkan. Redis dibatasi 128 MB dengan kebijakan `volatile-lru` dan tidak
memakai persistence karena PostgreSQL native tetap sumber data utama.

Cloudflare KV tidak digunakan untuk cache domain dinamis. KV hanya menyimpan
konfigurasi global yang jarang berubah seperti feature flag, menu, dan referensi.
Health `GET /api/v1/health/ready` menampilkan keterjangkauan Redis dan akan
berstatus `degraded` bila cache tidak tersedia tanpa mengalihkan sumber data.

Proxy Pages membaca environment variable non-secret `PRODUCTION_API_ORIGIN`.
Nilai default tetap Worker lama. Saat cutover, isi dengan
`https://api.eposyandu.app`; untuk rollback, hapus variable tersebut atau
kembalikan ke URL Worker lama. Jangan mengubah `STAGING_API_ORIGIN` menjadi
origin produksi.

Deployment juga menerbitkan metrik kustom `eposyandu.ApiUp` dan
`eposyandu.TunnelUp`. Setelah cutover, buat alarm `ApiUp[1m].min() < 1` dan
`TunnelUp[1m].min() < 1` dengan pending duration lima menit serta topic email
operasional yang sudah ada. Metrik hanya berisi status hidup/mati dan tidak
memuat payload maupun identitas pasien.

## Spesifikasi instance

- OCI Ampere A1, Oracle Linux 9 ARM64 (Ubuntu/Debian juga tetap didukung).
- Awal yang cukup: 1 OCPU, RAM sekitar 6 GB, boot volume minimal 30 GB.
- IP publik statis/reserved hanya dibutuhkan selama bootstrap/cutover.
- Saat final, tidak ada ingress publik 22/80/443. SSH melalui OCI Bastion dan
  trafik web melalui Cloudflare Tunnel outbound-only. Jangan pernah membuka
  50051, 8080, 8081, 8088, atau 2000 ke internet.

## Menyiapkan akses

Simpan private key hanya di komputer pengelola dan buat alias SSH:

```sshconfig
Host eposyandu-oracle
  HostName IP_PUBLIK_ORACLE
  User opc
  IdentityFile ~/.ssh/id_ed25519_oracle
  IdentitiesOnly yes
```

Jangan mengirim atau menyimpan private key di repository.

## Secret runtime

Nama file konfigurasi lama `nutrition-grpc.env` dan `nutrition-grpc-vault.env`
dipertahankan sebagai alias kompatibilitas; service yang dijalankan tetap
`data-processing-worker` dan socket aktifnya `data-processing.sock`.

Salin contoh konfigurasi ke lokasi privat:

```bash
mkdir -p ~/.config/e-posyandu
cp deploy/oracle/nutrition-grpc.env.example \
  ~/.config/e-posyandu/nutrition-grpc.env
chmod 600 ~/.config/e-posyandu/nutrition-grpc.env
```

Isi ID akun/Queue Cloudflare dan URL API. Token Queue serta
`RUST_WORKER_SHARED_SECRET` disimpan di OCI Vault, bukan di archive deployment.
Buat `/etc/e-posyandu/vault.env` dari
`deploy/oracle/vault/eposyandu-vault.env.example`, lalu isi OCID secret yang
telah dibuat di Vault. File ini hanya berisi metadata non-secret dan harus
dimiliki root dengan mode `0600`.

Saat boot atau deployment, instance principal mengambil secret ke
`/run/e-posyandu/nutrition-grpc-vault.env` (tmpfs, mode `0600`) untuk container.
Nilai secret tidak pernah masuk image, archive aplikasi, log, atau Git.

## Cloudflare Tunnel dan cutover final

Buat remotely-managed tunnel bernama `eposyandu-oracle-production`. Salin hanya
token `eyJ...` dari perintah instalasi ke secret OCI Vault, misalnya
`E_POSYANDU_CLOUDFLARE_TUNNEL_TOKEN`; jangan menjalankan perintah instalasi yang
menaruh token di command line server. Masukkan OCID secret-nya ke konfigurasi
server:

```dotenv
OCI_SECRET_CLOUDFLARE_TUNNEL_TOKEN_ID=ocid1.vaultsecret...
```

Jalankan ulang materializer Vault. Token akan berada di tmpfs
`/run/e-posyandu/cloudflare-tunnel-token` dengan mode `0600` dan dibaca
`cloudflared` melalui `TUNNEL_TOKEN_FILE`.

Tambahkan dua published application route pada tunnel. Keduanya memakai service
internal yang sama, tetapi **HTTP Host Header harus sama dengan hostname**:

| Public hostname | Service | HTTP Host Header |
| --- | --- | --- |
| `api.eposyandu.app` | `http://health-proxy:8088` | `api.eposyandu.app` |
| `nutrition.eposyandu.app` | `http://health-proxy:8088` | `nutrition.eposyandu.app` |

Sebelum mengganti nameserver di registrar, salin seluruh record DNS yang masih
dipakai ke zone Cloudflare. Inventaris aplikasi saat migrasi adalah apex/API/
nutrition menuju Oracle dan `www` menuju apex, tetapi record email atau
verifikasi yang terlihat di registrar tetap harus dipertahankan. Proxy hanya
record web; record email tidak boleh memakai proxy oranye.

Setelah token dan route siap, ubah konfigurasi host:

```dotenv
COMPOSE_PROFILES=cloudflare-tunnel
ORACLE_PUBLIC_BIND=0.0.0.0
```

Deploy ulang, tunggu Tunnel berstatus `Healthy`, delegasikan nameserver domain
ke dua nameserver Cloudflare, lalu uji endpoint publik. Setelah respons memuat
`Server: cloudflare` dan `CF-Ray`, selesaikan penutupan origin:

```dotenv
ORACLE_PUBLIC_BIND=127.0.0.1
```

Deploy ulang sekali lagi, lalu hapus ingress publik OCI untuk TCP 80/443 dan
UDP 443. SSH publik 22 tetap ditutup; akses administrasi hanya melalui OCI
Bastion. `cloudflared` hanya membutuhkan koneksi keluar TCP/UDP 7844.

Pemeriksaan akhir dari komputer pengelola:

```bash
npm run oracle:cutover:check -- eposyandu-oracle eposyandu.app
```

Untuk rollback trafik, arahkan route Cloudflare ke Worker/Pages lama atau
nonaktifkan proxy DNS sesuai runbook. Rollback database dilakukan melalui
backup terverifikasi, bukan dengan mempromosikan resource Oracle yang sudah
dihapus.

## Backup terenkripsi

Backup Oracle hanya berisi konfigurasi deployment, Caddyfile, unit systemd,
manifest rilis, dan metadata operasional. Backup tidak berisi database dump,
NIK, data kesehatan, payload Queue, file secret runtime, atau data TLS Caddy.

Database native memiliki timer terpisah
`eposyandu-postgresql-backup.timer`. Timer membuat dump custom PostgreSQL,
memverifikasinya dengan `pg_restore --list`, mengenkripsi hasilnya dengan GPG
AES-256, lalu mengunggah objek write-only ke prefix `production/oracle/`.

Buat bucket Object Storage **private** bernama, misalnya,
`eposyandu-oracle-backups`. Namespace Object Storage akun ini adalah
`axf8c8ghakg4`. Atur lifecycle bucket untuk menghapus objek dengan prefix
`production/` setelah masa retensi yang disetujui (contoh 30 hari).

Buat secret Vault baru, misalnya `E_POSYANDU_BACKUP_PASSPHRASE`, berisi
passphrase acak minimal 20 karakter. Simpan nilainya hanya di Vault. Tambahkan
policy least-privilege berikut pada dynamic group `eposyandu-grpc-worker-dg`,
dengan mengganti compartment dan OCID secret sesuai tenancy:

```text
Allow dynamic-group eposyandu-grpc-worker-dg to manage objects in tenancy where all {target.bucket.name='eposyandu-oracle-backups', any {request.permission='OBJECT_CREATE'}}
Allow dynamic-group eposyandu-grpc-worker-dg to read secret-bundles in tenancy where target.secret.id='<BACKUP_PASSPHRASE_SECRET_OCID>'
```

Policy pertama sengaja hanya mengizinkan pembuatan objek baru pada bucket
backup khusus; worker tidak dapat membaca atau menghapus backup. Prefix
`production/` tetap dipakai oleh aplikasi dan dibatasi oleh lifecycle bucket.
Penghapusan otomatis dilakukan oleh lifecycle Object Storage, bukan oleh VM.

Buat `/etc/e-posyandu/backup.env` di server dari
`deploy/oracle/backup/eposyandu-backup.env.example`, isi OCID secret passphrase,
lalu set permission `0600`. Setelah deployment berikutnya, timer
`eposyandu-backup.timer` berjalan sekali sehari. Arsip dibuat dengan GPG
AES-256 sebelum diunggah menggunakan instance principal; Object Storage juga
tetap menggunakan enkripsi server-side.

Pemeriksaan backup tanpa membuka isinya:

```bash
sudo systemctl status eposyandu-backup.timer --no-pager
sudo journalctl -u eposyandu-backup.service -n 30 --no-pager
sudo systemctl status eposyandu-postgresql-backup.timer --no-pager
sudo journalctl -u eposyandu-postgresql-backup.service -n 30 --no-pager
```

Untuk pemulihan, unduh objek dari bucket melalui akun administrator, ambil
passphrase dari Vault, dekripsi di direktori sementara yang terlindungi, dan
periksa `MANIFEST.json`. Jangan mengekstrak langsung ke `/etc` atau
`/opt/e-posyandu` sebelum konfigurasi diverifikasi.

## Deploy

Pastikan DNS health sudah mengarah ke Oracle, lalu jalankan dari root project:

```bash
npm run data-processing:deploy:oracle -- eposyandu-oracle nutrition.example.go.id
```

Perintah yang sama juga tersedia dengan nama yang lebih umum:

```bash
npm run oracle:deploy:data-processing -- eposyandu-oracle nutrition.example.go.id
```

Script memeriksa SSH, mengirim source yang diperlukan, memasang Podman resmi
Oracle Linux (atau Docker pada Ubuntu/Debian), membangun image ARM64,
menjalankan container non-root/read-only, dan memastikan health check internal
berhasil. Rilis berada di
`/opt/e-posyandu/releases`; symlink `current` hanya dipindah setelah container
berhasil aktif.

Setelah HTTPS aktif, hubungkan health check ke Cloudflare:

```bash
npm run data-processing:connect:oracle -- https://nutrition.example.go.id/health
```

## Pemeriksaan

```bash
curl --fail https://nutrition.example.go.id/health
ssh eposyandu-oracle \
  'sudo podman-compose -p e-posyandu-oracle -f /opt/e-posyandu/current/deploy/oracle/compose.yaml --env-file /etc/e-posyandu/nutrition-grpc.env ps'
```

Endpoint lain harus mengembalikan `404`. Hanya Caddy yang menerbitkan port;
service satu host memakai UDS dan tidak diterbitkan ke host. Bila worker
dipisahkan ke server lain, gunakan URL TCP privat dan firewall allowlist.
Periksa log tanpa menyalin secret:

```bash
ssh eposyandu-oracle \
  'sudo podman-compose -p e-posyandu-oracle -f /opt/e-posyandu/current/deploy/oracle/compose.yaml --env-file /etc/e-posyandu/nutrition-grpc.env logs --tail 100 data-processing-worker'
```

Hapus layanan Render/macOS lama hanya setelah Oracle sehat, job uji selesai,
dan status dashboard stabil. Jangan menjalankan dua Queue consumer dalam waktu
lama karena keduanya akan saling mengambil pesan.

## Tahap 2 selesai

Replika PostgreSQL standby Oracle telah dihentikan dan dihapus setelah dump
terenkripsi diverifikasi serta diunggah ke OCI Object Storage. Oracle
PostgreSQL native menjadi sumber kebenaran aplikasi; Supabase tetap
dipertahankan sebagai jalur legacy/rollback dan untuk komponen yang belum
dipindahkan. Jangan memasang kembali standby read-only tanpa keputusan migrasi
baru yang terdokumentasi.
