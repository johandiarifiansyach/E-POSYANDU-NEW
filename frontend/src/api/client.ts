/**
 * Public compatibility entry point for the API layer.
 *
 * New code should import the smallest domain module it needs. Existing
 * imports can continue using `api/client` while the application is migrated.
 */
export * from './httpClient';
export * from './authApi';
export * from './childrenApi';
export * from './measurementApi';
export * from './dashboardApi';
export * from './exportApi';
export * from './syncApi';
