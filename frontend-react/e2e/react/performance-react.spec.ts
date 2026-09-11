import { expect, test } from '@playwright/test';

/**
 * Chrome DevTools exposes the same CDP emulation used here. Keeping this as a
 * browser test makes the low-end check repeatable in CI and on a developer
 * machine instead of relying on a fast desktop CPU.
 */
test('@performance login tetap dapat dipakai pada throttling CPU 6x', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'CPU throttling CDP hanya tersedia pada Chromium.');

  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({ status: 401, json: { detail: 'Sesi belum tersedia.' } });
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();

    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return {
        domContentLoadedMs: entry ? Math.round(entry.domContentLoadedEventEnd - entry.startTime) : null,
        loadEventMs: entry ? Math.round(entry.loadEventEnd - entry.startTime) : null,
      };
    });
    await testInfo.attach('cpu-throttle-metrics.json', {
      body: JSON.stringify({ cpuRate: 6, ...navigation }, null, 2),
      contentType: 'application/json',
    });
    console.info('[CPU 6x]', navigation);
  } finally {
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await client.detach();
  }
});
