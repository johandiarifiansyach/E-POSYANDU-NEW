import type { ReactNode } from 'react';

export type MaintenanceLayoutProps = { children: ReactNode };

export default function MaintenanceLayout({ children }: MaintenanceLayoutProps) {
  return <main className="maintenance-layout">{children}</main>;
}
