import { expect, test } from '@playwright/test';

test('skeleton awal mengikuti shell aplikasi tanpa teks persiapan', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { AppLoadingSkeleton } = await import('/src/ui/skeleton.ts');
    document.body.replaceChildren(AppLoadingSkeleton());
  });

  const skeleton = page.locator('.app-loading-shell');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-label', 'Memuat konten aplikasi');
  await expect(skeleton.locator('.app-loading-sidebar')).toHaveCount(1);
  await expect(skeleton.locator('.app-loading-topbar')).toHaveCount(1);
  await expect(skeleton.locator('.app-loading-card')).toHaveCount(6);
  await expect(skeleton.locator('.app-loading-list-row')).toHaveCount(4);
  await expect(page.getByText('Menyiapkan aplikasi')).toHaveCount(0);

  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/app-skeleton-${testInfo.project.name}.png`, fullPage: true });
  }
});

test('skeleton login mengikuti struktur login box', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { LoginLoadingSkeleton } = await import('/src/ui/skeleton.ts');
    document.body.replaceChildren(LoginLoadingSkeleton());
  });

  const skeleton = page.locator('.login-loading-shell');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-label', 'Memuat halaman login');
  await expect(skeleton.locator('.login-glass-card')).toHaveCount(1);
  await expect(skeleton.locator('.login-loading-input')).toHaveCount(2);
  await expect(skeleton.locator('.login-loading-submit')).toHaveCount(1);
  await expect(skeleton.locator('.login-footer')).toHaveCount(1);
  await expect(skeleton.locator('.app-loading-shell')).toHaveCount(0);

  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/login-skeleton-${testInfo.project.name}.png`, fullPage: true });
  }
});

