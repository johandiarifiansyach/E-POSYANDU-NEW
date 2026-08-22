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

  test('creates scoped defaults and unique temporary identity values', () => {
    const form = createInitialChildForm({
      role: 'Kader Posyandu',
      desa: 'Desa Gumukmas',
      posyandu: 'SALAK 2'
    });
    const kk = generateTemporaryKk();
    const nik = generateTemporaryNik({ tglLahir: '2026-01-02' }, [{ nik: '3509040201260000' }]);

    expect(form.desa).toBe('Desa Gumukmas');
    expect(form.posyandu).toBe('SALAK 2');
    expect(kk).toMatch(/^350904\d{10}$/);
    expect(nik).toMatch(/^350904020126\d{4}$/);
    expect(nik).not.toBe('3509040201260000');
  });
});
