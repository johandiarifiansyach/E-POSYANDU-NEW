import {
  cacheRemoteDocuments,
  clearOfflineStore,
  completeMutation,
  getCachedDocument,
  getCachedDocuments,
  getCachedDocumentsByIds,
  getPendingMutations,
  getSyncConflicts,
  makeCachedDocument,
  markMutationError,
  PendingMutation,
  putCachedDocument,
  queueMutation,
  recordSyncConflict,
  removeCachedDocument,
  removeSyncConflict,
  SyncConflict,
  subscribeToOfflineStore,
  updatePendingMutation
} from '../services/offlineStore';

export type AuthUser = {
  uid: string;
  email: string | null;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type Auth = {
  currentUser: AuthUser | null;
};

export type AccessProfile = {
  userId: string;
  email: string | null;
  role: string;
  desa: string | null;
  posyandu: string | null;
};

export type Firestore = {
  kind: 'firestore';
};

export type DocumentData = Record<string, any>;

export type QueryDocumentSnapshot<T = DocumentData> = {
  id: string;
  data: () => T;
};

export type QuerySnapshot<T = DocumentData> = {
  docs: Array<QueryDocumentSnapshot<T>>;
};

type WhereOp = '==' | '>=' | '<=';
type OrderDirection = 'asc' | 'desc';

type WhereConstraint = {
  kind: 'where';
  field: string;
  op: WhereOp;
  value: any;
};

type OrderByConstraint = {
  kind: 'orderBy';
  field: string;
  direction: OrderDirection;
};

type QueryConstraint = WhereConstraint | OrderByConstraint;

type CollectionRef = {
  kind: 'collection';
  tableName: string;
};

type DocRef = {
  kind: 'doc';
  tableName: string;
  id: string;
};

type QueryRef = {
  kind: 'query';
  tableName: string;
  constraints: QueryConstraint[];
};

type FirebaseAppCompat = {
  projectId?: string;
};

type TimestampCompat = {
  toDate: () => Date;
  seconds: number;
};

export type ApiDocument = {
  id: string;
  data: DocumentData;
};

type SyncMutationResult = {
  id: string;
  resource: string;
  documentId: string;
  operation: PendingMutation['type'];
  document?: ApiDocument;
  error?: {
    status: number;
    code: string;
    detail: string;
  };
  conflict?: {
    serverDocument?: ApiDocument;
  };
};

type SyncChangeSet = {
  items: ApiDocument[];
  deletedIds?: string[];
  cursor?: string;
};

type SyncResponse = {
  results: SyncMutationResult[];
  changes: Record<string, SyncChangeSet>;
  cursor: string;
};

export type ChildrenPageRequest = {
  asOf: string;
  measurementEnd: string;
  measurementStart: string;
  page: number;
  posyandu?: string;
  search?: string;
  size?: number;
  sort: string;
  view?:
    | 'data'
    | 'recent'
    | 'recycle'
    | 'mpasi'
    | 'problem_underweight'
    | 'problem_stunting'
    | 'problem_wasting'
    | 'problem_tidak_naik';
  village?: string;
};

export type ChildrenPageResponse = {
  items: ApiDocument[];
  measurements: ApiDocument[];
  mpasiLogs?: ApiDocument[];
  total: number;
};

export type ExclusiveBreastfeedingPageRequest = {
  ageGroup: '0-5' | '6';
  measurementEnd: string;
  measurementStart: string;
  page: number;
  posyandu?: string;
  size?: number;
  village?: string;
};

export type ExclusiveBreastfeedingPageResponse = {
  items: ApiDocument[];
  total: number;
};

export type DashboardStatsRequest = {
  monthEnd: string;
  monthStart: string;
  posyandu?: string;
  previousMonthEnd: string;
  previousMonthStart: string;
  village?: string;
};

export type DashboardStatsResponse = {
  S: number;
  D: number;
  N: number;
  T: number;
  B: number;
  O: number;
  asiEksklusif: number;
  asiTarget: number;
  underweight: number;
  stunting: number;
  wasting: number;
  perD: string;
  perN: string;
  perT: string;
  perAsiEksklusif: string;
  perUnderweight: string;
  perStunting: string;
  perWasting: string;
};

export type MonitoringStatus = {
  environment: string;
  worker: {
    status: 'healthy' | 'degraded' | 'down' | 'unknown' | 'unconfigured';
    checkedAt: string | null;
    latencyMs: number | null;
    statusCode: number | null;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };
  database: {
    isolation: 'production' | 'isolated' | 'shared_production' | 'unknown';
    writesProtected: boolean;
  };
  storage: {
    r2Configured: boolean;
    status: {
      status: 'healthy' | 'cleaned' | 'warning';
      checkedAt: string;
      totalBytes: number;
      temporaryBytes: number;
      objectCount: number;
      deletedObjects: number;
      deletedBytes: number;
      softLimitBytes: number;
      cleanupTargetBytes: number;
    } | null;
  };
  queue: { configured: boolean };
  alerts: { externalConfigured: boolean };
};

export type SigiziMeasurementExportRequest = {
  monthStart: string;
  monthEnd: string;
  village?: string;
  posyandu?: string;
};

export type SigiziMeasurementExportRow = {
  nik: string;
  nama: string;
  tglUkur: string | null;
  bb: number | null;
  tb: number | null;
  lila: number | null;
  lk: number | null;
  edema: string;
  caraUkur: string;
  vitA: string;
  asiBulan0: string;
  asiBulan1: string;
  asiBulan2: string;
  asiBulan3: string;
  asiBulan4: string;
  asiBulan5: string;
  asiBulan6: string;
  kelasIbu: string;
  mbg: string;
};

export type SigiziMeasurementExportResponse = {
  items: SigiziMeasurementExportRow[];
};

export type BackgroundJobKind =
  | 'import_validation'
  | 'nutrition_report'
  | 'export_file'
  | 'system_sync';

export type BackgroundJob = {
  id: string;
  kind: BackgroundJobKind;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  result: Record<string, unknown> | null;
  error: string | null;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  queueConfigured?: boolean;
};

type LegacyDocument = {
  id: string;
  data: DocumentData;
  created_at: string;
  updated_at: string;
};

// An empty value means "use this website's /api route". This keeps the same
// frontend configuration working through Vite locally and Netlify in production.
const API_BASE_URL = (
  import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '')
).replace(/\/$/, '');
const LEGACY_SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const LEGACY_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const API_REQUEST_TIMEOUT_MS = 20_000;
const SYNC_STATE_PREFIX = 'e-posyandu:sync-state:';
const AUTH_SESSION_KEY = 'e-posyandu:auth-session';

const authState: Auth = { currentUser: null };
const authListeners = new Set<(user: AuthUser | null) => void>();
const activeViewRefreshers = new Set<() => Promise<void>>();
const syncStateListeners = new Set<(syncing: boolean) => void>();
let activeSyncOperations = 0;

function toTimestampCompat(input: Date | string): TimestampCompat {
  const date = input instanceof Date ? input : new Date(input);
  return {
    toDate: () => date,
    seconds: Math.floor(date.getTime() / 1000)
  };
}

function shouldHydrateTimestamp(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || !key) return false;
  const lower = key.toLowerCase();
  const looksLikeIso = value.includes('T') && (value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value));
  return looksLikeIso && (lower.endsWith('at') || lower === 'timestamp');
}

function isServerTimestampMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__serverTimestamp' in (value as Record<string, unknown>)
  );
}

function normalizeForWrite(value: any): any {
  if (isServerTimestampMarker(value)) return new Date().toISOString();

  if (value && typeof value?.toDate === 'function') {
    const asDate = value.toDate();
    if (asDate instanceof Date) return asDate.toISOString();
  }

  if (Array.isArray(value)) return value.map((item) => normalizeForWrite(item));

  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeForWrite(item);
    return out;
  }

  return value;
}

