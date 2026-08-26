// @ts-nocheck
import { APP_VERSION } from '../config/app';
import * as Context from '../shared/dashboardContext';
import type { PageState } from '../shared/pageState';
import { applySidebarCollapsedState, dashboardPages, getDashboardHashState, isDashboardTab, shouldDefaultToCompactSidebar } from './router';
import { MpasiModal } from '../features/breastfeeding/MpasiModal';
import { PmtModal, PmtMonitoringModal } from '../features/pmt/modals';
import { DeleteChildModal, AddChildModal } from '../features/children/modals';
import { MeasurementModal } from '../features/measurements/MeasurementModal';
import { filterByLocation } from '../services/locationService';
import { createSafeWorksheet, sanitizeImportedCellText, validateSpreadsheetFile } from '../services/xlsx';
import {
    buildSigiziMeasurementExportItems,
    fetchExportChildren,
    fetchExportDocuments,
    filterChildrenByAgeRange,
    getMpasiExportRows,
    getPmtExportRows,
    getSelectedMonthRange,
    getSigiziIdentityRows,
    getSigiziMeasurementRows,
    getTableExportRows,
    latestMeasurementsByChild,
    latestMpasiLogsByChild,
    MPASI_EXPORT_HEADERS,
    PMT_EXPORT_HEADERS,
    SIGIZI_IDENTITY_HEADERS,
    SIGIZI_MEASUREMENT_HEADERS,
    TABLE_EXPORT_HEADERS,
} from '../services/exportService';

const {
    Native, useState, useEffect, useLayoutEffect, useMemo, useRef,
    getFirestore, collection, addDoc, query, where, onSnapshot, serverTimestamp,
    updateDoc, doc, deleteDoc, getDocs, getDocsForExport, getCachedChildrenPage, peekCachedChildrenPage,
    getChangeHistory, getChildDetail, getChildrenPage, getDashboardStats,
    getMonitoringStatus, getSigiziMeasurementExport, initializeApp, reportAccountPresence,
    listSyncConflicts, resolveSyncConflict, subscribeToSyncConflicts,
    subscribeToRealtime, subscribeToSyncedMutations, syncActiveViewFromServer, syncPendingMutations,
    orderBy, DATA_WILAYAH, ROLES, isFullAccessRole, DASHBOARD_TABS, COMPACT_SIDEBAR_MEDIA_QUERY,
    MONTHS, YEARS, formatChildName, getKBM, formatDate, formatIndoDate,
    formatIndoDateTime, getAgeInMonths, calculateZScore, calculateGiziStatus,
    generateRandomDigits, normalizeDecimalInput, parseLocaleNumber,
    parseLocaleNumberForRange, ensureXlsx, Card, Button, InputGroup, Select,
    LocationFilterPanel, Badge, KenaikanBadge, StatusBadge,
    getPreferredColorScheme, saveColorScheme, subscribeColorScheme,
    Activity, Ruler, LogOut, Plus, MapPin, Clock, Baby, XCircle, ChevronDown,
    ChevronLeft, ChevronRight, Loader2, LayoutDashboard, Users, Trash2, Menu,
    AlertTriangle, TrendingDown, AlertCircle, Minus, Utensils, Gift,
    ClipboardCheck, CheckSquare, History, Filter, RotateCcw, UserRound, X,
    Moon, Sun, showSuccess, openReleaseNotes, DashboardPageSkeleton,
    db, appId
} = Context;

const {
    dashboard: DashboardOverviewPage,
    admin_backend: AdminBackendPage,
    pmt_program: PmtProgramPage,
    change_history: ChangeHistoryPage,
    data_balita: ChildrenTablePage,
    measurement: MeasurementPage,
    add_child: AddChildPage,
    asi_eksklusif: ExclusiveBreastfeedingPage
} = dashboardPages;

const EMPTY_DASHBOARD_STATS = {
    S: 0, D: 0, N: 0, T: 0, B: 0, O: 0,
    asiEksklusif: 0, asiTarget: 0,
    underweight: 0, stunting: 0, wasting: 0,
    perD: '0', perN: '0', perT: '0', perAsiEksklusif: '0',
    perUnderweight: '0', perStunting: '0', perWasting: '0'
};
export { EMPTY_DASHBOARD_STATS };

