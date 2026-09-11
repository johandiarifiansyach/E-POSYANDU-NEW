import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Baby,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Gift,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Minus,
  Moon,
  Plus,
  Ruler,
  Sun,
  Trash2,
  TrendingDown,
  UserRound,
  Users,
  Utensils,
  X,
} from "../../ui/icons";
import {
  getDashboardStats,
  getMonitoringStatus,
  type DashboardStatsRequest,
  type DashboardStatsResponse,
} from "../../api/dashboardApi";
import {
  DEFAULT_AGE_GROUP,
  EXCLUSIVE_BREASTFEEDING_AGE_GROUP_OPTIONS,
  type AgeGroup,
} from "../../config/ageFilters";
import {
  isFullAccessRole,
  MONTHS,
  ROLES,
} from "../../config/dashboard";
import { APP_VERSION } from "../../config/app";
import { errorMessage, type PageState } from "../../shared/pageState";
import { formatChildName } from "../../shared/formatters";
import { DashboardLayout } from "../../layouts";
import { LocationFilterPanel } from "../../components/filters";
import { appId, db } from "../../app/session";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  syncPendingMutations,
  updateDoc,
} from "../../api/syncApi";
import { getChildDetail } from "../../api/childrenApi";
import DashboardOverviewPage from "../../pages/DashboardOverviewPage";
import ReleaseNotesDialog from "../../components/ReleaseNotesDialog";
import PmtModal from "../pmt/PmtModal";
import DeleteChildModal from "../children/DeleteChildModal";
import AddChildModal from "../children/AddChildModal";
import MpasiModal from "../breastfeeding/MpasiModal";
import { getPmtCategoryForTab } from "../children/childRules";
import type { DashboardUser } from "../../types";
import {
  subscribeColorScheme,
  type ColorScheme,
} from "../../theme/colorScheme";
import { useFilterStore } from "../../stores/filterStore";
import { useRealtimeStore } from "../../stores/realtimeStore";
import { useUiStore } from "../../stores/uiStore";
import {
  ensureXlsx,
  sanitizeImportedCellText,
  validateSpreadsheetFile,
} from "../../compat/services/xlsx";
import {
  exportChildrenTable,
  exportMeasurements,
  exportMpasi,
  exportPmt,
  exportRecentIdentities,
} from "../../services/reactExports";

// Keep the initial dashboard bundle small on kader connections. Data-heavy
// modules are fetched only when the corresponding view is opened.
const ReactChildrenTablePage = lazy(
  () => import("../children/ReactChildrenTablePage"),
);
const ReactAddChildPage = lazy(() => import("../children/ReactAddChildPage"));
const ReactMeasurementPage = lazy(
  () => import("../measurements/ReactMeasurementPage"),
);
const ReactExclusiveBreastfeedingPage = lazy(
  () => import("../breastfeeding/ReactExclusiveBreastfeedingPage"),
);
const ReactMpasiPage = lazy(() => import("../mpasi/ReactMpasiPage"));
const ReactChangeHistoryPage = lazy(
  () => import("../history/ReactChangeHistoryPage"),
);
const ReactPmtProgramPage = lazy(() => import("../pmt/ReactPmtProgramPage"));
const ReactAdminBackendPage = lazy(
  () => import("../administration/ReactAdminBackendPage"),
);
const ReactAdminMonitoringPage = lazy(
  () => import("../administration/ReactAdminMonitoringPage"),
);

type DashboardScope = {
  month: number;
  year: number;
  ageGroup: AgeGroup;
  desa: string;
  posyandu: string;
};

const EMPTY_STATS: DashboardStatsResponse = {
  S: 0,
  D: 0,
  N: 0,
  T: 0,
  B: 0,
  O: 0,
  asiEksklusif: 0,
  asiTarget: 0,
  underweight: 0,
  stunting: 0,
  wasting: 0,
  perD: "0.0",
  perN: "0.0",
  perT: "0.0",
  perAsiEksklusif: "0.0",
  perUnderweight: "0.0",
  perStunting: "0.0",
  perWasting: "0.0",
};
function monthStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}
function monthEnd(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
}
function previousMonth(year: number, month: number) {
  const previous = new Date(year, month - 2, 1);
  return { year: previous.getFullYear(), month: previous.getMonth() + 1 };
}
function toRequest(
  scope: DashboardScope,
  user: DashboardUser,
): DashboardStatsRequest {
  const previous = previousMonth(scope.year, scope.month);
  return {
    ageGroup: scope.ageGroup,
    monthStart: monthStart(scope.year, scope.month),
    monthEnd: monthEnd(scope.year, scope.month),
    previousMonthStart: monthStart(previous.year, previous.month),
    previousMonthEnd: monthEnd(previous.year, previous.month),
    village:
      (isFullAccessRole(user.role) ? scope.desa : user.desa) || undefined,
    posyandu:
      (user.role === ROLES.KADER ? user.posyandu : scope.posyandu) || undefined,
  };
}
function initialScope(user: DashboardUser): DashboardScope {
  const now = new Date();
  return {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    ageGroup: DEFAULT_AGE_GROUP,
    desa: isFullAccessRole(user.role) ? "" : user.desa || "",
    posyandu: user.role === ROLES.KADER ? user.posyandu || "" : "",
  };
}