function hydrateForRead(value: any, key = ''): any {
  if (Array.isArray(value)) return value.map((item) => hydrateForRead(item));

  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [nestedKey, item] of Object.entries(value)) out[nestedKey] = hydrateForRead(item, nestedKey);
    return out;
  }

  return shouldHydrateTimestamp(key, value) ? toTimestampCompat(value) : value;
}

function makeDocSnapshot<T = DocumentData>(id: string, data: T): QueryDocumentSnapshot<T> {
  return { id, data: () => data };
}

function ensureCollectionName(pathParts: string[]): string {
  if (!pathParts.length) throw new Error('Path collection kosong.');
  return pathParts[pathParts.length - 1];
}

function createId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function isNetworkError(error: unknown) {
  if (!isOnline()) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|network|offline|load failed|fetch failed|connection/i.test(message);
}

type QuerySyncState = {
  lastSyncedAt: string;
  lastFullSyncAt: string;
};

function querySyncKey(ref: QueryRef) {
  const backendVersion = usesFastApi() ? 'node-api-v1' : 'legacy-supabase-v1';
  return `${SYNC_STATE_PREFIX}${backendVersion}:${ref.tableName}:${JSON.stringify(ref.constraints)}`;
}

function readQuerySyncState(ref: QueryRef): QuerySyncState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(querySyncKey(ref));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<QuerySyncState>;
    if (typeof value.lastSyncedAt !== 'string' || typeof value.lastFullSyncAt !== 'string') return null;
    return value as QuerySyncState;
  } catch {
    return null;
  }
}

function saveQuerySyncState(ref: QueryRef, state: QuerySyncState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(querySyncKey(ref), JSON.stringify(state));
  } catch {
    // Sync remains usable when browser storage is unavailable.
  }
}

function needsFullSync(state: QuerySyncState | null) {
  if (!state) return true;
  const lastFullSyncAt = new Date(state.lastFullSyncAt).getTime();
  return !Number.isFinite(lastFullSyncAt) || Date.now() - lastFullSyncAt >= FULL_SYNC_INTERVAL_MS;
}

function apiUrl(path: string): string {
  return `${API_BASE_URL}/api/v1${path}`;
}

function usesFastApi() {
  return Boolean(API_BASE_URL);
}

function clearSyncState() {
  if (typeof window === 'undefined') return;
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(SYNC_STATE_PREFIX))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Cache cleanup is best effort when browser storage is unavailable.
  }
}

function readStoredSession(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    let raw = window.sessionStorage.getItem(AUTH_SESSION_KEY);
    const fromLegacyStorage = !raw;
    if (!raw) raw = window.localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Partial<AuthUser>;
    if (
      typeof session.uid !== 'string' ||
      typeof session.accessToken !== 'string' ||
      typeof session.refreshToken !== 'string' ||
      typeof session.expiresAt !== 'number'
    ) {
      window.sessionStorage.removeItem(AUTH_SESSION_KEY);
      window.localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }
    const restored = {
      uid: session.uid,
      email: typeof session.email === 'string' ? session.email : null,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt
    };
    if (fromLegacyStorage) {
      window.sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(restored));
      window.localStorage.removeItem(AUTH_SESSION_KEY);
    }
    return restored;
  } catch {
    return null;
  }
}

function saveSession(user: AuthUser | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!user?.accessToken || !user.refreshToken || !user.expiresAt) {
      window.sessionStorage.removeItem(AUTH_SESSION_KEY);
      window.localStorage.removeItem(AUTH_SESSION_KEY);
      return;
    }
    window.sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(user));
    window.localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // The active session can still run until the page is closed.
  }
}

function notifyAuthListeners() {
  authListeners.forEach((listener) => listener(authState.currentUser));
}

function authConfig() {
  if (!LEGACY_SUPABASE_URL || !LEGACY_SUPABASE_ANON_KEY) {
    throw new Error('Konfigurasi Supabase Auth belum tersedia.');
  }
  return { url: LEGACY_SUPABASE_URL, publishableKey: LEGACY_SUPABASE_ANON_KEY };
}

type SupabaseAuthResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email?: string | null };
  profile?: AccessProfile;
};

async function supabaseAuthRequest(path: string, body: Record<string, string>): Promise<SupabaseAuthResponse> {
  const { url, publishableKey } = authConfig();
  const response = await fetchWithTimeout(`${url}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    let detail = 'Email atau kata sandi tidak dapat diverifikasi.';
    try {
      const payload = await response.json();
      if (typeof payload?.msg === 'string') detail = payload.msg;
      else if (typeof payload?.message === 'string') detail = payload.message;
    } catch {
      // Keep the safe generic message when Auth cannot return JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<SupabaseAuthResponse>;
}

async function usernameLoginRequest(username: string, password: string, turnstileToken?: string): Promise<SupabaseAuthResponse> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  const response = await fetchWithTimeout(`${API_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Request-ID': createRequestId()
    },
    body: JSON.stringify({ username, password, turnstileToken })
  });
  if (!response.ok) {
    let detail = 'Username atau kata sandi tidak benar.';
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string') detail = payload.detail;
    } catch {
      // Keep the safe generic message when the API cannot return JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<SupabaseAuthResponse>;
}

function sessionFromResponse(response: SupabaseAuthResponse): AuthUser {
  return {
    uid: response.user.id,
    email: response.user.email || null,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + response.expires_in * 1000
  };
}

async function refreshAccessToken(auth: Auth): Promise<AuthUser> {
  const session = auth.currentUser;
  if (!session?.refreshToken) throw new Error('Sesi masuk diperlukan.');
  const response = await supabaseAuthRequest('/token?grant_type=refresh_token', { refresh_token: session.refreshToken });
  const refreshed = sessionFromResponse(response);
  auth.currentUser = refreshed;
  saveSession(refreshed);
  notifyAuthListeners();
  return refreshed;
}

async function getAccessToken(auth: Auth): Promise<string> {
  const session = auth.currentUser;
  if (!session?.accessToken) throw new Error('Sesi masuk diperlukan.');
  if ((session.expiresAt || 0) > Date.now() + 60_000) return session.accessToken;
  return (await refreshAccessToken(auth)).accessToken as string;
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = API_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error('Layanan terlalu lama merespons. Silakan coba lagi.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await getAccessToken(authState);
  let response: Response;
  try {
    response = await fetchWithTimeout(apiUrl(path), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Request-ID': createRequestId(),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      }
    });
  } catch (error) {
    if (isNetworkError(error)) {
      throw new Error('Tidak dapat terhubung ke API. Periksa koneksi lalu coba lagi.');
    }
    throw error;
  }

  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    let detail = `Permintaan API gagal (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Keep the HTTP status message when the server cannot return JSON.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

async function graphQlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const accessToken = await getAccessToken(authState);
  let response: Response;
  try {
    response = await fetchWithTimeout(`${API_BASE_URL}/api/v1/graphql`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Request-ID': createRequestId()
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (error) {
    if (isNetworkError(error)) {
      throw new Error('Tidak dapat terhubung ke API. Periksa koneksi lalu coba lagi.');
    }
    throw error;
  }
  let payload: { data?: T; errors?: Array<{ message?: string }> };
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Permintaan GraphQL gagal (${response.status}).`);
  }
  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message || `Permintaan GraphQL gagal (${response.status}).`);
  }
  return payload.data;
}

export type FeatureFlags = {
  csvExport: boolean;
  largeExports: boolean;
  notifications: boolean;
  webhooks: boolean;
  fileUploads: boolean;
};

export async function getFeatureFlags(): Promise<FeatureFlags> {
  return apiRequest<FeatureFlags>('/features');
}

