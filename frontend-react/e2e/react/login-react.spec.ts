import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

async function mockUnauthenticatedSession(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({ status: 401, json: { detail: 'Sesi belum tersedia.' } });
  });
}

test('React login mempertahankan kontrak visual dan akses keyboard', async ({ page }, testInfo) => {
  await mockUnauthenticatedSession(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
  await expect(page.locator('.login-glass-card')).toHaveCount(1);
  await expect(page.locator('[data-react-login-username]')).toBeVisible();
  await expect(page.getByLabel('Username')).toBeFocused();

  const password = page.getByRole('textbox', { name: 'Kata Sandi', exact: true });
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await expect(page.getByRole('button', { name: 'Masuk' })).toBeEnabled();
  await expect(page.locator('.login-footer')).toBeVisible();
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({
      path: `${process.env.E2E_CAPTURE_UI}/react-login-${testInfo.project.name}.png`,
      fullPage: true
    });
  }
});

test('React bootstrap menampilkan skeleton saat pemeriksaan sesi lambat', async ({ page }) => {
  await page.route('**/api/v1/auth/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({ status: 401, json: { detail: 'Sesi belum tersedia.' } });
  });

  await page.goto('/');
  await expect(page.locator('.app-loading-shell')).toBeVisible();
  await expect(page.locator('.app-loading-shell')).toHaveAttribute('aria-label', 'Memuat konten aplikasi');
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
});

test('React login bebas pelanggaran aksesibilitas otomatis', async ({ page }) => {
  await mockUnauthenticatedSession(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' '))
  }))).toEqual([]);
});

test('React login tidak melebar pada viewport mobile', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Khusus viewport mobile.');
  await mockUnauthenticatedSession(page);
  await page.goto('/');

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