export const Dashboard = ({ user, onLogout }) => {
    const canWrite = user.accessMode !== 'read';
    const [children, setChildren] = useState([]);
    const [monthlyMeasurements, setMonthlyMeasurements] = useState({});
    const [pmtPrograms, setPmtPrograms] = useState([]);
    const [mpasiLogs, setMpasiLogs] = useState({});
    const [changeLogs, setChangeLogs] = useState([]);
    const [changeHistoryError, setChangeHistoryError] = useState(null);
    const [changeHistoryRevision, setChangeHistoryRevision] = useState(0);
    const [changeHistoryPage, setChangeHistoryPage] = useState(1);
    const [changeHistoryTotal, setChangeHistoryTotal] = useState(0);
    const [editingChild, setEditingChild] = useState(null);
    const [childToDelete, setChildToDelete] = useState(null);
    const [childToMpasi, setChildToMpasi] = useState(null);
    const [pmtModalData, setPmtModalData] = useState(null);
    const [pmtMonitoringData, setPmtMonitoringData] = useState(null);
    const [errorMsg, setErrorMsg] = useState(null);
    const [dashboardStats, setDashboardStats] = useState(EMPTY_DASHBOARD_STATS);
    const lastDashboardStatsRef = useRef(null);
    const [monitoringStatus, setMonitoringStatus] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [searchDraft, setSearchDraft] = useState('');
    const [sortOrder, setSortOrder] = useState('recent');
    const [activeTab, setActiveTab] = useState(() => {
        const requestedTab = getDashboardHashState().tab;
        return requestedTab === 'admin_backend' && user.role !== ROLES.SUPER_ADMIN
            ? 'dashboard'
            : requestedTab;
    });
    const [measurementChildId, setMeasurementChildId] = useState(() => getDashboardHashState().measurementChildId);
    const [selectedMeasurementChild, setSelectedMeasurementChild] = useState(null);
    const [measurementBackTab, setMeasurementBackTab] = useState('data_balita');
    const [addChildBackTab, setAddChildBackTab] = useState('data_balita');
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const sidebarCollapsedRef = useRef(shouldDefaultToCompactSidebar());
    const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
    const pmtLoadedRef = useRef(false);
    const [colorScheme, setColorScheme] = useState(() => getPreferredColorScheme());
    const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
    const [filterYear, setFilterYear] = useState(new Date().getFullYear());
    const [viewDesa, setViewDesa] = useState(isFullAccessRole(user.role) ? '' : (user.desa || ''));
    const [viewPosyandu, setViewPosyandu] = useState(user.role === ROLES.KADER ? (user.posyandu || '') : '');
    const [draftDesa, setDraftDesa] = useState(isFullAccessRole(user.role) ? '' : (user.desa || ''));
    const [draftPosyandu, setDraftPosyandu] = useState(user.role === ROLES.KADER ? (user.posyandu || '') : '');
    const fileInputRef = useRef(null);
    const accountMenuRef = useRef(null);
    const appShellRef = useRef(null);
    const sidebarCollapseButtonRef = useRef(null);
    const sidebarTooltipRef = useRef(null);
    useEffect(() => subscribeColorScheme(setColorScheme), []);
    useEffect(() => {
        if (!isAccountMenuOpen)
            return;
        const closeOnOutsideClick = (event) => {
            if (accountMenuRef.current && !accountMenuRef.current.contains(event.target))
                setIsAccountMenuOpen(false);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape')
                setIsAccountMenuOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsideClick);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsideClick);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [isAccountMenuOpen]);
    useEffect(() => setIsAccountMenuOpen(false), [activeTab]);
    useEffect(() => {
        const pulse = () => {
            if (document.visibilityState === 'visible' && navigator.onLine)
                void reportAccountPresence().catch(() => undefined);
        };
        pulse();
        const intervalId = window.setInterval(pulse, 60_000);
        document.addEventListener('visibilitychange', pulse);
        window.addEventListener('online', pulse);
        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', pulse);
            window.removeEventListener('online', pulse);
        };
    }, []);
    useEffect(() => {
        const compactLayout = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY);
        const handleLayoutChange = (event) => {
            if (!event.matches)
                return;
            sidebarCollapsedRef.current = true;
            applySidebarCollapsedState(appShellRef.current, sidebarCollapseButtonRef.current, true);
            setIsSidebarOpen(false);
        };
        compactLayout.addEventListener('change', handleLayoutChange);
        return () => compactLayout.removeEventListener('change', handleLayoutChange);
    }, []);
    // Pagination State
    const [currentPage, setCurrentPage] = useState(1);
    const [pagedChildren, setPagedChildren] = useState([]);
    const [pagedMeasurements, setPagedMeasurements] = useState({});
    const [pagedMpasiLogs, setPagedMpasiLogs] = useState({});
    const [pagedChildrenTotal, setPagedChildrenTotal] = useState(0);
    const [childrenPageState, setChildrenPageState] = useState<PageState<any[]>>({ status: 'idle' });
    const [measurementsPageState, setMeasurementsPageState] = useState<PageState<Record<string, any>>>({ status: 'idle' });
    const [dashboardPageState, setDashboardPageState] = useState<PageState<any>>({ status: 'idle' });
    const [changeHistoryPageState, setChangeHistoryPageState] = useState<PageState<any>>({ status: 'idle' });
    const [pmtPageState, setPmtPageState] = useState<PageState<any[]>>({ status: 'idle' });
    const [pagedChildrenPageState, setPagedChildrenPageState] = useState<PageState<any>>({ status: 'idle' });
    const [dataRevision, setDataRevision] = useState(0);
    const [syncConflicts, setSyncConflicts] = useState([]);
    const childrenLoading = childrenPageState.status === 'loading';
    const measurementsLoading = measurementsPageState.status === 'loading';
    const changeHistoryLoading = changeHistoryPageState.status === 'loading';
    const dashboardStatsLoading = dashboardPageState.status === 'loading';
    const pagedChildrenLoading = pagedChildrenPageState.status === 'loading';
    const itemsPerPage = 10;
    const serverPagedChildTabs = [
        'data_balita',
        'recent',
        'recycle_bin',
        'mpasi',
        'problem_underweight',
        'problem_stunting',
        'problem_wasting',
        'problem_tidak_naik'
    ];
    const isServerPagedChildTab = serverPagedChildTabs.includes(activeTab);
    useEffect(() => {
        const syncTabFromHash = () => {
            const hashState = getDashboardHashState();
            const protectedWriteTab = !canWrite && (hashState.tab === 'add_child' || hashState.tab === 'measurement');
            const allowedTab = (hashState.tab === 'admin_backend' && user.role !== ROLES.SUPER_ADMIN) || protectedWriteTab
                ? 'dashboard' : hashState.tab;
            if (allowedTab !== hashState.tab)
                window.history.replaceState(null, '', '#dashboard');
            setActiveTab(allowedTab);
            setMeasurementChildId(allowedTab === 'measurement' ? hashState.measurementChildId : null);
        };
        window.addEventListener('hashchange', syncTabFromHash);
        return () => window.removeEventListener('hashchange', syncTabFromHash);
    }, [user.role, canWrite]);
    useEffect(() => {
        let refreshTimer;
        const unsubscribe = subscribeToSyncedMutations(() => {
            if (!isServerPagedChildTab && activeTab !== 'dashboard' && activeTab !== 'asi_eksklusif')
                return;
            if (refreshTimer !== undefined)
                window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                setDataRevision((revision) => revision + 1);
                refreshTimer = undefined;
            }, 200);
        });
        return () => {
            unsubscribe();
            if (refreshTimer !== undefined)
                window.clearTimeout(refreshTimer);
        };
    }, [activeTab, isServerPagedChildTab]);
    // Server-paged views and the dashboard do not have a local collection
    // subscription, so they listen for a lightweight SSE change event and
    // refetch only while the current tab is visible.
    useEffect(() => {
        if (activeTab === 'admin_backend')
            return;
        let refreshTimer;
        const unsubscribe = subscribeToRealtime(() => {
            if (refreshTimer !== undefined)
                window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                if (activeTab === 'change_history')
                    setChangeHistoryRevision((revision) => revision + 1);
                else if (isServerPagedChildTab || activeTab === 'dashboard' || activeTab === 'asi_eksklusif')
                    setDataRevision((revision) => revision + 1);
                refreshTimer = undefined;
            }, 200);
        });
        return () => {
            unsubscribe();
            if (refreshTimer !== undefined)
                window.clearTimeout(refreshTimer);
        };
    }, [activeTab, isServerPagedChildTab]);
    useEffect(() => {
        let current = true;
        const refreshConflicts = () => {
            void listSyncConflicts().then((items) => {
                if (current)
                    setSyncConflicts(items);
            });
        };
        refreshConflicts();
        const unsubscribe = subscribeToSyncConflicts(refreshConflicts);
        return () => {
            current = false;
            unsubscribe();
        };
    }, []);
    // Fetch Children
    useEffect(() => {
        const hasSelectedMeasurement = activeTab === 'measurement' && selectedMeasurementChild?.id === measurementChildId;
        if (activeTab === 'dashboard' || activeTab === 'admin_backend' || activeTab === 'asi_eksklusif' || isServerPagedChildTab || hasSelectedMeasurement) {
            setChildrenPageState({ status: 'idle' });
            return;
        }
        setChildrenPageState({ status: 'loading' });
        const childrenCollection = collection(db, 'artifacts', appId, 'public', 'data', 'children');
        const scopedDesa = isFullAccessRole(user.role) ? viewDesa : user.desa;
        const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
        let q = query(childrenCollection);
        if (scopedDesa && scopedPosyandu) {
            q = query(childrenCollection, where('desa', '==', scopedDesa), where('posyandu', '==', scopedPosyandu));
        }
        else if (scopedDesa) {
            q = query(childrenCollection, where('desa', '==', scopedDesa));
        }
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setErrorMsg(null);
            let data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            if (user.role === ROLES.KADER)
                data = data.filter(c => c.posyandu === user.posyandu && c.desa === user.desa);
            else if (user.role === ROLES.BIDAN)
                data = data.filter(c => c.desa === user.desa);
            data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
            setChildren(data);
            setChildrenPageState({ status: 'success', data });
        }, (err) => {
            console.error(err);
            const message = 'Gagal memuat data: ' + err.message;
            setChildrenPageState({ status: 'error', message });
            setErrorMsg(message);
        });
        return () => unsubscribe();
    }, [activeTab, isServerPagedChildTab, measurementChildId, selectedMeasurementChild, user, viewDesa, viewPosyandu]);
    // Reset pagination when filters change
    useLayoutEffect(() => {
        setCurrentPage(1);
    }, [activeTab, searchTerm, sortOrder, viewDesa, viewPosyandu, filterMonth, filterYear]);
    // Fetch Change Logs
    useEffect(() => {
        if (activeTab !== 'change_history')
            return;
        let current = true;
        setChangeHistoryError(null);
        if (changeHistoryPageState.status !== 'success')
            setChangeHistoryPageState({ status: 'loading' });
        void getChangeHistory(changeHistoryPage, 10)
            .then(({ items, total }) => {
                if (!current)
                    return;
                const mappedItems = items.map((document) => ({ id: document.id, ...document.data }));
                setChangeLogs(mappedItems);
                setChangeHistoryTotal(total);
                setChangeHistoryPageState({ status: 'success', data: { items: mappedItems, total } });
            })
            .catch((error) => {
                if (!current)
                    return;
                console.error('Gagal memuat riwayat perubahan:', error);
                const message = error instanceof Error ? error.message : 'Riwayat perubahan tidak dapat dimuat.';
                setChangeHistoryError(message);
                setChangeHistoryPageState({ status: 'error', message });
            });
        return () => {
            current = false;
        };
    }, [activeTab, changeHistoryPage, changeHistoryRevision]);
    // Fetch Monthly Measurements
    useEffect(() => {
        if (activeTab === 'dashboard' || activeTab === 'admin_backend' || activeTab === 'asi_eksklusif' || isServerPagedChildTab) {
            setMonthlyMeasurements({});
            setMeasurementsPageState({ status: 'idle' });
            return;
        }
        setMeasurementsPageState({ status: 'loading' });
        const m = String(filterMonth).padStart(2, '0');
        const y = filterYear;
        const startStr = `${y}-${m}-01`;
        const endStr = `${y}-${m}-31`;
        const measurementsCollection = collection(db, 'artifacts', appId, 'public', 'data', 'measurements');
        const scopedDesa = isFullAccessRole(user.role) ? viewDesa : user.desa;
        const scopedPosyandu = user.role === ROLES.KADER ? user.posyandu : viewPosyandu;
        let q = query(measurementsCollection, where('tglUkur', '>=', startStr), where('tglUkur', '<=', endStr));
        if (scopedDesa && scopedPosyandu) {
            q = query(measurementsCollection, where('tglUkur', '>=', startStr), where('tglUkur', '<=', endStr), where('desa', '==', scopedDesa), where('posyandu', '==', scopedPosyandu));
        }
        else if (scopedDesa) {
            q = query(measurementsCollection, where('tglUkur', '>=', startStr), where('tglUkur', '<=', endStr), where('desa', '==', scopedDesa));
        }
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const mapping = {};
            snapshot.docs.forEach((doc) => {
                const data = doc.data();
                if (data.tglUkur >= startStr && data.tglUkur <= endStr)
                    mapping[data.childId] = { id: doc.id, ...data };
            });
            setMonthlyMeasurements(mapping);
            setMeasurementsPageState({ status: 'success', data: mapping });
        }, (error) => {
            console.error("Error fetching measurements:", error);
            const message = error instanceof Error ? error.message : 'Data penimbangan tidak dapat dimuat.';
            setMeasurementsPageState({ status: 'error', message });
            setErrorMsg('Gagal memuat penimbangan: ' + message);
        });
        return () => unsubscribe();
    }, [activeTab, filterMonth, filterYear, isServerPagedChildTab, user, viewDesa, viewPosyandu]);
    // Table-based child views request one page only, never the whole collection.
    useEffect(() => {
        if (!isServerPagedChildTab)
            return;
        let current = true;
        const month = String(filterMonth).padStart(2, '0');
        const lastDay = String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0');
        const monthStart = `${filterYear}-${month}-01`;
        const monthEnd = `${filterYear}-${month}-${lastDay}`;
        const request = {
            asOf: activeTab === 'recent' ? monthStart : monthEnd,
            measurementEnd: monthEnd,
            measurementStart: monthStart,
            page: currentPage,
            posyandu: viewPosyandu || undefined,
            search: searchTerm,
            size: itemsPerPage,
            sort: sortOrder,
            view: activeTab === 'data_balita' ? 'data' : activeTab === 'recycle_bin' ? 'recycle' : activeTab,
            village: viewDesa || undefined
        };
        const applyPage = (result) => {
            if (!current)
                return;
            const measurementByChild = {};
            result.measurements.forEach((item) => {
                const measurement = { id: item.id, ...item.data };
                if (measurement.childId)
                    measurementByChild[measurement.childId] = measurement;
            });
            const mpasiByChild = {};
            (result.mpasiLogs || []).forEach((item) => {
                const log = { id: item.id, ...item.data };
                if (log.childId)
                    mpasiByChild[log.childId] = log;
            });
            const mappedChildren = result.items.map((item) => ({ id: item.id, ...item.data }));
            setPagedChildren(mappedChildren);
            setPagedMeasurements(measurementByChild);
            setPagedMpasiLogs(mpasiByChild);
            setPagedChildrenTotal(result.total);
            setPagedChildrenPageState({ status: 'success', data: { items: mappedChildren, total: result.total } });
            setErrorMsg(null);
        };
        const memoryCachedPage = peekCachedChildrenPage(request);
        if (memoryCachedPage) {
            // Keep the previous result visible while the current tab is
            // revalidated; returning to a tab should never flash a skeleton.
            applyPage(memoryCachedPage);
        } else {
            setPagedChildrenPageState({ status: 'loading' });
        }
        const canPrimePersistentCache = ['data_balita', 'recent', 'recycle_bin'].includes(activeTab);
        void (async () => {
            if (!memoryCachedPage && canPrimePersistentCache) {
                try {
                    const cachedPage = await getCachedChildrenPage(request);
                    if (current && (cachedPage.items.length > 0 || cachedPage.total > 0))
                        applyPage(cachedPage);
                } catch (cacheError) {
                    console.warn('Cache halaman balita belum tersedia:', cacheError);
                }
            }
            try {
                applyPage(await getChildrenPage(request));
            } catch (error) {
            if (!current)
                return;
            const message = error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.';
            const networkUnavailable = !navigator.onLine || /failed to fetch|network|offline|load failed|fetch failed|connection|sementara tidak tersedia/i.test(message);
            if (networkUnavailable && activeTab === 'data_balita') {
                try {
                    applyPage(await getCachedChildrenPage(request));
                    return;
                }
                catch (cacheError) {
                    console.error('Gagal membaca cache Data Balita:', cacheError);
                }
            }
            console.error('Gagal memuat halaman Data Balita:', error);
            setPagedChildren([]);
            setPagedMeasurements({});
            setPagedMpasiLogs({});
            setPagedChildrenTotal(0);
            const pageError = `Gagal memuat data balita: ${message}`;
            setPagedChildrenPageState({ status: 'error', message: pageError });
            setErrorMsg(pageError);
            }
        })();
        return () => {
            current = false;
        };
    }, [activeTab, currentPage, dataRevision, filterMonth, filterYear, isServerPagedChildTab, itemsPerPage, searchTerm, sortOrder, viewDesa, viewPosyandu]);
    // Dashboard receives calculated totals only; no child or measurement collection is sent to the browser.
    useEffect(() => {
        if (activeTab !== 'dashboard')
            return;
        let current = true;
        const month = String(filterMonth).padStart(2, '0');
        const monthEnd = `${filterYear}-${month}-${String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0')}`;
        const monthStart = `${filterYear}-${month}-01`;
        const previous = new Date(filterYear, filterMonth - 2, 1);
        const previousYear = previous.getFullYear();
        const previousMonth = previous.getMonth() + 1;
        const previousMonthText = String(previousMonth).padStart(2, '0');
        const previousMonthStart = `${previousYear}-${previousMonthText}-01`;
        const previousMonthEnd = `${previousYear}-${previousMonthText}-${String(new Date(previousYear, previousMonth, 0).getDate()).padStart(2, '0')}`;
        const request = {
            monthEnd,
            monthStart,
            previousMonthEnd,
            previousMonthStart,
            village: viewDesa || undefined,
            posyandu: viewPosyandu || undefined
        };
        // Keep the browser cache separate from summaries produced by the old query.
        const requestKey = JSON.stringify(request);
        const cacheKey = `e-posyandu:dashboard-stats:v4:${requestKey}`;
        let cachedStats;
        try {
            const cached = window.localStorage.getItem(cacheKey);
            if (cached)
                cachedStats = JSON.parse(cached);
        }
        catch {
            cachedStats = null;
        }
        if (cachedStats) {
            setDashboardStats(cachedStats);
            setDashboardPageState({ status: 'success', data: cachedStats });
        }
        else {
            setDashboardPageState({ status: 'loading' });
        }
        void getDashboardStats(request)
            .then((stats) => {
            if (!current)
                return;
            lastDashboardStatsRef.current = { requestKey, stats };
            setDashboardStats(stats);
            setDashboardPageState({ status: 'success', data: stats });
            setErrorMsg(null);
            window.localStorage.setItem(cacheKey, JSON.stringify(stats));
        })
            .catch((error) => {
            if (!current)
                return;
            try {
                const cached = window.localStorage.getItem(cacheKey);
                if (cached) {
                    const cachedStats = JSON.parse(cached);
                    setDashboardStats(cachedStats);
                    setDashboardPageState({ status: 'success', data: cachedStats });
                    setErrorMsg(null);
                    return;
                }
            }
            catch {
                // Keep the API error when local storage cannot be read.
            }
            // A temporary database timeout must not replace a valid dashboard
            // with zeros. Keep the last successful result for this filter and
            // expose the problem as a warning while the next refresh retries.
            if (lastDashboardStatsRef.current?.requestKey === requestKey) {
                setDashboardStats(lastDashboardStatsRef.current.stats);
                setDashboardPageState({ status: 'success', data: lastDashboardStatsRef.current.stats });
                setErrorMsg(`Pembaruan ringkasan tertunda: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
                return;
            }
            const message = `Gagal memuat ringkasan dashboard: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`;
            setDashboardPageState({ status: 'error', message });
            setErrorMsg(message);
        });
        return () => {
            current = false;
        };
    }, [activeTab, dataRevision, filterMonth, filterYear, viewDesa, viewPosyandu]);
    useEffect(() => {
        if (activeTab !== 'dashboard' || !isFullAccessRole(user.role)) {
            setMonitoringStatus(null);
            return;
        }
        let current = true;
        const refreshMonitoring = () => {
            void getMonitoringStatus()
                .then((status) => {
                if (current)
                    setMonitoringStatus(status);
            })
                .catch(() => {
                if (current) {
                    setMonitoringStatus({
                        worker: { status: 'unknown', checkedAt: null, consecutiveFailures: 0 }
                    });
                }
            });
        };
        refreshMonitoring();
        const interval = window.setInterval(refreshMonitoring, 10 * 60 * 1000);
        return () => {
            current = false;
            window.clearInterval(interval);
        };
    }, [activeTab, user.role]);
    // Fetch PMT Programs (only active ones)
    useEffect(() => {
        if (activeTab !== 'pmt_program') {
            return;
        }
        if (!pmtLoadedRef.current)
            setPmtPageState({ status: 'loading' });
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'pmt_programs'));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const programs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            pmtLoadedRef.current = true;
            setPmtPrograms(programs);
            setPmtPageState({ status: 'success', data: programs });
        }, (error) => {
            const message = error instanceof Error ? error.message : 'Program PMT tidak dapat dimuat.';
            setPmtPageState({ status: 'error', message });
            setErrorMsg(`Gagal memuat program PMT: ${message}`);
        });
        return () => unsubscribe();
    }, [activeTab]);
    // Fetch MPASI Logs
    useEffect(() => {
        if (activeTab !== 'mpasi')
            return;
        setMpasiLogs({});
    }, [activeTab, filterMonth, filterYear]);
    useEffect(() => {
        if (activeTab === 'admin_backend')
            return;
        const timer = window.setTimeout(() => {
            void syncActiveViewFromServer().catch((error) => {
                console.warn('Pembaruan data otomatis dilewati:', error);
            });
        }, 0);
        return () => window.clearTimeout(timer);
    }, [activeTab, filterMonth, filterYear, viewDesa, viewPosyandu]);
    const filteredByLocation = useMemo(() => {
        return filterByLocation(children, viewDesa, viewPosyandu);
    }, [children, viewDesa, viewPosyandu]);
    const currentFilterDate = useMemo(() => new Date(filterYear, filterMonth, 0), [filterYear, filterMonth]);
    const activeChildren = useMemo(() => filteredByLocation.filter(c => {
        if (c.deletedAt)
            return false;
        const age = getAgeInMonths(c.tglLahir, currentFilterDate);
        return age >= 0 && age <= 59;
    }), [filteredByLocation, currentFilterDate]);
    const deletedChildren = useMemo(() => filteredByLocation.filter(c => c.deletedAt), [filteredByLocation]);
    const newInputs = useMemo(() => activeChildren.filter(c => {
        if (!c.createdAt)
            return false;
        const d = c.createdAt.toDate();
        return d.getMonth() + 1 === parseInt(String(filterMonth)) && d.getFullYear() === parseInt(String(filterYear));
    }), [activeChildren, filterMonth, filterYear]);
    const removeChildFromCurrentPage = (id) => {
        setPagedChildren((current) => current.filter((child) => child.id !== id));
        setPagedChildrenTotal((total) => Math.max(0, total - 1));
        setPagedChildrenPageState((current) => current.status === 'success'
            ? {
                status: 'success',
                data: {
                    items: current.data.items.filter((child) => child.id !== id),
                    total: Math.max(0, current.data.total - 1)
                }
            }
            : current);
        if (pagedChildren.length === 1 && currentPage > 1)
            setCurrentPage((page) => Math.max(1, page - 1));
    };
    const childMutationError = (action, error) => {
        const message = error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.';
        setErrorMsg(`Gagal ${action}: ${message}`);
    };
    const handleDeleteConfirm = async (id, deleteData) => { if (!canWrite) {
        setErrorMsg('Akun ini hanya memiliki hak baca.');
        return;
    } try {
        setErrorMsg(null);
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id), { deletedAt: serverTimestamp(), ...deleteData });
        removeChildFromCurrentPage(id);
        setChildToDelete(null);
        await syncPendingMutations();
        showSuccess('Data balita berhasil dipindahkan ke daftar dihapus.');
    }
    catch (e) {
        console.error('Gagal menghapus balita:', e);
        setChildToDelete(null);
        childMutationError('menghapus data balita', e);
    } };
    const handleRestore = async (id) => { if (!canWrite) {
        setErrorMsg('Akun ini hanya memiliki hak baca.');
        return;
    } if (!id)
        return; try {
        setErrorMsg(null);
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id), { deletedAt: null, deleteReason: null, deathDate: null, deathCause: null, deathLocation: null });
        removeChildFromCurrentPage(id);
        await syncPendingMutations();
        showSuccess('Data balita berhasil dipulihkan.');
    }
    catch (e) {
        console.error('Gagal memulihkan balita:', e);
        childMutationError('memulihkan data balita', e);
    } };
    const handlePermanentDelete = async (id) => { if (!canWrite) {
        setErrorMsg('Akun ini hanya memiliki hak baca.');
        return;
    } if (!id)
        return; try {
        setErrorMsg(null);
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'children', id));
        removeChildFromCurrentPage(id);
        await syncPendingMutations();
        showSuccess('Data balita berhasil dihapus permanen.');
    }
    catch (e) {
        console.error('Gagal menghapus permanen balita:', e);
        childMutationError('menghapus permanen data balita', e);
    } };
    const handleOpenPmtMonitoring = async (program, availableChild) => {
        if (!canWrite) {
            setErrorMsg('Akun ini hanya memiliki hak baca.');
            return false;
        }
        try {
            setErrorMsg(null);
            let child = availableChild;
            if (!child) {
                if (!program.childId)
                    throw new Error('Program PMT tidak memiliki identitas balita.');
                const childDocument = await getChildDetail(program.childId);
                child = { id: childDocument.id, ...childDocument.data };
                setChildren((current) => [
                    ...current.filter((item) => item.id !== child.id),
                    child
                ]);
            }
            setPmtMonitoringData({ program, child });
            return true;
        }
        catch (error) {
            console.error('Gagal membuka pemantauan PMT:', error);
            const message = error instanceof Error ? error.message : 'Data balita tidak dapat dimuat.';
            setErrorMsg(`Gagal membuka pemantauan PMT: ${message}`);
            return false;
        }
    };
    const handleDeletePmt = async (program) => {
        if (!canWrite) {
            setErrorMsg('Akun ini hanya memiliki hak baca.');
            return;
        }
        if (!program.id || !window.confirm(`Hapus program PMT untuk ${program.childName}? Data pemantauan mingguannya juga akan dihapus.`))
            return;
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'pmt_programs', program.id));
            await syncPendingMutations();
            setPmtPrograms((current) => current.filter((item) => item.id !== program.id));
            if (pmtMonitoringData?.program.id === program.id)
                setPmtMonitoringData(null);
            showSuccess('Program PMT berhasil dihapus.');
        }
        catch (error) {
            console.error('Gagal menghapus PMT:', error);
            setErrorMsg('Gagal menghapus program PMT. Silakan coba lagi.');
        }
    };
    const handleImportIdentitas = async (e) => {
        if (!canWrite) {
            setErrorMsg('Akun ini hanya memiliki hak baca.');
            if (e.target) e.target.value = '';
            return;
        }
        const file = e.target.files?.[0];
        if (!file)
            return;
        try {
            await validateSpreadsheetFile(file);
            const xlsx = await ensureXlsx();
            const fileBytes = await file.arrayBuffer();
            const wb = xlsx.read(fileBytes, {
                type: 'array',
                bookVBA: false,
                bookDeps: false,
                bookFiles: false,
                cellFormula: false,
                sheetRows: 5001,
                WTF: false
            });
            const ws = wb.Sheets[wb.SheetNames[0]];
            if (!ws)
                throw new Error('Lembar kerja Excel tidak ditemukan.');
            const data = xlsx.utils.sheet_to_json(ws, { defval: '', raw: false });
            if (data.length === 0)
                throw new Error('Berkas Excel tidak memiliki data identitas.');
            if (data.length > 5000)
                throw new Error('Impor dibatasi maksimal 5.000 baris per berkas.');
            if (!Object.prototype.hasOwnProperty.call(data[0], 'nama_anak') || !Object.prototype.hasOwnProperty.call(data[0], 'tgl_lahir'))
                throw new Error('Kolom nama_anak dan tgl_lahir wajib tersedia.');
                let importedCount = 0;
                let importDesa = user.desa || '', importPosyandu = user.posyandu || '';
                if (isFullAccessRole(user.role)) {
                    if (!viewDesa || !viewPosyandu)
                        return;
                    importDesa = viewDesa;
                    importPosyandu = viewPosyandu;
                }
                else if (user.role === ROLES.BIDAN) {
                    if (!viewPosyandu)
                        return;
                    importDesa = user.desa || '';
                    importPosyandu = viewPosyandu;
                }
                for (const row of data) {
                    const cleanNIK = sanitizeImportedCellText(row['NIK'], 32).replace(/'/g, '');
                    const cleanKK = sanitizeImportedCellText(row['nomor_KK'], 32).replace(/'/g, '');
                    const cleanNIKOrtu = sanitizeImportedCellText(row['nik_ortu'], 32).replace(/'/g, '');
                    const childData = {
                        anakKe: row['anak_ke'] || '', tglLahir: sanitizeImportedCellText(row['tgl_lahir'], 32), jk: sanitizeImportedCellText(row['jenis_kelamin'], 32) === 'Laki-laki' ? 'L' : 'P',
                        noKK: cleanKK, nik: cleanNIK, hasKK: !!cleanKK, hasNIK: !!cleanNIK, nama: sanitizeImportedCellText(row['nama_anak'], 120),
                        usiaKehamilan: row['usia_hamil'] || '', bbLahir: row['berat_lahir'] || '', pbLahir: row['panjang_lahir'] || '',
                        lkLahir: row['lingkar_kepala_lahir'] || '', bukuKIA: sanitizeImportedCellText(row['kia'], 16) || 'Tidak', bukuKIAKecil: sanitizeImportedCellText(row['kia_bayi_kecil'], 16) || 'Tidak',
                        imd: sanitizeImportedCellText(row['imd'], 16) || 'Tidak', namaOrtu: sanitizeImportedCellText(row['nama_ortu'], 120), nikOrtu: cleanNIKOrtu, noHpOrtu: sanitizeImportedCellText(row['hp_ortu'], 32),
                        alamat: sanitizeImportedCellText(row['alamat'], 500), rt: sanitizeImportedCellText(row['rt'], 8), rw: sanitizeImportedCellText(row['rw'], 8), desa: importDesa, posyandu: importPosyandu,
                        currentBB: row['berat_lahir'] || '', currentTB: row['panjang_lahir'] || '', currentLILA: 0, currentLK: row['lingkar_kepala_lahir'] || '',
                        createdAt: serverTimestamp(), createdBy: user.role, deletedAt: null
                    };
                    if (childData.nama && childData.tglLahir) {
                        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'children'), childData);
                        importedCount += 1;
                    }
                }
                await syncPendingMutations();
                if (importedCount > 0)
                    showSuccess(`${importedCount} data balita berhasil diimpor.`);
        }
        catch (error) {
            console.error('Impor identitas ditolak:', error);
            setErrorMsg(`Gagal mengimpor identitas: ${error instanceof Error ? error.message : 'Berkas tidak valid.'}`);
        }
        finally {
            if (fileInputRef.current)
                fileInputRef.current.value = "";
        }
    };
    const runExport = async (label, createFile) => {
        try {
            setErrorMsg(null);
            await createFile();
        }
        catch (error) {
            console.error(`Gagal ekspor ${label}:`, error);
            setErrorMsg(`Gagal membuat ${label}: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        }
    };
    const exportQueryContext = {
        db,
        appId,
        user,
        roles: ROLES,
        viewDesa,
        viewPosyandu,
        collection,
        query,
        where,
        getDocsForExport,
    };
    const handleExportSigizi = async () => {
        await runExport('file identitas Sigizi', async () => {
            const xlsx = await ensureXlsx();
            const exportedChildren = await fetchExportChildren({ currentFilterDate, ...exportQueryContext });
            const rows = getSigiziIdentityRows(exportedChildren, filterMonth, filterYear);
            const worksheet = createSafeWorksheet(xlsx, [SIGIZI_IDENTITY_HEADERS, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data Balita");
            xlsx.writeFile(workbook, `Format_Identitas_Sigizi_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    const handleExportPengukuranSigizi = async () => {
        await runExport('file pengukuran Sigizi', async () => {
            const xlsx = await ensureXlsx();
            const { start, end } = getSelectedMonthRange(filterMonth, filterYear);
            let exportItems;
            let usedLocalFallback = false;
            try {
                const result = await getSigiziMeasurementExport({
                    monthEnd: end,
                    monthStart: start,
                    village: viewDesa || undefined,
                    posyandu: viewPosyandu || undefined
                });
                exportItems = result.items;
            }
            catch (apiError) {
                console.warn('API ekspor SigiZI tidak tersedia, memakai jalur data terautentikasi/lokal:', apiError);
                usedLocalFallback = true;
                const fallbackChildren = [];
                const fallbackMeasurements = [];
                try {
                    const pageSize = 50;
                    for (let page = 1; page <= 200; page += 1) {
                        const response = await getChildrenPage({
                            asOf: end,
                            measurementStart: start,
                            measurementEnd: end,
                            page,
                            size: pageSize,
                            sort: 'name_asc',
                            view: 'data',
                            village: viewDesa || undefined,
                            posyandu: viewPosyandu || undefined
                        });
                        fallbackChildren.push(...response.items.map((item) => ({ id: item.id, ...item.data })));
                        fallbackMeasurements.push(...response.measurements.map((item) => ({ id: item.id, ...item.data })));
                        if (response.items.length < pageSize || fallbackChildren.length >= response.total)
                            break;
                    }
                }
                catch (fallbackError) {
                    console.warn('Jalur baca terautentikasi tidak tersedia, memakai cache ekspor:', fallbackError);
                    fallbackChildren.push(...await fetchExportChildren({ currentFilterDate, ...exportQueryContext }));
                }
                const cachedMeasurements = await fetchExportDocuments({
                    resource: 'measurements',
                    dateField: 'tglUkur',
                    end,
                    ...exportQueryContext,
                });
                const childrenById = new Map(fallbackChildren.map((item) => [item.id, item]));
                const measurementsById = new Map([...cachedMeasurements, ...fallbackMeasurements].map((item) => [item.id, item]));
                exportItems = buildSigiziMeasurementExportItems(Array.from(childrenById.values()), Array.from(measurementsById.values()), start, end);
            }
            const rows = getSigiziMeasurementRows(exportItems);
            const worksheet = createSafeWorksheet(xlsx, [SIGIZI_MEASUREMENT_HEADERS, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data Pengukuran");
            xlsx.writeFile(workbook, `Format_Ukur_Sigizi_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
            if (usedLocalFallback)
                showSuccess('File pengukuran SigiZI berhasil dibuat melalui jalur cadangan.');
        });
    };
    // --- NEW EXPORT FUNCTION FOR TABLES ---
    const handleExportTable = async () => {
        await runExport('file tabel balita', async () => {
            const xlsx = await ensureXlsx();
            const { start, end } = getSelectedMonthRange(filterMonth, filterYear);
            const [exportedChildren, measurements] = await Promise.all([
                fetchExportChildren({ currentFilterDate, ...exportQueryContext }),
                fetchExportDocuments({
                    resource: 'measurements',
                    dateField: 'tglUkur',
                    start,
                    end,
                    ...exportQueryContext,
                }),
            ]);
            const measurementsByChild = latestMeasurementsByChild(measurements);
            const rows = getTableExportRows({
                activeTab,
                children: exportedChildren,
                measurementsByChild,
                referenceDate: currentFilterDate,
                sortData: getSortedData,
            });
            const worksheet = createSafeWorksheet(xlsx, [TABLE_EXPORT_HEADERS, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data Export");
            let filenamePrefix = "Data_Balita";
            if (activeTab === 'problem_underweight')
                filenamePrefix = "Balita_Underweight";
            if (activeTab === 'problem_stunting')
                filenamePrefix = "Balita_Stunting";
            if (activeTab === 'problem_wasting')
                filenamePrefix = "Balita_Wasting";
            if (activeTab === 'problem_tidak_naik')
                filenamePrefix = "Balita_Tidak_Naik";
            xlsx.writeFile(workbook, `${filenamePrefix}_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    const handleExportMpasi = async () => {
        await runExport('file MPASI', async () => {
            const xlsx = await ensureXlsx();
            const { start, end } = getSelectedMonthRange(filterMonth, filterYear);
            const [allChildren, logs] = await Promise.all([
                fetchExportChildren({ currentFilterDate, ...exportQueryContext }),
                fetchExportDocuments({
                    resource: 'mpasi_logs',
                    dateField: 'tglMonitoring',
                    start,
                    end,
                    ...exportQueryContext,
                }),
            ]);
            const exportedChildren = filterChildrenByAgeRange(allChildren, 6, 23, currentFilterDate);
            const childIds = new Set(exportedChildren.map((child) => child.id).filter(Boolean));
            const logsByChild = latestMpasiLogsByChild(
                logs.filter((log) => childIds.has(log.childId || log.child_id || log.balitaId))
            );
            const rows = getMpasiExportRows(exportedChildren, logsByChild);
            const worksheet = createSafeWorksheet(xlsx, [MPASI_EXPORT_HEADERS, ...rows]);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Data MPASI");
            xlsx.writeFile(workbook, `Laporan_MPASI_${MONTHS[filterMonth - 1]}_${filterYear}.xls`, { bookType: 'biff8' });
        });
    };
    const handleExportPmt = async () => {
        await runExport('file PMT', async () => {
            const xlsx = await ensureXlsx();
            const [exportedChildren, exportedPrograms] = await Promise.all([
                fetchExportChildren({ currentFilterDate, ...exportQueryContext }),
                fetchExportDocuments({ resource: 'pmt_programs', ...exportQueryContext }),
            ]);
            const childById = new Map(exportedChildren.filter((child) => child.id).map((child) => [child.id, child]));
            const workbook = xlsx.utils.book_new();
            for (const category of ['Wasting', 'Underweight', 'TidakNaik']) {
                const rows = getPmtExportRows(category, exportedPrograms, childById);
                const worksheet = createSafeWorksheet(xlsx, [PMT_EXPORT_HEADERS, ...rows]);
                xlsx.utils.book_append_sheet(workbook, worksheet, category === 'TidakNaik' ? 'Tidak Naik' : category);
            }
            xlsx.writeFile(workbook, `Laporan_PMT_Lengkap_${MONTHS[filterMonth - 1]}_${filterYear}.xls`);
        });
    };
    const getSortedData = (data) => {
        const sorted = [...data];
        switch (sortOrder) {
            case 'name_asc': return sorted.sort((a, b) => a.nama.localeCompare(b.nama));
            case 'name_desc': return sorted.sort((a, b) => b.nama.localeCompare(a.nama));
            case 'recent': return sorted.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
            case 'oldest_input': return sorted.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
            case 'age_oldest': return sorted.sort((a, b) => new Date(a.tglLahir).getTime() - new Date(b.tglLahir).getTime());
            case 'age_youngest': return sorted.sort((a, b) => new Date(b.tglLahir).getTime() - new Date(a.tglLahir).getTime());
            default: return sorted;
        }
    };
    const getDisplayData = () => {
        switch (activeTab) {
            case 'recycle_bin': return deletedChildren;
            case 'recent': return newInputs;
            case 'mpasi':
                return activeChildren.filter(c => {
                    const age = getAgeInMonths(c.tglLahir, currentFilterDate);
                    return age >= 6 && age <= 23;
                });
            default: return activeChildren;
        }
    };
    const rawDisplayData = isServerPagedChildTab
        ? []
        : getDisplayData().filter(c => c.nama.toLowerCase().includes(searchTerm.toLowerCase()) || c.nik.includes(searchTerm));
    const displayData = getSortedData(rawDisplayData);
    // --- PAGINATION LOGIC ---
    const totalPages = Math.ceil(displayData.length / itemsPerPage);
    const paginatedData = displayData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    const tableDisplayData = isServerPagedChildTab ? pagedChildren : displayData;
    const tablePaginatedData = isServerPagedChildTab ? pagedChildren : paginatedData;
    const tableMeasurements = isServerPagedChildTab ? pagedMeasurements : monthlyMeasurements;
    const tableMpasiLogs = activeTab === 'mpasi' ? pagedMpasiLogs : mpasiLogs;
    const tableLoading = isServerPagedChildTab ? pagedChildrenLoading : childrenLoading || measurementsLoading;
    const tableTotalCount = isServerPagedChildTab ? pagedChildrenTotal : undefined;
    const handleSearchSubmit = () => {
        setCurrentPage(1);
        setSearchTerm(searchDraft.trim());
    };
    const handleClearSearch = () => {
        setSearchDraft('');
        setSearchTerm('');
        setCurrentPage(1);
    };
    const handleApplyLocationFilter = () => {
        setViewDesa(isFullAccessRole(user.role) ? draftDesa : (user.desa || ''));
        setViewPosyandu(user.role === ROLES.KADER ? (user.posyandu || '') : draftPosyandu);
    };
    const handleResetLocationFilter = () => {
        const defaultDesa = isFullAccessRole(user.role) ? '' : (user.desa || '');
        const defaultPosyandu = user.role === ROLES.KADER ? (user.posyandu || '') : '';
        setDraftDesa(defaultDesa);
        setDraftPosyandu(defaultPosyandu);
        setViewDesa(defaultDesa);
        setViewPosyandu(defaultPosyandu);
    };
    const measurementChild = useMemo(() => {
        if (selectedMeasurementChild?.id === measurementChildId)
            return selectedMeasurementChild;
        return children.find((child) => child.id === measurementChildId) || null;
    }, [children, measurementChildId, selectedMeasurementChild]);
    const handleOpenMeasurementPage = (child) => {
        if (!canWrite) {
            setErrorMsg('Akun ini hanya memiliki hak baca.');
            return;
        }
        if (!child.id)
            return;
        const backTab = activeTab === 'measurement' ? measurementBackTab : activeTab;
        setMeasurementBackTab(backTab === 'measurement' ? 'data_balita' : backTab);
        setSelectedMeasurementChild(child);
        setMeasurementChildId(child.id);
        setActiveTab('measurement');
        const targetHash = `#measurement/${encodeURIComponent(child.id)}`;
        if (window.location.hash !== targetHash)
            window.location.hash = targetHash;
    };
    const handleOpenEditChild = async (child) => {
        if (!canWrite) {
            setErrorMsg('Akun ini hanya memiliki hak baca.');
            return;
        }
        if (!child?.id)
            return;
        try {
            const document = await getChildDetail(child.id);
            setEditingChild({ id: document.id, ...document.data });
            setErrorMsg(null);
        }
        catch (error) {
            setErrorMsg(`Gagal memuat detail balita: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        }
    };
    const handleBackFromMeasurement = () => {
        const backTab = measurementBackTab === 'measurement' ? 'data_balita' : measurementBackTab;
        setSelectedMeasurementChild(null);
        setMeasurementChildId(null);
        setActiveTab(backTab);
        if (window.location.hash !== `#${backTab}`)
            window.location.hash = backTab;
    };
    const handleOpenAddChildPage = () => {
        if (!canWrite) {
            setErrorMsg('Akun ini hanya memiliki hak baca.');
            return;
        }
        const backTab = activeTab === 'measurement' || activeTab === 'add_child' ? 'data_balita' : activeTab;
        setAddChildBackTab(backTab);
        setActiveTab('add_child');
        setIsSidebarOpen(false);
        if (window.location.hash !== '#add_child')
            window.location.hash = 'add_child';
    };
    const handleOpenAdminBackend = () => {
        if (user.role !== ROLES.SUPER_ADMIN)
            return;
        setIsAccountMenuOpen(false);
        setActiveTab('admin_backend');
        setMeasurementChildId(null);
        if (window.location.hash !== '#admin_backend')
            window.location.hash = 'admin_backend';
    };
    const handleBackFromAddChild = () => {
        const backTab = addChildBackTab === 'add_child' || addChildBackTab === 'measurement' ? 'data_balita' : addChildBackTab;
        setActiveTab(backTab);
        if (window.location.hash !== `#${backTab}`)
            window.location.hash = backTab;
    };
    const accountName = user.role === ROLES.SUPER_ADMIN
        ? 'Administrator'
        : user.role === ROLES.KADER
        ? `Posyandu ${formatChildName(user.posyandu || '')}`.trim()
        : user.role === ROLES.BIDAN
            ? user.desa || 'Desa'
            : ROLES.GIZI;
    const accountDescription = user.role === ROLES.KADER
        ? user.desa || ROLES.KADER
        : user.role === ROLES.BIDAN
            ? ROLES.BIDAN
            : 'UPTD Puskesmas Gumukmas';
    const pageTitles = {
        dashboard: 'Dashboard',
        data_balita: 'Data Balita',
        asi_eksklusif: 'ASI Eksklusif',
        mpasi: 'MPASI',
        problem_underweight: 'Balita Underweight',
        problem_stunting: 'Balita Stunting',
        problem_wasting: 'Balita Wasting',
        problem_tidak_naik: 'Balita Tidak Naik',
        pmt_program: 'Pemberian PMT',
        add_child: 'Tambah Balita',
        recent: 'Balita Baru Diinput',
        change_history: 'Riwayat Perubahan',
        recycle_bin: 'Daftar Dihapus',
        measurement: 'Penimbangan Balita',
        admin_backend: 'Administrasi Backend'
    };
    const pageTitle = pageTitles[activeTab] || 'E-Posyandu';
    const handleResolveSyncConflict = async (conflictId, resolution) => {
        try {
            await resolveSyncConflict(conflictId, resolution);
            setSyncConflicts(await listSyncConflicts());
            setDataRevision((revision) => revision + 1);
            showSuccess(resolution === 'keep-local'
                ? 'Perubahan dari perangkat akan dikirim ulang menggunakan data server terbaru.'
                : 'Data server dipakai dan perubahan lokal yang bertabrakan dibatalkan.');
        }
        catch (error) {
            setErrorMsg(`Konflik sinkronisasi belum dapat diselesaikan: ${error instanceof Error ? error.message : 'Permintaan tidak dapat diproses.'}`);
        }
    };
    const setSidebarCollapsed = (collapsed) => {
        sidebarCollapsedRef.current = collapsed;
        hideSidebarTooltip();
        applySidebarCollapsedState(appShellRef.current, sidebarCollapseButtonRef.current, collapsed);
    };
    const showSidebarTooltip = (label, event) => {
        if (!sidebarCollapsedRef.current)
            return;
        const tooltip = sidebarTooltipRef.current;
        if (!tooltip)
            return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const top = Math.max(28, Math.min(window.innerHeight - 28, bounds.top + (bounds.height / 2)));
        tooltip.textContent = label;
        tooltip.style.top = `${top}px`;
        tooltip.setAttribute('aria-hidden', 'false');
        tooltip.classList.add('is-visible');
    };
    const hideSidebarTooltip = () => {
        const tooltip = sidebarTooltipRef.current;
        if (!tooltip)
            return;
        tooltip.classList.remove('is-visible');
        tooltip.setAttribute('aria-hidden', 'true');
    };
    const SidebarItem = ({ id, label, icon: Icon, onClick }) => (Native.createElement("button", { "data-nav-id": id, "data-tooltip": label, "aria-current": activeTab === id ? 'page' : undefined, "aria-label": label, onMouseEnter: (event) => showSidebarTooltip(label, event), onMouseLeave: hideSidebarTooltip, onFocus: (event) => showSidebarTooltip(label, event), onBlur: hideSidebarTooltip, onClick: onClick ? () => {
            hideSidebarTooltip();
            onClick();
        } : () => { hideSidebarTooltip(); if (isDashboardTab(id)) {
            setActiveTab(id);
            if (window.location.hash !== `#${id}`)
                window.location.hash = id;
        } setIsSidebarOpen(false); }, className: `sidebar-nav-item group ${activeTab === id ? 'is-active' : ''}` },
        Native.createElement("div", { className: "sidebar-nav-content flex items-center gap-3" },
            Native.createElement("span", { className: "sidebar-nav-icon" },
                Native.createElement(Icon, { className: "w-5 h-5" })),
            Native.createElement("span", { className: "sidebar-nav-label text-sm text-left" }, label))));
    return (Native.createElement("div", { ref: appShellRef, className: `app-shell font-sans text-slate-900 flex ${sidebarCollapsedRef.current ? 'is-sidebar-collapsed' : ''}` },
        isSidebarOpen && (Native.createElement("div", { className: "sidebar-scrim fixed inset-0 z-40 md:hidden", onClick: () => setIsSidebarOpen(false), "aria-hidden": "true" })),
        Native.createElement("button", { type: "button", className: "sidebar-expanded-dismiss", onClick: () => setSidebarCollapsed(true), "aria-label": "Ringkas menu samping" }),
        Native.createElement("aside", { className: `app-sidebar fixed md:sticky top-0 h-screen flex flex-col z-50 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}` },
            Native.createElement("div", { className: "sidebar-mobile-toolbar md:hidden" },
                Native.createElement("span", null, "Daftar Menu"),
                Native.createElement("button", { type: "button", onClick: () => setIsSidebarOpen(false), title: "Tutup menu", "aria-label": "Tutup menu" },
                    Native.createElement(X, { className: "h-5 w-5" }))),
            Native.createElement("div", { className: "sidebar-brand-panel", "data-sidebar-brand": "true" },
                Native.createElement("span", { className: "sidebar-brand-logo-shell", "aria-hidden": "true" },
                    Native.createElement("img", { src: "/logo-puskesmas-32981.svg", alt: "", className: "h-10 w-10" })),
                Native.createElement("div", { className: "sidebar-brand-copy min-w-0" },
                    Native.createElement("div", { className: "sidebar-brand-name-row" },
                        Native.createElement("strong", null, "E-Posyandu"),
                        Native.createElement("span", null, `v${APP_VERSION}`)),
                    Native.createElement("p", null, "UPTD Puskesmas Gumukmas"))),
            Native.createElement("nav", { className: "app-sidebar-nav flex-1 overflow-y-auto py-4 px-3 space-y-1", "aria-label": "Navigasi utama" },
                Native.createElement("button", { ref: sidebarCollapseButtonRef, type: "button", onMouseEnter: (event) => showSidebarTooltip(sidebarCollapsedRef.current ? 'Perluas Menu' : 'Ringkas Menu', event), onMouseLeave: hideSidebarTooltip, onFocus: (event) => showSidebarTooltip(sidebarCollapsedRef.current ? 'Perluas Menu' : 'Ringkas Menu', event), onBlur: hideSidebarTooltip, onClick: (event) => {
                        event.stopPropagation();
                        setSidebarCollapsed(!sidebarCollapsedRef.current);
                    }, className: "sidebar-collapse-button hidden md:flex", "aria-label": sidebarCollapsedRef.current ? 'Perluas Menu' : 'Ringkas Menu', "aria-expanded": !sidebarCollapsedRef.current },
                    Native.createElement("span", { className: "sidebar-nav-icon sidebar-collapse-symbol" },
                        Native.createElement(ChevronRight, { className: "sidebar-expand-icon h-5 w-5" }),
                        Native.createElement(ChevronLeft, { className: "sidebar-collapse-icon h-5 w-5" })),
                    Native.createElement("span", { className: "sidebar-nav-label text-sm text-left" },
                        Native.createElement("span", { className: "sidebar-expand-label" }, "Perluas Menu"),
                        Native.createElement("span", { className: "sidebar-collapse-label" }, "Ringkas Menu"))),
                Native.createElement("p", { className: "sidebar-section-label" }, "Menu Utama"),
                Native.createElement(SidebarItem, { id: "dashboard", label: "Dashboard", icon: LayoutDashboard }),
                Native.createElement(SidebarItem, { id: "data_balita", label: "Data Balita", icon: Users }),
                Native.createElement(SidebarItem, { id: "asi_eksklusif", label: "ASI Eksklusif", icon: Baby }),
                Native.createElement(SidebarItem, { id: "mpasi", label: "MPASI (6-23 Bln)", icon: Utensils }),
                Native.createElement("div", { className: "sidebar-nav-spacer sidebar-nav-spacer-small" }),
                Native.createElement("p", { className: "sidebar-section-label" }, "Analisis Gizi"),
                Native.createElement(SidebarItem, { id: "problem_underweight", label: "Balita Underweight", icon: TrendingDown }),
                Native.createElement(SidebarItem, { id: "problem_stunting", label: "Balita Stunting", icon: Ruler }),
                Native.createElement(SidebarItem, { id: "problem_wasting", label: "Balita Wasting", icon: AlertCircle }),
                Native.createElement(SidebarItem, { id: "problem_tidak_naik", label: "Balita Tidak Naik", icon: Minus }),
                Native.createElement(SidebarItem, { id: "pmt_program", label: "Pemberian PMT", icon: Gift }),
                Native.createElement("div", { className: "sidebar-nav-spacer" }),
                Native.createElement("p", { className: "sidebar-section-label" }, "Manajemen Data"),
                canWrite && Native.createElement(SidebarItem, { id: "add_child", label: "Tambah Balita", icon: Plus, onClick: handleOpenAddChildPage }),
                Native.createElement(SidebarItem, { id: "recent", label: "Balita Baru Diinput", icon: Clock }),
                Native.createElement(SidebarItem, { id: "change_history", label: "Riwayat Perubahan", icon: History }),
                Native.createElement(SidebarItem, { id: "recycle_bin", label: "Daftar Dihapus", icon: Trash2 }))),
        Native.createElement("div", { ref: sidebarTooltipRef, className: "sidebar-dock-tooltip", role: "tooltip", "aria-hidden": "true" }),
        Native.createElement("div", { className: "flex-1 flex flex-col min-w-0" },
            Native.createElement("header", { className: "app-topbar sticky top-0 z-30" },
                Native.createElement("div", { className: "app-header-title flex min-w-0 items-center gap-3" },
                    Native.createElement("button", { type: "button", onClick: () => setIsSidebarOpen(true), className: "sidebar-mobile-trigger icon-button md:hidden", title: "Buka menu", "aria-label": "Buka menu" },
                        Native.createElement(Menu, { className: "h-5 w-5" })),
                    Native.createElement("div", { className: "app-page-context min-w-0" },
                        Native.createElement("h1", { className: "truncate" }, pageTitle))),
                Native.createElement("div", { className: "topbar-actions" },
                    Native.createElement("button", { type: "button", className: "theme-toggle glass-control", onClick: () => saveColorScheme(colorScheme === 'dark' ? 'light' : 'dark'), title: colorScheme === 'dark' ? 'Gunakan mode terang' : 'Gunakan mode gelap', "aria-label": colorScheme === 'dark' ? 'Gunakan mode terang' : 'Gunakan mode gelap', "aria-pressed": colorScheme === 'dark' ? 'true' : 'false' }, colorScheme === 'dark'
                        ? Native.createElement(Sun, { className: "h-5 w-5", "aria-hidden": "true" })
                        : Native.createElement(Moon, { className: "h-5 w-5", "aria-hidden": "true" })),
                    Native.createElement("div", { ref: accountMenuRef, className: "account-wrapper relative" },
                    Native.createElement("button", { type: "button", className: "account-trigger glass-control", onClick: () => setIsAccountMenuOpen(!isAccountMenuOpen), "aria-haspopup": "menu", "aria-expanded": isAccountMenuOpen, "aria-controls": "account-dropdown-menu", title: "Buka menu akun" },
                        Native.createElement("span", { className: "account-avatar" }, accountName.charAt(0)),
                        Native.createElement("span", { className: "account-trigger-copy min-w-0 text-left" },
                            Native.createElement("span", { className: "block truncate text-sm font-bold text-slate-800" }, accountName),
                            Native.createElement("span", { className: "block truncate text-[11px] text-slate-500" }, accountDescription)),
                        Native.createElement(ChevronDown, { className: `account-chevron h-4 w-4 text-slate-500 ${isAccountMenuOpen ? 'is-open' : ''}` })),
                    isAccountMenuOpen && (Native.createElement("div", { id: "account-dropdown-menu", role: "menu", className: "account-menu" },
                        Native.createElement("div", { className: "account-menu-profile" },
                            Native.createElement("span", { className: "account-menu-avatar" },
                                Native.createElement(UserRound, { className: "h-5 w-5" })),
                            Native.createElement("div", { className: "min-w-0" },
                                Native.createElement("p", { className: "truncate text-sm font-bold text-slate-800" }, accountName),
                                Native.createElement("p", { className: "truncate text-xs text-slate-500" }, accountDescription),
                                Native.createElement("span", { className: "account-role-badge" }, user.role))),
                        Native.createElement("div", { className: "account-menu-divider" }),
                        user.role === ROLES.SUPER_ADMIN && Native.createElement("button", { type: "button", role: "menuitem", className: "account-admin-button", onClick: handleOpenAdminBackend },
                            Native.createElement(Activity, { className: "h-4 w-4" }),
                            Native.createElement("span", null, "Akses Backend Penuh")),
                        Native.createElement("button", { type: "button", role: "menuitem", className: "account-logout-button", onClick: () => {
                                setIsAccountMenuOpen(false);
                                onLogout();
                            } },
                            Native.createElement(LogOut, { className: "h-4 w-4" }),
                            Native.createElement("span", null, "Keluar Sistem"))))))),
            Native.createElement("main", { className: "app-content flex-1 p-4 sm:p-6 lg:p-8 overflow-x-hidden" },
                !canWrite && Native.createElement("div", { role: "status", className: "read-only-access-banner mb-6" },
                    Native.createElement(AlertCircle, { className: "h-5 w-5" }),
                    Native.createElement("div", null,
                        Native.createElement("strong", null, "Mode Hanya Baca"),
                        Native.createElement("p", null, "Anda dapat melihat data sesuai wilayah akun, tetapi tidak dapat menambah, mengubah, atau menghapus data."))),
                errorMsg && (!isDashboardTab || !errorMsg.startsWith("Gagal memuat ringkasan dashboard:")) && (Native.createElement("div", { role: "alert", className: "ios-inline-notification ios-inline-notification-error mb-6 flex items-center gap-3" },
                    Native.createElement(AlertTriangle, { className: "w-5 h-5 flex-shrink-0" }),
                    Native.createElement("p", { className: "text-sm font-medium" }, errorMsg))),
                syncConflicts.length > 0 && (Native.createElement("section", { role: "alert", className: "ios-inline-notification ios-inline-notification-warning mb-6", "aria-live": "polite" },
                    Native.createElement("div", { className: "flex items-start gap-3" },
                        Native.createElement(AlertTriangle, { className: "mt-0.5 h-5 w-5 flex-shrink-0" }),
                        Native.createElement("div", { className: "min-w-0 flex-1" },
                            Native.createElement("p", { className: "text-sm font-bold" }, "Perubahan data perlu dikonfirmasi"),
                            Native.createElement("p", { className: "mt-1 text-sm" }, syncConflicts[0].detail),
                            syncConflicts.length > 1 && Native.createElement("p", { className: "mt-1 text-xs" }, `${syncConflicts.length} konflik menunggu penyelesaian.`),
                            Native.createElement("div", { className: "mt-3 flex flex-wrap gap-2" },
                                Native.createElement("button", { type: "button", className: "apple-button apple-button-primary bg-blue-600 px-4 py-2 text-sm font-semibold text-white", onClick: () => void handleResolveSyncConflict(syncConflicts[0].id, 'keep-local') }, "Gunakan Data Saya"),
                                Native.createElement("button", { type: "button", className: "apple-button apple-button-secondary px-4 py-2 text-sm font-semibold", onClick: () => void handleResolveSyncConflict(syncConflicts[0].id, 'accept-server') }, "Gunakan Data Server")))))),
                activeTab !== 'add_child' && activeTab !== 'measurement' && activeTab !== 'change_history' && activeTab !== 'admin_backend' && (Native.createElement("div", { className: "mb-6" },
                    Native.createElement(LocationFilterPanel, { draftDesa: draftDesa, draftPosyandu: draftPosyandu, filterMonth: filterMonth, filterYear: filterYear, onApply: handleApplyLocationFilter, onReset: handleResetLocationFilter, role: user.role, setDraftDesa: setDraftDesa, setDraftPosyandu: setDraftPosyandu, setFilterMonth: setFilterMonth, setFilterYear: setFilterYear, user: user }))),
                Native.createElement(Native.Suspense, { fallback: Native.createElement(DashboardPageSkeleton, null) }, activeTab === 'admin_backend' ? (user.role === ROLES.SUPER_ADMIN ? Native.createElement(AdminBackendPage, null) : Native.createElement(DashboardOverviewPage, { stats: dashboardStats, loading: dashboardStatsLoading, pageState: dashboardPageState, monitoringStatus: monitoringStatus, filterMonth: filterMonth, filterYear: filterYear, viewDesa: viewDesa, viewPosyandu: viewPosyandu })) : activeTab === 'add_child' ? (Native.createElement(AddChildPage, { allChildren: children, onBack: handleBackFromAddChild, onSuccess: handleBackFromAddChild, user: user })) : activeTab === 'measurement' ? (measurementChild ? (Native.createElement(MeasurementPage, { child: measurementChild, onBack: handleBackFromMeasurement })) : (Native.createElement(Card, { className: "p-8 text-center text-slate-500" }, childrenLoading ? 'Memuat data balita...' : 'Data balita tidak ditemukan atau tidak dapat diakses.'))) : activeTab === 'dashboard' ? (Native.createElement(DashboardOverviewPage, { stats: dashboardStats, loading: dashboardStatsLoading, pageState: dashboardPageState, monitoringStatus: monitoringStatus, filterMonth: filterMonth, filterYear: filterYear, viewDesa: viewDesa, viewPosyandu: viewPosyandu })) : activeTab === 'asi_eksklusif' ? (Native.createElement(ExclusiveBreastfeedingPage, { filterMonth: filterMonth, filterYear: filterYear, refreshKey: dataRevision, viewDesa: viewDesa, viewPosyandu: viewPosyandu })) : activeTab === 'pmt_program' ? (Native.createElement(PmtProgramPage, { childrenData: children, pmtPrograms: pmtPrograms, pageState: pmtPageState, onExportPmt: handleExportPmt, onDeleteProgram: handleDeletePmt, onOpenMonitoring: handleOpenPmtMonitoring })) : activeTab === 'change_history' ? (Native.createElement(ChangeHistoryPage, { changeLogs: changeLogs, loading: changeHistoryLoading, error: changeHistoryError, pageState: changeHistoryPageState, currentPage: changeHistoryPage, total: changeHistoryTotal, pageSize: 10, onPageChange: setChangeHistoryPage, onRetry: () => setChangeHistoryRevision((revision) => revision + 1) })) : (Native.createElement(ChildrenTablePage, { activeTab: activeTab, currentFilterDate: currentFilterDate, currentPage: currentPage, displayData: tableDisplayData, fileInputRef: fileInputRef, filterMonth: filterMonth, filterYear: filterYear, handleExportMpasi: handleExportMpasi, handleExportPengukuranSigizi: handleExportPengukuranSigizi, handleExportTable: handleExportTable, handleImportIdentitas: handleImportIdentitas, handlePermanentDelete: handlePermanentDelete, handleRestore: handleRestore, itemsPerPage: itemsPerPage, loading: tableLoading, pageState: pagedChildrenPageState, monthlyMeasurements: tableMeasurements, mpasiLogs: tableMpasiLogs, paginatedData: tablePaginatedData, searchTerm: searchTerm, searchDraft: searchDraft, setChildToDelete: setChildToDelete, setChildToMpasi: setChildToMpasi, setCurrentPage: setCurrentPage, onEditChild: handleOpenEditChild, setPmtModalData: setPmtModalData, setSearchDraft: setSearchDraft, onClearSearch: handleClearSearch, onSubmitSearch: handleSearchSubmit, onOpenMeasurement: handleOpenMeasurementPage, onOpenAddChild: handleOpenAddChildPage, setSortOrder: setSortOrder, sortOrder: sortOrder, totalDataCount: tableTotalCount, user: user, readOnly: !canWrite })))),
            Native.createElement("footer", { className: "app-footer" },
                Native.createElement("p", null, "\u00A9 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach"),
                Native.createElement("button", { type: "button", className: "app-version-button", onClick: openReleaseNotes, "aria-haspopup": "dialog", title: "Lihat apa yang baru" }, `E-Posyandu v${APP_VERSION}`))),
        canWrite && editingChild && (Native.createElement(AddChildModal, { user: user, isEdit: true, initialData: editingChild, onClose: () => setEditingChild(null), onSuccess: () => setEditingChild(null), allChildren: children })),
        canWrite && childToDelete && (Native.createElement(DeleteChildModal, { child: childToDelete, onClose: () => setChildToDelete(null), onConfirm: handleDeleteConfirm })),
        canWrite && childToMpasi && (Native.createElement(MpasiModal, { child: childToMpasi, onClose: () => setChildToMpasi(null) })),
        canWrite && pmtModalData && (Native.createElement(PmtModal, { child: pmtModalData.child, category: pmtModalData.category, onClose: () => setPmtModalData(null) })),
        canWrite && pmtMonitoringData && (Native.createElement(PmtMonitoringModal, { program: pmtMonitoringData.program, child: pmtMonitoringData.child, onClose: () => setPmtMonitoringData(null) }))));
};