export async function getMonitoringStatus(): Promise<MonitoringStatus> {
  return apiRequest<MonitoringStatus>('/monitoring/status');
}

export async function getChangeHistory(
  page = 1,
  size = 10
): Promise<{ items: ApiDocument[]; total: number }> {
  const currentPage = Math.max(1, Math.trunc(page));
  const pageSize = Math.min(50, Math.max(1, Math.trunc(size)));
  const response = await apiRequest<SyncChangeSet & { total?: number }>(
    `/collections/change_logs?order=timestamp%7Cdesc&page=${currentPage}&size=${pageSize}`
  );
  return {
    items: response.items,
    total: Number.isFinite(response.total) ? Number(response.total) : response.items.length
  };
}

export async function createBackgroundJob(
  kind: BackgroundJobKind,
  payload: Record<string, unknown>,
  idempotencyKey = createRequestId()
): Promise<BackgroundJob> {
  return apiRequest<BackgroundJob>('/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ kind, payload })
  });
}

export async function getBackgroundJob(id: string): Promise<BackgroundJob> {
  return apiRequest<BackgroundJob>(`/jobs/${encodeURIComponent(id)}`);
}

export async function waitForBackgroundJob(
  id: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<BackgroundJob> {
  const intervalMs = Math.max(500, options.intervalMs ?? 1_500);
  const timeoutMs = Math.max(intervalMs, options.timeoutMs ?? 5 * 60_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getBackgroundJob(id);
    if (job.status === 'completed') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error || 'Pekerjaan tidak berhasil diproses.');
    }
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
  throw new Error('Pekerjaan masih diproses. Silakan periksa kembali sebentar lagi.');
}

export async function downloadBackgroundJobFile(job: BackgroundJob): Promise<Blob> {
  if (!job.downloadUrl) throw new Error('Berkas hasil pekerjaan belum tersedia.');
  const accessToken = await getAccessToken(authState);
  const response = await fetch(`${API_BASE_URL}${job.downloadUrl}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Request-ID': createRequestId()
    }
  });
  if (!response.ok) {
    let detail = 'Berkas hasil pekerjaan tidak dapat diunduh.';
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string') detail = payload.detail;
    } catch {
      // Keep a safe message when the response is not JSON.
    }
    throw new Error(detail);
  }
  return response.blob();
}

function stackFrames(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return '';
  return error.stack
    .split('\n')
    .slice(1)
    .filter((line) => /^\s*at\s|@/.test(line))
    .slice(0, 12)
    .join('\n')
    .slice(0, 1_500);
}

export async function reportClientError(
  error: unknown,
  source: string,
  options: { suppressErrors?: boolean } = {}
): Promise<void> {
  const suppressErrors = options.suppressErrors ?? true;
  if (!usesFastApi() || !isOnline() || !authState.currentUser?.accessToken) return;
  const name = error instanceof Error ? error.name : 'UnknownError';
  try {
    await apiRequest<{ accepted: boolean }>('/client-errors', {
      method: 'POST',
      body: JSON.stringify({
        name: name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'Error',
        source: source.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64),
        route: window.location.pathname.slice(0, 200),
        stackFrames: stackFrames(error)
      })
    });
  } catch (reportError) {
    if (!suppressErrors)
      throw reportError;
    // Error reporting must never interrupt the user's current task.
  }
}

export async function getChildrenPage(request: ChildrenPageRequest): Promise<ChildrenPageResponse> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  const result = await graphQlRequest<{ childrenPage: ChildrenPageResponse }>(`
    query ChildrenPage(
      $asOf: String!
      $measurementStart: String!
      $measurementEnd: String!
      $page: Int!
      $size: Int!
      $sort: String!
      $view: String!
      $search: String
      $village: String
      $posyandu: String
    ) {
      childrenPage(
        asOf: $asOf
        measurementStart: $measurementStart
        measurementEnd: $measurementEnd
        page: $page
        size: $size
        sort: $sort
        view: $view
        search: $search
        village: $village
        posyandu: $posyandu
      )
    }
  `, {
    asOf: request.asOf,
    measurementEnd: request.measurementEnd,
    measurementStart: request.measurementStart,
    page: request.page,
    size: request.size || 10,
    sort: request.sort,
    view: request.view || 'data',
    search: request.search?.trim() || null,
    village: request.village?.trim() || null,
    posyandu: request.posyandu?.trim() || null
  });
  const response = result.childrenPage;
  const now = new Date().toISOString();
  await Promise.all([
    cacheRemoteDocuments('children', response.items.map((item) => ({
      id: item.id,
      data: item.data,
      createdAt: typeof item.data.createdAt === 'string' ? item.data.createdAt : now,
      updatedAt: typeof item.data.updatedAt === 'string' ? item.data.updatedAt : now
    }))),
    cacheRemoteDocuments('measurements', response.measurements.map((item) => ({
      id: item.id,
      data: item.data,
      createdAt: typeof item.data.createdAt === 'string' ? item.data.createdAt : now,
      updatedAt: typeof item.data.updatedAt === 'string' ? item.data.updatedAt : now
    })))
  ]);

  const pendingChildren = new Map(
    (await getCachedDocumentsByIds('children', response.items.map((item) => item.id)))
      .filter((document) => document.pending)
      .map((document) => [document.id, document])
  );
  const visibleItems = response.items.flatMap((item) => {
    const pending = pendingChildren.get(item.id);
    if (!pending) return [item];

    const hiddenByPendingMutation = pending.deleted || (
      request.view === 'recycle'
        ? !pending.data.deletedAt
        : Boolean(pending.data.deletedAt)
    );
    if (hiddenByPendingMutation) return [];
    return [{ id: item.id, data: { ...item.data, ...pending.data } }];
  });
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  const hiddenCount = response.items.length - visibleItems.length;

  return {
    ...response,
    items: visibleItems,
    measurements: response.measurements.filter((item) => visibleIds.has(String(item.data.childId || ''))),
    mpasiLogs: response.mpasiLogs?.filter((item) => visibleIds.has(String(item.data.childId || ''))),
    total: Math.max(0, response.total - hiddenCount)
  };
}

export async function getExclusiveBreastfeedingPage(
  request: ExclusiveBreastfeedingPageRequest
): Promise<ExclusiveBreastfeedingPageResponse> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  const result = await graphQlRequest<{ exclusiveBreastfeedingPage: ExclusiveBreastfeedingPageResponse }>(`
    query ExclusiveBreastfeedingPage(
      $measurementStart: String!
      $measurementEnd: String!
      $ageGroup: String!
      $page: Int!
      $size: Int!
      $village: String
      $posyandu: String
    ) {
      exclusiveBreastfeedingPage(
        measurementStart: $measurementStart
        measurementEnd: $measurementEnd
        ageGroup: $ageGroup
        page: $page
        size: $size
        village: $village
        posyandu: $posyandu
      )
    }
  `, {
    ageGroup: request.ageGroup,
    measurementEnd: request.measurementEnd,
    measurementStart: request.measurementStart,
    page: request.page,
    size: request.size || 10,
    village: request.village?.trim() || null,
    posyandu: request.posyandu?.trim() || null
  });
  return result.exclusiveBreastfeedingPage;
}

export async function getChildDetail(id: string): Promise<ApiDocument> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  const document = await apiRequest<ApiDocument>(`/collections/children/${encodeURIComponent(id)}`);
  return { ...document, data: hydrateForRead(document.data) };
}

export async function getDashboardStats(request: DashboardStatsRequest): Promise<DashboardStatsResponse> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  const data = await graphQlRequest<{ dashboardStats: DashboardStatsResponse }>(`
    query DashboardStats(
      $monthStart: String!
      $monthEnd: String!
      $previousMonthStart: String!
      $previousMonthEnd: String!
      $village: String
      $posyandu: String
    ) {
      dashboardStats(
        monthStart: $monthStart
        monthEnd: $monthEnd
        previousMonthStart: $previousMonthStart
        previousMonthEnd: $previousMonthEnd
        village: $village
        posyandu: $posyandu
      )
    }
  `, {
    ...request,
    village: request.village?.trim() || null,
    posyandu: request.posyandu?.trim() || null
  });
  return data.dashboardStats;
}

export async function getSigiziMeasurementExport(
  request: SigiziMeasurementExportRequest
): Promise<SigiziMeasurementExportResponse> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  const parameters = new URLSearchParams({
    monthEnd: request.monthEnd,
    monthStart: request.monthStart
  });
  if (request.village?.trim()) parameters.set('village', request.village.trim());
  if (request.posyandu?.trim()) parameters.set('posyandu', request.posyandu.trim());
  return apiRequest<SigiziMeasurementExportResponse>(`/exports/sigizi-measurements?${parameters.toString()}`);
}

function compareCachedChildren(left: ApiDocument, right: ApiDocument, sort: string) {
  const leftData = left.data;
  const rightData = right.data;
  const comparable = (value: unknown) => {
    if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
      return ((value as { toDate: () => Date }).toDate()).toISOString();
    }
    return String(value || '');
  };
  const byText = (a: unknown, b: unknown) => comparable(a).localeCompare(comparable(b), 'id');

  switch (sort) {
    case 'oldest_input': return byText(leftData.createdAt, rightData.createdAt) || byText(left.id, right.id);
    case 'name_asc': return byText(leftData.nama, rightData.nama) || byText(left.id, right.id);
    case 'name_desc': return byText(rightData.nama, leftData.nama) || byText(left.id, right.id);
    case 'age_oldest': return byText(leftData.tglLahir, rightData.tglLahir) || byText(left.id, right.id);
    case 'age_youngest': return byText(rightData.tglLahir, leftData.tglLahir) || byText(left.id, right.id);
    default: return byText(rightData.createdAt, leftData.createdAt) || byText(right.id, left.id);
  }
}

export async function getCachedChildrenPage(request: ChildrenPageRequest): Promise<ChildrenPageResponse> {
  const asOf = request.asOf;
  const parsedAsOf = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(parsedAsOf.getTime())) throw new Error('Periode data balita tidak valid.');
  parsedAsOf.setUTCMonth(parsedAsOf.getUTCMonth() - 60);
  const cutoff = parsedAsOf.toISOString().slice(0, 10);
  const search = request.search?.trim().toLocaleLowerCase('id') || '';
  const children = (await getCachedDocuments('children'))
    .filter((document) => {
      const data = document.data;
      const birthDate = String(data.tglLahir || '');
      if (document.deleted || data.deletedAt || birthDate <= cutoff || birthDate > asOf) return false;
      if (request.village && data.desa !== request.village) return false;
      if (request.posyandu && data.posyandu !== request.posyandu) return false;
      if (!search) return true;
      return String(data.nama || '').toLocaleLowerCase('id').includes(search) || String(data.nik || '').includes(search);
    })
    .map((document) => ({ id: document.id, data: hydrateForRead(document.data) }));
  children.sort((left, right) => compareCachedChildren(left, right, request.sort));

  const total = children.length;
  const size = Math.min(Math.max(request.size || 10, 1), 50);
  const offset = (Math.max(request.page, 1) - 1) * size;
  const items = children.slice(offset, offset + size);
  const childIds = new Set(items.map((item) => item.id));
  const measurements = (await getCachedDocuments('measurements'))
    .filter((document) => {
      const data = document.data;
      return !document.deleted && childIds.has(String(data.childId || '')) && data.tglUkur >= request.measurementStart && data.tglUkur <= request.measurementEnd;
    })
    .map((document) => ({ id: document.id, data: hydrateForRead(document.data) }))
    .sort((left, right) => {
      const dateCompare = String(right.data.tglUkur || '').localeCompare(String(left.data.tglUkur || ''));
      const createdAt = (value: unknown) => value && typeof (value as { toDate?: unknown }).toDate === 'function'
        ? (value as { toDate: () => Date }).toDate().toISOString()
        : String(value || '');
      return dateCompare || createdAt(right.data.createdAt).localeCompare(createdAt(left.data.createdAt));
    });
  const latestMeasurements = new Map<string, ApiDocument>();
  measurements.forEach((measurement) => {
    const childId = String(measurement.data.childId || '');
    if (childId && !latestMeasurements.has(childId)) latestMeasurements.set(childId, measurement);
  });

  return { items, measurements: Array.from(latestMeasurements.values()), total };
}

async function legacySupabaseRequest<T>(url: URL, init: RequestInit = {}): Promise<T> {
  if (!LEGACY_SUPABASE_URL || !LEGACY_SUPABASE_ANON_KEY) {
    throw new Error('VITE_API_URL atau konfigurasi Supabase lama belum tersedia.');
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: LEGACY_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${LEGACY_SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    let detail = `Permintaan Supabase gagal (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.message === 'string') detail = body.message;
    } catch {
      // Keep the HTTP status message when the server cannot return JSON.
    }
    throw new Error(detail);
  }

  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

