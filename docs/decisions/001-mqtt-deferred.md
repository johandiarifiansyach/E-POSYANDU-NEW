# ADR 001: MQTT Ditunda Sampai Ada Perangkat IoT

## Status

Diterima pada 9 Agustus 2026.

## Keputusan

E-Posyandu tidak menambahkan broker, client, atau koneksi MQTT pada aplikasi saat ini. Sinkronisasi browser tetap memakai Service Worker, antrean IndexedDB, dan REST API. Pemrosesan berat tetap melalui Cloudflare Queue dan worker gRPC.

## Alasan

Belum ada timbangan digital, sensor, atau perangkat lapangan yang mengirim telemetri terus-menerus. MQTT tidak mempercepat login, CRUD, dashboard, atau ekspor, tetapi akan menambah broker, kredensial perangkat, ACL topik, sertifikat TLS, monitoring koneksi, serta biaya operasional.

## Kriteria Aktivasi

MQTT baru dievaluasi ketika tersedia perangkat IoT nyata yang membutuhkan pengiriman data kecil secara terus-menerus. Implementasinya wajib memakai TLS, identitas unik per perangkat, ACL per topik, rotasi kredensial, antrean offline perangkat, dan jembatan server yang memvalidasi data sebelum masuk PostgreSQL.

MQTT tidak boleh menulis langsung ke Supabase dan tidak menggantikan REST API pengguna.
