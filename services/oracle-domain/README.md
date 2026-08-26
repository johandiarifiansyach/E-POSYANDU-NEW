# Oracle domain runtime

`oracle-domain` adalah library runtime yang dipakai oleh binary service Oracle
yang terpisah. Ia tidak dijalankan sebagai service sendiri. Setiap binary
memiliki lifecycle, container, port gRPC, dan deployment target sendiri:

| Binary | Batas domain | Port internal |
| --- | --- | --- |
| `identity-service` | login, MFA, passkey, sesi, akun admin | 50052 |
| `operations-service` | CRUD, cache, sinkronisasi, retensi | 50053 |
| `realtime-service` | PostgreSQL `NOTIFY` dan subscription SSE | 50054 |
| `monitoring-service` | snapshot metrik admin | 50055 |

`oracle-api` hanya gateway HTTPS. Gateway mengirim envelope request melalui
gRPC/HTTP2 ke service pemilik domain dan mengembalikan status, cookie, header
keamanan, serta body dari response. Semua RPC internal memerlukan metadata
`x-eposyandu-service-token`. Pada satu VM, transport-nya memakai UDS di
`/run/e-posyandu/*.sock`; URL `http://HOST:PORT` tetap didukung untuk service
lintas server atau platform. Port gRPC tidak dipublish ke host.

Source domain masih direferensikan dari modul teruji di `oracle-api/src` selama
migrasi agar perilaku autentikasi dan scope tetap identik. Pemisahan runtime
sudah aktif; pemindahan source per bounded context dapat dilakukan setelah
cutover dan uji kontrak tanpa mengubah kontrak protobuf.
