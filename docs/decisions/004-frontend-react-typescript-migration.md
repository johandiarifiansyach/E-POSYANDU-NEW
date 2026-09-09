# Rencana Migrasi Frontend ke React TSX + TypeScript 7

Status: Migrasi 100% ke frontend React sudah selesai. Rencana Vue dibatalkan,
proyek frontend native lama dihapus, dan React menjadi satu-satunya renderer.

## Keputusan

Frontend target menggunakan React, TSX, TypeScript `^7.0.2`, dan Vite. React
menjadi lapisan presentasi; TypeScript 7 menjadi fondasi bahasa, kontrak data,
dan validasi statis. Semua komponen, router, state, API client, hook, service,
dan pengujian ditulis dalam TypeScript.

React tidak mengubah batas layanan:

```text
React TSX + TypeScript 7
          ↓
Rust Read/Write Service
          ↓
Redis / PostgreSQL
          ↓
Python Worker
```

Browser hanya meminta dan menampilkan hasil persisten dari Rust. WHO, z-score,
status gizi, N/T/O/B, risiko, edukasi, agregasi, dan data grafik tetap menjadi
otoritas Python sesuai kontrak backend.

Target toolchain:

- React dan React DOM
- TypeScript `^7.0.2` dengan `jsx: "react-jsx"`
- Vite dan `@vitejs/plugin-react`
- React Router untuk route dan guard
- `tsc --noEmit` untuk pemeriksaan TS/TSX (tanpa wrapper compiler khusus)
- React Testing Library dan Playwright untuk pengujian komponen/E2E

## Implementasi lokal saat ini

Folder `frontend-react/` berisi entry point React TSX, router React, konfigurasi
Vite/TypeScript 7, autentikasi, MFA, pemulihan sesi, role guard, tema, logout
otomatis, maintenance, skeleton, seluruh layout, komponen bersama, filter,
pagination, realtime, ekspor, dan error boundary. Implementasi strict React
untuk semua halaman sudah tersedia: dashboard, Data Balita, tambah balita,
pengukuran, grafik pertumbuhan, ASI eksklusif, MPASI, PMT, riwayat perubahan,
administrasi backend, monitoring admin, dan aktivasi undangan.

Tidak ada bridge renderer di `frontend-react/src`. Semua route dan shell yang
berjalan langsung menggunakan komponen React strict. Direktori `src/compat/`
hanya berisi kontrak, utilitas, data referensi, dan stylesheet bersama; tidak
ada runtime DOM native yang dipakai aplikasi.

Pemeriksaan lokal:

```text
npm run frontend:react:check
npm run frontend:react:build
npm run frontend:react:dev
```

`frontend-react:check` memakai `tsc --noEmit` dan build Vite berhasil dijalankan.
Seluruh entrypoint halaman dashboard tersedia di target TSX tanpa feature flag
per modul atau jalur bridge runtime.

Tahap 4 (komponen bersama) selesai secara lokal: primitive UI, skeleton,
filter periode/wilayah, dan tiga layout slot telah memiliki implementasi TSX
strict. Tahap 5 kini memiliki entrypoint TSX untuk seluruh halaman dashboard:
Dashboard, Data Balita (termasuk view masalah, data baru, dan recycle bin),
Pengukuran, Grafik Pertumbuhan, ASI Eksklusif, MPASI, PMT, Riwayat Perubahan,
Tambah Balita, Administrasi Backend, Monitoring, dan Aktivasi Undangan. Kartu
SKDN, capaian ASI, prevalensi status gizi, indikator snapshot/worker, serta
state loading/error pada `DashboardOverviewPage.tsx` sudah dipindahkan ke JSX
strict.

Setiap page sudah ditulis sebagai komponen strict React. `pageRegistry.ts`
menjadi daftar kanonik seluruh entrypoint React, termasuk view bermasalah,
balita baru diinput, dan recycle bin.

Tahap 6 dijalankan dengan konfigurasi Playwright khusus React
di `frontend-react/playwright.config.ts` dan smoke suite
`frontend-react/e2e/react/login-react.spec.ts`. Suite ini memeriksa kontrak class dan
struktur login, fokus keyboard, skeleton saat pemeriksaan sesi lambat,
aksesibilitas WCAG melalui axe, serta tidak adanya overflow pada viewport
mobile; Chromium, WebKit, mobile Chrome, dan mobile WebKit dijalankan tanpa
perubahan pada route produksi.