test('login dapat dipakai dengan keyboard, footer rilis, dan pengaturan password', async ({ page }, testInfo) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
  await expect(page.locator('.login-footer p').first()).toHaveText('© 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach');
  const versionButton = page.getByRole('button', { name: 'E-Posyandu v3.7.0' });
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
  await expect(releaseDialog.getByText('13 Agustus 2026', { exact: true }).first()).toBeVisible();
  for (const version of ['v3.7.0', 'v3.6.0', 'v3.5.6', 'v3.5.5', 'v3.5.4', 'v3.5.3', 'v3.5.2', 'v3.5.1', 'v3.5.0', 'v3.4.5', 'v3.4.4', 'v3.4.3', 'v3.4.1', 'v3.4.0', 'v3.3.0', 'v3.0.0', 'v2.4.0', 'v2.0.0', 'v1.0.0']) {
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

test('login pulih dari koneksi IndexedDB yang sedang ditutup tanpa meminta endpoint me', async ({ page }) => {
  let profileRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-ID',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Origin': 'http://127.0.0.1:4174',
      'Content-Type': 'application/json'
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (path.endsWith('/auth/session')) {
      await route.fulfill({ status: 401, headers, json: { detail: 'Sesi belum tersedia.' } });
      return;
    }
    if (path.endsWith('/auth/login')) {
      await route.fulfill({ status: 200, headers, json: {
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
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
  await page.evaluate(() => {
    const prototype = IDBDatabase.prototype as any;
    const originalTransaction = prototype.transaction;
    let rejectedTransactions = 0;
    prototype.transaction = function (...args: any[]) {
      if (rejectedTransactions < 2) {
        rejectedTransactions += 1;
        throw new DOMException('The database connection is closing', 'InvalidStateError');
      }
      return originalTransaction.apply(this, args);
    };
  });
  await page.getByLabel('Username').fill('salak1');
  await page.getByRole('textbox', { name: 'Kata Sandi', exact: true }).fill('kata-sandi-uji');
  await page.getByRole('button', { name: 'Masuk' }).click();

  await expect(page.locator('[data-nav-id="dashboard"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verifikasi Dua Langkah' })).toHaveCount(0);
  expect(profileRequests).toBe(0);
});

test('sesi logout otomatis setelah 30 menit tidak aktif dan tidak pulih saat logout server gagal', async ({ page }) => {
  let serverSessionActive = false;
  let sessionRequests = 0;
  let logoutRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-ID',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Origin': 'http://127.0.0.1:4174',
      'Content-Type': 'application/json'
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (path.endsWith('/auth/session')) {
      sessionRequests += 1;
      await route.fulfill(serverSessionActive ? {
        status: 200,
        headers,
        json: {
          user: { id: 'user-idle', email: 'salak1@posyandu.com' },
          profile: {
            userId: 'user-idle',
            email: 'salak1@posyandu.com',
            role: 'Kader Posyandu',
            desa: 'Desa Gumukmas',
            posyandu: 'SALAK 1'
          }
        }
      } : { status: 401, headers, json: { detail: 'Sesi belum tersedia.' } });
      return;
    }
    if (path.endsWith('/auth/login')) {
      serverSessionActive = true;
      await route.fulfill({ status: 200, headers, json: {
        user: { id: 'user-idle', email: 'salak1@posyandu.com' },
        profile: {
          userId: 'user-idle',
          email: 'salak1@posyandu.com',
          role: 'Kader Posyandu',
          desa: 'Desa Gumukmas',
          posyandu: 'SALAK 1'
        }
      } });
      return;
    }
    if (path.endsWith('/auth/logout')) {
      logoutRequests += 1;
      await route.fulfill({ status: 503, headers, json: { detail: 'Logout server sengaja digagalkan.' } });
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

  await page.evaluate(() => {
    localStorage.setItem('e-posyandu:last-activity', String(Date.now() - (31 * 60 * 1000)));
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
  await expect.poll(() => logoutRequests).toBe(1);
  const expiredState = await page.evaluate(() => ({
    activity: localStorage.getItem('e-posyandu:last-activity'),
    expired: localStorage.getItem('e-posyandu:idle-session-expired'),
    user: localStorage.getItem('e-posyandu:user')
  }));
  expect(expiredState.activity).toBeNull();
  expect(expiredState.expired).not.toBeNull();
  expect(expiredState.user).toBeNull();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();
  await expect(page.locator('[data-nav-id="dashboard"]')).toHaveCount(0);
  await expect.poll(() => logoutRequests).toBe(2);
  expect(sessionRequests).toBe(1);
});

test('login tidak melewati Turnstile dan rate limiter saat Worker mencapai batas kapasitas', async ({ page }) => {
  let directAuthRequests = 0;
  let directProfileRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
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

  await expect(page.getByRole('alert')).toContainText('Layanan login aman sementara tidak tersedia');
  await expect(page.locator('[data-nav-id="dashboard"]')).toHaveCount(0);
  expect(directAuthRequests).toBe(0);
  expect(directProfileRequests).toBe(0);
});

test('cache offline dienkripsi dan dipisahkan sebelum akun lain dapat membaca', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();

  const result = await page.evaluate(async () => {
    const offlineStore = await import('/src/services/offlineStore.ts');
    const now = new Date().toISOString();
    await offlineStore.initializeOfflineStoreSession('user-sensitive-a', { forceReset: true });
    await offlineStore.putCachedDocument(offlineStore.makeCachedDocument(
      'children',
      'child-sensitive',
      { nama: 'BALITA SANGAT RAHASIA', nik: '3509040101259999' },
      now,
      now,
      false
    ));
    await offlineStore.queueMutation({
      type: 'update',
      tableName: 'children',
      documentId: 'child-sensitive',
      payload: { data: { namaOrtu: 'ORANG TUA SANGAT RAHASIA' } }
    });

    const readRawStores = async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('e-posyandu-offline');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (storeName: string) => new Promise<any[]>((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores = {
        documents: await read('documents'),
        mutations: await read('mutations'),
        conflicts: await read('conflicts')
      };
      database.close();
      return stores;
    };

    const before = await readRawStores();
    const serializedBefore = JSON.stringify(before);
    const readableByOwner = await offlineStore.getCachedDocument('children', 'child-sensitive');
    await offlineStore.initializeOfflineStoreSession('user-sensitive-b', { forceReset: true });
    const visibleToOtherOwner = await offlineStore.getCachedDocuments('children');
    const after = await readRawStores();

    return {
      envelopesAreEncrypted: [...before.documents, ...before.mutations].every((entry) => (
        entry.encrypted === true && entry.encryptionVersion === 1 && entry.iv && entry.ciphertext
      )),
      containsChildName: serializedBefore.includes('BALITA SANGAT RAHASIA'),
      containsNik: serializedBefore.includes('3509040101259999'),
      containsParentName: serializedBefore.includes('ORANG TUA SANGAT RAHASIA'),
      readableByOwner: readableByOwner?.data?.nama,
      visibleToOtherOwner: visibleToOtherOwner.length,
      persistedAfterAccountChange: after.documents.length + after.mutations.length + after.conflicts.length
    };
  });

  expect(result).toEqual({
    envelopesAreEncrypted: true,
    containsChildName: false,
    containsNik: false,
    containsParentName: false,
    readableByOwner: 'BALITA SANGAT RAHASIA',
    visibleToOtherOwner: 0,
    persistedAfterAccountChange: 0
  });
});

test('startup tanpa sesi menghapus cache terenkripsi dan kunci akun sebelumnya', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();

  await page.evaluate(async () => {
    const offlineStore = await import('/src/services/offlineStore.ts');
    const now = new Date().toISOString();
    await offlineStore.initializeOfflineStoreSession('user-closed-session', { forceReset: true });
    await offlineStore.putCachedDocument(offlineStore.makeCachedDocument(
      'children',
      'child-closed-session',
      { nama: 'DATA SESI LAMA', nik: '3509040101258888' },
      now,
      now,
      false
    ));
    localStorage.setItem('e-posyandu:auth-session', JSON.stringify({
      uid: 'user-closed-session',
      email: 'stale@example.test',
      accessToken: 'stale-access-token',
      refreshToken: 'stale-refresh-token',
      expiresAt: Date.now() + 60_000
    }));
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'E-Posyandu' })).toBeVisible();

  const remaining = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('e-posyandu-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = (storeName: string) => new Promise<number>((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      documents: await count('documents'),
      mutations: await count('mutations'),
      conflicts: await count('conflicts'),
      owner: sessionStorage.getItem('e-posyandu:offline-owner-v1'),
      key: sessionStorage.getItem('e-posyandu:offline-key-v1'),
      legacyAuth: localStorage.getItem('e-posyandu:auth-session')
    };
    database.close();
    return result;
  });

  expect(remaining).toEqual({
    documents: 0,
    mutations: 0,
    conflicts: 0,
    owner: null,
    key: null,
    legacyAuth: null
  });
});
