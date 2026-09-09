import type { ReactNode } from 'react';

export type InlineNoticeTone = 'info' | 'success' | 'warning' | 'error';

export type InlineNoticeProps = {
  tone?: InlineNoticeTone;
  children: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
};

const toneClasses: Record<InlineNoticeTone, string> = {
  info: 'ios-inline-notification-info',
  success: 'ios-inline-notification-success',
  warning: 'ios-inline-notification-warning',
  error: 'ios-inline-notification-error'
};

/** Consistent inline feedback for loading fallbacks and recoverable errors. */
export default function InlineNotice({ tone = 'info', children, className = '', role }: InlineNoticeProps) {
  return <div role={role || (tone === 'error' ? 'alert' : 'status')} className={`ios-inline-notification ${toneClasses[tone]} ${className}`.trim()}>{children}</div>;
}
