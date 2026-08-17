import { LATEST_RELEASE, RELEASE_HISTORY, type AppRelease } from '../config/releases';
import { createElement as h } from '../runtime/dom';

let activeDialog: HTMLElement | null = null;
let previousFocus: HTMLElement | null = null;
let previousBodyOverflow = '';

function changeList(release: AppRelease) {
  return h('ul', null, release.changes.map((change) => h('li', null, change)));
}

function historyItem(release: AppRelease, index: number) {
  return h('article', { className: `release-history-item${index === 0 ? ' is-current' : ''}` },
    h('div', { className: 'release-history-rail', 'aria-hidden': 'true' }, h('span', null)),
    h('div', { className: 'release-history-content' },
      h('div', { className: 'release-history-heading' },
        h('div', null,
          h('span', { className: 'release-version-chip' }, `v${release.version}`),
          h('h3', null, release.title)
        ),
        h('time', { dateTime: release.releaseDateIso }, release.releaseDate)
      ),
      changeList(release)
    )
  );
}

function dialogView() {
  return h('section', {
    className: 'release-notes-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'release-notes-title',
    'aria-describedby': 'release-notes-description'
  },
  h('header', { className: 'release-notes-header' },
    h('div', { className: 'release-notes-title-group' },
      h('span', { className: 'release-notes-logo' }, h('img', { src: '/logo-puskesmas-32981.svg', alt: '' })),
      h('div', null,
        h('p', { className: 'release-notes-eyebrow' }, `E-Posyandu v${LATEST_RELEASE.version}`),
        h('h2', { id: 'release-notes-title' }, 'Apa yang Baru')
      )
    ),
    h('button', {
      type: 'button',
      className: 'release-notes-close',
      'data-release-notes-close': true,
      'aria-label': 'Tutup Apa yang Baru',
      title: 'Tutup'
    }, '×')
  ),
  h('div', { className: 'release-notes-scroll' },
    h('section', { className: 'release-current', id: 'release-notes-description' },
      h('div', { className: 'release-current-heading' },
        h('div', null,
          h('span', { className: 'release-current-label' }, 'Rilis terbaru'),
          h('h3', null, LATEST_RELEASE.title)
        ),
        h('time', { dateTime: LATEST_RELEASE.releaseDateIso }, LATEST_RELEASE.releaseDate)
      ),
      changeList(LATEST_RELEASE)
    ),
    h('section', { className: 'release-history', 'aria-labelledby': 'release-history-title' },
      h('h2', { id: 'release-history-title' }, 'Riwayat Pembaruan'),
      h('div', { className: 'release-history-list' }, RELEASE_HISTORY.map(historyItem))
    )
  ),
  h('footer', { className: 'release-notes-actions' },
    h('button', { type: 'button', className: 'release-notes-done', 'data-release-notes-close': true }, 'Selesai')
  ));
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
  backdrop.append(dialogView());
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
