import { expect, test, type Page } from '@playwright/test';

const child = {
  id: 'child-delete-regression',
  data: {
    nama: 'Balita Uji Hapus',
    nik: '3509040101250001',
    hasNIK: true,
    tglLahir: '2025-01-01',
    jk: 'L',
    namaOrtu: 'Orang Tua Uji',
    desa: 'Desa Gumukmas',
    posyandu: 'SALAK 1',
    currentBB: 5,
    currentTB: 73.5,
    lastMeasurementDate: '2026-07-25',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1
  }
};

const pmtProgram = {
  id: 'pmt-program-regression',
  data: {
    childId: child.id,
    childName: child.data.nama,
    category: 'Wasting',
    sumberAnggaran: 'BOK Puskesmas',
    mitraLain: 'TP PKK Desa Gumukmas',
    tglPemberian: '2026-07-25',
    initialMeasurementDate: '2026-07-25',
    initialBB: 8.2,
    initialTB: 73.5,
    monitorings: {
      1: { tgl: '2026-08-01', bb: 8.4, tb: 73.8 }
    },
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1
  }
};

const measurement = {
  id: 'measurement-regression',
  data: {
    childId: child.id,
    childName: child.data.nama,
    desa: child.data.desa,
    posyandu: child.data.posyandu,
    tglUkur: '2026-08-01',
    bb: 5,
    tb: 73.5,
    lila: 13.2,
    lk: 44.1,
    caraUkur: 'Terlentang',
    statusNaik: 'T',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1
  }
};

const changeHistoryEntries = [
  {
    id: 'change-older',
    data: {
      childId: child.id,
      childName: 'Perubahan Lama',
      changedBy: 'Kader Posyandu',
      changes: [{ field: 'nama', oldValue: 'Nama Awal', newValue: 'Nama Lama' }],
      timestamp: '2026-07-30T08:00:00.000Z'
    }
  },
  {
    id: 'change-newer',
    data: {
      childId: child.id,
      childName: 'Perubahan Terbaru',
      changedBy: 'Ahli Gizi',
      changes: [{ field: 'nama', oldValue: 'Nama Lama', newValue: 'Nama Terbaru' }],
      timestamp: '2026-08-01T08:00:00.000Z'
    }
  }
];

async function configureAuthenticatedPage(
  page: Page,
  syncFails = false,
  includeChildrenCollection = false,
  changeLogs = [] as typeof changeHistoryEntries
) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('e-posyandu:auth-session', JSON.stringify({
      uid: 'user-regression',
      email: 'salak1@posyandu.com',
      accessToken: 'access-token-regression',
      refreshToken: 'refresh-token-regression',
      expiresAt: Date.now() + 3_600_000
    }));
    window.localStorage.setItem('e-posyandu:user', JSON.stringify({
      role: 'Kader Posyandu',
      desa: 'Desa Gumukmas',
      posyandu: 'SALAK 1'
    }));
  });

  await page.route('http://127.0.0.1:9/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Request-ID',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (path.endsWith('/me')) {
      await route.fulfill({ status: 200, headers, json: {
        userId: 'user-regression',
        email: 'salak1@posyandu.com',
        role: 'Kader Posyandu',
        desa: 'Desa Gumukmas',
        posyandu: 'SALAK 1'
      } });
      return;
    }
    if (path.endsWith('/children/page')) {
      await route.fulfill({ status: 200, headers, json: {
        items: [child],
        measurements: [measurement],
        mpasiLogs: [],
        total: 1
      } });
      return;
    }
    if (path.endsWith(`/collections/children/${child.id}`)) {
      await route.fulfill({ status: 200, headers, json: child });
      return;
    }
    if (path.endsWith('/collections/children')) {
      await route.fulfill({ status: 200, headers, json: {
        items: includeChildrenCollection ? [child] : [],
        cursor: new Date().toISOString()
      } });
      return;
    }
    if (path.endsWith('/collections/measurements')) {
      await route.fulfill({ status: 200, headers, json: {
        items: [measurement],
        cursor: new Date().toISOString()
      } });
      return;
    }
    if (path.endsWith('/collections/pmt_programs')) {
      await route.fulfill({ status: 200, headers, json: {
        items: [pmtProgram],
        cursor: new Date().toISOString()
      } });
      return;
    }
    if (path.endsWith('/collections/change_logs')) {
      await route.fulfill({ status: 200, headers, json: {
        items: changeLogs,
        cursor: new Date().toISOString()
      } });
      return;
    }
    if (path.includes('/collections/')) {
      await route.fulfill({ status: 200, headers, json: {
        items: [],
        cursor: new Date().toISOString()
      } });
      return;
    }
    if (path.endsWith('/sync')) {
      if (syncFails) {
        await route.fulfill({ status: 503, headers, json: { detail: 'API uji sedang tidak tersedia.' } });
      } else {
        const cursor = new Date().toISOString();
        const changes = {
          children: { items: includeChildrenCollection ? [child] : [], cursor },
          measurements: { items: [measurement], cursor },
          pmt_programs: { items: [pmtProgram], cursor },
          change_logs: { items: changeLogs, cursor }
        };
        await route.fulfill({ status: 200, headers, json: { results: [], changes, cursor: new Date().toISOString() } });
      }
      return;
    }
    await route.fulfill({ status: 404, headers, json: { detail: 'Rute uji tidak tersedia.' } });
  });
}

