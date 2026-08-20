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

Isi ID akun/Queue Cloudflare, token Queue dengan izin minimum, URL API, dan
`RUST_WORKER_SHARED_SECRET` yang sama dengan Worker. Nilai secret tidak pernah
masuk image, archive aplikasi, log, atau Git; script mengirim salinan sementara
langsung ke `/etc/e-posyandu/nutrition-grpc.env` dengan mode `0600`.

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
