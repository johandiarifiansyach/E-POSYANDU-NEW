import { lazy, Suspense } from 'react';
import type { ReactAddChildPageProps } from './ReactAddChildPage';

const ReactAddChildPage = lazy(() => import('./ReactAddChildPage'));

/** Modal-compatible React entrypoint retained for callers migrating from the old page modal. */
export type AddChildModalProps = Omit<ReactAddChildPageProps, 'onBack' | 'onSuccess'> & {
  initialData?: ReactAddChildPageProps['initialData'] | null;
  isEdit?: boolean;
  /** Compatibility callback used by callers of the former imperative modal. */
  onClose?: () => void;
  onBack?: () => void;
  onSuccess?: () => void;
};

export default function AddChildModal({ onClose, onBack, onSuccess, ...props }: AddChildModalProps) {
  const close = onClose ?? onBack ?? (() => undefined);
  const success = onSuccess ?? close;
  return <Suspense fallback={<div className="identity-modal-backdrop ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center" role="status"><div className="identity-modal-panel ios-liquid-modal w-full max-w-4xl p-8 text-center text-slate-500">Memuat formulir…</div></div>}>
    <ReactAddChildPage {...props} modal onBack={close} onSuccess={success} />
  </Suspense>;
}