test('balita yang dihapus tidak muncul kembali ketika pengiriman masih tertunda', async ({ page }) => {
  await configureAuthenticatedPage(page, true);

  await page.goto('/#data_balita');
  await expect(page.getByText(child.data.nama, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Hapus Balita', exact: true }).click();
  await page.getByRole('button', { name: 'Konfirmasi Hapus' }).click();
  await expect(page.getByText('Gagal menghapus data balita: API uji sedang tidak tersedia.')).toBeVisible();
  await expect(page.getByText(child.data.nama, { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Data Balita Lengkap', exact: true })).toBeVisible();
  await expect(page.getByText(child.data.nama, { exact: true })).toHaveCount(0);
});

test('form edit identitas dapat digulir sampai tombol simpan', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#data_balita');
  const editAction = page.getByRole('button', { name: 'Edit Identitas', exact: true });
  await editAction.hover();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '1');
  await editAction.click();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('heading', { name: 'Edit Identitas Balita' })).toBeVisible();
  await expect(page.locator('[data-identity-modal] .ios-liquid-modal')).toBeVisible();

  const scrollArea = page.locator('[data-identity-modal-scroll]');
  const dimensions = await scrollArea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await scrollArea.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => scrollArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Perbarui Data' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.E2E_CAPTURE_UI) {
    await scrollArea.evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/edit-child-liquid-glass.png`, fullPage: true });
  }
});

test('halaman tambah balita memakai simbol dan kontrol bergaya iOS', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#add_child');

  const addChildPage = page.locator('[data-add-child-page]');
  await expect(page.getByRole('heading', { name: 'Registrasi Balita Baru' })).toBeVisible();
  await expect(addChildPage.locator('.apple-symbol-tile')).toHaveCount(4);
  await expect(addChildPage.locator('.ios-form-switch')).toHaveCount(2);

  const noKkSwitch = page.getByRole('checkbox', { name: 'Tidak punya KK' });
  await noKkSwitch.check();
  await expect(noKkSwitch).toBeChecked();

  await expect(page.getByRole('button', { name: 'Batal' }).locator('svg')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simpan Data Balita' }).locator('svg')).toBeVisible();
});

test('input MPASI memakai liquid glass dan dapat digulir sampai tombol simpan', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#mpasi');

  const mpasiAction = page.getByRole('button', { name: 'Input MPASI', exact: true });
  await expect(mpasiAction).toBeVisible();
  await mpasiAction.hover();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '1');
  await mpasiAction.click();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '0');

  const modal = page.locator('[data-mpasi-modal] .ios-liquid-modal');
  const scrollArea = page.locator('[data-mpasi-modal-scroll]');
  await expect(modal).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pemantauan MPASI' })).toBeVisible();
  await expect(scrollArea).toHaveCSS('overflow-y', 'auto');

  const dimensions = await scrollArea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(dimensions.scrollHeight).toBeGreaterThanOrEqual(dimensions.clientHeight);
  if ((page.viewportSize()?.width || 0) <= 480) {
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  }

  const foodChoice = page.getByRole('button', { name: /Makanan Pokok/ });
  await foodChoice.click();
  await expect(foodChoice).toHaveAttribute('aria-pressed', 'true');
  await scrollArea.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const lastFoodChoice = page.getByRole('button', { name: /Buah dan Sayur Lainnya/ });
  await expect(lastFoodChoice).toBeVisible();
  const lastFoodBox = await lastFoodChoice.boundingBox();
  const actionsBox = await page.locator('[data-mpasi-modal] .ios-modal-actions').boundingBox();
  expect(lastFoodBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect((lastFoodBox?.y || 0) + (lastFoodBox?.height || 0)).toBeLessThanOrEqual((actionsBox?.y || 0) + 1);
  await expect(page.getByRole('button', { name: 'Simpan Data MPASI' })).toBeVisible();
  await expect(modal).toHaveCSS('font-family', /apple-system|SF Pro|Helvetica Neue/);

  if (process.env.E2E_CAPTURE_UI) {
    await scrollArea.evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/mpasi-liquid-glass.png`, fullPage: true });
  }
});

