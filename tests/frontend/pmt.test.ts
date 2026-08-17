import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import {
  categoryMetric,
  getMonitoringForWeek,
  maxWeeksForCategory,
  monitoringStatus,
  numericValue
} from '../../frontend/src/features/pmt/pmtRules';

test.describe('pmt feature', () => {
  test('uses the correct monitoring duration and nutrition index', () => {
    expect(maxWeeksForCategory('Wasting')).toBe(8);
    expect(maxWeeksForCategory('Underweight')).toBe(4);
    expect(maxWeeksForCategory('TidakNaik')).toBe(2);
    expect(categoryMetric('Wasting')).toBe('BB/TB');
    expect(categoryMetric('Underweight')).toBe('BB/U');
    expect(categoryMetric('TidakNaik')).toBe('N/T');
  });

  test('normalizes PMT numeric values and finds a monitoring week', () => {
    const program = {
      monitorings: [
        { week: 1, bb: '3,2', tb: '50' },
        { week: 2, bb: '3,4', tb: '50,5' }
      ]
    };

    expect(numericValue('3,2')).toBe(3.2);
    expect(numericValue('0')).toBeNull();
    expect(getMonitoringForWeek(program, 2)).toEqual({ week: 2, bb: '3,4', tb: '50,5' });
  });

  test('marks a no-gain PMT program from consecutive weights', () => {
    const program = {
      category: 'TidakNaik',
      monitorings: [{ week: 1, bb: 3.1 }]
    };
    const baseline = { weight: 3.1 };

    expect(monitoringStatus(program, {}, null, 0, baseline)).toBe('T');
    expect(monitoringStatus(program, {}, { bb: 3.1 }, 1, baseline)).toBe('T');
    expect(monitoringStatus(program, {}, { bb: 3.4 }, 1, baseline)).toBe('N');
  });
});
