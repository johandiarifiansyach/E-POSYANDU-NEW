import { useEffect } from 'react';
import { APP_VERSION } from '../config/app';
import { RELEASE_HISTORY, type AppRelease } from '../compat/config/releases';

export type ReleaseNotesDialogProps = { onClose: () => void };

const migrationChanges = [
  'Seluruh halaman aplikasi kini dirender oleh komponen React TSX tanpa bridge UI lama.',
  'Tabel balita, analisis gizi, ASI, MPASI, PMT, administrasi, dan riwayat memakai entrypoint React yang sama.',
  'Navigasi analisis gizi dan manajemen data tetap memakai pagination server-side serta cache hasil terakhir.'
];

/**
 * Keep the migration announcement as the current release while retaining the
 * complete release history that was already shown by the native UI. The
 * previous 3.8.1 entry is folded into the current release because the app
 * version did not change for the React migration.
 */
const currentRelease: AppRelease = {
  version: APP_VERSION,
  releaseDate: '9 September 2026',
  releaseDateIso: '2026-09-09',
  title: 'Migrasi UI React TSX',
  changes: [...migrationChanges, ...(RELEASE_HISTORY[0]?.changes ?? [])]
};

const releaseHistory: AppRelease[] = [currentRelease, ...RELEASE_HISTORY.slice(1)];

function changeList(release: AppRelease) {
  return <ul>{release.changes.map((change) => <li key={`${release.version}-${change}`}>{change}</li>)}</ul>;
}

export default function ReleaseNotesDialog({ onClose }: ReleaseNotesDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  return <div className="release-notes-backdrop is-visible" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="react-release-notes-title" aria-describedby="react-release-notes-description">
      <header className="release-notes-header"><div className="release-notes-title-group"><span className="release-notes-logo"><img src="/logo-puskesmas-32981.svg" alt="" width={40} height={40} loading="lazy" decoding="async" /></span><div><p className="release-notes-eyebrow">E-Posyandu v{APP_VERSION}</p><h2 id="react-release-notes-title">Apa yang Baru</h2></div></div><button type="button" className="release-notes-close" onClick={onClose} aria-label="Tutup Apa yang Baru">×</button></header>
      <div className="release-notes-scroll">
        <section className="release-current" id="react-release-notes-description">
          <div className="release-current-heading"><div><span className="release-current-label">Rilis terbaru</span><h3>{currentRelease.title}</h3></div><time dateTime={currentRelease.releaseDateIso}>{currentRelease.releaseDate}</time></div>
          {changeList(currentRelease)}
        </section>
        <section className="release-history" aria-labelledby="react-release-history-title">
          <h2 id="react-release-history-title">Riwayat Pembaruan</h2>
          <div className="release-history-list">
            {releaseHistory.map((release, index) => <article className={`release-history-item${index === 0 ? ' is-current' : ''}`} key={`${release.version}-${release.releaseDateIso}`}>
              <div className="release-history-rail" aria-hidden="true"><span /></div>
              <div className="release-history-content">
                <div className="release-history-heading"><div><span className="release-version-chip">v{release.version}</span><h3>{release.title}</h3></div><time dateTime={release.releaseDateIso}>{release.releaseDate}</time></div>
                {changeList(release)}
              </div>
            </article>)}
          </div>
        </section>
      </div>
      <footer className="release-notes-actions"><button type="button" className="release-notes-done" onClick={onClose}>Selesai</button></footer>
    </section>
  </div>;
}
