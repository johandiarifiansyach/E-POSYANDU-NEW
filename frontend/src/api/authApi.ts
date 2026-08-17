/** Authentication and session API. */
export type {
  AccessProfile,
  Auth,
  AuthUser,
  MfaEnrollment,
  MfaStatus,
  SignInResult
} from './legacyClient';

export {
  getAuth,
  getCurrentAccessProfile,
  enrollMfa,
  initializeApp,
  onAuthStateChanged,
  restoreAuthSession,
  signInAnonymously,
  signInWithPassword,
  signOut,
  verifyMfa
} from './legacyClient';