test('riwayat perubahan selalu menampilkan perubahan terbaru paling atas', async ({ page }) => {
  await configureAuthenticatedPage(page, false, false, changeHistoryEntries);
  await page.goto('/#change_history');

  await expect(page.getByRole('heading', { name: 'Riwayat Perubahan Identitas' })).toBeVisible();
  await expect(page.locator('.apple-list-card h4')).toHaveText([
    'Perubahan Terbaru',
    'Perubahan Lama'
  ]);
});

test('sidebar desktop dapat diciutkan menjadi ikon dan dibuka kembali', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'Kontrol ciut hanya ditampilkan pada tablet dan desktop.');
  await configureAuthenticatedPage(page);
  await page.goto('/#dashboard');

  const appShell = page.locator('.app-shell');
  const content = page.locator('.app-shell > div.flex-1').first();
  const sidebarLabel = page.locator('.sidebar-nav-label').filter({ hasText: 'Dashboard' });
  const sidebarBrand = page.locator('[data-sidebar-brand]');
  await expect(appShell).toHaveClass(/is-sidebar-collapsed/);
  await expect(sidebarLabel).toBeHidden();
  await expect(sidebarBrand).toBeHidden();
  await expect(page.locator('.app-sidebar nav svg').first()).toBeVisible();
  await expect(page.locator('.sidebar-collapse-symbol')).toHaveCSS('background-color', 'rgb(0, 122, 255)');

  const compactBounds = await content.boundingBox();
  await page.locator('[data-nav-id="dashboard"]').hover();
  await expect(page.getByRole('tooltip')).toHaveText('Dashboard');
  await expect(page.getByRole('tooltip')).toHaveCSS('opacity', '1');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/sidebar-tooltip.png` });
  }

  const expandButton = page.getByRole('button', { name: 'Perluas Menu' });
  await expandButton.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Perluas Menu');
  await expandButton.click();
  await expect(appShell).not.toHaveClass(/is-sidebar-collapsed/);
  await expect(sidebarLabel).toBeVisible();
  await expect(sidebarBrand).toBeVisible();
  await expect(sidebarBrand).toContainText('E-Posyandu');
  await expect(sidebarBrand).toContainText('v3.4.0');
  await expect(page.getByRole('button', { name: 'Ringkas Menu', exact: true })).toBeVisible();
  await expect(page.locator('.app-sidebar')).toHaveCSS('width', '280px');

  const expandedBounds = await content.boundingBox();
  expect(expandedBounds?.x).toBe(compactBounds?.x);
  expect(expandedBounds?.width).toBe(compactBounds?.width);
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/sidebar-expanded-overlay.png` });
    await expect(appShell).not.toHaveClass(/is-sidebar-collapsed/);
  }

  await page.mouse.click(1000, 300);
  await expect(appShell).toHaveClass(/is-sidebar-collapsed/);

  await page.getByRole('button', { name: 'Perluas Menu' }).click();
  await page.getByRole('button', { name: 'Ringkas Menu', exact: true }).click();
  await expect(appShell).toHaveClass(/is-sidebar-collapsed/);
});

