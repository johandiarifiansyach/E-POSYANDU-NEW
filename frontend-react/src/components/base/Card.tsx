import type { HTMLAttributes, ReactNode } from 'react';

export function Card({ children, className = '', ...props }: { children?: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`app-card rounded-2xl ${className}`}>{children}</div>;
}

export function InputGroup({ label, children, error }: { label: string; children?: ReactNode; error?: string | null }) {
  return <div className="space-y-2">
    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">{label}</label>
    {children}
    {error ? <p className="text-xs text-rose-500">{error}</p> : null}
  </div>;
}
