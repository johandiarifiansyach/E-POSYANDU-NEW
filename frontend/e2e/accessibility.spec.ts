import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('halaman login tidak memiliki pelanggaran WCAG yang terdeteksi otomatis', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(' '))
  }));

  expect(violations).toEqual([]);
});