function matchesQuery(data: DocumentData, ref: QueryRef) {
  return ref.constraints.every((constraint) => {
    if (constraint.kind !== 'where') return true;
    const value = String(data[constraint.field] ?? '');
    const target = String(constraint.value);
    if (constraint.op === '==') return value === target;
    if (constraint.op === '>=') return value >= target;
    return value <= target;
  });
}

function sortSnapshots(ref: QueryRef, snapshots: Array<QueryDocumentSnapshot<DocumentData>>) {
  const orderConstraints = ref.constraints.filter((constraint): constraint is OrderByConstraint => constraint.kind === 'orderBy');
  if (orderConstraints.length === 0) return snapshots;

  return [...snapshots].sort((left, right) => {
    for (const constraint of orderConstraints) {
      const leftValue = String(left.data()[constraint.field] ?? '');
      const rightValue = String(right.data()[constraint.field] ?? '');
      if (leftValue === rightValue) continue;
      const comparison = leftValue.localeCompare(rightValue);
      return constraint.direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}

async function readCachedQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  const documents = await getCachedDocuments(ref.tableName);
  const snapshots = documents
    .filter((document) => !document.deleted && matchesQuery(document.data, ref))
    .map((document) => makeDocSnapshot(document.id, hydrateForRead(document.data)));
  return { docs: sortSnapshots(ref, snapshots) };
}

async function mergePendingDocuments(
  ref: QueryRef,
  remoteDocuments: Array<QueryDocumentSnapshot<DocumentData>>
): Promise<QuerySnapshot<DocumentData>> {
  const byId = new Map(remoteDocuments.map((document) => [document.id, document]));
  const cachedDocuments = await getCachedDocuments(ref.tableName);

  cachedDocuments.filter((document) => document.pending).forEach((document) => {
    if (document.deleted || !matchesQuery(document.data, ref)) {
      byId.delete(document.id);
      return;
    }
    byId.set(document.id, makeDocSnapshot(document.id, hydrateForRead(document.data)));
  });

  return { docs: sortSnapshots(ref, Array.from(byId.values())) };
}

async function executeFastApiQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  const params = new URLSearchParams();
  const syncState = readQuerySyncState(ref);
  const fullSync = needsFullSync(syncState);
  const syncStartedAt = new Date().toISOString();
  for (const constraint of ref.constraints) {
    if (constraint.kind === 'where') params.append('filter', `${constraint.field}|${constraint.op}|${String(constraint.value)}`);
    else params.append('order', `${constraint.field}|${constraint.direction}`);
  }
  let response: SyncChangeSet;
  if (!fullSync && syncState) {
    const synced = await apiRequest<SyncResponse>('/sync', {
      method: 'POST',
      body: JSON.stringify({
        mutations: [],
        pull: [{ resource: ref.tableName, since: syncState.lastSyncedAt }]
      })
    });
    response = synced.changes[ref.tableName] || { items: [], cursor: synced.cursor };
  } else {
    const suffix = params.size ? `?${params.toString()}` : '';
    response = await apiRequest<SyncChangeSet>(`/collections/${encodeURIComponent(ref.tableName)}${suffix}`);
  }
  const cacheEntries = response.items.map((document) => ({
    id: document.id,
    data: document.data,
    createdAt: typeof document.data.createdAt === 'string' ? document.data.createdAt : new Date().toISOString(),
    updatedAt: typeof document.data.updatedAt === 'string' ? document.data.updatedAt : new Date().toISOString()
  }));
  await cacheRemoteDocuments(ref.tableName, cacheEntries);
  await Promise.all((response.deletedIds || []).map((id) => removeCachedDocument(ref.tableName, id)));
  if (fullSync) {
    const remoteIds = new Set(cacheEntries.map((document) => document.id));
    const cachedDocuments = await getCachedDocuments(ref.tableName);
    await Promise.all(
      cachedDocuments
        .filter((document) => !document.pending && matchesQuery(document.data, ref) && !remoteIds.has(document.id))
        .map((document) => removeCachedDocument(ref.tableName, document.id))
    );
  }
  const cursor = response.cursor || syncStartedAt;
  saveQuerySyncState(ref, {
    lastSyncedAt: cursor,
    lastFullSyncAt: fullSync ? cursor : syncState?.lastFullSyncAt || cursor
  });
  return readCachedQuery(ref);
}

async function executeLegacySupabaseQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  const cacheEntries: Array<{ id: string; data: DocumentData; createdAt: string; updatedAt: string }> = [];
  const syncState = readQuerySyncState(ref);
  const fullSync = needsFullSync(syncState);
  const syncStartedAt = new Date().toISOString();
  let offset = 0;

  while (true) {
    const url = new URL(`${LEGACY_SUPABASE_URL}/rest/v1/documents`);
    url.searchParams.set('select', 'id,data,created_at,updated_at');
    url.searchParams.append('table_name', `eq.${ref.tableName}`);
    if (!fullSync && syncState) url.searchParams.append('updated_at', `gt.${syncState.lastSyncedAt}`);

    for (const constraint of ref.constraints) {
      if (constraint.kind === 'where') {
        const operator = constraint.op === '==' ? 'eq' : constraint.op === '>=' ? 'gte' : 'lte';
        url.searchParams.append(`data->>${constraint.field}`, `${operator}.${String(constraint.value)}`);
      }
    }

    const orderConstraints = ref.constraints.filter((constraint): constraint is OrderByConstraint => constraint.kind === 'orderBy');
    if (orderConstraints.length > 0) {
      url.searchParams.set(
        'order',
        orderConstraints.map((constraint) => `data->>${constraint.field}.${constraint.direction}`).join(',')
      );
    }

    const rows = await legacySupabaseRequest<LegacyDocument[]>(url, {
      headers: { Range: `${offset}-${offset + 999}` }
    });
    for (const row of rows) {
      cacheEntries.push({
        id: row.id,
        data: row.data || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }

    if (rows.length < 1000) break;
    offset += 1000;
  }

  await cacheRemoteDocuments(ref.tableName, cacheEntries);
  if (fullSync) {
    const remoteIds = new Set(cacheEntries.map((document) => document.id));
    const cachedDocuments = await getCachedDocuments(ref.tableName);
    await Promise.all(
      cachedDocuments
        .filter((document) => !document.pending && matchesQuery(document.data, ref) && !remoteIds.has(document.id))
        .map((document) => removeCachedDocument(ref.tableName, document.id))
    );
  }

  saveQuerySyncState(ref, {
    lastSyncedAt: syncStartedAt,
    lastFullSyncAt: fullSync ? syncStartedAt : syncState?.lastFullSyncAt || syncStartedAt
  });
  return readCachedQuery(ref);
}

async function executeRemoteQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  return usesFastApi() ? executeFastApiQuery(ref) : executeLegacySupabaseQuery(ref);
}

async function executeRemoteQueryWithFallback(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  if (!isOnline()) return readCachedQuery(ref);
  try {
    return await executeRemoteQuery(ref);
  } catch (error) {
    if (isNetworkError(error)) return readCachedQuery(ref);
    throw error;
  }
}

function queryParameters(ref: QueryRef) {
  const parameters = new URLSearchParams();
  ref.constraints.forEach((constraint) => {
    if (constraint.kind === 'where') parameters.append('filter', `${constraint.field}|${constraint.op}|${String(constraint.value)}`);
    else parameters.append('order', `${constraint.field}|${constraint.direction}`);
  });
  return parameters;
}

async function fetchFastApiExport(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  const parameters = queryParameters(ref);
  const documents: Array<QueryDocumentSnapshot<DocumentData>> = [];
  const pageSize = 500;
  let page = 1;

  // Halaman aplikasi tidak pernah memakai jalur ini. Data lengkap dibaca
  // bertahap hanya setelah pengguna benar-benar meminta sebuah ekspor.
  while (true) {
    parameters.set('export', '1');
    parameters.set('page', String(page));
    parameters.set('size', String(pageSize));
    const suffix = parameters.size ? `?${parameters.toString()}` : '';
    const response = await apiRequest<{ items: ApiDocument[]; hasMore?: boolean }>(
      `/collections/${encodeURIComponent(ref.tableName)}${suffix}`
    );
    documents.push(...response.items.map((item) => makeDocSnapshot(item.id, hydrateForRead(item.data))));
    if (!response.hasMore) break;
    page += 1;
  }
  return mergePendingDocuments(ref, documents);
}

async function fetchLegacyExport(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  const documents: Array<QueryDocumentSnapshot<DocumentData>> = [];
  let offset = 0;

  while (true) {
    const url = new URL(`${LEGACY_SUPABASE_URL}/rest/v1/documents`);
    url.searchParams.set('select', 'id,data');
    url.searchParams.append('table_name', `eq.${ref.tableName}`);
    ref.constraints.forEach((constraint) => {
      if (constraint.kind !== 'where') return;
      const operator = constraint.op === '==' ? 'eq' : constraint.op === '>=' ? 'gte' : 'lte';
      url.searchParams.append(`data->>${constraint.field}`, `${operator}.${String(constraint.value)}`);
    });
    const rows = await legacySupabaseRequest<Array<Pick<LegacyDocument, 'id' | 'data'>>>(url, {
      headers: { Range: `${offset}-${offset + 999}` }
    });
    rows.forEach((row) => documents.push(makeDocSnapshot(row.id, hydrateForRead(row.data || {}))));
    if (rows.length < 1000) break;
    offset += 1000;
  }

  return mergePendingDocuments(ref, documents);
}

// Exports are the deliberate exception to the light page-loading policy: they
// fetch every matching record only after the user asks to generate a file.
export async function getDocsForExport(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  if (!isOnline()) return readCachedQuery(ref);
  try {
    return usesFastApi() ? await fetchFastApiExport(ref) : await fetchLegacyExport(ref);
  } catch (error) {
    if (isNetworkError(error)) return readCachedQuery(ref);
    throw error;
  }
}

function notifySyncState() {
  const syncing = activeSyncOperations > 0;
  syncStateListeners.forEach((listener) => listener(syncing));
}

async function runOnlineOperation<T>(operation: () => Promise<T>): Promise<T> {
  activeSyncOperations += 1;
  notifySyncState();
  try {
    return await operation();
  } finally {
    activeSyncOperations -= 1;
    notifySyncState();
  }
}

export function isSyncing() {
  return activeSyncOperations > 0;
}

export function subscribeToSyncState(listener: (syncing: boolean) => void): () => void {
  syncStateListeners.add(listener);
  listener(isSyncing());
  return () => syncStateListeners.delete(listener);
}

export function initializeApp(config: FirebaseAppCompat): FirebaseAppCompat {
  return config;
}

export function getAuth(_app?: FirebaseAppCompat): Auth {
  return authState;
}

export async function restoreAuthSession(auth: Auth): Promise<AuthUser | null> {
  const session = readStoredSession();
  auth.currentUser = session;
  if (session) notifyAuthListeners();
  return session;
}

export async function signInWithPassword(
  auth: Auth,
  username: string,
  password: string,
  turnstileToken?: string
): Promise<{ session: AuthUser; profile: AccessProfile | null }> {
  const response = await usernameLoginRequest(username, password, turnstileToken);
  const nextSession = sessionFromResponse(response);
  if (auth.currentUser && auth.currentUser.uid !== nextSession.uid) {
    await clearOfflineStore();
    clearSyncState();
  }
  auth.currentUser = nextSession;
  saveSession(nextSession);
  notifyAuthListeners();
  return { session: nextSession, profile: response.profile || null };
}

export async function getCurrentAccessProfile(): Promise<AccessProfile> {
  if (!usesFastApi()) throw new Error('Alamat API aplikasi belum diatur.');
  return apiRequest<AccessProfile>('/me');
}

export async function signInAnonymously(auth: Auth): Promise<void> {
  if (auth.currentUser) return;
  auth.currentUser = { uid: `anon-${createId()}`, email: null };
  notifyAuthListeners();
}

export function onAuthStateChanged(
  auth: Auth,
  callback: (user: AuthUser | null) => void
): () => void {
  authListeners.add(callback);
  callback(auth.currentUser);
  return () => authListeners.delete(callback);
}

export async function signOut(auth: Auth): Promise<void> {
  const pending = await getPendingMutations();
  if (pending.length > 0) throw new Error('Masih ada data offline yang belum tersinkron. Sambungkan internet sebelum keluar.');

  const accessToken = auth.currentUser?.accessToken;
  if (accessToken && isOnline() && LEGACY_SUPABASE_URL && LEGACY_SUPABASE_ANON_KEY) {
    try {
      await fetch(`${LEGACY_SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: LEGACY_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`
        }
      });
    } catch {
      // Local logout still protects this device when Auth cannot be reached.
    }
  }
  auth.currentUser = null;
  saveSession(null);
  await clearOfflineStore();
  clearSyncState();
  notifyAuthListeners();
}

