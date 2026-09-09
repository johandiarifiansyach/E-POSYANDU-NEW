import type { ReactNode } from 'react';

export type AuthLayoutProps = {
  children: ReactNode;
  footer?: ReactNode;
  themeToggle?: ReactNode;
};

/** Shared unauthenticated shell; visual tokens match the application theme. */
export default function AuthLayout({ children, footer, themeToggle }: AuthLayoutProps) {
  return <div className="login-shell">
    <div className="login-batik-background" aria-hidden="true" />
    {themeToggle}
    <main className="login-stage"><div className="login-stack">{children}</div></main>
    {footer ? <footer className="login-footer">{footer}</footer> : null}
  </div>;
}
