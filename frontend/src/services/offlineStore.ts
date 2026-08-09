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

const DATABASE_NAME = 'e-posyandu-offline';
const DATABASE_VERSION = 2;
const DOCUMENT_STORE = 'documents';
const MUTATION_STORE = 'mutations';
const CONFLICT_STORE = 'conflicts';

let databasePromise: Promise<IDBDatabase> | null = null;
const memoryDocuments = new Map<string, CachedDocument>();
const memoryMutations = new Map<string, PendingMutation>();
const memoryConflicts = new Map<string, SyncConflict>();
const listeners = new Set<() => void>();
let lastQueuedAtMs = 0;

function documentKey(tableName: string, id: string) {
  return `${tableName}:${id}`;
}

function mutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `mutation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined';
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

function getDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
          const documents = database.createObjectStore(DOCUMENT_STORE, { keyPath: 'key' });
          documents.createIndex('tableName', 'tableName', { unique: false });
        }
        if (!database.objectStoreNames.contains(MUTATION_STORE)) {
          const mutations = database.createObjectStore(MUTATION_STORE, { keyPath: 'id' });
          mutations.createIndex('queuedAt', 'queuedAt', { unique: false });
          mutations.createIndex('documentKey', ['tableName', 'documentId'], { unique: false });
        }
        if (!database.objectStoreNames.contains(CONFLICT_STORE)) {
          const conflicts = database.createObjectStore(CONFLICT_STORE, { keyPath: 'id' });
          conflicts.createIndex('detectedAt', 'detectedAt', { unique: false });
          conflicts.createIndex('documentKey', ['tableName', 'documentId'], { unique: false });
        }
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

    void operation(store)
      .then((value) => {
        result = value;
        operationFinished = true;
      })
      .catch((error) => {
        transaction.abort();
        reject(error);
      });
  });
}

async function readAllDocumentsFromIdb(tableName: string): Promise<CachedDocument[]> {
  return runStore(DOCUMENT_STORE, 'readonly', async (store) => {
    return requestResult(store.index('tableName').getAll(tableName)) as Promise<CachedDocument[]>;
  });
}

export function subscribeToOfflineStore(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getCachedDocuments(tableName: string): Promise<CachedDocument[]> {
  if (!canUseIndexedDb()) {
    return Array.from(memoryDocuments.values()).filter((document) => document.tableName === tableName);
  }

  try {
    return await readAllDocumentsFromIdb(tableName);
  } catch {
    return Array.from(memoryDocuments.values()).filter((document) => document.tableName === tableName);
  }
}

export async function getCachedDocument(tableName: string, id: string): Promise<CachedDocument | undefined> {
  const key = documentKey(tableName, id);
  if (!canUseIndexedDb()) return memoryDocuments.get(key);

  try {
    return await runStore(DOCUMENT_STORE, 'readonly', async (store) => requestResult(store.get(key)) as Promise<CachedDocument | undefined>);
  } catch {
    return memoryDocuments.get(key);
  }
}

export async function putCachedDocument(document: CachedDocument): Promise<void> {
  memoryDocuments.set(document.key, document);

  if (canUseIndexedDb()) {
    try {
      await runStore(DOCUMENT_STORE, 'readwrite', async (store) => {
        store.put(document);
      });
    } catch {
      // Memory cache keeps the current session usable when IndexedDB is unavailable.
    }
  }

  notifyListeners();
}

export async function removeCachedDocument(tableName: string, id: string): Promise<void> {
  const key = documentKey(tableName, id);
  memoryDocuments.delete(key);

  if (canUseIndexedDb()) {
    try {
      await runStore(DOCUMENT_STORE, 'readwrite', async (store) => {
        store.delete(key);
      });
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
  const currentDocuments = new Map((await getCachedDocuments(tableName)).map((document) => [document.key, document]));
  const toStore: CachedDocument[] = [];

  documents.forEach((document) => {
    const key = documentKey(tableName, document.id);
    if (currentDocuments.get(key)?.pending) return;
    toStore.push(makeCachedDocument(tableName, document.id, document.data, document.createdAt, document.updatedAt, false));
  });

  toStore.forEach((document) => memoryDocuments.set(document.key, document));

  if (canUseIndexedDb() && toStore.length > 0) {
    try {
      await runStore(DOCUMENT_STORE, 'readwrite', async (store) => {
        toStore.forEach((document) => store.put(document));
      });
    } catch {
      // The in-memory cache is sufficient until IndexedDB becomes available again.
    }
  }
}

export async function queueMutation(mutation: Omit<PendingMutation, 'id' | 'queuedAt'>): Promise<PendingMutation> {
  const queuedAtMs = Math.max(Date.now(), lastQueuedAtMs + 1);
  lastQueuedAtMs = queuedAtMs;
  const entry: PendingMutation = {
    ...mutation,
    id: mutationId(),
    queuedAt: new Date(queuedAtMs).toISOString()
  };
  memoryMutations.set(entry.id, entry);

  if (canUseIndexedDb()) {
    try {
      await runStore(MUTATION_STORE, 'readwrite', async (store) => {
        store.put(entry);
      });
    } catch {
      // The queue remains available for this open session.
    }
  }

  notifyListeners();
  return entry;
}

export async function updatePendingMutation(mutation: PendingMutation): Promise<void> {
  memoryMutations.set(mutation.id, mutation);
  if (canUseIndexedDb()) {
    try {
      await runStore(MUTATION_STORE, 'readwrite', async (store) => {
        store.put(mutation);
      });
    } catch {
      // The in-memory queue still contains the rebased mutation.
    }
  }
  notifyListeners();
}

export async function recordSyncConflict(conflict: SyncConflict): Promise<void> {
  memoryConflicts.set(conflict.id, conflict);
  if (canUseIndexedDb()) {
    try {
      await runStore(CONFLICT_STORE, 'readwrite', async (store) => {
        store.put(conflict);
      });
    } catch {
      // The conflict remains visible for the current session.
    }
  }
  notifyListeners();
}

export async function getSyncConflicts(): Promise<SyncConflict[]> {
  const sortConflicts = (items: SyncConflict[]) =>
    items.sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
  if (!canUseIndexedDb()) return sortConflicts(Array.from(memoryConflicts.values()));
  try {
    const entries = await runStore(CONFLICT_STORE, 'readonly', async (store) => {
      return requestResult(store.index('detectedAt').getAll()) as Promise<SyncConflict[]>;
    });
    entries.forEach((entry) => memoryConflicts.set(entry.id, entry));
    return sortConflicts(entries);
  } catch {
    return sortConflicts(Array.from(memoryConflicts.values()));
  }
}

export async function removeSyncConflict(id: string): Promise<void> {
  memoryConflicts.delete(id);
  if (canUseIndexedDb()) {
    try {
      await runStore(CONFLICT_STORE, 'readwrite', async (store) => {
        store.delete(id);
      });
    } catch {
      // The current session no longer exposes the resolved conflict.
    }
  }
  notifyListeners();
}

export async function getPendingMutations(): Promise<PendingMutation[]> {
  const sortMutations = (entries: PendingMutation[]) =>
    entries.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id));

  if (!canUseIndexedDb()) {
    return sortMutations(Array.from(memoryMutations.values()));
  }

  try {
    const entries = await runStore(MUTATION_STORE, 'readonly', async (store) => {
      return requestResult(store.index('queuedAt').getAll()) as Promise<PendingMutation[]>;
    });
    entries.forEach((entry) => memoryMutations.set(entry.id, entry));
    return sortMutations(entries);
  } catch {
    return sortMutations(Array.from(memoryMutations.values()));
  }
}

export async function completeMutation(mutation: PendingMutation): Promise<void> {
  memoryMutations.delete(mutation.id);
  await removeSyncConflict(mutation.id);

  if (canUseIndexedDb()) {
    try {
      await runStore(MUTATION_STORE, 'readwrite', async (store) => {
        store.delete(mutation.id);
      });
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
  const updated = { ...mutation, lastError: error instanceof Error ? error.message : String(error) };
  memoryMutations.set(updated.id, updated);

  if (canUseIndexedDb()) {
    try {
      await runStore(MUTATION_STORE, 'readwrite', async (store) => {
        store.put(updated);
      });
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
