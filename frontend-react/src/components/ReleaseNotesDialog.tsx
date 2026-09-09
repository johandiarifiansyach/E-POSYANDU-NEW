import { useEffect } from 'react';
import { APP_VERSION } from '../config/app';

export type ReleaseNotesDialogProps = { onClose: () => void };

const changes = [
  'Seluruh halaman aplikasi kini dirender oleh komponen React TSX tanpa bridge UI lama.',
  'Tabel balita, analisis gizi, ASI, MPASI, PMT, administrasi, dan riwayat memakai entrypoint React yang sama.',
  'Navigasi analisis gizi dan manajemen data tetap memakai pagination server-side serta cache hasil terakhir.'
];

export default function ReleaseNotesDialog({ onClose }: ReleaseNotesDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  return <div className="release-notes-backdrop is-visible" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="react-release-notes-title">
      <header className="release-notes-header"><div className="release-notes-title-group"><span className="release-notes-logo"><img src="/logo-puskesmas-32981.svg" alt="" /></span><div><p className="release-notes-eyebrow">E-Posyandu v{APP_VERSION}</p><h2 id="react-release-notes-title">Apa yang Baru</h2></div></div><button type="button" className="release-notes-close" onClick={onClose} aria-label="Tutup Apa yang Baru">×</button></header>
      <div className="release-notes-scroll"><section className="release-current"><div className="release-current-heading"><div><span className="release-current-label">Rilis terbaru</span><h3>Migrasi UI React TSX</h3></div><time dateTime="2026-09-09">9 September 2026</time></div><ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul></section></div>
      <footer className="release-notes-actions"><button type="button" className="release-notes-done" onClick={onClose}>Selesai</button></footer>
    </section>
  </div>;
}
