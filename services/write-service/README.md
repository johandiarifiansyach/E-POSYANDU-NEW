# Write Service

Write Service menangani POST/PATCH/DELETE mutasi data balita, pengukuran,
ASI/MPASI, PMT, sinkronisasi, dan pekerjaan analisis yang masuk ke outbox.
Transaksi raw data dan `analysis_outbox` tetap dilakukan oleh PostgreSQL;
Analysis Worker memproses dampaknya secara asinkron.

Service memakai `WriteDomain` dengan `ORACLE_API_NATIVE_READS_ENABLED=false`.
Ia tidak bergantung pada koneksi Python untuk menerima dan meng-commit write.

Transport default: `unix:///run/e-posyandu/write.sock`.
