import { test, expect } from '../../frontend-react/node_modules/@playwright/test/index.mjs';
import {
  getMeasurementStatuses,
  measurementMethodForAge,
  validateMeasurementForm,
} from '../../frontend-react/src/compat/features/measurements/measurementRules';
import {
  calculateGiziStatus,
  calculateZScore,
} from '../../frontend-react/src/compat/shared/dashboardUtils';
import {
  GROWTH_CHART_LABELS,
  GROWTH_CHART_TYPES,
  safeChildFileName,
} from '../../frontend-react/src/compat/features/measurements/growthCharts';
import { fetchChildMeasurementHistory } from '../../frontend-react/src/compat/services/measurementService';

test.describe('measurement feature', () => {
  test('selects the automatic measurement method at the 24-month boundary', () => {
    expect(measurementMethodForAge(0)).toBe('Terlentang');
    expect(measurementMethodForAge(23)).toBe('Terlentang');
    expect(measurementMethodForAge(24)).toBe('Berdiri');
    expect(measurementMethodForAge(59)).toBe('Berdiri');
  });

  test('normalizes valid local decimal input before saving', () => {
    const result = validateMeasurementForm({
      date: '2026-02-01',
      bb: '3,2',
      tb: '50,5',
      lila: '13,2',
      lk: '34,1',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      measurementDate: '2026-02-01',
      bb: 3.2,
      tb: 50.5,
      lila: 13.2,
      lk: 34.1,
    });
  });

  test('rejects an out-of-range gram-sized value', () => {
    const result = validateMeasurementForm({
      date: '2026-02-01',
      bb: '32000',
      tb: '50',
      lila: '13',
      lk: '34',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Berat badan');
  });

  test('does not request or persist LILA for infants aged 0-2 months', () => {
    const result = validateMeasurementForm({
      date: '2026-02-01',
      ageInMonths: 1,
      bb: '3,2',
      tb: '50,5',
      lila: '',
      lk: '34,1',
    });

    expect(result.ok).toBe(true);
    expect(result.data.lila).toBeNull();
  });

  test('requires LILA from three completed months', () => {
    const result = validateMeasurementForm({
      date: '2026-04-01',
      ageInMonths: 3,
      bb: '6,3',
      tb: '61,4',
      lila: '',
      lk: '40,5',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('LiLa');
  });

  test('keeps WHO, z-score, and status calculations delegated to Python', () => {
    const statuses = getMeasurementStatuses({
      tglUkur: '2026-02-01',
      bb: 3.2,
      tb: 50,
      caraUkur: 'Terlentang',
    }, { tglLahir: '2026-01-01', jk: 'L' });

    expect(statuses.pythonRequired).toBe(true);
    expect(statuses.statusBbu).toBe('-');
    expect(calculateZScore(3.2, 'BBU', 1, 'L')).toBeNull();
    expect(calculateGiziStatus(3.2, 'BBU', 1, 'L')).toBe('-');
  });

  test('exposes the six chart types without calculating chart data in the browser', () => {
    expect(GROWTH_CHART_TYPES).toEqual(['bbu', 'tbu', 'bbtb', 'imtu', 'lilau', 'lku']);
    expect(GROWTH_CHART_LABELS.bbu).toBe('BB/U');
    expect(GROWTH_CHART_LABELS.lilau).toBe('LILA/U');
    expect(safeChildFileName({ nama: 'Bayi Satu / Test' })).toBe('bayi-satu-test');
  });

  test('loads every previous measurement through the paginated read path', async () => {
    const child = {
      id: 'child-1',
      nama: 'Bayi Satu',
      tglLahir: '2026-01-01',
      lastMeasurementDate: '2026-08-15',
      jk: 'L',
      desa: 'Desa Satu',
      posyandu: 'Posyandu Satu',
    };
    const records = [
      { id: 'm-aug', data: { childId: 'child-1', tglUkur: '2026-08-15', bb: 7.5 } },
      { id: 'm-jul', data: { childId: 'child-1', tglUkur: '2026-07-10', bb: 7.1 } },
      { id: 'm-jun', data: { childId: 'child-1', tglUkur: '2026-06-05', bb: 6.7 } },
    ];
    const requestedEnds: string[] = [];
    const readPage = async (request: { measurementEnd: string }) => {
      requestedEnds.push(request.measurementEnd);
      const latest = records.find((record) => record.data.tglUkur <= request.measurementEnd);
      return {
        items: [{ id: child.id, data: child }],
        measurements: latest ? [latest] : [],
        total: 1,
      };
    };

    const history = await fetchChildMeasurementHistory(child, new Date('2026-08-16T00:00:00'), readPage);
    expect(history.map((measurement) => measurement.tglUkur)).toEqual([
      '2026-08-15', '2026-07-10', '2026-06-05',
    ]);
    expect(requestedEnds).toEqual(['2026-08-15', '2026-08-14', '2026-07-09', '2026-06-04']);
  });
});
