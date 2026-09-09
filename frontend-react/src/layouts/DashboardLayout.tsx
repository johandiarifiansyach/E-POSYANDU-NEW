import type { ReactNode } from "react";

export type DashboardLayoutProps = {
  children: ReactNode;
  sidebar: ReactNode;
  topbar: ReactNode;
  footer?: ReactNode;
  mobileDock?: ReactNode;
  className?: string;
};

/**
 * Authenticated application frame.  The sidebar/topbar are slots so each
 * feature can migrate independently without changing the shell contract.
 */
export default function DashboardLayout({
  children,
  sidebar,
  topbar,
  footer,
  mobileDock,
  className = "",
}: DashboardLayoutProps) {
  return (
    <div
      className={`app-shell flex font-sans text-slate-900 ${className}`.trim()}
    >
      {sidebar}
      <div className="app-workspace flex min-w-0 flex-1 flex-col">
        {topbar}
        <main className="app-content flex-1 overflow-x-hidden p-4 sm:p-6 lg:p-8">
          {children}
        </main>
        {footer}
      </div>
      {mobileDock}
    </div>
  );
}
