import { LATEST_RELEASE, RELEASE_HISTORY, type AppRelease } from '../config/releases';

let activeDialog: HTMLElement | null = null;
let previousFocus: HTMLElement | null = null;
let previousBodyOverflow = '';

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function changeList(release: AppRelease) {
  return release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join('');
}

function historyMarkup() {
  return RELEASE_HISTORY.map((release, index) => `
    <article class="release-history-item${index === 0 ? ' is-current' : ''}">
      <div class="release-history-rail" aria-hidden="true"><span></span></div>
      <div class="release-history-content">
        <div class="release-history-heading">
          <div>
            <span class="release-version-chip">v${escapeHtml(release.version)}</span>
            <h3>${escapeHtml(release.title)}</h3>
          </div>
          <time datetime="${release.releaseDateIso}">${escapeHtml(release.releaseDate)}</time>
        </div>
        <ul>${changeList(release)}</ul>
      </div>
    </article>
  `).join('');
}

function dialogMarkup() {
  return `
    <section class="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="release-notes-title" aria-describedby="release-notes-description">
      <header class="release-notes-header">
        <div class="release-notes-title-group">
          <span class="release-notes-logo"><img src="/logo-puskesmas-32981.svg" alt="" /></span>
          <div>
            <p class="release-notes-eyebrow">E-Posyandu v${escapeHtml(LATEST_RELEASE.version)}</p>
            <h2 id="release-notes-title">Apa yang Baru</h2>
          </div>
        </div>
        <button type="button" class="release-notes-close" data-release-notes-close aria-label="Tutup Apa yang Baru" title="Tutup">&times;</button>
      </header>
      <div class="release-notes-scroll">
        <section class="release-current" id="release-notes-description">
          <div class="release-current-heading">
            <div>
              <span class="release-current-label">Rilis terbaru</span>
              <h3>${escapeHtml(LATEST_RELEASE.title)}</h3>
            </div>
            <time datetime="${LATEST_RELEASE.releaseDateIso}">${escapeHtml(LATEST_RELEASE.releaseDate)}</time>
          </div>
          <ul>${changeList(LATEST_RELEASE)}</ul>
        </section>
        <section class="release-history" aria-labelledby="release-history-title">
          <h2 id="release-history-title">Riwayat Pembaruan</h2>
          <div class="release-history-list">${historyMarkup()}</div>
        </section>
      </div>
      <footer class="release-notes-actions">
        <button type="button" class="release-notes-done" data-release-notes-close>Selesai</button>
      </footer>
    </section>
  `;
}

export function closeReleaseNotes() {
  const dialog = activeDialog;
  if (!dialog) return;
  activeDialog = null;
  dialog.classList.remove('is-visible');
  document.body.style.overflow = previousBodyOverflow;
  window.setTimeout(() => dialog.remove(), 220);
  previousFocus?.focus({ preventScroll: true });
  previousFocus = null;
}

export function openReleaseNotes() {
  if (activeDialog) {
    activeDialog.querySelector<HTMLElement>('[data-release-notes-close]')?.focus({ preventScroll: true });
    return;
  }

  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousBodyOverflow = document.body.style.overflow;
  const backdrop = document.createElement('div');
  backdrop.className = 'release-notes-backdrop';
  backdrop.innerHTML = dialogMarkup();
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  activeDialog = backdrop;

  const closeButtons = backdrop.querySelectorAll<HTMLButtonElement>('[data-release-notes-close]');
  closeButtons.forEach((button) => button.addEventListener('click', closeReleaseNotes));
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeReleaseNotes();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeReleaseNotes();
    if (event.key !== 'Tab') return;

    const focusable = Array.from(backdrop.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.requestAnimationFrame(() => {
    backdrop.classList.add('is-visible');
    backdrop.querySelector<HTMLButtonElement>('[data-release-notes-close]')?.focus({ preventScroll: true });
  });
}
