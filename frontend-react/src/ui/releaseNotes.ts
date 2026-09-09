import { APP_VERSION } from '../config/app';

export type ReleaseNote = { version: string; date: string; changes: string[] };
export const RELEASE_NOTES: ReleaseNote[] = [{
  version: APP_VERSION,
  date: '2026',
  changes: [
    'Frontend React + TSX menggunakan komponen strict tanpa renderer DOM lama.',
    'Data WHO, z-score, status gizi, N/T/O/B, grafik, dan agregasi tetap berasal dari layanan analisis Python.',
    'Jalur baca memakai hasil persisten Rust/Redis/PostgreSQL dengan skeleton dan snapshot fallback.'
  ]
}];
