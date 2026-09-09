# E-Posyandu Frontend React

Frontend React + TSX + TypeScript 7 yang menjadi satu-satunya renderer aplikasi.
Kontrak, utilitas, data WHO, dan stylesheet bersama berada di `src/compat/`;
proyek frontend native lama sudah dihapus.

## Menjalankan

```bash
npm install
npm run typecheck
npm run dev
```

Server development berjalan di `http://127.0.0.1:5176` dan menggunakan proxy
API yang sama dengan frontend lama.

Untuk build deployment gunakan `npm run pages:build:react` dari root; hasilnya
berada di `frontend-react/dist`. Perintah deploy React tersedia sebagai
`npm run pages:deploy:react`.
Pipeline verifikasi lengkap React + backend tersedia sebagai `npm run ci:react`.

## Strategi parity

`src/main.tsx` dan router menggunakan React. `AuthGate`, `LoginPage`, `MfaPage`,
dan `MaintenancePage` juga React TSX. Komponen dasar, kartu metrik, state
kosong/error, filter periode/wilayah, layout, dan skeleton reusable tersedia di
`src/components/` serta `src/layouts/` dengan token visual aplikasi yang sama.
Panel error memakai reporter lokal React (`src/ui/problemReporter.ts`), sehingga
tidak lagi bergantung pada runtime DOM lama.

Semua halaman dashboard memiliki entrypoint TSX strict di `src/pages/` dan
terdaftar di `src/pages/pageRegistry.ts`: dashboard, Data Balita, view
underweight/stunting/wasting/tidak naik, balita baru diinput, recycle bin,
tambah balita, pengukuran, grafik pertumbuhan, ASI eksklusif, MPASI, PMT,
riwayat perubahan, administrasi backend, monitoring, dan aktivasi undangan.
Setiap entrypoint langsung merender implementasi React pada folder
`src/features/`; tidak ada bridge renderer lain pada jalur runtime.

Smoke test React dijalankan dari root dengan:

```bash
npm run frontend:react:test
```

Konfigurasinya memakai server Vite port 4176 dan menguji Chromium, WebKit,
serta dua viewport mobile. Set `E2E_CAPTURE_UI=/tmp/e-posyandu-captures` bila
ingin menyimpan screenshot parity untuk inspeksi manual.

`ErrorBoundary` menjaga agar kegagalan render tidak menghasilkan halaman kosong
dan tetap memberi kesempatan retry. Adapter API tetap berbagi kontrak layanan
yang sudah teruji dengan backend; adapter tersebut bukan renderer legacy dan
tidak membuat halaman React kembali ke DOM runtime lama.

`ReactDashboardShell` adalah shell utama dashboard React. Shell mengambil
agregasi dari endpoint Rust yang sama, menampilkan skeleton saat memuat,
menyimpan snapshot lokal agar kegagalan sementara tidak membuat halaman kosong,
dan menavigasikan seluruh modul strict.

Shell yang sama menyediakan seluruh modul React untuk Data Balita, pengukuran,
grafik, ASI Eksklusif, MPASI, PMT, riwayat perubahan, serta administrasi.
ASI membatasi kelompok umur ke 0–5 dan 6 bulan; MPASI memakai kohort 6–23
bulan; tabel lain memakai filter kelompok umur kanonik. Seluruh modul
menggunakan pagination Rust, skeleton, dan fallback snapshot tanpa menghitung
ulang analisis di browser.

Smoke test dashboard terautentikasi tersedia di
`frontend-react/e2e/react/dashboard-react.spec.ts`; sesi, endpoint statistik, dan
monitoring dimock di browser sehingga tidak memerlukan database nyata.
