import { Dashboard, UserRole } from './LegacyApp';

type DashboardPageProps = {
  user: UserRole;
  onLogout: () => void;
};

export default function DashboardPage({ user, onLogout }: DashboardPageProps) {
  return <Dashboard user={user} onLogout={onLogout} />;
}