Tahap 7 diselesaikan dengan metadata/guard route dan `ErrorBoundary`. Tidak ada
flag bridge pada runtime; fallback operasional menggunakan snapshot/cache dan
retry di boundary React.

Tahap 8 diselesaikan pada `ReactDashboardShell.tsx`. Shell memiliki filter
periode, kelompok umur, desa, dan posyandu; memanggil endpoint agregasi Rust;
menampilkan skeleton saat request berjalan; menyimpan snapshot lokal sebagai
fallback; dan menavigasikan seluruh modul strict React. Monitoring informatif
dan tidak memblokir pemuatan statistik.

Tahap 10 menambahkan implementasi React strict untuk Data Balita, ASI
Eksklusif, MPASI, dan Riwayat Perubahan. Data Balita memakai pagination server dan
menampilkan hasil analisis yang sudah dipersistenkan; ASI hanya menawarkan
kelompok usia 0–5 bulan dan 6 bulan sesuai aturan program; Riwayat Perubahan
memakai endpoint audit yang sama dengan filter periode/wilayah serta pencarian.
MPASI membaca `view=mpasi` dari endpoint children, mempertahankan cohort tetap
6–23 bulan tanpa filter umur tambahan, dan menampilkan log makanan tersimpan.
Ketiga modul memiliki skeleton, error state, dan pagination tanpa menunggu
Python pada jalur baca. Modul ASI dan Riwayat Perubahan berjalan melalui shell
dashboard React; rollback dilakukan dengan memilih artefak frontend sebelumnya,
bukan dengan flag bridge di runtime.

Smoke test dashboard diperluas untuk memeriksa navigasi ke Data Balita, ASI
Eksklusif, dan Riwayat Perubahan dengan endpoint Rust yang dimock. Ini
memastikan perpindahan modul tidak mengubah kontrak filter atau membuat
halaman kosong ketika respons analisis terlambat.

Validasi Tahap 9 ditambahkan pada `frontend-react/e2e/react/dashboard-react.spec.ts`.
Suite tersebut menjalankan dashboard dengan sesi dan respons agregasi yang
terisolasi, lalu memeriksa angka SKDN, capaian ASI, filter umur, dan
penerapan ulang scope. Flag dashboard hanya dinyalakan pada Playwright
configuration sehingga pengujian tidak mengubah default deployment.

## Status akhir migrasi lokal (Tahap 11–12)

Semua page target sudah memiliki implementasi React strict dan terdaftar di
`src/pages/pageRegistry.ts`: login, MFA, maintenance, dashboard, Data Balita,
tambah balita, pengukuran, grafik pertumbuhan, ASI eksklusif, MPASI, PMT,
riwayat perubahan, administrasi backend, monitoring admin, dan aktivasi
undangan. Pengukuran memakai antrean mutasi/offline yang sama; hasil WHO,
z-score, status gizi, N/T/O/B, risiko, edukasi, grafik, dan agregasi tetap
diminta dari Python/Rust sesuai kontrak backend, bukan dihitung ulang di
browser.

Verifikasi terakhir pada mesin lokal:

```text
18 passed, 2 skipped — npm run frontend:react:test
npm run frontend:react:check              ✓
npm run frontend:check                    ✓
npm run frontend:react:build              ✓
git diff --check                           ✓
```

`npm run ci:react` menjalankan rangkaian check backend/legacy, typecheck dan
smoke test React, lalu membangun `frontend-react/dist` sebagai kandidat artefak
deployment.

Parity komponen tahap akhir juga sudah selesai secara lokal. Primitive UI lama
(`Button`, `Select`, `Badge`, `DataTable`, `Modal`, `Pagination`, `Tooltip`,
filter, skeleton, feedback, dan notifikasi) memiliki implementasi TSX yang
dipakai runtime React. Dialog/modal fitur pengukuran, analisis WHO, grafik,
MPASI, PMT, pemantauan PMT, tambah/edit balita, dan hapus balita telah
dimigrasikan. Konsol administrasi React juga mencakup passkey WebAuthn,
polling status layanan, kartu layanan Cloudflare/Oracle/database, manajemen
akun, dan monitoring sepuluh metrik. Tidak ada renderer `Legacy*`, `Native`,
atau `dashboardContext` pada jalur runtime `frontend-react/src`.

