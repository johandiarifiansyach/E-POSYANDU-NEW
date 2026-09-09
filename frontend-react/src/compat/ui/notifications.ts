type NotificationKind = 'success' | 'error' | 'info';

let activeNotification: HTMLElement | null = null;
let dismissTimer: number | undefined;

function removeActiveNotification(animate = true) {
  if (dismissTimer !== undefined) window.clearTimeout(dismissTimer);
  dismissTimer = undefined;

  const notification = activeNotification;
  activeNotification = null;
  if (!notification) return;

  if (!animate) {
    notification.remove();
    return;
  }

  notification.classList.remove('is-visible');
  notification.classList.add('is-leaving');
  window.setTimeout(() => notification.remove(), 220);
}

function statusIcon(kind: NotificationKind) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const circle = document.createElementNS(namespace, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '9');
  svg.append(circle);

  const mark = document.createElementNS(namespace, 'path');
  mark.setAttribute('d', kind === 'success' ? 'm8.5 12 2.25 2.25 4.75-5' : kind === 'error' ? 'M12 7.5v5M12 16.5h.01' : 'M12 11v5M12 7.5h.01');
  svg.append(mark);
  return svg;
}

function closeIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', 'm7 7 10 10M17 7 7 17');
  svg.append(path);
  return svg;
}

function showNotification(kind: NotificationKind, titleText: string, message: string) {
  removeActiveNotification(false);

  const notification = document.createElement('div');
  notification.className = `ios-notification ios-notification-${kind}`;
  notification.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  notification.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  notification.setAttribute('aria-atomic', 'true');

  const icon = document.createElement('span');
  icon.className = 'ios-notification-icon';
  icon.append(statusIcon(kind));

  const content = document.createElement('div');
  content.className = 'ios-notification-content';
  const title = document.createElement('p');
  title.className = 'ios-notification-title';
  title.textContent = titleText;
  const detail = document.createElement('p');
  detail.className = 'ios-notification-detail';
  detail.textContent = message;
  content.append(title, detail);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ios-notification-close';
  closeButton.title = 'Tutup notifikasi';
  closeButton.setAttribute('aria-label', 'Tutup notifikasi');
  closeButton.append(closeIcon());
  closeButton.addEventListener('click', () => removeActiveNotification());

  notification.append(icon, content, closeButton);
  document.body.append(notification);
  activeNotification = notification;

  window.requestAnimationFrame(() => notification.classList.add('is-visible'));
  dismissTimer = window.setTimeout(() => removeActiveNotification(), kind === 'error' ? 5200 : 3800);
}

export function showSuccess(message: string) {
  showNotification('success', 'Berhasil', message);
}

export function showError(message: string) {
  showNotification('error', 'Tidak Berhasil', message);
}

export function showInfo(message: string) {
  showNotification('info', 'Informasi', message);
}
