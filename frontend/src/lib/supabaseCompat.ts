import {
  cacheRemoteDocuments,
  completeMutation,
  getCachedDocument,
  getCachedDocuments,
  getPendingMutations,
  makeCachedDocument,
  markMutationError,
  PendingMutation,
  putCachedDocument,
  queueMutation,
  subscribeToOfflineStore
} from './offlineStore';

export type Auth = {
  currentUser: { uid: string } | null;
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

type ApiDocument = {
  id: string;
  data: DocumentData;
};

type LegacyDocument = {
  id: string;
  data: DocumentData;
  created_at: string;
  updated_at: string;
};

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const LEGACY_SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const LEGACY_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const REMOTE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REALTIME_RECONNECT_DELAY_MS = 3_000;

const authState: Auth = { currentUser: null };
const authListeners = new Set<(user: { uid: string } | null) => void>();
const remoteChangeListeners = new Map<string, Set<() => void>>();
let realtimeSocket: WebSocket | null = null;
let realtimeReconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

function apiUrl(path: string): string {
  return `${API_BASE_URL}/api/v1${path}`;
}

function usesFastApi() {
  return Boolean(API_BASE_URL);
}

function realtimeUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const origin = API_BASE_URL || window.location.origin;
  const url = new URL(`${origin}/api/v1/realtime`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    }
  });

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
  for (const constraint of ref.constraints) {
    if (constraint.kind === 'where') params.append('filter', `${constraint.field}|${constraint.op}|${String(constraint.value)}`);
    else params.append('order', `${constraint.field}|${constraint.direction}`);
  }
  const suffix = params.size ? `?${params.toString()}` : '';
  const response = await apiRequest<{ items: ApiDocument[] }>(`/collections/${encodeURIComponent(ref.tableName)}${suffix}`);
  const cacheEntries = response.items.map((document) => ({
    id: document.id,
    data: document.data,
    createdAt: typeof document.data.createdAt === 'string' ? document.data.createdAt : new Date().toISOString(),
    updatedAt: typeof document.data.updatedAt === 'string' ? document.data.updatedAt : new Date().toISOString()
  }));
  await cacheRemoteDocuments(ref.tableName, cacheEntries);
  return mergePendingDocuments(
    ref,
    response.items.map((document) => makeDocSnapshot(document.id, hydrateForRead(document.data)))
  );
}

async function executeLegacySupabaseQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  const documents: Array<QueryDocumentSnapshot<DocumentData>> = [];
  const cacheEntries: Array<{ id: string; data: DocumentData; createdAt: string; updatedAt: string }> = [];
  let offset = 0;

  while (true) {
    const url = new URL(`${LEGACY_SUPABASE_URL}/rest/v1/documents`);
    url.searchParams.set('select', 'id,data,created_at,updated_at');
    url.searchParams.append('table_name', `eq.${ref.tableName}`);

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
      documents.push(makeDocSnapshot(row.id, hydrateForRead(row.data || {})));
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
  return mergePendingDocuments(ref, documents);
}

async function executeRemoteQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  return usesFastApi() ? executeFastApiQuery(ref) : executeLegacySupabaseQuery(ref);
}

async function executeQuery(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  if (!isOnline()) return readCachedQuery(ref);
  try {
    return await executeRemoteQuery(ref);
  } catch (error) {
    if (isNetworkError(error)) return readCachedQuery(ref);
    throw error;
  }
}

function notifyRemoteChange(tableName: string) {
  for (const listener of remoteChangeListeners.get(tableName) || []) listener();
}

function scheduleRealtimeReconnect() {
  if (realtimeReconnectTimer || remoteChangeListeners.size === 0 || !isOnline()) return;
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    ensureRealtimeConnection();
  }, REALTIME_RECONNECT_DELAY_MS);
}

function ensureRealtimeConnection() {
  if (
    !usesFastApi() ||
    typeof WebSocket === 'undefined' ||
    !isOnline() ||
    remoteChangeListeners.size === 0 ||
    realtimeSocket?.readyState === WebSocket.OPEN ||
    realtimeSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  const url = realtimeUrl();
  if (!url) return;

  try {
    const socket = new WebSocket(url);
    realtimeSocket = socket;
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === 'document_changed' && typeof message.tableName === 'string') {
          notifyRemoteChange(message.tableName);
        }
      } catch {
        // Ignore malformed messages and keep the local fallback refresh active.
      }
    };
    socket.onclose = () => {
      if (realtimeSocket === socket) realtimeSocket = null;
      scheduleRealtimeReconnect();
    };
    socket.onerror = () => socket.close();
  } catch {
    scheduleRealtimeReconnect();
  }
}

