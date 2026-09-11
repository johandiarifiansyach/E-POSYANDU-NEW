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

### Data fetching

`src/app/queryClient.ts` menyediakan satu `QueryClient` TanStack Query untuk
deduplikasi request, cache singkat (30 detik), retry terbatas, dan revalidasi
saat koneksi pulih. Dashboard, Data Balita, ASI Eksklusif, MPASI, dan Riwayat
Perubahan memakai query key berbasis request sehingga halaman atau filter yang
sama tidak mengambil data ulang. Cache memori/API lama dipakai sebagai
`initialData` hanya saat tersedia, lalu langsung direvalidasi; cache miss tetap
mengirim request pertama (nilai `null` tidak diperlakukan sebagai snapshot).

Daftar dibaca melalui endpoint Rust yang sudah server-paginated (10 baris per
request) dengan `keepPreviousData`, sehingga perpindahan halaman tidak
menampilkan tabel kosong dan browser tidak pernah mengambil seluruh database.
Pencarian memakai debounce 300 ms setelah tombol Cari dikonfirmasi. Setelah
perubahan data berhasil disinkronkan, query terkait di-invalidate agar request
berikutnya membaca hasil analisis terbaru dari Rust/Redis/PostgreSQL.

### State management

State lintas fitur memakai Zustand dengan store kecil berdasarkan domain di
`src/stores/`: `authStore` hanya menyimpan profil pengguna, `filterStore`
menyimpan filter periode/wilayah yang sedang diedit dan diterapkan,
`realtimeStore` menyimpan status koneksi monitoring, sedangkan `uiStore`
menyimpan sidebar, akun, tema, dan dialog rilis. Komponen berlangganan dengan
selector per bidang, sehingga perubahan filter tidak merender ulang status
autentikasi atau UI sidebar. Nilai sementara seperti isi form, modal aktif, dan
status satu halaman tetap lokal di komponen; tidak dimasukkan ke global store.

Smoke test dashboard terautentikasi tersedia di
`frontend-react/e2e/react/dashboard-react.spec.ts`; sesi, endpoint statistik, dan
monitoring dimock di browser sehingga tidak memerlukan database nyata.

### Images and assets

Poster edukasi gizi dikirim sebagai aset WebP yang sudah dioptimalkan (lebar
maksimum 1200 piksel) dan dimuat dengan `loading="lazy"` serta
`decoding="async"`. Latar login juga tersedia sebagai WebP dengan lebar
maksimum 1600 piksel. Dimensi intrinsik pada gambar poster dan logo mencegah
pergeseran layout pada koneksi lambat. Respons WebP statis memakai cache
immutable jangka panjang; entrypoint HTML dan service worker tetap tidak di-cache
agar rilis baru segera digunakan.

Halaman grafik memakai `React.lazy`; library ekspor grafik baru dimuat ketika
pengguna meminta ekspor. Jalankan `npm run frontend:react:assets` setelah
mengganti artwork sumber untuk membuat ulang turunan WebP. Python tetap menjadi
otoritas analisis dan hanya mengembalikan URL aset yang sudah ditinjau; resize
dilakukan pada pipeline aset saat build sebelum file dikirim ke client.

### CSS and styling

Tailwind membaca `index.html`, seluruh TS/TSX/JS/JSX di `src`, dan fallback HTML
di `public` melalui `tailwind.config.js`; utility yang tidak digunakan dibuang
ketika build produksi. Pemeriksaan `npm run frontend:styling:check` menjaga
content scan dan plugin PostCSS tetap aktif serta menolak dependency CSS-in-JS
runtime seperti styled-components atau Emotion. Style inline yang tersisa hanya
untuk nilai data-driven (misalnya lebar progress dan tinggi spacer virtualisasi)
dan bukan library CSS-in-JS.

### Build configuration

Vite menargetkan ES2020 dan memakai esbuild untuk minifikasi cepat. Vendor
`react`/`react-dom` dipisahkan ke chunk `react-vendor`, sehingga browser dapat
menyimpan cache framework secara terpisah dari bundle halaman. Paket `esbuild`
dicantumkan eksplisit karena Vite 8/Rolldown tidak lagi memasangnya otomatis
untuk opsi `minify: "esbuild"`.

### Profiling dan perangkat rendah

React DevTools Profiler menjadi alat utama untuk menemukan commit dan
re-render yang mahal. Untuk metrik tambahan tanpa extension, jalankan Vite
dengan `VITE_REACT_PROFILER=true`; `src/app/PerformanceProfiler.tsx` akan
menulis durasi commit secara opt-in dan hanya pada mode development:

```bash
VITE_REACT_PROFILER=true npm run frontend:react:dev
```

Uji repeatable dengan emulasi CPU 6× (setara throttling 4–6× di Chrome
DevTools) tersedia melalui:

```bash
npm run frontend:react:perf
```

Tes ini memakai Chromium CDP, memastikan halaman login tetap dapat digunakan,
dan melampirkan waktu `DOMContentLoaded`/`load` ke hasil Playwright. Untuk
inspeksi interaktif, pilih **Performance → CPU throttling → 6× slowdown** di
Chrome DevTools lalu rekam halaman dashboard dan tabel ber-paginasi.