export function getFirestore(_app?: FirebaseAppCompat): Firestore {
  return { kind: 'firestore' };
}

export function collection(_db: Firestore, ...pathParts: string[]): CollectionRef {
  return { kind: 'collection', tableName: ensureCollectionName(pathParts) };
}

export function doc(_db: Firestore, ...pathParts: string[]): DocRef {
  if (pathParts.length < 2) throw new Error('Path doc tidak valid.');
  return { kind: 'doc', tableName: pathParts[pathParts.length - 2], id: pathParts[pathParts.length - 1] };
}

export function where(field: string, op: WhereOp, value: any): WhereConstraint {
  return { kind: 'where', field, op, value };
}

export function orderBy(field: string, direction: OrderDirection = 'asc'): OrderByConstraint {
  return { kind: 'orderBy', field, direction };
}

export function query(base: CollectionRef, ...constraints: QueryConstraint[]): QueryRef {
  return { kind: 'query', tableName: base.tableName, constraints };
}

export function serverTimestamp(): { __serverTimestamp: true } {
  return { __serverTimestamp: true };
}

async function applyPendingMutation(mutation: PendingMutation): Promise<void> {
  if (!usesFastApi()) {
    await applyLegacySupabaseMutation(mutation);
    return;
  }

  const collectionPath = `/collections/${encodeURIComponent(mutation.tableName)}`;
  const mutationHeaders = { 'Idempotency-Key': mutation.id };
  if (mutation.type === 'add') {
    const created = await apiRequest<ApiDocument>(collectionPath, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ id: mutation.documentId, data: mutation.payload?.data || {} })
    });
    const now = new Date().toISOString();
    await cacheRemoteDocuments(mutation.tableName, [{
      id: created.id,
      data: created.data,
      createdAt: typeof created.data.createdAt === 'string' ? created.data.createdAt : mutation.queuedAt,
      updatedAt: typeof created.data.updatedAt === 'string' ? created.data.updatedAt : now
    }]);
    return;
  }
  if (mutation.type === 'update') {
    const envelope = mutation.payload?.data && (
      Object.prototype.hasOwnProperty.call(mutation.payload, 'expectedVersion') ||
      Object.prototype.hasOwnProperty.call(mutation.payload, 'expectedUpdatedAt')
    )
      ? mutation.payload
      : { data: mutation.payload || {} };
    const updated = await apiRequest<ApiDocument>(`${collectionPath}/${encodeURIComponent(mutation.documentId)}`, {
      method: 'PATCH',
      headers: mutationHeaders,
      body: JSON.stringify(envelope)
    });
    const now = new Date().toISOString();
    await cacheRemoteDocuments(mutation.tableName, [{
      id: updated.id,
      data: updated.data,
      createdAt: typeof updated.data.createdAt === 'string' ? updated.data.createdAt : now,
      updatedAt: typeof updated.data.updatedAt === 'string' ? updated.data.updatedAt : now
    }]);
    return;
  }
  await apiRequest(`${collectionPath}/${encodeURIComponent(mutation.documentId)}`, {
    method: 'DELETE',
    headers: mutationHeaders,
    body: JSON.stringify({
      expectedVersion: mutation.payload?.expectedVersion,
      expectedUpdatedAt: mutation.payload?.expectedUpdatedAt
    })
  });
}

