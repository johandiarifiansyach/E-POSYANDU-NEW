// @ts-nocheck
import Native from '../native/dom';
import { Dashboard } from './DashboardApp';
export default function DashboardPage({ user, onLogout }) {
    return Native.createElement(Dashboard, { user: user, onLogout: onLogout });
}