test('topbar dan Dock tidak melebar pada tablet', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1100 });
  await configureAuthenticatedPage(page);
  await page.goto('/#dashboard');

  await expect(page.locator('.app-topbar h1')).toHaveText('Dashboard');
  await expect(page.locator('.app-shell')).toHaveClass(/is-sidebar-collapsed/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const content = page.locator('.app-shell > div.flex-1').first();
  const compactBounds = await content.boundingBox();
  await page.getByRole('button', { name: 'Perluas Menu' }).click();
  const expandedBounds = await content.boundingBox();
  expect(expandedBounds?.x).toBe(compactBounds?.x);
  expect(expandedBounds?.width).toBe(compactBounds?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('header bersih, periode berada di panel data, tema dan footer berfungsi', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#dashboard');

  const topbar = page.locator('.app-topbar');
  const scopePanel = page.locator('[data-scope-panel]');
  await expect(topbar.locator('h1')).toHaveText('Dashboard');
  await expect(topbar).not.toContainText('Halaman Aktif');
  await expect(topbar).not.toContainText('E-Posyandu');
  await expect(topbar.getByLabel('Pilih bulan')).toHaveCount(0);
  await expect(scopePanel.getByLabel('Pilih bulan')).toBeVisible();
  await expect(scopePanel.getByLabel('Pilih tahun')).toBeVisible();
  await expect(scopePanel).not.toContainText('Filter Wilayah');
  if ((page.viewportSize()?.width || 0) < 768) {
    await page.getByRole('button', { name: 'Buka menu' }).click();
    await expect(page.locator('[data-sidebar-brand]')).toBeVisible();
    await expect(page.locator('[data-sidebar-brand]')).toContainText('UPTD Puskesmas Gumukmas');
    await page.getByRole('button', { name: 'Tutup menu' }).click();
  }
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/clean-header-light.png`, fullPage: true });
  }

  const themeToggle = page.getByRole('button', { name: 'Gunakan mode gelap' });
  await themeToggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Gunakan mode terang' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCSS('background-color', 'rgb(11, 11, 15)');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/clean-header-dark.png`, fullPage: true });
  }

  await expect(page.locator('.app-footer')).toContainText('© 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach');
  const versionButton = page.locator('.app-footer').getByRole('button', { name: 'E-Posyandu v3.4.0' });
  await expect(versionButton).toBeVisible();
  await versionButton.click();
  const releaseDialog = page.getByRole('dialog', { name: 'Apa yang Baru' });
  await expect(releaseDialog).toBeVisible();
  await expect(releaseDialog.getByText('2 Agustus 2026', { exact: true }).first()).toBeVisible();
  await expect(releaseDialog.getByText('v1.0.0', { exact: true })).toBeVisible();
  await releaseDialog.getByRole('button', { name: 'Selesai' }).click();
  await expect(releaseDialog).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('mode gelap menjaga kontras sidebar dan seluruh permukaan tabel', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#data_balita');
  await page.getByRole('button', { name: 'Gunakan mode gelap' }).click();

  const table = page.locator('.ios-data-table');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th').first()).toHaveCSS('color', 'rgba(235, 235, 245, 0.72)');
  await expect(table.locator('tbody td').first()).toHaveCSS('color', 'rgb(245, 245, 247)');

  const tableBackgrounds = await table.locator('thead th, tbody td').evaluateAll((cells) =>
    cells.map((cell) => getComputedStyle(cell).backgroundColor)
  );
  expect(tableBackgrounds).not.toContain('rgb(255, 255, 255)');
  expect(tableBackgrounds).not.toContain('rgba(255, 255, 255, 0.88)');

  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/children-table-dark.png`, fullPage: true });
  }

  if ((page.viewportSize()?.width || 0) < 768) {
    await page.getByRole('button', { name: 'Buka menu' }).click();
  } else {
    await page.getByRole('button', { name: 'Perluas Menu' }).click();
  }
  const sidebarLabel = page.locator('[data-nav-id="data_balita"] .sidebar-nav-label');
  await expect(sidebarLabel).toBeVisible();
  await expect(sidebarLabel).toHaveCSS('color', 'rgb(255, 255, 255)');

  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/sidebar-dark.png`, fullPage: true });
  }
});

