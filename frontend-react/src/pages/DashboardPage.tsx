import type { DashboardUser } from '../types';
import ReactDashboardShell from '../features/dashboard/ReactDashboardShell';

/** React-owned dashboard entrypoint. */
export type DashboardPageProps = {
  user: DashboardUser;
  onLogout: () => Promise<void>;
};

export default function DashboardPage({ user, onLogout }: DashboardPageProps) {
  return <ReactDashboardShell user={user} onLogout={onLogout} />;
}