Build sudah menggunakan lazy-loading untuk modul pengukuran, grafik, ekspor,
dan halaman berat. Entry awal kini sekitar 329 kB (gzip sekitar 102 kB) dan
tidak lagi menghasilkan peringatan ukuran chunk Vite; dependensi ekspor tetap
diambil hanya saat fitur terkait dibuka. Deployment dilakukan terpisah melalui
perintah Pages setelah pemeriksaan lokal dan persetujuan rilis.

## Prinsip parity visual

- Pertahankan cascade CSS, token, aset, teks, ukuran, warna, breakpoint, dan
  urutan layout dari implementasi native sebelumnya melalui aset bersama di
  `frontend-react/src/compat/`.
- Jangan mengubah kontrak API, format status, filter, pagination, ekspor,
  realtime, atau fallback.
- Bandingkan setiap halaman dengan screenshot desktop,
  Safari, dan viewport kader sebelum mengganti route.
- Fallback operasional menggunakan snapshot/cache pada runtime React dan artefak
  Pages versi sebelumnya; proyek native lama tidak lagi menjadi fallback.

## Struktur folder target

Frontend React menjadi satu-satunya frontend di `frontend-react/`; kode native
lama sudah dihapus setelah parity dan smoke test selesai.

```text
frontend-react/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── postcss.config.js
├── tailwind.config.js
├── public/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── app/
│   │   ├── AppShell.tsx
│   │   ├── AuthGate.tsx
│   │   ├── appConfig.ts
│   │   └── ErrorBoundary.tsx
│   ├── router/
│   │   ├── index.tsx
│   │   ├── guards.ts
│   │   └── routeMeta.ts
│   ├── layouts/
│   │   ├── AuthLayout.tsx
│   │   ├── DashboardLayout.tsx
│   │   └── MaintenanceLayout.tsx
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── MfaPage.tsx
│   │   ├── MaintenancePage.tsx
│   │   ├── DashboardPage.tsx
│   │   ├── ChildrenTablePage.tsx
│   │   ├── ProblemUnderweightPage.tsx
│   │   ├── ProblemStuntingPage.tsx
│   │   ├── ProblemWastingPage.tsx
│   │   ├── ProblemTidakNaikPage.tsx
│   │   ├── RecentChildrenPage.tsx
│   │   ├── RecycleBinPage.tsx
│   │   ├── MeasurementPage.tsx
│   │   ├── GrowthChartsPage.tsx
│   │   ├── ExclusiveBreastfeedingPage.tsx
│   │   ├── MpasiPage.tsx
│   │   ├── PmtProgramPage.tsx
│   │   ├── ChangeHistoryPage.tsx
│   │   ├── AdminBackendPage.tsx
│   │   └── AdminMonitoringPage.tsx
│   ├── components/
│   │   ├── ReleaseNotesDialog.tsx
│   │   ├── base/
│   │   │   ├── Button.tsx
│   │   │   ├── Card.tsx
│   │   │   ├── DataTable.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── Select.tsx
│   │   │   ├── Badge.tsx
│   │   │   ├── Pagination.tsx
│   │   │   ├── LoadingSkeletons.tsx
│   │   │   └── SkeletonBlock.tsx
│   │   ├── data-display/
│   │   │   └── MetricCard.tsx
│   │   ├── filters/
│   │   │   └── LocationFilterPanel.tsx
│   │   └── feedback/
│   │       ├── EmptyState.tsx
│   │       └── InlineNotice.tsx
│   ├── features/
│   │   ├── auth/
│   │   ├── dashboard/
│   │   ├── children/
│   │   ├── measurements/
│   │   ├── growth-charts/
│   │   ├── breastfeeding/
│   │   ├── mpasi/
│   │   ├── pmt/
│   │   ├── reports/
│   │   └── administration/
│   ├── api/
│   │   ├── httpClient.ts
│   │   ├── authApi.ts
│   │   ├── childrenApi.ts
│   │   ├── measurementApi.ts
│   │   ├── dashboardApi.ts
│   │   ├── analysisApi.ts
│   │   ├── exportApi.ts
│   │   └── types.ts
│   ├── stores/
│   │   ├── authStore.ts
│   │   ├── uiStore.ts
│   │   ├── filterStore.ts
│   │   └── realtimeStore.ts
│   ├── hooks/
│   │   ├── usePageState.ts
│   │   ├── usePagination.ts
│   │   ├── useFilters.ts
│   │   ├── useRealtime.ts
│   │   └── useOfflineSync.ts
│   ├── services/
│   │   ├── offlineStore.ts
│   │   ├── exportService.ts
│   │   ├── notificationService.ts
│   │   └── errorReporter.ts
│   ├── shared/
│   │   ├── constants.ts
│   │   ├── formatters.ts
│   │   ├── validators.ts
│   │   └── permissions.ts
│   ├── styles/
│   ├── types/
│   └── test/
│       ├── unit/
│       ├── component/
│       └── e2e/
└── README.md
```