function subscribeToRemoteChanges(tableName: string, listener: () => void): () => void {
  let listeners = remoteChangeListeners.get(tableName);
  if (!listeners) {
    listeners = new Set();
    remoteChangeListeners.set(tableName, listeners);
  }
  listeners.add(listener);
  ensureRealtimeConnection();

  return () => {
    const currentListeners = remoteChangeListeners.get(tableName);
    currentListeners?.delete(listener);
    if (currentListeners?.size === 0) remoteChangeListeners.delete(tableName);
    if (remoteChangeListeners.size === 0) {
      if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
      realtimeSocket?.close();
      realtimeSocket = null;
    }
  };
}

export function initializeApp(config: FirebaseAppCompat): FirebaseAppCompat {
  return config;
}

export function getAuth(_app?: FirebaseAppCompat): Auth {
  return authState;
}

export async function signInAnonymously(auth: Auth): Promise<void> {
  if (auth.currentUser) return;
  auth.currentUser = { uid: `anon-${createId()}` };
  for (const listener of authListeners) listener(auth.currentUser);
}

export function onAuthStateChanged(
  auth: Auth,
  callback: (user: { uid: string } | null) => void
): () => void {
  authListeners.add(callback);
  callback(auth.currentUser);
  return () => authListeners.delete(callback);
}

export async function signOut(auth: Auth): Promise<void> {
  auth.currentUser = null;
  for (const listener of authListeners) listener(null);
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
  if (mutation.type === 'add') {
    await apiRequest(collectionPath, {
      method: 'POST',
      body: JSON.stringify({ id: mutation.documentId, data: mutation.payload?.data || {} })
    });
    return;
  }
  if (mutation.type === 'update') {
    await apiRequest(`${collectionPath}/${encodeURIComponent(mutation.documentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: mutation.payload || {} })
    });
    return;
  }
  await apiRequest(`${collectionPath}/${encodeURIComponent(mutation.documentId)}`, { method: 'DELETE' });
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

let syncPromise: Promise<void> | null = null;

export async function syncPendingMutations(): Promise<void> {
  if (!isOnline()) return;
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    while (true) {
      const [mutation] = await getPendingMutations();
      if (!mutation) break;
      try {
        await applyPendingMutation(mutation);
        await completeMutation(mutation);
      } catch (error) {
        await markMutationError(mutation, error);
        break;
      }
    }
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

function requestSync() {
  if (isOnline()) void syncPendingMutations();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    ensureRealtimeConnection();
    void syncPendingMutations();
  });
  window.setInterval(() => {
    void syncPendingMutations();
  }, 30_000);
  void syncPendingMutations();
}

export async function addDoc(ref: CollectionRef, payload: Record<string, any>): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const id = createId();
  const data = normalizeForWrite(payload);
  await putCachedDocument(makeCachedDocument(ref.tableName, id, data, now, now));
  await queueMutation({ type: 'add', tableName: ref.tableName, documentId: id, payload: { data, createdAt: now } });
  requestSync();
  return { id };
}

export async function getDocs(ref: QueryRef): Promise<QuerySnapshot<DocumentData>> {
  return executeQuery(ref);
}

export async function updateDoc(ref: DocRef, patch: Record<string, any>): Promise<void> {
  const now = new Date().toISOString();
  const normalizedPatch = normalizeForWrite(patch);
  const existing = await getCachedDocument(ref.tableName, ref.id);
  const merged = { ...(existing?.data || {}), ...normalizedPatch };
  await putCachedDocument(makeCachedDocument(ref.tableName, ref.id, merged, existing?.createdAt || now, now));
  await queueMutation({ type: 'update', tableName: ref.tableName, documentId: ref.id, payload: normalizedPatch });
  requestSync();
}

export async function deleteDoc(ref: DocRef): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getCachedDocument(ref.tableName, ref.id);
  await putCachedDocument(makeCachedDocument(ref.tableName, ref.id, existing?.data || {}, existing?.createdAt || now, now, true, true));
  await queueMutation({ type: 'delete', tableName: ref.tableName, documentId: ref.id });
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

  const pull = async () => {
    try {
      const snapshot = await executeQuery(ref);
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
  const interval = setInterval(() => {
    if (isOnline() && (typeof document === 'undefined' || !document.hidden)) void pull();
  }, REMOTE_REFRESH_INTERVAL_MS);
  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && !document.hidden && isOnline()) schedulePull();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibilityChange);
  const unsubscribeOfflineStore = subscribeToOfflineStore(schedulePull);
  const unsubscribeRealtime = subscribeToRemoteChanges(ref.tableName, schedulePull);

  return () => {
    active = false;
    clearInterval(interval);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibilityChange);
    unsubscribeOfflineStore();
    unsubscribeRealtime();
  };
}