test('mode gelap mencakup form identitas, pengukuran, ASI eksklusif, dan PMT', async ({ page }, testInfo) => {
  await configureAuthenticatedPage(page, false, true);
  await page.goto('/#data_balita');
  await page.getByRole('button', { name: 'Gunakan mode gelap' }).click();

  await page.getByRole('button', { name: 'Edit Identitas', exact: true }).click();
  const identityModal = page.locator('[data-identity-modal] .ios-liquid-modal');
  const identityInput = identityModal.locator('input:not([type="checkbox"]):not([type="radio"])').first();
  await expect(identityModal).toHaveCSS('background-color', 'rgba(29, 29, 34, 0.9)');
  await expect(identityInput).toHaveCSS('background-color', 'rgba(58, 58, 64, 0.82)');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/edit-child-dark-${testInfo.project.name}.png`, fullPage: true });
  }
  await identityModal.locator('.ios-modal-close').click();

  await page.getByRole('button', { name: 'Pengukuran Balita', exact: true }).click();
  const measurementTabs = page.locator('.measurement-segmented');
  await expect(measurementTabs).toHaveCSS('background-color', 'rgba(118, 118, 128, 0.24)');
  await expect(measurementTabs.getByRole('tab', { name: 'Riwayat' })).toHaveCSS('background-color', 'rgba(72, 72, 78, 0.96)');
  await measurementTabs.getByRole('tab', { name: 'Tambah' }).click();
  const measurementForm = page.locator('.ios-measurement-form');
  await expect(measurementForm.locator('.measurement-form-panel').first()).toHaveCSS('background-color', 'rgba(44, 44, 49, 0.82)');
  await expect(measurementForm.locator('input:not([type="checkbox"]):not([type="radio"])').first()).toHaveCSS('background-color', 'rgba(58, 58, 64, 0.82)');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/measurement-form-dark-${testInfo.project.name}.png`, fullPage: true });
  }

  await page.goto('/#asi_eksklusif');
  await expect(page.locator('.apple-summary-card').first()).toHaveCSS('background-color', 'rgba(38, 38, 43, 0.84)');
  await expect(page.locator('.apple-segmented-control button').first()).toHaveCSS('background-color', 'rgba(72, 72, 78, 0.96)');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/exclusive-breastfeeding-dark-${testInfo.project.name}.png`, fullPage: true });
  }

  await page.goto('/#pmt_program');
  await expect(page.locator('.pmt-filter-bar')).toHaveCSS('background-color', 'rgba(38, 38, 43, 0.78)');
  await page.getByRole('button', { name: `Pantau PMT ${child.data.nama}` }).click();
  const monitoringModal = page.locator('[data-pmt-monitoring-modal] .ios-liquid-modal');
  await expect(monitoringModal).toHaveCSS('background-color', 'rgba(29, 29, 34, 0.9)');
  await expect(monitoringModal.locator('input:not([type="checkbox"]):not([type="radio"])').first()).toHaveCSS('background-color', 'rgba(58, 58, 64, 0.82)');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/pmt-monitoring-dark-${testInfo.project.name}.png`, fullPage: true });
  }
  await monitoringModal.locator('.ios-modal-close').click();

  await page.goto('/#problem_tidak_naik');
  await page.getByRole('button', { name: 'Beri PMT', exact: true }).click();
  const createModal = page.locator('[data-pmt-create-modal] .ios-liquid-modal');
  await expect(createModal).toHaveCSS('background-color', 'rgba(29, 29, 34, 0.9)');
  await expect(createModal.locator('input:not([type="checkbox"]):not([type="radio"])').first()).toHaveCSS('background-color', 'rgba(58, 58, 64, 0.82)');

  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/pmt-create-dark-${testInfo.project.name}.png`, fullPage: true });
  }
});

test('notifikasi operasi memakai liquid glass iOS dan dapat ditutup', async ({ page }, testInfo) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#dashboard');
  await page.evaluate(async (moduleUrl) => {
    const notifications = await import(moduleUrl);
    notifications.showSuccess('Program PMT berhasil dihapus.');
  }, '/src/native/notifications.ts');

  const notification = page.locator('.ios-notification');
  await expect(notification).toBeVisible();
  await expect(notification).toContainText('Berhasil');
  await expect(notification).toContainText('Program PMT berhasil dihapus.');
  await expect(notification).toHaveCSS('backdrop-filter', /blur/);
  await expect(notification.locator('.ios-notification-icon')).toHaveCSS('background-color', 'rgb(52, 199, 89)');

  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/notification-ios-${testInfo.project.name}.png`, fullPage: true });
  }

  await page.getByRole('button', { name: 'Tutup notifikasi' }).click();
  await expect(notification).toHaveCount(0);
});

