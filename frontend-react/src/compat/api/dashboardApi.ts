/** Dashboard, monitoring, change history, and background jobs. */
export type {
  BackgroundJob,
  BackgroundJobKind,
  DashboardStatsRequest,
  DashboardStatsResponse,
  FeatureFlags,
  MonitoringStatus
} from './legacyClient';

export {
  createBackgroundJob,
  getBackgroundJob,
  getChangeHistory,
  getDashboardStats,
  getFeatureFlags,
  getMonitoringStatus,
  reportClientError,
  waitForBackgroundJob
} from './legacyClient';