type ChildTableView =
  | "data"
  | "recent"
  | "recycle"
  | "problem_underweight"
  | "problem_stunting"
  | "problem_wasting"
  | "problem_tidak_naik";
type ActiveView =
  | "dashboard"
  | ChildTableView
  | "asi"
  | "mpasi"
  | "pmt"
  | "history"
  | "addChild"
  | "measurement"
  | "adminBackend"
  | "adminMonitoring";

/**
 * Age filters are scoped to a page.  General pages always start from the
 * complete 0–59-month cohort, while the two programme pages have fixed
 * defaults that match their programme definitions.
 */
function defaultAgeGroupForView(view: ActiveView): AgeGroup {
  if (view === "mpasi") return "6-23";
  if (view === "asi") return "0-5";
  return DEFAULT_AGE_GROUP;
}

const HASH_TO_VIEW: Record<string, ActiveView> = {
  dashboard: "dashboard",
  data_balita: "data",
  asi_eksklusif: "asi",
  mpasi: "mpasi",
  problem_underweight: "problem_underweight",
  problem_stunting: "problem_stunting",
  problem_wasting: "problem_wasting",
  problem_tidak_naik: "problem_tidak_naik",
  pmt_program: "pmt",
  recent: "recent",
  change_history: "history",
  recycle_bin: "recycle",
  add_child: "addChild",
  admin_backend: "adminBackend",
  admin_monitoring: "adminMonitoring",
};

function viewFromHash(): ActiveView {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (raw.startsWith("measurement/")) return "measurement";
  return HASH_TO_VIEW[raw] || "dashboard";
}

function measurementIdFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (!raw.startsWith("measurement/")) return "";
  try {
    return decodeURIComponent(raw.slice("measurement/".length));
  } catch {
    return "";
  }
}

function hashForView(view: ActiveView) {
  return (
    Object.entries(HASH_TO_VIEW).find(([, value]) => value === view)?.[0] ||
    "dashboard"
  );
}

const PAGE_TITLES: Record<ActiveView, string> = {
  dashboard: "Dashboard",
  data: "Data Balita",
  recent: "Balita Baru Diinput",
  recycle: "Daftar Dihapus",
  problem_underweight: "Balita Underweight",
  problem_stunting: "Balita Stunting",
  problem_wasting: "Balita Wasting",
  problem_tidak_naik: "Balita Tidak Naik",
  asi: "ASI Eksklusif",
  mpasi: "MPASI",
  pmt: "Pemberian PMT",
  history: "Riwayat Perubahan",
  addChild: "Tambah Balita",
  measurement: "Penimbangan Balita",
  adminBackend: "Administrasi Backend",
  adminMonitoring: "Monitoring Realtime",
};

type SidebarProps = {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
  canAdmin: boolean;
  canWrite: boolean;
  collapsed: boolean;
  sidebarOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
  onShowTooltip: (
    label: string,
    event:
      React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
  ) => void;
  onHideTooltip: () => void;
};

