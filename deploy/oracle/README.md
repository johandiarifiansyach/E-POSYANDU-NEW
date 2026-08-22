# Deployment Platform Oracle

Oracle menjalankan frontend, `oracle-api`, dan `nutrition-grpc` sebagai origin
produksi utama. Supabase tetap menjadi **satu-satunya database writable** dan
layanan identitas; PostgreSQL Oracle hanya standby baca berkala, bukan primary
kedua. Cloudflare berada di depan Oracle untuk DNS, proxy/WAF, DDoS, Turnstile,
Tunnel, Queue, R2, serta jalur rollback Worker/Pages. Tidak ada failover tulis
otomatis ke database Oracle.

Urutan migrasi yang aman:

1. Deploy Oracle dengan mode `proxy`, lalu uji frontend/API internal.
2. Materialisasi seluruh secret dari OCI Vault dan aktifkan mode `auth`,
   `reads`, lalu `full`; setiap tahap memiliki health check dan rollback.
3. Buat Cloudflare Tunnel menuju listener internal `health-proxy:8088`.
4. Delegasikan DNS ke Cloudflare dan uji login, CRUD, sinkronisasi offline,
   ekspor, Queue/R2, serta grafik dari jaringan desktop dan seluler.
5. Ubah bind publik Oracle menjadi loopback, tutup ingress OCI 80/443, dan
   pertahankan Worker/Pages dalam keadaan tidak menerima trafik normal sebagai
   rollback darurat.

Jangan menghapus Worker Cloudflare atau Pages. Keduanya adalah rollback
darurat, sedangkan Queue dan R2 tetap komponen produksi yang aktif. Pastikan
hanya satu consumer Queue (`nutrition-grpc` Oracle) yang berjalan.

Image frontend juga dibangun di VM dan hanya diterbitkan pada loopback
`127.0.0.1:8082` untuk pemeriksaan internal. Nilai awal
`ORACLE_FRONTEND_SITE=http://frontend.invalid` sengaja membuatnya tidak dapat
diakses dari internet. Jangan mengganti nilai tersebut dengan `eposyandu.app`
sebelum DNS, daftar hostname widget Turnstile, CORS backend, dan uji rollback
selesai. Browser mengakses API melalui origin yang sama sehingga token sesi
tidak perlu dikirim lintas-origin.

`ORACLE_FRONTEND_TURNSTILE_SITE_KEY` adalah site key publik, bukan secret. Jika
nilai itu belum ada pada konfigurasi deployment privat, script deploy membaca
`VITE_TURNSTILE_SITE_KEY` dari `frontend/.env` tanpa mencetak nilainya. Secret
key Turnstile tetap hanya boleh disimpan di backend/Vault.

Saat cutover, isi `ORACLE_FRONTEND_SITE=eposyandu.app`,
`ORACLE_FRONTEND_WWW_SITE=www.eposyandu.app`, dan
`ORACLE_FRONTEND_CANONICAL_ORIGIN=https://eposyandu.app`. Hostname `www`
selalu dialihkan permanen ke apex agar sesi, Turnstile, dan URL kanonis hanya
memakai satu origin.

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

Tambahkan empat published application route pada tunnel. Semua memakai service
internal yang sama, tetapi **HTTP Host Header harus sama dengan hostname**:

| Public hostname | Service | HTTP Host Header |
| --- | --- | --- |
| `eposyandu.app` | `http://health-proxy:8088` | `eposyandu.app` |
| `www.eposyandu.app` | `http://health-proxy:8088` | `www.eposyandu.app` |
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
nonaktifkan proxy DNS sesuai runbook. Jangan mempromosikan standby PostgreSQL
Oracle menjadi writable saat rollback.

## Backup konfigurasi terenkripsi

Backup Oracle hanya berisi konfigurasi deployment, Caddyfile, unit systemd,
manifest rilis, dan metadata operasional. Backup tidak berisi database dump,
NIK, data kesehatan, payload Queue, file secret runtime, atau data TLS Caddy.

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
```

Untuk pemulihan, unduh objek dari bucket melalui akun administrator, ambil
passphrase dari Vault, dekripsi di direktori sementara yang terlindungi, dan
periksa `MANIFEST.json`. Jangan mengekstrak langsung ke `/etc` atau
`/opt/e-posyandu` sebelum konfigurasi diverifikasi.

## Deploy

Pastikan DNS health sudah mengarah ke Oracle, lalu jalankan dari root project:

```bash
npm run grpc:deploy:oracle -- eposyandu-oracle nutrition.example.go.id
```

Perintah yang sama juga tersedia dengan nama yang lebih umum:

```bash
npm run oracle:deploy -- eposyandu-oracle nutrition.example.go.id
```

Script memeriksa SSH, mengirim source yang diperlukan, memasang Podman resmi
Oracle Linux (atau Docker pada Ubuntu/Debian), membangun image ARM64,
menjalankan container non-root/read-only, dan memastikan health check internal
berhasil. Rilis berada di
`/opt/e-posyandu/releases`; symlink `current` hanya dipindah setelah container
berhasil aktif.

Setelah HTTPS aktif, hubungkan health check ke Cloudflare:

```bash
npm run grpc:connect:oracle -- https://nutrition.example.go.id/health
```

## Pemeriksaan

```bash
curl --fail https://nutrition.example.go.id/health
ssh eposyandu-oracle \
  'sudo podman-compose -p e-posyandu-oracle -f /opt/e-posyandu/current/deploy/oracle/compose.yaml --env-file /etc/e-posyandu/nutrition-grpc.env ps'
