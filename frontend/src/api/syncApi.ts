/** Offline queue, Firestore-compatible operations, and sync conflicts. */
export type { Firestore } from './legacyClient';

export {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  isSyncing,
  listSyncConflicts,
  onSnapshot,
  orderBy,
  query,
  resolveSyncConflict,
  serverTimestamp,
  subscribeToSyncConflicts,
  subscribeToSyncState,
  subscribeToSyncedMutations,
  syncActiveViewFromServer,
  syncMeasurementMutationsNow,
  syncPendingMutations,
  updateDoc,
  where
} from './legacyClient';