## Aturan kepemilikan kode

- `pages/` hanya menyusun layout dan feature component.
- `components/` berisi komponen visual reusable tanpa akses database.
- `features/` berisi alur tampilan per modul, bukan rumus WHO atau status gizi.
- `api/` adalah satu-satunya jalur HTTP ke Rust Read/Write Service.
- `stores/` menyimpan state sesi, UI, filter, dan realtime.
- `hooks/` menangani loading, pagination, filter, realtime, dan offline sync.
- `services/` menangani ekspor, notifikasi, offline store, dan error reporting.
- `shared/` hanya berisi utilitas murni.
- `types/` menjadi lokasi kontrak domain dan API.
- Arah dependensi: `pages → features → api/services`.

## Pemetaan frontend lama

| Frontend lama | Lokasi React target |
| --- | --- |
| `src/pages/` | `src/pages/` dan `src/features/` |
| `src/components/` | `src/components/` |
| `src/api/` | `src/api/` |
| `src/services/` | `src/services/` |
| `src/ui/` | `src/components/base/`, `src/components/data-display/`, dan `src/components/feedback/` |
| `src/features/measurements/` | `src/features/measurements/` dan `src/features/growth-charts/` |
| `src/features/breastfeeding/` | `src/features/breastfeeding/` dan `src/features/mpasi/` |
| `src/styles/` | `src/styles/` |
| `src/runtime/dom.ts` | Dipindahkan ke `src/compat/` sebagai referensi kompatibilitas; tidak diimpor runtime |

## Tahapan migrasi

1. Inventarisasi route, kontrak API, state, role, ekspor, dan perilaku visual.
2. Buat `frontend-react/` dengan React TSX + TypeScript 7 dan konfigurasi Vite.
3. Migrasikan login, MFA, sesi, role guard, theme, maintenance, dan skeleton.
4. Migrasikan komponen bersama, layout, filter, tabel, modal, dan pagination.
5. Migrasikan halaman Dashboard, Data Balita, Pengukuran, Grafik, ASI, MPASI,
   PMT, riwayat, admin, dan monitoring secara berurutan.
6. Jalankan parity test, accessibility test, E2E, dan uji perangkat lambat.
7. Aktifkan route React melalui feature flag secara bertahap.
8. Hapus proyek native setelah periode observasi, parity, dan rollback selesai.

## Kriteria selesai

- `tsc --noEmit` dan build production berhasil.
- Semua file UI target menggunakan `.tsx` dan TypeScript strict.
- Tidak ada analitik klinis yang berjalan di browser.
- Dashboard, tabel, filter, pagination, grafik, ekspor, role, dan realtime
  menghasilkan perilaku serta tampilan yang sama dengan frontend lama.
- Skeleton/fallback tetap tampil saat Python atau Redis belum siap.
- E2E desktop, Safari, dan koneksi lambat lulus.

## Rollback dan non-goals

Rollback frontend dilakukan dengan memilih artefak React Pages versi
sebelumnya. Tidak ada perubahan pada Rust, Python, Redis, PostgreSQL, kontrak
gRPC, atau schema database sebagai bagian dari migrasi frontend ini.
