# Deployment Oracle Nutrition Worker

Oracle menjalankan layanan Rust `nutrition-grpc` untuk pekerjaan berat. API,
autentikasi, database utama, Queue, dan penyimpanan hasil tetap berada di
Cloudflare/Supabase. VM Oracle tidak menerima data langsung dari browser.

## Spesifikasi instance

- OCI Ampere A1, Oracle Linux 9 ARM64 (Ubuntu/Debian juga tetap didukung).
- Awal yang cukup: 1 OCPU, RAM sekitar 6 GB, boot volume minimal 30 GB.
- IP publik statis/reserved dan DNS `A` menuju IP tersebut.
- Network Security Group: TCP 22 hanya dari IP pengelola; TCP 80 dan 443 dari
  internet untuk penerbitan serta pembaruan sertifikat. Jangan membuka 50051
  atau 8080.

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
Allow dynamic-group eposyandu-grpc-worker-dg to manage objects in tenancy where all {target.bucket.name='eposyandu-oracle-backups', target.object.name='production/*', any {request.permission='OBJECT_CREATE'}}
Allow dynamic-group eposyandu-grpc-worker-dg to read secret-bundles in tenancy where target.secret.id='<BACKUP_PASSPHRASE_SECRET_OCID>'
```

Policy pertama sengaja hanya mengizinkan pembuatan objek baru di prefix
`production/`; worker tidak dapat membaca atau menghapus backup. Penghapusan
otomatis dilakukan oleh lifecycle Object Storage, bukan oleh VM.

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
