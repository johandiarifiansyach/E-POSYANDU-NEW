/** Authentication and session API. */
export type {
  AccessProfile,
  AuthenticatedSignInResult,
  Auth,
  AuthUser,
  MfaFactor,
  MfaPendingSignIn,
  SignInResult
} from './legacyClient';

export {
  expireAuthSession,
  challengeMfaFactor,
  completeAdminInvitation,
  enrollMfaFactor,
  getAuth,
  getCurrentAccessProfile,
  initializeApp,
  onAuthStateChanged,
  reportAccountPresence,
  restoreAuthSession,
  signInAnonymously,
  signInWithPassword,
  signOut,
  verifyMfaFactor
} from './legacyClient';