async function applyLegacySupabaseMutation(mutation: PendingMutation): Promise<void> {
  const endpoint = new URL(`${LEGACY_SUPABASE_URL}/rest/v1/documents`);

  if (mutation.type === 'delete') {
    endpoint.searchParams.append('table_name', `eq.${mutation.tableName}`);
    endpoint.searchParams.append('id', `eq.${mutation.documentId}`);
    await legacySupabaseRequest(endpoint, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return;
  }

  let data: DocumentData;
  let createdAt: string;
  if (mutation.type === 'add') {
    data = mutation.payload?.data || {};
    createdAt = mutation.payload?.createdAt || mutation.queuedAt;
  } else {
    const existingUrl = new URL(endpoint);
    existingUrl.searchParams.set('select', 'data,created_at');
    existingUrl.searchParams.append('table_name', `eq.${mutation.tableName}`);
    existingUrl.searchParams.append('id', `eq.${mutation.documentId}`);
    existingUrl.searchParams.set('limit', '1');
    const [existing] = await legacySupabaseRequest<Array<{ data: DocumentData; created_at: string }>>(existingUrl);
    data = { ...(existing?.data || {}), ...(mutation.payload || {}) };
    createdAt = existing?.created_at || mutation.queuedAt;
  }

  endpoint.searchParams.set('on_conflict', 'table_name,id');
  await legacySupabaseRequest(endpoint, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      table_name: mutation.tableName,
      id: mutation.documentId,
      data,
      created_at: createdAt,
      updated_at: new Date().toISOString()
    })
  });
}

type SyncRunResult = {
  errors: Map<string, Error>;
  syncedCount: number;
};

let syncPromise: Promise<SyncRunResult> | null = null;
const syncedMutationListeners = new Set<() => void>();

