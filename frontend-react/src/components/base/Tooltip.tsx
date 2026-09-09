import type { ReactNode } from 'react';

export type TooltipProps = { label: string; children: ReactNode; className?: string };

/** Accessible hover/focus label for compact action controls. */
export default function Tooltip({ label, children, className = '' }: TooltipProps) {
  return <span className={`ui-tooltip ${className}`.trim()} title={label} aria-label={label}>{children}</span>;
}