function DashboardSidebar({
  activeView,
  onNavigate,
  canAdmin,
  canWrite,
  collapsed,
  sidebarOpen,
  onClose,
  onToggle,
  onShowTooltip,
  onHideTooltip,
}: SidebarProps) {
  const item = (
    view: ActiveView,
    id: string,
    label: string,
    Icon: typeof LayoutDashboard,
    onClick?: () => void,
  ) => (
    <button
      type="button"
      data-nav-id={id}
      data-tooltip={label}
      aria-current={activeView === view ? "page" : undefined}
      aria-label={label}
      onMouseEnter={(event) => onShowTooltip(label, event)}
      onMouseLeave={onHideTooltip}
      onFocus={(event) => onShowTooltip(label, event)}
      onBlur={onHideTooltip}
      onClick={() => {
        onHideTooltip();
        (onClick || (() => onNavigate(view)))();
        onClose();
      }}
      className={`sidebar-nav-item group ${activeView === view ? "is-active" : ""}`}
    >
      <div className="sidebar-nav-content flex items-center gap-3">
        <span className="sidebar-nav-icon" aria-hidden="true">
          <Icon className="h-5 w-5" />
        </span>
        <span className="sidebar-nav-label text-sm text-left">{label}</span>
      </div>
    </button>
  );
  const collapseButton = (
    <button
      type="button"
      className="sidebar-collapse-button hidden md:flex"
      onClick={onToggle}
      onMouseEnter={(event) =>
        onShowTooltip(collapsed ? "Perluas Menu" : "Ringkas Menu", event)
      }
      onMouseLeave={onHideTooltip}
      onFocus={(event) =>
        onShowTooltip(collapsed ? "Perluas Menu" : "Ringkas Menu", event)
      }
      onBlur={onHideTooltip}
      aria-label={collapsed ? "Perluas Menu" : "Ringkas Menu"}
      aria-expanded={!collapsed}
    >
      <span className="sidebar-nav-icon sidebar-collapse-symbol">
        <ChevronRight className="sidebar-expand-icon h-5 w-5" />
        <ChevronLeft className="sidebar-collapse-icon h-5 w-5" />
      </span>
      <span className="sidebar-nav-label text-sm text-left">
        <span className="sidebar-expand-label">Perluas Menu</span>
        <span className="sidebar-collapse-label">Ringkas Menu</span>
      </span>
    </button>
  );
  return (
    <>
      {sidebarOpen ? (
        <div
          className="sidebar-scrim fixed inset-0 z-40 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}
      <button
        type="button"
        className="sidebar-expanded-dismiss"
        onClick={onToggle}
        aria-label="Ringkas menu samping"
      />
      <aside
        className={`app-sidebar fixed md:sticky top-0 h-screen flex flex-col z-50 ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
        aria-label="Navigasi utama"
      >
        <div className="sidebar-mobile-toolbar md:hidden">
          <span>Daftar Menu</span>
          <button
            type="button"
            onClick={onClose}
            title="Tutup menu"
            aria-label="Tutup menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="sidebar-brand-panel" data-sidebar-brand="true">
          <span className="sidebar-brand-logo-shell" aria-hidden="true">
            <img src="/logo-puskesmas-32981.svg" alt="" className="h-10 w-10" width={40} height={40} loading="lazy" decoding="async" />
          </span>
          <div className="sidebar-brand-copy min-w-0">
            <div className="sidebar-brand-name-row">
              <strong>E-Posyandu</strong>
              <span>v{APP_VERSION}</span>
            </div>
            <p>UPTD Puskesmas Gumukmas</p>
          </div>
        </div>
        <nav className="app-sidebar-nav flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {collapseButton}
          <p className="sidebar-section-label">Menu Utama</p>
          {item("dashboard", "dashboard", "Dashboard", LayoutDashboard)}
          {item("data", "data_balita", "Data Balita", Users)}
          {item("asi", "asi_eksklusif", "ASI Eksklusif", Baby)}
          {item("mpasi", "mpasi", "MPASI (6-23 Bln)", Utensils)}
          <div className="sidebar-nav-spacer sidebar-nav-spacer-small" />
          <p className="sidebar-section-label">Analisis Gizi</p>
          {item(
            "problem_underweight",
            "problem_underweight",
            "Balita Underweight",
            TrendingDown,
          )}
          {item(
            "problem_stunting",
            "problem_stunting",
            "Balita Stunting",
            Ruler,
          )}
          {item(
            "problem_wasting",
            "problem_wasting",
            "Balita Wasting",
            AlertCircle,
          )}
          {item(
            "problem_tidak_naik",
            "problem_tidak_naik",
            "Balita Tidak Naik",
            Minus,
          )}
          {item("pmt", "pmt_program", "Pemberian PMT", Gift)}
          <div className="sidebar-nav-spacer" />
          <p className="sidebar-section-label">Manajemen Data</p>
          {canWrite
            ? item("addChild", "add_child", "Tambah Balita", Plus)
            : null}
          {item("recent", "recent", "Balita Baru Diinput", Clock)}
          {item("history", "change_history", "Riwayat Perubahan", History)}
          {item("recycle", "recycle_bin", "Daftar Dihapus", Trash2)}
        </nav>
      </aside>
      <div
        id="react-sidebar-tooltip"
        className="sidebar-dock-tooltip"
        role="tooltip"
        aria-hidden="true"
      />
    </>
  );
}

function accountDetails(user: DashboardUser) {
  if (user.role === ROLES.SUPER_ADMIN)
    return { name: "Administrator", description: "UPTD Puskesmas Gumukmas" };
  if (user.role === ROLES.KADER)
    return {
      name: `Posyandu ${formatChildName(user.posyandu || "")}`.trim(),
      description: user.desa || "Desa",
    };
  if (user.role === ROLES.BIDAN)
    return { name: user.desa || "Desa", description: "Bidan Desa" };
  return { name: "Ahli Gizi", description: "UPTD Puskesmas Gumukmas" };
}

function DashboardTopbar({
  user,
  title,
  colorScheme,
  onToggleTheme,
  accountOpen,
  onToggleAccount,
  onLogout,
  onOpenAdmin,
  accountRef,
}: {
  user: DashboardUser;
  title: string;
  colorScheme: ColorScheme;
  onToggleTheme: () => void;
  accountOpen: boolean;
  onToggleAccount: () => void;
  onLogout: () => Promise<void>;
  onOpenAdmin: () => void;
  accountRef: React.RefObject<HTMLDivElement | null>;
}) {
  const account = accountDetails(user);
  return (
    <header className="app-topbar sticky top-0 z-30">
      <div className="app-header-title flex min-w-0 items-center gap-3">
        <button
          type="button"
          className="sidebar-mobile-trigger icon-button md:hidden"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("e-posyandu-open-sidebar"))
          }
          title="Buka menu"
          aria-label="Buka menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="app-page-context min-w-0">
          <h1 className="truncate">{title}</h1>
        </div>
      </div>
      <div className="topbar-actions">
        <button
          type="button"
          className="theme-toggle glass-control"
          onClick={onToggleTheme}
          title={
            colorScheme === "dark"
              ? "Gunakan mode terang"
              : "Gunakan mode gelap"
          }
          aria-label={
            colorScheme === "dark"
              ? "Gunakan mode terang"
              : "Gunakan mode gelap"
          }
          aria-pressed={colorScheme === "dark"}
        >
          {colorScheme === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </button>
        <div ref={accountRef} className="account-wrapper relative">
          <button
            type="button"
            className="account-trigger glass-control"
            onClick={onToggleAccount}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-controls="react-account-dropdown"
            title="Buka menu akun"
          >
            <span className="account-avatar">{account.name.charAt(0)}</span>
            <span className="account-trigger-copy min-w-0 text-left">
              <span className="block truncate text-sm font-bold text-slate-800">
                {account.name}
              </span>
              <span className="block truncate text-[11px] text-slate-500">
                {account.description}
              </span>
            </span>
            <ChevronDown
              className={`account-chevron h-4 w-4 text-slate-500 ${accountOpen ? "is-open" : ""}`}
            />
          </button>
          {accountOpen ? (
            <div
              id="react-account-dropdown"
              role="menu"
              className="account-menu"
            >
              <div className="account-menu-profile">
                <span className="account-menu-avatar">
                  <UserRound className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-800">
                    {account.name}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {account.description}
                  </p>
                  <span className="account-role-badge">{user.role}</span>
                </div>
              </div>
              <div className="account-menu-divider" />
              {user.role === ROLES.SUPER_ADMIN ? (
                <button
                  type="button"
                  role="menuitem"
                  className="account-admin-button"
                  onClick={onOpenAdmin}
                >
                  <Activity className="h-4 w-4" />
                  <span>Akses Administrator</span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="account-logout-button"
                onClick={() => void onLogout()}
              >
                <LogOut className="h-4 w-4" />
                <span>Keluar Sistem</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export type ReactDashboardShellProps = {
  user: DashboardUser;
  onLogout: () => Promise<void>;
};

export default function ReactDashboardShell({
  user,
  onLogout,
}: ReactDashboardShellProps) {
  const [activeView, setActiveView] = useState<ActiveView>(() =>
    typeof window === "undefined" ? "dashboard" : viewFromHash(),
  );
  const [selectedChild, setSelectedChild] = useState<Record<
    string,
    any
  > | null>(null);
  const [pmtModalData, setPmtModalData] = useState<{
    child: Record<string, any>;
    category: string;
  } | null>(null);
  const [mpasiChild, setMpasiChild] = useState<Record<string, any> | null>(null);
  const [editingChild, setEditingChild] = useState<Record<string, any> | null>(
    null,
  );
  const [childToDelete, setChildToDelete] = useState<Record<string, any> | null>(null);
  const filterOwnerKey = `${user.role}:${user.desa || ""}:${user.posyandu || ""}:${user.accessMode}`;
  const filterDefaults = useMemo(() => initialScope(user), [user]);
  const initializeFilters = useFilterStore((state) => state.initialize);
  const draft = useFilterStore((state) => state.draft);
  const scope = useFilterStore((state) => state.applied);
  const setDraft = useFilterStore((state) => state.setDraft);
  const applyDraft = useFilterStore((state) => state.applyDraft);
  const resetFilters = useFilterStore((state) => state.reset);
  const setFilterAgeGroup = useFilterStore((state) => state.setAgeGroup);
  useEffect(() => {
    initializeFilters(filterOwnerKey, filterDefaults);
  }, [filterDefaults, filterOwnerKey, initializeFilters]);
  const request = useMemo(() => toRequest(scope, user), [scope, user]);
  const queryClient = useQueryClient();
  const dashboardQuery = useQuery({
    queryKey: ["dashboard-stats", request],
    queryFn: () => getDashboardStats(request),
    enabled: activeView === "dashboard",
    // Never seed a new filter with a browser snapshot or the previous query.
    // The backend owns the authoritative fallback; the UI shows a skeleton
    // until the response for this exact scope arrives.
    staleTime: 0,
    // The aggregate is immediately available from PostgreSQL.  If a few
    // clinical rows are still waiting for Python, keep the aggregate visible
    // and refresh it in the background rather than replacing the whole page
    // with an indefinite skeleton.
    refetchInterval: (query) =>
      query.state.data?.analysisPending ? 5_000 : false,
    refetchOnWindowFocus: true,
  });
  const stats = dashboardQuery.data || EMPTY_STATS;
  const analysisPending = Boolean(dashboardQuery.data?.analysisPending);
  const pageState: PageState<DashboardStatsResponse> = dashboardQuery.data
      ? { status: "success", data: dashboardQuery.data }
      : dashboardQuery.error
        ? {
            status: "error",
            message: errorMessage(
              dashboardQuery.error,
              "Ringkasan dashboard belum dapat dimuat.",
            ),
          }
        : { status: "loading" };
  const invalidateReadQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] }),
      queryClient.invalidateQueries({ queryKey: ["children-page"] }),
      queryClient.invalidateQueries({
        queryKey: ["exclusive-breastfeeding-page"],
      }),
      queryClient.invalidateQueries({ queryKey: ["change-history"] }),
    ]);
  }, [queryClient]);
  const monitoringStatus = useRealtimeStore((state) => state.monitoringStatus);
  const setMonitoringStatus = useRealtimeStore((state) => state.setMonitoringStatus);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const accountOpen = useUiStore((state) => state.accountOpen);
  const setAccountOpen = useUiStore((state) => state.setAccountOpen);
  const colorScheme = useUiStore((state) => state.colorScheme);
  const setColorScheme = useUiStore((state) => state.setColorScheme);
  const toggleColorScheme = useUiStore((state) => state.toggleColorScheme);
  const releaseNotesOpen = useUiStore((state) => state.releaseNotesOpen);
  const setReleaseNotesOpen = useUiStore((state) => state.setReleaseNotesOpen);
  const [actionError, setActionError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const accountRef = useRef<HTMLDivElement | null>(null);

  const resetAgeGroupForView = useCallback((view: ActiveView) => {
    const ageGroup = defaultAgeGroupForView(view);
    setFilterAgeGroup(ageGroup);
  }, [setFilterAgeGroup]);

  useEffect(() => subscribeColorScheme(setColorScheme), [setColorScheme]);
  useEffect(() => {
    const onHashChange = () => {
      const next = viewFromHash();
      if (next !== "measurement") {
        resetAgeGroupForView(next);
        setActiveView(next);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (activeView !== "measurement" || selectedChild) return undefined;
    const childId = measurementIdFromHash();
    if (!childId) {
      setActiveView("data");
      return undefined;
    }
    let active = true;
    void getChildDetail(childId)
      .then((document) => {
        if (active) setSelectedChild({ id: document.id, ...document.data });
      })
      .catch(() => {
        if (!active) return;
        setActionError("Data balita untuk pengukuran tidak dapat dimuat.");
        setActiveView("data");
      });
    return () => {
      active = false;
    };
  }, [activeView, selectedChild]);
  useEffect(() => {
    const close = () => setSidebarOpen(false);
    window.addEventListener("e-posyandu-close-sidebar", close);
    const open = () => setSidebarOpen(true);
    window.addEventListener("e-posyandu-open-sidebar", open);
    return () => {
      window.removeEventListener("e-posyandu-close-sidebar", close);
      window.removeEventListener("e-posyandu-open-sidebar", open);
    };
  }, []);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        accountRef.current &&
        !accountRef.current.contains(event.target as Node)
      )
        setAccountOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountOpen(false);
        setSidebarOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void getMonitoringStatus()
      .then((status) => {
        if (active) setMonitoringStatus(status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const applyScope = useCallback(() => applyDraft(), [applyDraft]);
  const resetScope = useCallback(() => {
    const next = initialScope(user);
    resetFilters(next);
  }, [resetFilters, user]);
  const navigate = useCallback((view: ActiveView) => {
    if (view === "measurement" && !selectedChild) return;
    if (
      (view === "adminBackend" || view === "adminMonitoring") &&
      user.role !== ROLES.SUPER_ADMIN
    )
      return;
    // Do not carry a cohort selected on another page into this page.  ASI
    // and MPASI intentionally reset to their programme-specific defaults.
    resetAgeGroupForView(view);
    if (view !== "measurement") setSelectedChild(null);
    setActiveView(view);
    const nextHash = `#${hashForView(view)}`;
    if (window.location.hash !== nextHash)
      window.history.replaceState(null, "", nextHash);
  }, [resetAgeGroupForView, selectedChild, user]);
  const openMeasurement = useCallback((child: Record<string, unknown>) => {
    const childId = String(child.id || child.childId || "");
    if (!childId) return;
    setSelectedChild(child);
    setActiveView("measurement");
    const nextHash = `#measurement/${encodeURIComponent(childId)}`;
    if (window.location.hash !== nextHash)
      window.history.replaceState(null, "", nextHash);
  }, []);
  const showTooltip = (
    label: string,
    event:
      React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
  ) => {
    if (!sidebarCollapsed) return;
    const tooltip = document.getElementById("react-sidebar-tooltip");
    if (!tooltip) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    tooltip.textContent = label;
    tooltip.style.top = `${Math.max(28, Math.min(window.innerHeight - 28, bounds.top + bounds.height / 2))}px`;
    tooltip.setAttribute("aria-hidden", "false");
    tooltip.classList.add("is-visible");
  };
  const hideTooltip = () => {
    const tooltip = document.getElementById("react-sidebar-tooltip");
    tooltip?.classList.remove("is-visible");
    tooltip?.setAttribute("aria-hidden", "true");
  };
  const canWrite = user.accessMode !== "read";
  const exportContext = useMemo(() => ({
    scope,
    user,
    db,
    appId,
    roles: ROLES,
  }), [scope, user]);
  const runExport = useCallback((label: string, task: () => Promise<void>) => {
    setActionError(null);
    void task().catch((cause) => {
      setActionError(
        `Gagal membuat ${label}: ${errorMessage(cause, "Permintaan tidak dapat diproses.")}`,
      );
    });
  }, []);
  const handleImportIdentitas = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !canWrite) return;
    try {
      await validateSpreadsheetFile(file);
      const xlsx = await ensureXlsx();
      const workbook = xlsx.read(await file.arrayBuffer(), {
        type: "array",
        bookVBA: false,
        bookDeps: false,
        bookFiles: false,
        cellFormula: false,
        sheetRows: 5001,
        WTF: false,
      });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("Lembar kerja Excel tidak ditemukan.");
      const rows = xlsx.utils.sheet_to_json(sheet, {
        defval: "",
        raw: false,
      }) as Array<Record<string, any>>;
      if (!rows.length) throw new Error("Berkas Excel tidak memiliki data identitas.");
      if (rows.length > 5000) throw new Error("Impor dibatasi maksimal 5.000 baris per berkas.");
      if (!Object.prototype.hasOwnProperty.call(rows[0], "nama_anak") || !Object.prototype.hasOwnProperty.call(rows[0], "tgl_lahir")) {
        throw new Error("Kolom nama_anak dan tgl_lahir wajib tersedia.");
      }
      let desa = user.desa || "";
      let posyandu = user.posyandu || "";
      if (isFullAccessRole(user.role)) {
        desa = scope.desa;
        posyandu = scope.posyandu;
      } else if (user.role === ROLES.BIDAN) {
        desa = user.desa || "";
        posyandu = scope.posyandu || "";
      }
      if (!desa || !posyandu) {
        throw new Error("Pilih desa dan posyandu sebelum mengimpor identitas.");
      }
      let imported = 0;
      for (const row of rows) {
        const nama = sanitizeImportedCellText(row.nama_anak, 120);
        const tglLahir = sanitizeImportedCellText(row.tgl_lahir, 32);
        if (!nama || !tglLahir) continue;
        await addDoc(
          collection(db, "artifacts", appId, "public", "data", "children"),
          {
            anakKe: row.anak_ke || "",
            tglLahir,
            jk: sanitizeImportedCellText(row.jenis_kelamin, 32) === "Laki-laki" ? "L" : "P",
            noKK: sanitizeImportedCellText(row.nomor_KK, 32),
            nik: sanitizeImportedCellText(row.NIK, 32),
            hasKK: Boolean(row.nomor_KK),
            hasNIK: Boolean(row.NIK),
            nama,
            usiaKehamilan: row.usia_hamil || "",
            bbLahir: row.berat_lahir || "",
            pbLahir: row.panjang_lahir || "",
            lkLahir: row.lingkar_kepala_lahir || "",
            bukuKIA: sanitizeImportedCellText(row.kia, 16) || "Tidak",
            bukuKIAKecil: sanitizeImportedCellText(row.kia_bayi_kecil, 16) || "Tidak",
            imd: sanitizeImportedCellText(row.imd, 16) || "Tidak",
            namaOrtu: sanitizeImportedCellText(row.nama_ortu, 120),
            nikOrtu: sanitizeImportedCellText(row.nik_ortu, 32),
            noHpOrtu: sanitizeImportedCellText(row.hp_ortu, 32),
            alamat: sanitizeImportedCellText(row.alamat, 500),
            rt: sanitizeImportedCellText(row.rt, 8),
            rw: sanitizeImportedCellText(row.rw, 8),
            desa,
            posyandu,
            currentBB: row.berat_lahir || "",
            currentTB: row.panjang_lahir || "",
            currentLILA: 0,
            currentLK: row.lingkar_kepala_lahir || "",
            deletedAt: null,
            createdAt: serverTimestamp(),
            createdBy: user.role,
          },
        );
        imported += 1;
      }
      await syncPendingMutations();
      await invalidateReadQueries();
      if (!imported) throw new Error("Tidak ada baris identitas yang dapat diimpor.");
      setActionError(null);
    } catch (cause) {
      setActionError(`Gagal mengimpor identitas: ${errorMessage(cause, "Berkas tidak valid.")}`);
    }
  };
  const confirmDeleteChild = useCallback(async (id: string, payload: Record<string, string>) => {
    await updateDoc(
      doc(db, "artifacts", appId, "public", "data", "children", id),
      { ...payload, deletedAt: serverTimestamp(), updatedAt: serverTimestamp() },
      { deferSync: true },
    );
    await syncPendingMutations();
    await invalidateReadQueries();
    setChildToDelete(null);
  }, [invalidateReadQueries]);
  const handleOpenAddChild = useCallback(() => {
    setEditingChild(null);
    navigate("addChild");
  }, [navigate]);
  const handleEditChild = useCallback((child: Record<string, unknown>) => {
    const id = String(child.id || child.childId || "");
    if (!id) return;
    void getChildDetail(id)
      .then((document) => setEditingChild({ id: document.id, ...document.data }))
      .catch((cause) => setActionError(`Gagal memuat detail balita: ${errorMessage(cause, "Permintaan tidak dapat diproses.")}`));
  }, []);
  const handleOpenPmt = useCallback((child: Record<string, unknown>, category: string) => {
    if (!canWrite) return;
    setPmtModalData({ child: child as Record<string, any>, category: getPmtCategoryForTab(category) });
  }, [canWrite]);
  const handleRestoreChild = useCallback(async (child: Record<string, unknown>) => {
    const id = String(child.id || child.childId || "");
    if (!id) return;
    await updateDoc(doc(db, "artifacts", appId, "public", "data", "children", id), { deletedAt: null, updatedAt: serverTimestamp() }, { deferSync: true });
    await syncPendingMutations();
    await invalidateReadQueries();
    navigate("data");
  }, [invalidateReadQueries, navigate]);
  const handlePermanentDelete = useCallback(async (child: Record<string, unknown>) => {
    const id = String(child.id || child.childId || "");
    if (!id) return;
    await deleteDoc(doc(db, "artifacts", appId, "public", "data", "children", id));
    await syncPendingMutations();
    await invalidateReadQueries();
    navigate("data");
  }, [invalidateReadQueries, navigate]);
  const handleExportTable = useCallback(() => runExport("file tabel balita", () => exportChildrenTable({ ...exportContext, activeView })), [activeView, exportContext, runExport]);
  const handleExportMeasurement = useCallback(() => runExport("file pengukuran", () => exportMeasurements(exportContext)), [exportContext, runExport]);
  const handleExportSigizi = useCallback(() => runExport("file identitas Sigizi", () => exportRecentIdentities(exportContext)), [exportContext, runExport]);
  const handleImportClick = useCallback(() => importInputRef.current?.click(), []);
  const handleDeleteMpasiChild = useCallback((child: Record<string, unknown>) => {
    if (canWrite) setChildToDelete(child as Record<string, any>);
  }, [canWrite]);
  const handleOpenMpasi = useCallback((child: Record<string, unknown>) => {
    if (canWrite) setMpasiChild(child as Record<string, any>);
  }, [canWrite]);
  const handleExportMpasi = useCallback(() => runExport("file MPASI", () => exportMpasi(exportContext)), [exportContext, runExport]);
  const handleExportPmt = useCallback(() => runExport("file PMT", () => exportPmt(exportContext)), [exportContext, runExport]);
  const handleDeleteProgram = useCallback(async (program: Record<string, any>) => {
    if (!canWrite || !program.id) return;
    const name = String(program.childName || "balita");
    if (!window.confirm(`Hapus program PMT untuk ${name}? Data pemantauan mingguannya juga akan dihapus.`)) return;
    try {
      await deleteDoc(doc(db, "artifacts", appId, "public", "data", "pmt_programs", String(program.id)));
      await syncPendingMutations();
      await invalidateReadQueries();
    } catch (cause) {
      setActionError(`Gagal menghapus program PMT: ${errorMessage(cause, "Permintaan tidak dapat diproses.")}`);
    }
  }, [canWrite, invalidateReadQueries]);
  const title = PAGE_TITLES[activeView];
  const showFilter = ![
    "addChild",
    "measurement",
    "adminBackend",
    "adminMonitoring",
  ].includes(activeView);

  return (
    <DashboardLayout
      className={[
        sidebarCollapsed ? "is-sidebar-collapsed" : "",
        sidebarOpen ? "is-mobile-sidebar-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      sidebar={
        <DashboardSidebar
          activeView={activeView}
          onNavigate={navigate}
          canAdmin={user.role === ROLES.SUPER_ADMIN}
          canWrite={canWrite}
          collapsed={sidebarCollapsed}
          sidebarOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onToggle={() => setSidebarCollapsed((current) => !current)}
          onShowTooltip={showTooltip}
          onHideTooltip={hideTooltip}
        />
      }
      topbar={
        <DashboardTopbar
          accountRef={accountRef}
          user={user}
          title={title}
          colorScheme={colorScheme}
          onToggleTheme={toggleColorScheme}
          accountOpen={accountOpen}
          onToggleAccount={() => setAccountOpen((current) => !current)}
          onLogout={async () => {
            setAccountOpen(false);
            await onLogout();
          }}
          onOpenAdmin={() => {
            setAccountOpen(false);
            navigate("adminBackend");
          }}
        />
      }
      footer={
        <footer className="app-footer">
          <p>
            © 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach
          </p>
          <button
            type="button"
            className="app-version-button"
            onClick={() => setReleaseNotesOpen(true)}
            aria-haspopup="dialog"
            title="Lihat apa yang baru"
          >
            E-Posyandu v{APP_VERSION}
          </button>
        </footer>
      }
    >
      <div className="space-y-6">
        <input
          ref={importInputRef}
          type="file"
          accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={handleImportIdentitas}
          tabIndex={-1}
          aria-hidden="true"
        />
        {actionError ? (
          <div role="alert" className="ios-inline-notification ios-inline-notification-error">
            {actionError}
          </div>
        ) : null}
        {!canWrite ? (
          <div role="status" className="read-only-access-banner mb-6">
            <AlertCircle className="h-5 w-5" />
            <div>
              <strong>Mode Hanya Baca</strong>
              <p>
                Anda dapat melihat data sesuai wilayah akun, tetapi tidak dapat
                menambah, mengubah, atau menghapus data.
              </p>
            </div>
          </div>
        ) : null}
        {showFilter ? (
          <div className="mb-6">
            <LocationFilterPanel
              draftDesa={draft.desa}
              draftPosyandu={draft.posyandu}
              filterMonth={draft.month}
              filterYear={draft.year}
              ageGroup={draft.ageGroup}
              role={user.role}
              user={user}
              onApply={applyScope}
              onReset={resetScope}
              setDraftDesa={(desa) =>
                setDraft((current) => ({ ...current, desa, posyandu: "" }))
              }
              setDraftPosyandu={(posyandu) =>
                setDraft((current) => ({ ...current, posyandu }))
              }
              setFilterMonth={(month) =>
                setDraft((current) => ({ ...current, month }))
              }
              setFilterYear={(year) =>
                setDraft((current) => ({ ...current, year }))
              }
              setAgeGroup={(ageGroup) =>
                setDraft((current) => ({ ...current, ageGroup }))
              }
              ageGroupOptions={
                activeView === "asi"
                  ? EXCLUSIVE_BREASTFEEDING_AGE_GROUP_OPTIONS
                  : undefined
              }
              showAgeGroupFilter={activeView !== "mpasi"}
            />
          </div>
        ) : null}
        <Suspense
          fallback={
            <div className="space-y-4" role="status" aria-live="polite">
              <div className="h-8 w-56 animate-pulse rounded-lg bg-slate-200" />
              <div className="h-56 animate-pulse rounded-2xl bg-slate-100" />
              <span className="sr-only">Memuat modul…</span>
            </div>
          }
        >
          {activeView === "dashboard" ? (
            <DashboardOverviewPage
              stats={stats}
              pageState={pageState}
              loading={pageState.status === "loading"}
              refreshing={dashboardQuery.isFetching || analysisPending}
              monitoringStatus={monitoringStatus}
              filterMonth={scope.month}
              filterYear={scope.year}
              ageGroup={scope.ageGroup}
              viewDesa={request.village}
              viewPosyandu={request.posyandu}
            />
          ) : [
              "data",
              "recent",
              "recycle",
              "problem_underweight",
              "problem_stunting",
              "problem_wasting",
              "problem_tidak_naik",
            ].includes(activeView) ? (
            <ReactChildrenTablePage
              user={user}
              scope={scope}
              initialView={activeView as ChildTableView}
              onOpenAddChild={handleOpenAddChild}
              onEditChild={handleEditChild}
              onOpenMeasurement={openMeasurement}
              onOpenPmt={handleOpenPmt}
              onRestoreChild={handleRestoreChild}
              onPermanentDelete={handlePermanentDelete}
              onExportTable={handleExportTable}
              onExportMeasurement={handleExportMeasurement}
              onExportSigizi={handleExportSigizi}
              onImportIdentitas={handleImportClick}
            />
          ) : activeView === "addChild" ? (
            <ReactAddChildPage
              user={user}
              allChildren={[]}
              initialData={editingChild || undefined}
              isEdit={Boolean(editingChild)}
              onBack={() => {
                setEditingChild(null);
                navigate("data");
              }}
              onSuccess={() => {
                setEditingChild(null);
                void invalidateReadQueries();
                navigate("data");
              }}
            />
          ) : activeView === "measurement" && selectedChild ? (
            <ReactMeasurementPage
              user={user}
              child={selectedChild}
              onBack={() => {
                void invalidateReadQueries();
                navigate("data");
              }}
            />
          ) : activeView === "asi" ? (
            <ReactExclusiveBreastfeedingPage user={user} scope={scope} />
          ) : activeView === "mpasi" ? (
            <ReactMpasiPage
              user={user}
              scope={scope}
              onOpenAddChild={handleOpenAddChild}
              onEditChild={handleEditChild}
              onOpenMeasurement={openMeasurement}
              onDeleteChild={handleDeleteMpasiChild}
              onOpenMpasi={handleOpenMpasi}
              onExportMpasi={handleExportMpasi}
            />
          ) : activeView === "pmt" ? (
            <ReactPmtProgramPage
              user={user}
              ageGroup="6-23"
              currentFilterDate={new Date(scope.year, scope.month, 0)}
              onExportPmt={handleExportPmt}
              onDeleteProgram={canWrite ? handleDeleteProgram : undefined}
            />
          ) : activeView === "history" ? (
            <ReactChangeHistoryPage user={user} scope={scope} />
          ) : activeView === "adminBackend" &&
            user.role === ROLES.SUPER_ADMIN ? (
            <ReactAdminBackendPage user={user} />
          ) : activeView === "adminMonitoring" &&
            user.role === ROLES.SUPER_ADMIN ? (
            <ReactAdminMonitoringPage user={user} />
          ) : null}
        </Suspense>
      </div>
      {releaseNotesOpen ? (
        <ReleaseNotesDialog onClose={() => setReleaseNotesOpen(false)} />
      ) : null}
      {pmtModalData ? (
        <PmtModal
          child={pmtModalData.child}
          category={pmtModalData.category}
          onClose={() => setPmtModalData(null)}
          onSaved={() => {
            setPmtModalData(null);
            void invalidateReadQueries();
          }}
        />
      ) : null}
      {editingChild ? (
        <AddChildModal
          user={user}
          allChildren={[]}
          initialData={editingChild}
          isEdit
          onClose={() => setEditingChild(null)}
          onSuccess={() => {
            setEditingChild(null);
            void invalidateReadQueries();
            setActiveView("data");
          }}
        />
      ) : null}
      {mpasiChild ? (
        <MpasiModal
          child={mpasiChild}
          onClose={() => setMpasiChild(null)}
          onSaved={() => {
            setMpasiChild(null);
            void invalidateReadQueries();
          }}
        />
      ) : null}
      {childToDelete ? (
        <DeleteChildModal
          child={childToDelete}
          onClose={() => setChildToDelete(null)}
          onConfirm={confirmDeleteChild}
        />
      ) : null}
    </DashboardLayout>
  );
}
