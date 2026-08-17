import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { getUserScope, hasRole } from '../../frontend/src/services/authService';

test.describe('auth feature', () => {
  test('keeps the authenticated user scope in one shape', () => {
    expect(getUserScope({
      role: 'Kader Posyandu',
      desa: 'Desa Gumukmas',
      posyandu: 'SALAK 1'
    })).toEqual({
      role: 'Kader Posyandu',
      desa: 'Desa Gumukmas',
      posyandu: 'SALAK 1'
    });
  });

  test('checks role without throwing for a missing session', () => {
    expect(hasRole(null, 'Ahli Gizi')).toBe(false);
    expect(hasRole({ role: 'Ahli Gizi' }, 'Ahli Gizi')).toBe(true);
    expect(hasRole({ role: 'Kader Posyandu' }, 'Ahli Gizi')).toBe(false);
  });
});
