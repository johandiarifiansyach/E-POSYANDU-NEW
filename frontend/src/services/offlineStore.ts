export type CachedDocument = {
  key: string;
  tableName: string;
  id: string;
  data: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  pending: boolean;
  deleted: boolean;
};

export type MutationType = 'add' | 'update' | 'delete';

export type PendingMutation = {
  id: string;
  type: MutationType;
  tableName: string;
  documentId: string;
  payload?: Record<string, any>;
  queuedAt: string;
  lastError?: string;
};

export type SyncConflict = {
  id: string;
  mutationId: string;
  tableName: string;
  documentId: string;
  operation: MutationType;
  localData: Record<string, any>;
  baseData: Record<string, any>;
  serverDocument?: { id: string; data: Record<string, any> };
  detail: string;
  detectedAt: string;
};

type EncryptedEnvelope = {
  key?: string;
  id?: string;
  ownerScope: string;
  tableName?: string;
  encrypted: true;
  encryptionVersion: 1;
  iv: string;
  ciphertext: string;
};

type RawOfflineStores = {
  documents: any[];
  mutations: any[];
  conflicts: any[];
};

const DATABASE_NAME = 'e-posyandu-offline';
const DATABASE_VERSION = 3;
const DOCUMENT_STORE = 'documents';
const MUTATION_STORE = 'mutations';
const CONFLICT_STORE = 'conflicts';
const OFFLINE_OWNER_SESSION_KEY = 'e-posyandu:offline-owner-v1';
const OFFLINE_ENCRYPTION_SESSION_KEY = 'e-posyandu:offline-key-v1';

let databasePromise: Promise<IDBDatabase> | null = null;
let activeOwnerId = '';
let activeOwnerScope = '';
let activeEncryptionKey: CryptoKey | null = null;
const memoryDocuments = new Map<string, CachedDocument>();
const memoryMutations = new Map<string, PendingMutation>();
const memoryConflicts = new Map<string, SyncConflict>();
const listeners = new Set<() => void>();
let lastQueuedAtMs = 0;

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function canEncryptPersistentData() {
  return canUseIndexedDb() && typeof crypto !== 'undefined' && Boolean(crypto.subtle) && typeof sessionStorage !== 'undefined';
}

function requireOfflineSession() {
  if (!activeOwnerId || !activeOwnerScope) throw new Error('Penyimpanan offline belum terikat ke sesi akun yang aktif.');
}

function documentKey(tableName: string, id: string) {
  requireOfflineSession();
  return `${activeOwnerScope}:document:${tableName}:${id}`;
}

function mutationStorageKey(id: string) {
  requireOfflineSession();
  return `${activeOwnerScope}:mutation:${id}`;
}

function conflictStorageKey(id: string) {
  requireOfflineSession();
  return `${activeOwnerScope}:conflict:${id}`;
}

function mutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `mutation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Operasi IndexedDB gagal.'));
  });
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[]) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

function getDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;
        if (!transaction) return;
        const documents = database.objectStoreNames.contains(DOCUMENT_STORE)
          ? transaction.objectStore(DOCUMENT_STORE)
          : database.createObjectStore(DOCUMENT_STORE, { keyPath: 'key' });
        ensureIndex(documents, 'tableName', 'tableName');
        ensureIndex(documents, 'ownerTable', ['ownerScope', 'tableName']);
        const mutations = database.objectStoreNames.contains(MUTATION_STORE)
          ? transaction.objectStore(MUTATION_STORE)
          : database.createObjectStore(MUTATION_STORE, { keyPath: 'id' });
        ensureIndex(mutations, 'queuedAt', 'queuedAt');
        ensureIndex(mutations, 'documentKey', ['tableName', 'documentId']);
        ensureIndex(mutations, 'ownerScope', 'ownerScope');
        const conflicts = database.objectStoreNames.contains(CONFLICT_STORE)
          ? transaction.objectStore(CONFLICT_STORE)
          : database.createObjectStore(CONFLICT_STORE, { keyPath: 'id' });
        ensureIndex(conflicts, 'detectedAt', 'detectedAt');
        ensureIndex(conflicts, 'documentKey', ['tableName', 'documentId']);
        ensureIndex(conflicts, 'ownerScope', 'ownerScope');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Tidak dapat membuka penyimpanan offline.'));
    });
  }
  return databasePromise;
}

async function runStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const database = await getDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result: T;
    let operationFinished = false;
    transaction.oncomplete = () => {
      if (operationFinished) resolve(result);
    };
    transaction.onerror = () => reject(transaction.error || new Error('Transaksi penyimpanan offline gagal.'));
    transaction.onabort = () => reject(transaction.error || new Error('Transaksi penyimpanan offline dibatalkan.'));
    void operation(store).then((value) => {
      result = value;
      operationFinished = true;
    }).catch((error) => {
      transaction.abort();
      reject(error);
    });
  });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function ownerScope(ownerId: string) {
  if (typeof crypto === 'undefined' || !crypto.subtle) return `memory-${ownerId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerId));
  return Array.from(new Uint8Array(digest).slice(0, 16)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function importEncryptionKey(rawKey: Uint8Array) {
  return crypto.subtle.importKey('raw', rawKey.slice().buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function sessionKeyMaterial(ownerId: string): Uint8Array | null {
  try {
    if (sessionStorage.getItem(OFFLINE_OWNER_SESSION_KEY) !== ownerId) return null;
    const encoded = sessionStorage.getItem(OFFLINE_ENCRYPTION_SESSION_KEY);
    if (!encoded) return null;
    const bytes = base64ToBytes(encoded);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function saveSessionKeyMaterial(ownerId: string, rawKey: Uint8Array) {
  sessionStorage.setItem(OFFLINE_OWNER_SESSION_KEY, ownerId);
  sessionStorage.setItem(OFFLINE_ENCRYPTION_SESSION_KEY, bytesToBase64(rawKey));
}

function clearSessionKeyMaterial() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(OFFLINE_OWNER_SESSION_KEY);
    sessionStorage.removeItem(OFFLINE_ENCRYPTION_SESSION_KEY);
  } catch {
    // The active in-memory key is still discarded by the caller.
  }
}

function isEncryptedEnvelope(value: any): value is EncryptedEnvelope {
  return Boolean(value && value.encrypted === true && value.encryptionVersion === 1 && typeof value.ownerScope === 'string' && typeof value.iv === 'string' && typeof value.ciphertext === 'string');
}

function envelopeStorageKey(envelope: EncryptedEnvelope) {
  return String(envelope.key || envelope.id || '');
}

async function encryptValue(storeName: string, storageKey: string, value: unknown) {
  if (!activeEncryptionKey) throw new Error('Kunci enkripsi cache offline belum tersedia.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`${storeName}:${storageKey}`);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, activeEncryptionKey, plaintext);
  return {
    encrypted: true as const,
    encryptionVersion: 1 as const,
    ownerScope: activeOwnerScope,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  };
}

async function decryptValue<T>(storeName: string, envelope: EncryptedEnvelope): Promise<T> {
  if (!activeEncryptionKey || envelope.ownerScope !== activeOwnerScope) throw new Error('Cache offline bukan milik sesi akun aktif.');
  const storageKey = envelopeStorageKey(envelope);
  const additionalData = new TextEncoder().encode(`${storeName}:${storageKey}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData },
    activeEncryptionKey,
    base64ToBytes(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function readRawOfflineStores(): Promise<RawOfflineStores> {
  if (!canUseIndexedDb()) return { documents: [], mutations: [], conflicts: [] };
  const database = await getDatabase();
  const readStore = (storeName: string) => new Promise<any[]>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('Cache offline tidak dapat diperiksa.'));
  });
  const [documents, mutations, conflicts] = await Promise.all([
    readStore(DOCUMENT_STORE), readStore(MUTATION_STORE), readStore(CONFLICT_STORE)
  ]);
  return { documents, mutations, conflicts };
}

function rawEntries(stores: RawOfflineStores) {
  return [...stores.documents, ...stores.mutations, ...stores.conflicts];
}

async function documentEnvelope(document: CachedDocument): Promise<EncryptedEnvelope> {
  const key = documentKey(document.tableName, document.id);
  return { key, tableName: document.tableName, ...(await encryptValue(DOCUMENT_STORE, key, { ...document, key })) };
}

async function mutationEnvelope(mutation: PendingMutation): Promise<EncryptedEnvelope> {
  const id = mutationStorageKey(mutation.id);
  return { id, ...(await encryptValue(MUTATION_STORE, id, mutation)) };
}

async function conflictEnvelope(conflict: SyncConflict): Promise<EncryptedEnvelope> {
  const id = conflictStorageKey(conflict.id);
  return { id, ...(await encryptValue(CONFLICT_STORE, id, conflict)) };
}

async function replaceRawStores(stores: RawOfflineStores) {
  const database = await getDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([DOCUMENT_STORE, MUTATION_STORE, CONFLICT_STORE], 'readwrite');
    const documents = transaction.objectStore(DOCUMENT_STORE);
    const mutations = transaction.objectStore(MUTATION_STORE);
    const conflicts = transaction.objectStore(CONFLICT_STORE);
    documents.clear();
    mutations.clear();
    conflicts.clear();
    stores.documents.forEach((entry) => documents.put(entry));
    stores.mutations.forEach((entry) => mutations.put(entry));
    stores.conflicts.forEach((entry) => conflicts.put(entry));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Migrasi cache terenkripsi gagal.'));
    transaction.onabort = () => reject(transaction.error || new Error('Migrasi cache terenkripsi dibatalkan.'));
  });
}

async function migrateLegacyStores(stores: RawOfflineStores) {
  const legacyDocuments = stores.documents.filter((entry) => !isEncryptedEnvelope(entry)) as CachedDocument[];
  const legacyMutations = stores.mutations.filter((entry) => !isEncryptedEnvelope(entry)) as PendingMutation[];
  const legacyConflicts = stores.conflicts.filter((entry) => !isEncryptedEnvelope(entry)) as SyncConflict[];
  await replaceRawStores({
    documents: await Promise.all(legacyDocuments.map((entry) => documentEnvelope(entry))),
    mutations: await Promise.all(legacyMutations.map((entry) => mutationEnvelope(entry))),
    conflicts: await Promise.all(legacyConflicts.map((entry) => conflictEnvelope(entry)))
  });
}

async function retainOnlyActiveOwner(stores: RawOfflineStores) {
  await replaceRawStores({
    documents: stores.documents.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope),
    mutations: stores.mutations.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope),
    conflicts: stores.conflicts.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope)
  });
}

export async function initializeOfflineStoreSession(
  ownerId: string,
  options: { forceReset?: boolean; allowLegacyMigration?: boolean } = {}
): Promise<void> {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) throw new Error('ID akun diperlukan untuk mengaktifkan cache offline.');
  memoryDocuments.clear();
  memoryMutations.clear();
  memoryConflicts.clear();
  activeOwnerId = normalizedOwnerId;
  activeOwnerScope = await ownerScope(normalizedOwnerId);
  activeEncryptionKey = null;

  if (!canEncryptPersistentData()) {
    await clearOfflineStore();
    clearSessionKeyMaterial();
    return;
  }

  let rawStores = await readRawOfflineStores();
  const entries = rawEntries(rawStores);
  const allEntriesAreLegacy = entries.length > 0 && entries.every((entry) => !isEncryptedEnvelope(entry));
  let rawKey = options.forceReset ? null : sessionKeyMaterial(normalizedOwnerId);
  if (options.forceReset || !rawKey) {
    if (!(options.allowLegacyMigration && allEntriesAreLegacy)) {
      await clearOfflineStore();
      rawStores = { documents: [], mutations: [], conflicts: [] };
    }
    rawKey = crypto.getRandomValues(new Uint8Array(32));
    saveSessionKeyMaterial(normalizedOwnerId, rawKey);
  }
  activeEncryptionKey = await importEncryptionKey(rawKey);
  if (options.allowLegacyMigration && allEntriesAreLegacy) await migrateLegacyStores(rawStores);
  else await retainOnlyActiveOwner(rawStores);
}

export async function resetOfflineStoreWithoutSession(): Promise<void> {
  await clearOfflineStore();
  clearSessionKeyMaterial();
  activeEncryptionKey = null;
  activeOwnerId = '';
  activeOwnerScope = '';
}

function encryptedPersistenceAvailable() {
  requireOfflineSession();
  return canEncryptPersistentData() && Boolean(activeEncryptionKey);
}

async function readAllDocumentsFromIdb(tableName: string): Promise<CachedDocument[]> {
  const raw = await runStore(DOCUMENT_STORE, 'readonly', async (store) => requestResult(store.getAll()) as Promise<any[]>);
  const envelopes = raw.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope && entry.tableName === tableName);
  const results = await Promise.all(envelopes.map(async (entry) => {
    try {
      return await decryptValue<CachedDocument>(DOCUMENT_STORE, entry);
    } catch {
      return null;
    }
  }));
  return results.filter((entry): entry is CachedDocument => Boolean(entry));
}

export function subscribeToOfflineStore(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getCachedDocuments(tableName: string): Promise<CachedDocument[]> {
  requireOfflineSession();
  if (!encryptedPersistenceAvailable()) return Array.from(memoryDocuments.values()).filter((document) => document.tableName === tableName);
  try {
    const documents = await readAllDocumentsFromIdb(tableName);
    documents.forEach((document) => memoryDocuments.set(document.key, document));
    return documents;
  } catch {
    return Array.from(memoryDocuments.values()).filter((document) => document.tableName === tableName);
  }
}

export async function getCachedDocument(tableName: string, id: string): Promise<CachedDocument | undefined> {
  const key = documentKey(tableName, id);
  if (!encryptedPersistenceAvailable()) return memoryDocuments.get(key);
  try {
    const raw = await runStore(DOCUMENT_STORE, 'readonly', async (store) => requestResult(store.get(key)) as Promise<any>);
    if (!isEncryptedEnvelope(raw) || raw.ownerScope !== activeOwnerScope) return undefined;
    const document = await decryptValue<CachedDocument>(DOCUMENT_STORE, raw);
    memoryDocuments.set(document.key, document);
    return document;
  } catch {
    return memoryDocuments.get(key);
  }
}

export async function getCachedDocumentsByIds(tableName: string, ids: string[]): Promise<CachedDocument[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  const keys = uniqueIds.map((id) => documentKey(tableName, id));
  if (!encryptedPersistenceAvailable()) return keys.flatMap((key) => memoryDocuments.get(key) ? [memoryDocuments.get(key)!] : []);
  try {
    const raw = await runStore(DOCUMENT_STORE, 'readonly', async (store) => Promise.all(keys.map((key) => requestResult(store.get(key)) as Promise<any>)));
    const documents = await Promise.all(raw.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope).map((entry) => decryptValue<CachedDocument>(DOCUMENT_STORE, entry)));
    documents.forEach((document) => memoryDocuments.set(document.key, document));
    return documents;
  } catch {
    return keys.flatMap((key) => memoryDocuments.get(key) ? [memoryDocuments.get(key)!] : []);
  }
}

export async function putCachedDocument(document: CachedDocument): Promise<void> {
  requireOfflineSession();
  const normalized = { ...document, key: documentKey(document.tableName, document.id) };
  memoryDocuments.set(normalized.key, normalized);
  if (encryptedPersistenceAvailable()) {
    try {
      const envelope = await documentEnvelope(normalized);
      await runStore(DOCUMENT_STORE, 'readwrite', async (store) => { store.put(envelope); });
    } catch {
      // Memory cache keeps the active session usable without writing plaintext.
    }
  }
  notifyListeners();
}

export async function removeCachedDocument(tableName: string, id: string): Promise<void> {
  const key = documentKey(tableName, id);
  memoryDocuments.delete(key);
  if (encryptedPersistenceAvailable()) {
    try {
      await runStore(DOCUMENT_STORE, 'readwrite', async (store) => { store.delete(key); });
    } catch {
      // The in-memory state is already updated.
    }
  }
  notifyListeners();
}

export async function clearOfflineStore(): Promise<void> {
  memoryDocuments.clear();
  memoryMutations.clear();
  memoryConflicts.clear();
  if (canUseIndexedDb()) {
    try {
      const database = await getDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([DOCUMENT_STORE, MUTATION_STORE, CONFLICT_STORE], 'readwrite');
        transaction.objectStore(DOCUMENT_STORE).clear();
        transaction.objectStore(MUTATION_STORE).clear();
        transaction.objectStore(CONFLICT_STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Gagal membersihkan penyimpanan offline.'));
        transaction.onabort = () => reject(transaction.error || new Error('Pembersihan penyimpanan offline dibatalkan.'));
      });
    } catch {
      // In-memory entries have already been cleared.
    }
  }
  notifyListeners();
}

export async function cacheRemoteDocuments(
  tableName: string,
  documents: Array<{ id: string; data: Record<string, any>; createdAt: string; updatedAt: string }>
): Promise<void> {
  requireOfflineSession();
  const currentDocuments = new Map((await getCachedDocumentsByIds(tableName, documents.map((document) => document.id))).map((document) => [document.key, document]));
  const toStore: CachedDocument[] = [];
  documents.forEach((document) => {
    const key = documentKey(tableName, document.id);
    if (currentDocuments.get(key)?.pending) return;
    toStore.push(makeCachedDocument(tableName, document.id, document.data, document.createdAt, document.updatedAt, false));
  });
  toStore.forEach((document) => memoryDocuments.set(document.key, document));
  if (encryptedPersistenceAvailable() && toStore.length > 0) {
    try {
      const envelopes = await Promise.all(toStore.map((document) => documentEnvelope(document)));
      await runStore(DOCUMENT_STORE, 'readwrite', async (store) => { envelopes.forEach((document) => store.put(document)); });
    } catch {
      // Memory cache remains usable and no plaintext is persisted.
    }
  }
}

export async function queueMutation(mutation: Omit<PendingMutation, 'id' | 'queuedAt'>): Promise<PendingMutation> {
  requireOfflineSession();
  const queuedAtMs = Math.max(Date.now(), lastQueuedAtMs + 1);
  lastQueuedAtMs = queuedAtMs;
  const entry: PendingMutation = { ...mutation, id: mutationId(), queuedAt: new Date(queuedAtMs).toISOString() };
  memoryMutations.set(entry.id, entry);
  if (encryptedPersistenceAvailable()) {
    try {
      const envelope = await mutationEnvelope(entry);
      await runStore(MUTATION_STORE, 'readwrite', async (store) => { store.put(envelope); });
    } catch {
      // The queue remains available in memory and is never persisted as plaintext.
    }
  }
  notifyListeners();
  return entry;
}

export async function updatePendingMutation(mutation: PendingMutation): Promise<void> {
  requireOfflineSession();
  memoryMutations.set(mutation.id, mutation);
  if (encryptedPersistenceAvailable()) {
    try {
      const envelope = await mutationEnvelope(mutation);
      await runStore(MUTATION_STORE, 'readwrite', async (store) => { store.put(envelope); });
    } catch {
      // The in-memory queue still contains the rebased mutation.
    }
  }
  notifyListeners();
}

export async function recordSyncConflict(conflict: SyncConflict): Promise<void> {
  requireOfflineSession();
  memoryConflicts.set(conflict.id, conflict);
  if (encryptedPersistenceAvailable()) {
    try {
      const envelope = await conflictEnvelope(conflict);
      await runStore(CONFLICT_STORE, 'readwrite', async (store) => { store.put(envelope); });
    } catch {
      // The conflict remains visible in memory for the active session.
    }
  }
  notifyListeners();
}

export async function getSyncConflicts(): Promise<SyncConflict[]> {
  requireOfflineSession();
  const sortConflicts = (items: SyncConflict[]) => items.sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
  if (!encryptedPersistenceAvailable()) return sortConflicts(Array.from(memoryConflicts.values()));
  try {
    const raw = await runStore(CONFLICT_STORE, 'readonly', async (store) => requestResult(store.getAll()) as Promise<any[]>);
    const entries = await Promise.all(raw.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope).map((entry) => decryptValue<SyncConflict>(CONFLICT_STORE, entry)));
    entries.forEach((entry) => memoryConflicts.set(entry.id, entry));
    return sortConflicts(entries);
  } catch {
    return sortConflicts(Array.from(memoryConflicts.values()));
  }
}

export async function removeSyncConflict(id: string): Promise<void> {
  requireOfflineSession();
  memoryConflicts.delete(id);
  if (encryptedPersistenceAvailable()) {
    try {
      await runStore(CONFLICT_STORE, 'readwrite', async (store) => { store.delete(conflictStorageKey(id)); });
    } catch {
      // The current session no longer exposes the resolved conflict.
    }
  }
  notifyListeners();
}

export async function getPendingMutations(): Promise<PendingMutation[]> {
  requireOfflineSession();
  const sortMutations = (entries: PendingMutation[]) => entries.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id));
  if (!encryptedPersistenceAvailable()) return sortMutations(Array.from(memoryMutations.values()));
  try {
    const raw = await runStore(MUTATION_STORE, 'readonly', async (store) => requestResult(store.getAll()) as Promise<any[]>);
    const entries = await Promise.all(raw.filter((entry) => isEncryptedEnvelope(entry) && entry.ownerScope === activeOwnerScope).map((entry) => decryptValue<PendingMutation>(MUTATION_STORE, entry)));
    entries.forEach((entry) => memoryMutations.set(entry.id, entry));
    return sortMutations(entries);
  } catch {
    return sortMutations(Array.from(memoryMutations.values()));
  }
}

export async function completeMutation(mutation: PendingMutation): Promise<void> {
  requireOfflineSession();
  memoryMutations.delete(mutation.id);
  await removeSyncConflict(mutation.id);
  if (encryptedPersistenceAvailable()) {
    try {
      await runStore(MUTATION_STORE, 'readwrite', async (store) => { store.delete(mutationStorageKey(mutation.id)); });
    } catch {
      // The in-memory queue has already been cleared.
    }
  }
  const remaining = await getPendingMutations();
  const hasPendingForDocument = remaining.some((entry) => entry.tableName === mutation.tableName && entry.documentId === mutation.documentId);
  const cachedDocument = await getCachedDocument(mutation.tableName, mutation.documentId);
  if (cachedDocument && !hasPendingForDocument) {
    if (cachedDocument.deleted) await removeCachedDocument(mutation.tableName, mutation.documentId);
    else await putCachedDocument({ ...cachedDocument, pending: false });
  }
  notifyListeners();
}

export async function markMutationError(mutation: PendingMutation, error: unknown): Promise<void> {
  requireOfflineSession();
  const updated = { ...mutation, lastError: error instanceof Error ? error.message : String(error) };
  memoryMutations.set(updated.id, updated);
  if (encryptedPersistenceAvailable()) {
    try {
      const envelope = await mutationEnvelope(updated);
      await runStore(MUTATION_STORE, 'readwrite', async (store) => { store.put(envelope); });
    } catch {
      // The in-memory queue retains the error state.
    }
  }
  notifyListeners();
}

export function makeCachedDocument(
  tableName: string,
  id: string,
  data: Record<string, any>,
  createdAt: string,
  updatedAt: string,
  pending = true,
  deleted = false
): CachedDocument {
  return { key: documentKey(tableName, id), tableName, id, data, createdAt, updatedAt, pending, deleted };
}
