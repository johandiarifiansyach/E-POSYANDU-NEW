import type { ReactNode } from 'react';

export default function DataTable({ children, className = '', ariaLabel = 'Tabel data' }: { children?: ReactNode; className?: string; ariaLabel?: string }) {
  return <div className={`ios-table-scroll overflow-x-auto ${className}`} role="region" tabIndex={0} aria-label={ariaLabel}>{children}</div>;
}
