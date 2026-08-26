import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import {
  createInitialChildForm,
  formatChildName,
  generateTemporaryKk,
  generateTemporaryNik,
  validateChildBirthMeasurements
} from '../../frontend/src/features/children/childRules';

test.describe('children feature', () => {
  test('formats each part of a child name', () => {
    expect(formatChildName('depan tengah-belakang')).toBe('Depan Tengah-Belakang');
  });

  test('accepts kilogram and centimetre birth measurements', () => {
    const result = validateChildBirthMeasurements({
      bbLahir: '3,2',
      pbLahir: '49,5',
      lkLahir: '33,2'
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ bbLahir: 3.2, pbLahir: 49.5, lkLahir: 33.2 });
  });

  test('rejects birth weight entered in gram-sized values', () => {
    const result = validateChildBirthMeasurements({
      bbLahir: '3200',
      pbLahir: '49,5',
      lkLahir: '33,2'
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('kilogram');
  });

  test('creates scoped defaults and Posyandu-coded temporary NIK', () => {
    const form = createInitialChildForm({
      role: 'Kader Posyandu',
      desa: 'Desa Gumukmas',
      posyandu: 'SALAK 2'
    });
    const kk = generateTemporaryKk();
    const nik = generateTemporaryNik({ tglLahir: '2026-01-02', posyandu: 'SALAK 2' });

    expect(form.desa).toBe('Desa Gumukmas');
    expect(form.posyandu).toBe('SALAK 2');
    expect(kk).toMatch(/^350904\d{10}$/);
    expect(nik).toBe('3509040201260002');
  });

  test('uses a random 10-60 suffix for SALAK 61, 98, and 99', () => {
    for (const posyandu of ['SALAK 61', 'SALAK 98', 'SALAK 99']) {
      const nik = generateTemporaryNik({ tglLahir: '2026-01-02', posyandu });
      expect(nik).toMatch(/^35090402012600(?:1[0-9]|[2-5][0-9]|60)$/);
    }
  });

  test('changes the suffix to 10-60 when a generated NIK already exists', () => {
    const existingNiks = [{ nik: '3509040201260002' }];
    const nik = generateTemporaryNik({ tglLahir: '2026-01-02', posyandu: 'SALAK 2' }, existingNiks);

    expect(nik).toMatch(/^35090402012600(?:1[0-9]|[2-5][0-9]|60)$/);
    expect(nik).not.toBe(existingNiks[0].nik);
  });
});
