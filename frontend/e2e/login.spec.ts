import { expect, test } from '@playwright/test';

test('login dapat dipakai dengan keyboard, footer rilis, dan pengaturan password', async ({ page }, testInfo) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
  await expect(page.locator('.login-footer p').first()).toHaveText('© 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach');
  const versionButton = page.getByRole('button', { name: 'E-Posyandu v3.5.2' });
  await expect(versionButton).toBeVisible();
  await expect(page.locator('.login-glass-card .login-footer')).toHaveCount(0);
  await expect(page.locator('.login-shell > .login-footer')).toBeVisible();
  await expect(page.locator('.login-footer')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.login-footer')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const footerPlacement = await page.locator('.login-footer').evaluate((footer) => {
    const copyright = footer.firstElementChild?.getBoundingClientRect();
    const version = footer.lastElementChild?.getBoundingClientRect();
    return {
      copyrightLeft: copyright?.left || 0,
      versionRight: version?.right || 0,
      viewportWidth: window.innerWidth
    };
  });
  expect(footerPlacement.copyrightLeft).toBeLessThanOrEqual(20);
  expect(footerPlacement.viewportWidth - footerPlacement.versionRight).toBeLessThanOrEqual(20);

  await versionButton.click();
  const releaseDialog = page.getByRole('dialog', { name: 'Apa yang Baru' });
  await expect(releaseDialog).toBeVisible();
  await expect(releaseDialog.getByText('12 Agustus 2026', { exact: true }).first()).toBeVisible();
  for (const version of ['v3.5.2', 'v3.5.1', 'v3.5.0', 'v3.4.5', 'v3.4.4', 'v3.4.3', 'v3.4.1', 'v3.4.0', 'v3.3.0', 'v3.0.0', 'v2.4.0', 'v2.0.0', 'v1.0.0']) {
    await expect(releaseDialog.getByText(version, { exact: true })).toBeVisible();
  }
  await expect(releaseDialog.getByText('6 Januari 2026', { exact: true })).toBeVisible();
  await expect(releaseDialog.getByText('31 Desember 2024', { exact: true })).toBeVisible();
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/release-notes-login-${testInfo.project.name}.png`, fullPage: true });
  }
  await releaseDialog.getByRole('button', { name: 'Selesai' }).click();
  await expect(releaseDialog).toBeHidden();

  const username = page.getByLabel('Username');
  const password = page.getByRole('textbox', { name: 'Kata Sandi', exact: true });
  const passwordToggle = page.getByRole('button', { name: 'Perlihatkan kata sandi' });

  await username.focus();
  await expect(username).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();

  await password.fill('kata-sandi-uji');
  await passwordToggle.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Sembunyikan kata sandi' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Masuk' })).toBeEnabled();
});

test('tema login mengikuti sistem dan pilihan manual tersimpan', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Gunakan mode terang' })).toBeVisible();
  await expect(page.locator('.login-glass-card')).toHaveCSS('background-color', 'rgba(29, 29, 34, 0.82)');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/login-dark-${testInfo.project.name}.png`, fullPage: true });
  }

  await page.getByRole('button', { name: 'Gunakan mode terang' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Gunakan mode gelap' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('e-posyandu:color-scheme'))).toBe('light');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Gunakan mode gelap' })).toBeVisible();
});

test('halaman login tidak melebar di layar ponsel', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Pemeriksaan khusus viewport ponsel.');
  await page.goto('/');

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test('login memakai profil dari respons yang sama tanpa meminta endpoint me', async ({ page }) => {
  let profileRequests = 0;
  await page.route('http://127.0.0.1:9/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-ID',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (path.endsWith('/auth/login')) {
      await route.fulfill({ status: 200, headers, json: {
        access_token: 'access-token-login',
        refresh_token: 'refresh-token-login',
        expires_in: 3600,
        user: { id: 'user-login', email: 'salak1@posyandu.com' },
        profile: {
          userId: 'user-login',
          email: 'salak1@posyandu.com',
          role: 'Kader Posyandu',
          desa: 'Desa Gumukmas',
          posyandu: 'SALAK 1'
        }
      } });
      return;
    }
    if (path.endsWith('/me')) {
      profileRequests += 1;
      await route.fulfill({ status: 500, headers, json: { detail: 'Endpoint me tidak boleh diperlukan.' } });
      return;
    }
    if (path.endsWith('/graphql')) {
      await route.fulfill({ status: 200, headers, json: {
        data: { dashboardStats: {
          S: 0, D: 0, N: 0, T: 0, B: 0, O: 0,
          asiEksklusif: 0, asiTarget: 0, underweight: 0, stunting: 0, wasting: 0,
          perD: '0', perN: '0', perT: '0', perAsiEksklusif: '0',
          perUnderweight: '0', perStunting: '0', perWasting: '0'
        } }
      } });
      return;
    }
    await route.fulfill({ status: 200, headers, json: { items: [], cursor: new Date().toISOString() } });
  });

  await page.goto('/');
  await page.getByLabel('Username').fill('salak1');
  await page.getByRole('textbox', { name: 'Kata Sandi', exact: true }).fill('kata-sandi-uji');
  await page.getByRole('button', { name: 'Masuk' }).click();

  await expect(page.locator('[data-nav-id="dashboard"]')).toBeVisible();
  expect(profileRequests).toBe(0);
});

test('login beralih ke Supabase Auth saat Worker mencapai batas kapasitas', async ({ page }) => {
  let directAuthRequests = 0;
  let directProfileRequests = 0;
  let profileRequests = 0;
  await page.route('http://127.0.0.1:9/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/me')) profileRequests += 1;
    await route.fulfill({
      status: 429,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' },
      body: 'error code: 1027'
    });
  });
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=password', async (route) => {
    directAuthRequests += 1;
    const payload = route.request().postDataJSON();
    expect(payload).toEqual({
      email: 'gizipuskesmasgumukmas@gmail.com',
      password: 'kata-sandi-uji'
    });
    await route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      json: {
        access_token: 'access-token-fallback',
        refresh_token: 'refresh-token-fallback',
        expires_in: 3600,
        user: { id: 'user-gizi', email: 'gizipuskesmasgumukmas@gmail.com' }
      }
    });
  });
  await page.route('http://127.0.0.1:54321/rest/v1/rpc/eposyandu_current_access_profile', async (route) => {
    directProfileRequests += 1;
    expect(route.request().headers().authorization).toBe('Bearer access-token-fallback');
    await route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      json: [{
        user_id: 'user-gizi',
        email: 'gizipuskesmasgumukmas@gmail.com',
        role: 'Ahli Gizi',
        village: null,
        posyandu: null
      }]
    });
  });

  await page.goto('/');
  await page.getByLabel('Username').fill('gizi');
  await page.getByRole('textbox', { name: 'Kata Sandi', exact: true }).fill('kata-sandi-uji');
  await page.getByRole('button', { name: 'Masuk' }).click();

  await expect(page.locator('[data-nav-id="dashboard"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('e-posyandu:user'))).toBe(JSON.stringify({
    role: 'Ahli Gizi',
    desa: null,
    posyandu: null
  }));
  expect(directAuthRequests).toBe(1);
  expect(directProfileRequests).toBe(1);
  expect(profileRequests).toBe(0);
});
