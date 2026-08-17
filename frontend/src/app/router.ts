// @ts-nocheck
import Native from '../runtime/dom';
import { COMPACT_SIDEBAR_MEDIA_QUERY, DASHBOARD_TABS } from '../config/dashboard';

export const dashboardPages = {
    dashboard: Native.lazy(() => import('../pages/DashboardOverviewPage')),
    pmt_program: Native.lazy(() => import('../pages/PmtProgramPage')),
    change_history: Native.lazy(() => import('../pages/ChangeHistoryPage')),
    data_balita: Native.lazy(() => import('../pages/ChildrenTablePage')),
    measurement: Native.lazy(() => import('../pages/MeasurementPage')),
    add_child: Native.lazy(() => import('../pages/AddChildPage')),
    asi_eksklusif: Native.lazy(() => import('../pages/ExclusiveBreastfeedingPage'))
};

export const isDashboardTab = (value) => DASHBOARD_TABS.includes(value);

export const getDashboardHashState = () => {
    if (typeof window === 'undefined')
        return { tab: 'dashboard', measurementChildId: null };

    const raw = window.location.hash.replace(/^#\/?/, '');
    if (raw.startsWith('measurement/')) {
        const childId = decodeURIComponent(raw.replace(/^measurement\//, ''));
        return {
            tab: childId ? 'measurement' : 'data_balita',
            measurementChildId: childId || null
        };
    }

    const [tab, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    return {
        tab: isDashboardTab(tab) ? tab : 'dashboard',
        measurementChildId: params.get('child') || null
    };
};

export const shouldDefaultToCompactSidebar = () => (
    typeof window !== 'undefined' && window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches
);

export const applySidebarCollapsedState = (shell, button, collapsed) => {
    if (shell)
        shell.classList.toggle('is-sidebar-collapsed', collapsed);
    if (button) {
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', collapsed ? 'Perluas Menu' : 'Ringkas Menu');
        button.setAttribute('title', collapsed ? 'Perluas Menu' : 'Ringkas Menu');
    }
};