test('mobile landscape memakai Dock ikon tanpa menyempitkan halaman', async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 360 });
  await configureAuthenticatedPage(page);
  await page.goto('/#dashboard');

  const appShell = page.locator('.app-shell');
  const content = page.locator('.app-shell > div.flex-1').first();
  await expect(appShell).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.getByRole('button', { name: 'Buka menu' })).toBeHidden();

  const compactBounds = await content.boundingBox();
  await page.getByRole('button', { name: 'Perluas Menu' }).click();
  await expect(appShell).not.toHaveClass(/is-sidebar-collapsed/);
  const expandedBounds = await content.boundingBox();
  expect(expandedBounds?.x).toBe(compactBounds?.x);
  expect(expandedBounds?.width).toBe(compactBounds?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/sidebar-mobile-landscape.png`, fullPage: true });
  }
});

test('form penimbangan memakai tata letak iOS yang responsif', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#data_balita');
  const measurementAction = page.getByRole('button', { name: 'Pengukuran Balita', exact: true });
  await measurementAction.hover();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '1');
  await measurementAction.click();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('heading', { name: 'Pengukuran Balita' })).toBeVisible();

  const historyScroll = page.locator('.measurement-history-scroll');
  await expect(historyScroll).toBeVisible();
  const historyDimensions = await historyScroll.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(historyDimensions.scrollWidth).toBeGreaterThan(historyDimensions.clientWidth);
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/measurement-history.png`, fullPage: true });
  }
  await historyScroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => historyScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Tambah' }).click();

  const measurementPage = page.locator('[data-measurement-page]');
  await expect(measurementPage.locator('.ios-measurement-form')).toBeVisible();
  await expect(measurementPage.locator('.measurement-form-panel')).toHaveCount(3);
  await expect(measurementPage.locator('.measurement-status-panel')).toBeVisible();
  await expect(measurementPage.locator('.measurement-service-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simpan Pengukuran' }).locator('svg')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('PMT ditampilkan sebagai tabel mingguan dan dapat difilter per kategori', async ({ page }) => {
  await configureAuthenticatedPage(page);
  await page.goto('/#pmt_program');

  await expect(page.getByRole('heading', { name: 'Program Pemberian PMT' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Sumber Anggaran' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Pengukuran Awal' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Minggu 8' })).toBeVisible();
  await expect(page.getByText('BOK Puskesmas', { exact: true })).toBeVisible();
  await expect(page.getByText('TP PKK Desa Gumukmas', { exact: true })).toBeVisible();

  const monitoringButton = page.getByRole('button', { name: `Pantau PMT ${child.data.nama}` });
  await expect(monitoringButton).toBeEnabled();
  await monitoringButton.hover();
  await expect(page.locator('.table-action-tooltip')).toHaveText('Isi pemantauan mingguan');
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '1');
  await expect(monitoringButton).toHaveCSS('background-color', 'rgb(0, 122, 255)');
  await monitoringButton.click();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('heading', { name: 'Pemantauan Mingguan' })).toBeVisible();
  await expect(page.locator('[data-pmt-monitoring-modal] .ios-liquid-modal')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Minggu 1' })).toHaveAttribute('aria-selected', 'true');
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/pmt-monitoring-liquid-glass.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Tutup pemantauan PMT' }).click();

  const deleteButton = page.getByRole('button', { name: `Hapus PMT ${child.data.nama}` });
  await expect(deleteButton).toBeEnabled();
  await deleteButton.hover();
  await expect(page.locator('.table-action-tooltip')).toHaveText('Hapus program PMT');
  await expect(deleteButton).toHaveCSS('background-color', 'rgb(255, 59, 48)');

  await page.getByRole('tab', { name: 'Underweight' }).click();
  await expect(page.getByText('Belum ada program PMT pada kategori ini.')).toBeVisible();
  await page.getByRole('tab', { name: 'Wasting' }).click();
  await expect(page.getByText('BB 8.4 kg', { exact: true })).toBeVisible();

});

test('ikon pemberian PMT pada tabel masalah gizi mengikuti gaya Dock iOS', async ({ page }) => {
  await configureAuthenticatedPage(page, false, true);
  await page.goto('/#problem_tidak_naik');

  const pmtAction = page.getByRole('button', { name: 'Beri PMT', exact: true });
  await expect(pmtAction).toBeVisible();
  await pmtAction.hover();
  await expect(page.locator('.table-action-tooltip')).toHaveText('Beri PMT');
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '1');
  await expect(pmtAction).toHaveCSS('background-color', 'rgb(52, 199, 89)');
  await pmtAction.click();
  await expect(page.locator('.table-action-tooltip')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('heading', { name: 'Pemberian PMT' })).toBeVisible();
  await expect(page.locator('[data-pmt-create-modal] .ios-liquid-modal')).toBeVisible();
  await expect(page.getByText('TidakNaik', { exact: true })).toBeVisible();
  if (process.env.E2E_CAPTURE_UI) {
    await page.screenshot({ path: `${process.env.E2E_CAPTURE_UI}/pmt-create-liquid-glass.png`, fullPage: true });
  }
});
