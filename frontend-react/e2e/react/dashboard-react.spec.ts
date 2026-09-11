import { expect, test } from '@playwright/test';

const dashboardStats = {
  S: 3100,
  D: 3050,
  N: 1600,
  T: 1450,
  B: 12,
  O: 38,
  asiEksklusif: 21,
  asiTarget: 43,
  underweight: 289,
  stunting: 395,
  wasting: 198,
  perD: '98.4',
  perN: '52.5',
  perT: '47.5',
  perAsiEksklusif: '48.8',
  perUnderweight: '9.3',
  perStunting: '12.7',
  perWasting: '6.4',
  snapshotStale: false,
  // A projection can contain usable aggregate values while Python finishes
  // a few clinical rows. The page must keep those values visible.
  analysisPending: true
};

test('dashboard React mempertahankan snapshot, filter, dan agregasi', async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('e-posyandu:auth-session', JSON.stringify({ uid: 'react-smoke-user' }));
    window.localStorage.removeItem('e-posyandu:user');
  });
  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({ status: 200, json: { user: { id: 'react-smoke-user', email: 'smoke@example.test' } } });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({ status: 200, json: {
      userId: 'react-smoke-user',
      email: 'smoke@example.test',
      role: 'Ahli Gizi',
      desa: null,
      posyandu: null,
      accessMode: 'read'
    } });
  });
  await page.route('**/api/v1/analysis/dashboard-stats', async (route) => {
    await route.fulfill({ status: 200, json: dashboardStats });
  });
  await page.route('**/api/v1/monitoring/status', async (route) => {
    await route.fulfill({ status: 200, json: {
      environment: 'test',
      worker: { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 4, statusCode: 200, consecutiveFailures: 0, lastSuccessAt: new Date().toISOString(), lastFailureAt: null },
      database: { isolation: 'isolated', writesProtected: true },
      storage: { r2Configured: false, status: null },
      queue: { configured: true },
      alerts: { externalConfigured: false }
    } });
  });
  await page.route('**/api/v1/children/page?**', async (route) => {
    await route.fulfill({ status: 200, json: {
      items: [{ id: 'child-1', data: { nama: 'Balita Uji React', nik: '3509040101250001', hasNIK: false, jk: 'P', tglLahir: '2025-01-01', ageInMonths: 20, namaOrtu: 'Orang Tua Uji', desa: 'Desa Gumukmas', posyandu: 'SALAK 1' } }],
      measurements: [{ id: 'measurement-1', data: { childId: 'child-1', bb: 10.5, tb: 80, lila: 15, lk: 46, bbuStatus: 'Berat Badan Normal', tbuStatus: 'Normal', bbtbStatus: 'Gizi Baik', imtuStatus: 'Gizi Baik', weightGainStatus: 'N' } }],
      total: 1,
      pageLimited: true
    } });
  });
  await page.route('**/api/v1/exclusive-breastfeeding/page?**', async (route) => {
    await route.fulfill({ status: 200, json: {
      items: [{ id: 'asi-child-1', data: { nama: 'Bayi ASI React', nik: '9876543210987654', ageInMonths: 6, tglUkur: '2026-09-05', posyandu: 'SALAK 1', desa: 'Desa Gumukmas' } }],
      total: 1
    } });
  });
  await page.route('**/api/v1/collections/change_logs?**', async (route) => {
    await route.fulfill({ status: 200, json: {
      items: [{ id: 'change-1', data: { childName: 'Balita Riwayat React', changedBy: 'Petugas Uji', timestamp: '2026-09-05T08:00:00Z', changes: [{ field: 'nama', oldValue: 'Nama Lama', newValue: 'Nama Baru' }] } }],
      total: 1
    } });
  });
  await page.route('**/api/v1/children/page?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('view') !== 'mpasi') return route.fallback();
    await route.fulfill({ status: 200, json: {
      items: [{ id: 'mpasi-child-1', data: { nama: 'Balita MPASI React', nik: '1111222233334444', desa: 'Desa Gumukmas', posyandu: 'SALAK 1' } }],
      mpasiLogs: [{ id: 'mpasi-log-1', data: { childId: 'mpasi-child-1', tglMonitoring: '2026-09-05', asi: 'Ya', makananPokok: ['nasi'], kacang: [], susu: ['susu'], daging: ['ayam'], telur: [], sayurVitA: ['wortel'], sayurLain: [], intervensiGizi: 'Lanjutkan MPASI beragam' } }],
      measurements: [],
      total: 1
    } });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Capaian Program SKDN' })).toBeVisible();
  await expect(page.getByText('3100', { exact: true })).toBeVisible();
  await expect(page.getByText('21 / 43 bayi', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Memperbarui ringkasan')).toBeVisible();
  await expect(page.getByLabel('Pilih kelompok umur')).toHaveValue('0-59');

  await page.getByLabel('Pilih kelompok umur').selectOption('6-23');
  await page.getByRole('button', { name: 'Terapkan filter wilayah' }).click();
  await expect(page.getByRole('heading', { name: 'Capaian Program SKDN' })).toBeVisible();
  const openMenuOnNarrowViewport = async () => {
    if ((page.viewportSize()?.width || 0) < 900) {
      await page.getByRole('button', { name: 'Buka menu' }).click();
    }
  };
  await openMenuOnNarrowViewport();
  await page.getByRole('button', { name: 'Data Balita' }).click();
  await expect(page.getByRole('heading', { name: 'Data Balita Lengkap' })).toBeVisible();
  await expect(page.getByText('Balita Uji React', { exact: true })).toBeVisible();
  await expect(page.getByText('3509040101250001', { exact: true })).toHaveClass(/text-red-600/);
  await expect(page.getByLabel('Pilih kelompok umur')).toHaveValue('0-59');
  await openMenuOnNarrowViewport();
  await page.getByRole('button', { name: 'ASI Eksklusif' }).click();
  await expect(page.getByRole('heading', { name: 'Daftar ASI Eksklusif' })).toBeVisible();
  await expect(page.getByText('Bayi ASI React', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Pilih kelompok umur')).toHaveValue('0-5');
  await openMenuOnNarrowViewport();
  await page.getByRole('button', { name: 'Riwayat Perubahan' }).click();
  await expect(page.getByRole('heading', { name: 'Riwayat Perubahan Identitas' })).toBeVisible();
  await expect(page.getByText('Balita Riwayat React', { exact: true })).toBeVisible();
  await openMenuOnNarrowViewport();
  await page.getByRole('button', { name: 'MPASI' }).click();
  await expect(page.getByRole('heading', { name: 'Balita MPASI (6-23 Bulan)' })).toBeVisible();
  await expect(page.getByText('Balita MPASI React', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Pilih kelompok umur')).toHaveCount(0);
});
