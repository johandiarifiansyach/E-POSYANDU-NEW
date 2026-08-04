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
