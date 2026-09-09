import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type AppModalProps = {
  children?: ReactNode;
  onClose: () => void | Promise<void>;
  title?: string;
  className?: string;
  backdropClassName?: string;
  panelClassName?: string;
  bodyClassName?: string;
  footer?: ReactNode;
};

export default function AppModal({ children, onClose, title = '', className = '', backdropClassName = '', panelClassName = '', bodyClassName = 'p-4', footer = null }: AppModalProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') void onClose(); };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);
  return <div className={`fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-md ${backdropClassName}`} role="dialog" aria-modal="true" aria-label={title || 'Dialog'} onMouseDown={(event) => { if (event.target === event.currentTarget) void onClose(); }}>
    <div className={`app-card max-h-[90vh] w-full max-w-3xl overflow-y-auto ${panelClassName} ${className}`}>
      <div className="flex items-center justify-between border-b border-slate-200/70 p-4">
        <h2 className="text-lg font-bold">{title}</h2>
        <button ref={closeRef} type="button" onClick={() => void onClose()} aria-label="Tutup">×</button>
      </div>
      <div className={bodyClassName}>{children}</div>
      {footer ? <div className="border-t border-slate-200/70 p-4">{footer}</div> : null}
    </div>
  </div>;
}