export function subscribeToSyncedMutations(listener: () => void): () => void {
  syncedMutationListeners.add(listener);
  return () => syncedMutationListeners.delete(listener);
}

export async function listSyncConflicts(): Promise<SyncConflict[]> {
  return getSyncConflicts();
}

export function subscribeToSyncConflicts(listener: () => void): () => void {
  return subscribeToOfflineStore(listener);
}

export async function resolveSyncConflict(
  conflictId: string,
  resolution: 'keep-local' | 'accept-server'
): Promise<void> {
  const conflict = (await getSyncConflicts()).find((item) => item.id === conflictId);
  const mutation = (await getPendingMutations()).find((item) => item.id === conflict?.mutationId);
  if (!conflict || !mutation) {
    await removeSyncConflict(conflictId);
    return;
  }

  const serverDocument = conflict.serverDocument;
  if (resolution === 'accept-server') {
    await completeMutation(mutation);
    if (serverDocument) {
      const now = new Date().toISOString();
      await putCachedDocument(makeCachedDocument(
        conflict.tableName,
        conflict.documentId,
        serverDocument.data,
        typeof serverDocument.data.createdAt === 'string' ? serverDocument.data.createdAt : now,
        typeof serverDocument.data.updatedAt === 'string' ? serverDocument.data.updatedAt : now,
        false
      ));
    } else {
      await removeCachedDocument(conflict.tableName, conflict.documentId);
    }
    return;
  }

  if (!serverDocument) {
    throw new Error('Data terbaru dari server belum tersedia untuk menyelesaikan konflik.');
  }
  await updatePendingMutation({
    ...mutation,
    lastError: undefined,
    payload: {
      ...(mutation.payload || {}),
      baseData: baseDataForPatch(serverDocument.data, conflict.localData),
      expectedVersion: serverDocument.data.version,
      expectedUpdatedAt: serverDocument.data.updatedAt
    }
  });
  await removeSyncConflict(conflictId);
  requestSync();
}

function notifySyncedMutations() {
  syncedMutationListeners.forEach((listener) => listener());
}

function nextPendingMutation(mutations: PendingMutation[]): PendingMutation | undefined {
  const first = mutations[0];
  if (!first || first.type !== 'add' || first.tableName === 'children') return first;

  const childId = first.payload?.data?.childId;
  if (typeof childId !== 'string' || !childId) return first;

  return mutations.find(
    (candidate) =>
      candidate.type === 'add' && candidate.tableName === 'children' && candidate.documentId === childId
  ) || first;
}

function orderedPendingMutations(mutations: PendingMutation[]): PendingMutation[] {
  const remaining = [...mutations];
  const ordered: PendingMutation[] = [];
  while (remaining.length > 0) {
    const next = nextPendingMutation(remaining);
    if (!next) break;
    ordered.push(next);
    remaining.splice(remaining.findIndex((mutation) => mutation.id === next.id), 1);
  }
  return ordered;
}

