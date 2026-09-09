export type NotificationTone = 'success' | 'error' | 'info';
export type NotificationDetail = { message: string; tone: NotificationTone };
export const NOTIFICATION_EVENT = 'e-posyandu:notification';

function publish(message: string, tone: NotificationTone) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<NotificationDetail>(NOTIFICATION_EVENT, { detail: { message, tone } }));
}

export const showSuccess = (message: string) => publish(message, 'success');
export const showError = (message: string) => publish(message, 'error');
export const showInfo = (message: string) => publish(message, 'info');
