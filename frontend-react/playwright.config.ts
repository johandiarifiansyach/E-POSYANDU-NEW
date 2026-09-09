import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const reactRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(reactRoot, '..');

/** Playwright suite for the React migration; deployment remains manual. */
export default defineConfig({
  testDir: path.join(reactRoot, 'e2e/react'),
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } }
  ],
  webServer: {
    command: `npm --prefix "${reactRoot}" run dev -- --host 127.0.0.1 --port 4176`,
    cwd: workspaceRoot,
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      VITE_API_URL: '',
      VITE_TURNSTILE_SITE_KEY: '',
      // Keep every migrated slice explicit in the isolated browser suite;
      // production defaults are also React-enabled, with flags retained only
      // for emergency rollback.
      VITE_REACT_DASHBOARD_ENABLED: 'true',
      VITE_REACT_CHILDREN_ENABLED: 'true',
      VITE_REACT_ASI_ENABLED: 'true',
      VITE_REACT_CHANGE_HISTORY_ENABLED: 'true',
      VITE_REACT_MPASI_ENABLED: 'true'
    }
  }
});
