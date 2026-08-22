/** Authentication and session API. */
export type {
  AccessProfile,
  Auth,
  AuthUser,
  SignInResult
} from './legacyClient';

export {
  expireAuthSession,
  getAuth,
  getCurrentAccessProfile,
  initializeApp,
  onAuthStateChanged,
  restoreAuthSession,
  signInAnonymously,
  signInWithPassword,
  signOut
} from './legacyClient';
