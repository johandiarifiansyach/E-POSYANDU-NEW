function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} /></svg>;
}

export default function Pagination({ currentPage, totalPages, disablePrevious = false, disableNext = false, onPrevious, onNext }: { currentPage: number; totalPages: number; disablePrevious?: boolean; disableNext?: boolean; onPrevious: () => void; onNext: () => void }) {
  return <nav className="ios-pagination" aria-label="Navigasi halaman tabel">
    <button type="button" className="ios-pagination-button" disabled={disablePrevious} onClick={onPrevious} title="Halaman sebelumnya" aria-label="Kembali ke halaman sebelumnya"><Chevron direction="left" /><span>Kembali</span></button>
    <span className="ios-page-indicator" aria-current="page"><span className="ios-page-indicator-label">Halaman</span><strong>{currentPage}</strong><span aria-hidden="true">/</span><span>{Math.max(1, totalPages)}</span></span>
    <button type="button" className="ios-pagination-button" disabled={disableNext} onClick={onNext} title="Halaman berikutnya" aria-label="Lanjut ke halaman berikutnya"><span>Berikutnya</span><Chevron direction="right" /></button>
  </nav>;
}
