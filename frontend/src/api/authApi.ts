/** Authentication and session API. */
export type { AccessProfile, Auth, AuthUser } from './legacyClient';

export {
  getAuth,
  getCurrentAccessProfile,
  initializeApp,
  onAuthStateChanged,
  restoreAuthSession,
  signInAnonymously,
  signInWithPassword,
  signOut
} from './legacyClient';
