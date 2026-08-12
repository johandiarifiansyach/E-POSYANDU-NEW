import { APP_VERSION } from './app';

export type AppRelease = {
  version: string;
  releaseDate: string;
  releaseDateIso: string;
  title: string;
  changes: string[];
};

export const RELEASE_HISTORY: AppRelease[] = [
  {
    version: APP_VERSION,
    releaseDate: '12 Agustus 2026',
    releaseDateIso: '2026-08-12',
    title: 'Login Tetap Tersedia Saat API Terganggu',
    changes: [
      'Login username kini memiliki jalur pemulihan melalui Supabase Auth saat Cloudflare Worker tidak dapat dijangkau atau mencapai batas kapasitas.',
      'Role, status aktif, dan wilayah akun diverifikasi melalui RPC profil pribadi tanpa membuka tabel pengguna ke browser.',
      'Kesalahan kata sandi dan verifikasi keamanan tetap ditangani oleh alur normal sehingga jalur pemulihan tidak melemahkan pemeriksaan akun.',
      'Circuit breaker menahan permintaan API berulang selama gangguan dan halaman Data Balita menggunakan cache perangkat yang tersedia.',
      'Pesan mentah Load failed diganti dengan penanganan layanan yang lebih jelas dan cache PWA diperbarui.'
    ]
  },
  {
    version: '3.5.1',
    releaseDate: '10 Agustus 2026',
    releaseDateIso: '2026-08-10',
    title: 'Tabel Balita Lebih Cepat dan Stabil',
    changes: [
      'Tabel balita kini hanya membaca cache untuk 10 data yang sedang tampil, bukan seluruh data di perangkat.',
      'Cache balita dan pengukuran diproses berdasarkan ID dalam satu transaksi IndexedDB agar tetap ringan di HP kader.',
      'Permintaan API, GraphQL, login, dan pembaruan sesi memiliki batas waktu 20 detik sehingga loading tidak menggantung.',
      'Cache aplikasi diperbarui agar perbaikan segera diterima oleh perangkat yang sebelumnya menyimpan versi lama.'
    ]
  },
  {
    version: '3.5.0',
    releaseDate: '10 Agustus 2026',
    releaseDateIso: '2026-08-10',
    title: 'Ketahanan Operasional dan Worker Terukur',
    changes: [
      'Queue dan worker gRPC menangani validasi impor, kalkulasi laporan, serta persiapan ekspor tanpa memperlambat login dan CRUD.',
      'Backup PostgreSQL terenkripsi dan uji restore ke lingkungan staging telah diaktifkan dan diverifikasi melalui GitHub Actions.',
      'Monitoring terpadu memeriksa frontend, API, kesiapan layanan, Queue, R2, dan nutrition worker dengan laporan terstruktur.',
      'Konflik sinkronisasi offline diperkuat dengan versioning, idempotensi, dan pilihan data saat perangkat serta server mengubah kolom yang sama.',
      'Penyimpanan sementara R2 dibersihkan otomatis sebelum melewati batas gratis dan hasil pekerjaan berat memiliki retensi terkontrol.',
      'Render hanya dipertahankan aktif pada hari kerja pukul 07.00-16.00 WIB agar kuota gratis lebih hemat.'
    ]
  },
  {
    version: '3.4.5',
    releaseDate: '5 Agustus 2026',
    releaseDateIso: '2026-08-05',
    title: 'Sinkronisasi Penimbangan Terisolasi',
    changes: [
      'Penimbangan baru tidak lagi dianggap gagal akibat antrean perubahan identitas lama yang bermasalah.',
      'Setiap perubahan offline menerima hasil sinkronisasi sendiri sehingga kegagalan satu data tidak menghambat data lainnya.',
      'Nilai berat lama yang telanjur ditulis dalam gram dikonversi aman ke kilogram sebelum disimpan dan dihitung.',
      'Payload BB penimbangan dan pembaruan ringkasan balita diuji sampai proses simpan pada desktop dan ponsel.',
      'Cache aplikasi diperbarui agar perbaikan segera diterima perangkat kader.'
    ]
  },
  {
    version: '3.4.4',
    releaseDate: '5 Agustus 2026',
    releaseDateIso: '2026-08-05',
    title: 'Form Stabil dan Penimbangan Lebih Ringan',
    changes: [
      'Kolom identitas dan penimbangan kini tetap terisi saat digunakan pada ponsel, tablet, maupun desktop.',
      'Runtime native mempertahankan elemen, fokus, posisi kursor, dan keyboard saat formulir diperbarui.',
      'Pemrosesan ganda pada input desimal dihapus agar BB, TB, LiLA, serta lingkar kepala tidak saling menimpa.',
      'Status gizi real-time di form penimbangan dihapus agar pengisian lebih ringan; hasil status tetap tersedia pada tabel riwayat.',
      'Pengujian pengisian form ditambahkan untuk tampilan desktop dan ponsel.'
    ]
  },
  {
    version: '3.4.3',
    releaseDate: '4 Agustus 2026',
    releaseDateIso: '2026-08-04',
    title: 'Input Pengukuran Desimal Stabil di HP',
    changes: [
      'Kolom BB dan TB kini stabil di ponsel kader dan tidak lagi tiba-tiba kosong saat mengetik.',
      'Input desimal menerima format koma maupun titik, lalu diseragamkan otomatis agar tetap valid.',
      'Keyboard numerik ponsel diprioritaskan untuk input BB/TB agar pengisian lebih cepat.',
      'Penanganan perubahan nilai BB/TB diperkuat supaya tidak tertimpa re-render saat form aktif.',
      'Pembaruan cache aplikasi dipercepat agar perbaikan segera terpasang di perangkat yang sebelumnya menyimpan versi lama.'
    ]
  },
  {
    version: '3.4.1',
    releaseDate: '2 Agustus 2026',
    releaseDateIso: '2026-08-02',
    title: 'Pembaruan dan Perbaikan Sistem',
    changes: [
      'Jumlah sasaran dashboard kini sama dengan Data Balita aktif usia 0-59 bulan pada akhir periode laporan.',
      'Perhitungan dashboard telah diverifikasi konsisten untuk akun gizi, 5 desa, dan 63 posyandu.',
      'Proses login dipercepat dengan mengirim profil akses bersama sesi dan menjalankan proses nonkritis di latar belakang.',
      'Dashboard dimuat bersamaan dengan autentikasi agar perpindahan halaman lebih cepat pada koneksi lambat.',
      'Pengujian regresi login dan konsistensi data ditambahkan untuk mencegah masalah yang sama terulang.'
    ]
  },
  {
    version: '3.4.0',
    releaseDate: '2 Agustus 2026',
    releaseDateIso: '2026-08-02',
    title: 'Pengalaman iOS yang Lebih Lengkap',
    changes: [
      'Mode terang dan gelap kini konsisten pada login, formulir, tabel, ASI eksklusif, serta PMT.',
      'Notifikasi operasi diperbarui menjadi toast iOS dengan efek liquid glass.',
      'Nomor versi kini membuka jendela Apa yang Baru beserta riwayat pembaruan.',
      'Responsivitas, aksesibilitas, dan kenyamanan penggunaan pada ponsel disempurnakan.'
    ]
  },
  {
    version: '3.3.0',
    releaseDate: '1 Agustus 2026',
    releaseDateIso: '2026-08-01',
    title: 'Penyempurnaan Antarmuka dan PMT',
    changes: [
      'Antarmuka diperbarui mengikuti gaya iOS, iPadOS, dan macOS dengan liquid glass.',
      'Sidebar menjadi Dock responsif yang dapat diringkas dan diperluas.',
      'Pemberian serta pemantauan PMT disusun dalam tabel dan pencatatan mingguan.',
      'Formulir MPASI, identitas, pengukuran, dan riwayat penimbangan disempurnakan.'
    ]
  },
  {
    version: '3.0.0',
    releaseDate: '30 Juli 2026',
    releaseDateIso: '2026-07-30',
    title: 'Migrasi Arsitektur Generasi Ketiga',
    changes: [
      'Frontend dimigrasikan penuh ke native TypeScript, HTML5, dan CSS.',
      'API Rust dijalankan melalui Cloudflare Worker dengan PostgreSQL Supabase.',
      'Sinkronisasi offline, cache, pagination, dan penghematan egress mulai diterapkan.',
      'Hosting frontend dialihkan ke Cloudflare Pages.'
    ]
  },
  {
    version: '2.4.0',
    releaseDate: '6 Januari 2026',
    releaseDateIso: '2026-01-06',
    title: 'React TypeScript dan Akses Berbasis Peran',
    changes: [
      'React menggunakan TypeScript dengan komponen TSX.',
      'Login dibedakan sesuai peran akun gizi, desa, dan posyandu.'
    ]
  },
  {
    version: '2.0.0',
    releaseDate: '24 Desember 2025',
    releaseDateIso: '2025-12-24',
    title: 'Peralihan ke React dan Firebase',
    changes: [
      'Website beralih dari Google Sheet ke React dengan database Firebase.'
    ]
  },
  {
    version: '1.0.0',
    releaseDate: '31 Desember 2024',
    releaseDateIso: '2024-12-31',
    title: 'Rilis Pertama',
    changes: [
      'Website E-Posyandu pertama kali dibuat.'
    ]
  }
];

export const LATEST_RELEASE: AppRelease = RELEASE_HISTORY[0]!;
