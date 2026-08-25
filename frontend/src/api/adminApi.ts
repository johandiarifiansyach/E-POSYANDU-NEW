/** Administrator-only backend operations and account-presence API. */
export type {
  AdminAccountPresence,
  AdminAccountInput,
  AdminAccountMutationResult,
  AdminAccountsOverview,
  AdminMonitoringSample,
  BackendReadiness
} from './legacyClient';

export {
  createAdminAccount,
  deleteAdminAccount,
  getAdminAccountsOverview,
  getAdminMonitoringStreamUrl,
  getBackendReadiness,
  updateAdminAccount
} from './legacyClient';
