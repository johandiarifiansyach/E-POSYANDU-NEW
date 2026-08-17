import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests/frontend',
  testMatch: /.*\.test\.ts/,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list'
});
