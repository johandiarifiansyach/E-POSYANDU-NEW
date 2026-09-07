# Read Service

Read Service menangani request GET untuk tabel, dashboard, koleksi, ekspor,
dan snapshot hasil analisis. Endpoint analisis yang memakai POST (`/api/v1/analysis/*`)
juga berada di sini karena bersifat read-side dan tidak mengubah data.

Service memakai `ReadDomain` dengan `ORACLE_API_NATIVE_WRITES_ENABLED=false`.
Hasil terhitung dibaca dari Redis/PostgreSQL; Python hanya dipanggil saat
snapshot belum tersedia atau grafik/analisis memang diminta.

Transport default: `unix:///run/e-posyandu/read.sock`.