```

Endpoint lain harus mengembalikan `404`. Hanya Caddy yang menerbitkan port;
gRPC berada pada `127.0.0.1:50051` di dalam container. Periksa log tanpa
menyalin secret:

```bash
ssh eposyandu-oracle \
  'sudo podman-compose -p e-posyandu-oracle -f /opt/e-posyandu/current/deploy/oracle/compose.yaml --env-file /etc/e-posyandu/nutrition-grpc.env logs --tail 100 nutrition-worker'
```

Hapus layanan Render/macOS lama hanya setelah Oracle sehat, job uji selesai,
dan status dashboard stabil. Jangan menjalankan dua Queue consumer dalam waktu
lama karena keduanya akan saling mengambil pesan.

## PostgreSQL standby read-only

Standby Oracle adalah salinan baca berkala dari empat tabel laporan
(`children`, `measurements`, `mpasi_logs`, dan `eposyandu_growth_lms`). Supabase
tetap menjadi primary tunggal untuk login dan seluruh operasi tulis. Desain ini
bukan multi-primary: aplikasi tidak boleh menulis ke PostgreSQL Oracle karena
dua primary tanpa konsensus berisiko menimbulkan konflik dan kehilangan data.

Database standby tidak menerbitkan port ke host maupun internet. Hanya jaringan
container internal yang dapat menjangkaunya. Volume OCI mengenkripsi data saat
tersimpan; role `eposyandu_reader` juga dipaksa memakai
`default_transaction_read_only=on` dan hanya memperoleh `SELECT`.

Buat tiga secret terpisah di OCI Vault:

- `E_POSYANDU_STANDBY_SOURCE_DATABASE_URL`: URL direct atau Session Pooler
  Supabase production port 5432.
- `E_POSYANDU_STANDBY_POSTGRES_PASSWORD`: password acak minimal 32 karakter
  untuk pemilik sinkronisasi lokal.
- `E_POSYANDU_STANDBY_READER_PASSWORD`: password acak berbeda minimal 32
  karakter untuk role aplikasi read-only.

Tambahkan OCID ketiganya ke `/etc/e-posyandu/vault.env` memakai nama variabel
berikut (file hanya berisi OCID, bukan nilai secret):

```dotenv
OCI_SECRET_ORACLE_STANDBY_SOURCE_DATABASE_URL_ID=ocid1.vaultsecret...
OCI_SECRET_ORACLE_STANDBY_POSTGRES_PASSWORD_ID=ocid1.vaultsecret...
OCI_SECRET_ORACLE_STANDBY_READER_PASSWORD_ID=ocid1.vaultsecret...
```

Dynamic group instance harus mempunyai izin `read secret-bundles` yang dibatasi
ke ketiga OCID tersebut. Setelah itu, pasang standby dari komputer pengelola:

```bash
npm run oracle:standby:deploy -- eposyandu-oracle
```

Perintah tersebut mengambil secret melalui instance principal, membuat snapshot
awal, memverifikasi role read-only, dan memasang sinkronisasi setiap 15 menit.
Secret hanya dimaterialisasi ke `/run/e-posyandu` (tmpfs, mode `0600`). Snapshot
tidak pernah diunggah ke Object Storage dan PostgreSQL tidak membuka port
publik. Status dapat diperiksa tanpa menampilkan data pasien:

```bash
ssh eposyandu-oracle \
  'sudo systemctl status eposyandu-oracle-standby-sync.timer --no-pager'
ssh eposyandu-oracle \
  'sudo /usr/local/libexec/e-posyandu/eposyandu-oracle-standby verify'
```

Jangan mengarahkan bacaan produksi ke standby sebelum sinkronisasi awal,
verifikasi selisih data, pemantauan lag, dan uji fallback selesai.