function syncMutationPayload(mutation: PendingMutation) {
  if (mutation.type === 'add') {
    return {
      id: mutation.id,
      operation: mutation.type,
      resource: mutation.tableName,
      documentId: mutation.documentId,
      data: mutation.payload?.data || {}
    };
  }
  if (mutation.type === 'update') {
    const envelope = mutation.payload?.data && (
      Object.prototype.hasOwnProperty.call(mutation.payload, 'expectedVersion') ||
      Object.prototype.hasOwnProperty.call(mutation.payload, 'expectedUpdatedAt')
    )
      ? mutation.payload
      : { data: mutation.payload || {} };
    return {
      id: mutation.id,
      operation: mutation.type,
      resource: mutation.tableName,
      documentId: mutation.documentId,
      data: envelope.data,
      expectedVersion: envelope.expectedVersion,
      expectedUpdatedAt: envelope.expectedUpdatedAt
    };
  }
  return {
    id: mutation.id,
    operation: mutation.type,
    resource: mutation.tableName,
    documentId: mutation.documentId,
    expectedVersion: mutation.payload?.expectedVersion,
    expectedUpdatedAt: mutation.payload?.expectedUpdatedAt
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function baseDataForPatch(serverData: DocumentData, localData: DocumentData): DocumentData {
  return Object.fromEntries(Object.keys(localData).map((key) => [key, serverData[key]]));
}

async function rebaseNextMutation(
  completed: PendingMutation,
  serverDocument: ApiDocument
): Promise<void> {
  const next = (await getPendingMutations()).find(
    (mutation) =>
      mutation.id !== completed.id &&
      mutation.tableName === completed.tableName &&
      mutation.documentId === completed.documentId
  );
  if (!next) return;
  const localData = next.payload?.data || {};
  await updatePendingMutation({
    ...next,
    lastError: undefined,
    payload: {
      ...(next.payload || {}),
      baseData: baseDataForPatch(serverDocument.data, localData),
      expectedVersion: serverDocument.data.version,
      expectedUpdatedAt: serverDocument.data.updatedAt
    }
  });
}

async function handleSyncConflict(
  mutation: PendingMutation,
  result: SyncMutationResult
): Promise<'rebased' | 'stored'> {
  const serverDocument = result.conflict?.serverDocument;
  const localData = mutation.payload?.data || {};
  const baseData = mutation.payload?.baseData || {};
  if (mutation.type === 'update' && serverDocument) {
    const conflictingFields = Object.keys(localData).filter((key) => {
      const serverValue = serverDocument.data[key];
      return !valuesEqual(serverValue, baseData[key]) && !valuesEqual(serverValue, localData[key]);
    });
    if (conflictingFields.length === 0) {
      const merged = { ...serverDocument.data, ...localData };
      await updatePendingMutation({
        ...mutation,
        lastError: undefined,
        payload: {
          ...(mutation.payload || {}),
          baseData: baseDataForPatch(serverDocument.data, localData),
          expectedVersion: serverDocument.data.version,
          expectedUpdatedAt: serverDocument.data.updatedAt
        }
      });
      const now = new Date().toISOString();
      await putCachedDocument(makeCachedDocument(
        mutation.tableName,
        mutation.documentId,
        merged,
        typeof serverDocument.data.createdAt === 'string' ? serverDocument.data.createdAt : now,
        now,
        true
      ));
      await removeSyncConflict(mutation.id);
      return 'rebased';
    }
  }

  const detail = result.error?.detail || 'Perubahan lokal bertabrakan dengan data terbaru di server.';
  const conflict: SyncConflict = {
    id: mutation.id,
    mutationId: mutation.id,
    tableName: mutation.tableName,
    documentId: mutation.documentId,
    operation: mutation.type,
    localData,
    baseData,
    serverDocument,
    detail,
    detectedAt: new Date().toISOString()
  };
  await recordSyncConflict(conflict);
  return 'stored';
}

function nextSyncBatch(pending: PendingMutation[], maximum = 25): PendingMutation[] {
  const documentKeys = new Set<string>();
  const batch: PendingMutation[] = [];
  for (const mutation of pending) {
    const key = `${mutation.tableName}:${mutation.documentId}`;
    if (documentKeys.has(key)) continue;
    documentKeys.add(key);
    batch.push(mutation);
    if (batch.length >= maximum) break;
  }
  return batch;
}

async function syncFastApiBatch(batch: PendingMutation[]): Promise<SyncRunResult> {
  const response = await apiRequest<SyncResponse>('/sync', {
    method: 'POST',
    body: JSON.stringify({ mutations: batch.map(syncMutationPayload), pull: [] })
  });
  const results = new Map(response.results.map((result) => [result.id, result]));
  if (results.size !== batch.length || batch.some((mutation) => !results.has(mutation.id))) {
    throw new Error('Respons sinkronisasi tidak lengkap. Data tetap disimpan untuk dicoba kembali.');
  }

  const errors = new Map<string, Error>();
  let syncedCount = 0;
  for (const mutation of batch) {
    const result = results.get(mutation.id);
    if (result?.error) {
      const error = new Error(result.error.detail || 'Perubahan data belum dapat disinkronkan.');
      if (result.error.status === 409) {
        const conflictOutcome = await handleSyncConflict(mutation, result);
        if (conflictOutcome === 'rebased') continue;
      }
      errors.set(mutation.id, error);
      await markMutationError(mutation, error);
      continue;
    }
    await completeMutation(mutation);
    syncedCount += 1;
    if (mutation.type !== 'delete' && result?.document?.id) {
      const document = result.document;
      await rebaseNextMutation(mutation, document);
      const now = new Date().toISOString();
      await cacheRemoteDocuments(mutation.tableName, [{
        id: document.id,
        data: document.data,
        createdAt: typeof document.data.createdAt === 'string' ? document.data.createdAt : now,
        updatedAt: typeof document.data.updatedAt === 'string' ? document.data.updatedAt : now
      }]);
    }
  }
  return { errors, syncedCount };
}

async function runPendingMutationSync(): Promise<SyncRunResult> {
  const errors = new Map<string, Error>();
  let syncedCount = 0;
  const attempted = new Set<string>();

  await runOnlineOperation(async () => {
    if (usesFastApi()) {
      while (true) {
        const pending = orderedPendingMutations(await getPendingMutations())
          .filter((mutation) => !attempted.has(mutation.id));
        if (pending.length === 0) break;
        const batch = nextSyncBatch(pending);
        batch.forEach((mutation) => attempted.add(mutation.id));
        try {
          const outcome = await syncFastApiBatch(batch);
          syncedCount += outcome.syncedCount;
          outcome.errors.forEach((error, id) => errors.set(id, error));
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          await Promise.all(batch.map((mutation) => markMutationError(mutation, normalizedError)));
          batch.forEach((mutation) => errors.set(mutation.id, normalizedError));
          break;
        }
      }
      return;
    }

    while (true) {
      const mutation = nextPendingMutation(
        (await getPendingMutations()).filter((entry) => !attempted.has(entry.id))
      );
      if (!mutation) break;
      attempted.add(mutation.id);
      try {
        await applyPendingMutation(mutation);
        await completeMutation(mutation);
        syncedCount += 1;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        await markMutationError(mutation, normalizedError);
        errors.set(mutation.id, normalizedError);
      }
    }
  });

  if (syncedCount > 0) notifySyncedMutations();
  return { errors, syncedCount };
}

export async function syncPendingMutations(focusMutationIds: string[] = []): Promise<void> {
  if (!isOnline()) return;
  const focusedIds = new Set(focusMutationIds.filter(Boolean));
  const collectedErrors = new Map<string, Error>();

  while (true) {
    if (!syncPromise) {
      syncPromise = runPendingMutationSync().finally(() => {
        syncPromise = null;
      });
    }
    const outcome = await syncPromise;
    outcome.errors.forEach((error, id) => collectedErrors.set(id, error));

    if (focusedIds.size === 0) break;
    const pendingFocusedMutations = (await getPendingMutations())
      .filter((mutation) => focusedIds.has(mutation.id));
    const hasUnattemptedFocusedMutation = pendingFocusedMutations
      .some((mutation) => !collectedErrors.has(mutation.id));
    if (!hasUnattemptedFocusedMutation) break;
  }

  const relevantErrors = focusedIds.size > 0
    ? Array.from(collectedErrors).filter(([id]) => focusedIds.has(id))
    : Array.from(collectedErrors);
  if (relevantErrors.length > 0) throw relevantErrors[0][1];
}

function requestSync() {
  if (isOnline()) void syncPendingMutations().catch(() => {
    // The queued mutation remains available and is retried by the next online action.
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', requestSync);
}

export async function syncActiveViewFromServer(): Promise<void> {
  if (!isOnline()) throw new Error('Perangkat sedang offline. Sambungkan internet untuk memperbarui data.');

  await runOnlineOperation(async () => {
    await syncPendingMutations();
    await Promise.all(Array.from(activeViewRefreshers, (refresh) => refresh()));
  });
}

export async function addDoc(ref: CollectionRef, payload: Record<string, any>): Promise<{ id: string; mutationId: string }> {
  const now = new Date().toISOString();
  const id = createId();
  const data = normalizeForWrite(payload);
  await putCachedDocument(makeCachedDocument(ref.tableName, id, data, now, now));
  const mutation = await queueMutation({ type: 'add', tableName: ref.tableName, documentId: id, payload: { data, createdAt: now } });
  requestSync();
  return { id, mutationId: mutation.id };
}

export async function getDocs(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  return readCachedQuery(ref);
}

export async function updateDoc(ref: DocRef, patch: Record<string, any>): Promise<{ mutationId: string }> {
  const now = new Date().toISOString();
  const normalizedPatch = normalizeForWrite(patch);
  const existing = await getCachedDocument(ref.tableName, ref.id);
  const expectedUpdatedAt = existing && !existing.pending ? existing.updatedAt : undefined;
  const cachedVersion = existing?.data?.version;
  const expectedVersion = existing && !existing.pending && Number.isSafeInteger(cachedVersion)
    ? cachedVersion
    : undefined;
  const baseData = Object.fromEntries(
    Object.keys(normalizedPatch).map((key) => [key, existing?.data?.[key]])
  );
  const merged = { ...(existing?.data || {}), ...normalizedPatch };
  await putCachedDocument(makeCachedDocument(ref.tableName, ref.id, merged, existing?.createdAt || now, now));
  const mutation = await queueMutation({
    type: 'update',
    tableName: ref.tableName,
    documentId: ref.id,
    payload: { data: normalizedPatch, baseData, expectedVersion, expectedUpdatedAt }
  });
  requestSync();
  return { mutationId: mutation.id };
}

export async function deleteDoc(ref: DocRef): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getCachedDocument(ref.tableName, ref.id);
  const cachedVersion = existing?.data?.version;
  const expectedVersion = existing && !existing.pending && Number.isSafeInteger(cachedVersion)
    ? cachedVersion
    : undefined;
  const expectedUpdatedAt = existing && !existing.pending ? existing.updatedAt : undefined;
  await putCachedDocument(makeCachedDocument(ref.tableName, ref.id, existing?.data || {}, existing?.createdAt || now, now, true, true));
  await queueMutation({
    type: 'delete',
    tableName: ref.tableName,
    documentId: ref.id,
    payload: { data: {}, baseData: existing?.data || {}, expectedVersion, expectedUpdatedAt }
  });
  requestSync();
}

export function onSnapshot(
  ref: QueryRef,
  onNext: (snapshot: QuerySnapshot<DocumentData>) => void,
  onError?: (error: Error) => void
): () => void {
  let active = true;
  let lastSignature = '';
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const pull = async (fromServer = false) => {
    try {
      const snapshot = fromServer ? await executeRemoteQueryWithFallback(ref) : await readCachedQuery(ref);
      const signature = JSON.stringify(snapshot.docs.map((item) => ({ id: item.id, data: item.data() })));
      if (signature !== lastSignature) {
        lastSignature = signature;
        if (active) onNext(snapshot);
      }
    } catch (error) {
      if (onError && active) onError(error as Error);
    }
  };

  const schedulePull = () => {
    if (!active || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void pull();
    }, 150);
  };

  void pull();
  const refreshFromServer = async () => {
    if (active) await pull(true);
  };
  activeViewRefreshers.add(refreshFromServer);
  const unsubscribeOfflineStore = subscribeToOfflineStore(schedulePull);

  return () => {
    active = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    activeViewRefreshers.delete(refreshFromServer);
    unsubscribeOfflineStore();
  };
}
