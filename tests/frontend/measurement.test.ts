import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import {
  calculateWhoLmsValue,
  calculateCircumferenceZScore,
  calculateWeightGainStatus,
  getCircumferenceStatus,
  getMeasurementStatuses,
  validateMeasurementForm
} from '../../frontend/src/features/measurements/measurementRules';
import {
  calculateGiziStatus,
  calculateZScore
} from '../../frontend/src/shared/dashboardUtils';
import { getGrowthChartModels } from '../../frontend/src/features/measurements/growthCharts';
import {
  buildAnonymousGrowthSummaryPayload,
  buildLocalGrowthSummaryFallback
} from '../../frontend/src/features/measurements/growthSummary';
import { fetchChildMeasurementHistory } from '../../frontend/src/services/measurementService';

const child = { tglLahir: '2026-01-01', jk: 'L' };

test.describe('measurement feature', () => {
  test('normalizes valid local decimal input before saving', () => {
    const result = validateMeasurementForm({
      date: '2026-02-01',
      bb: '3,2',
      tb: '50,5',
      lila: '13,2',
      lk: '34,1'
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      measurementDate: '2026-02-01',
      bb: 3.2,
      tb: 50.5,
      lila: 13.2,
      lk: 34.1
    });
  });

  test('rejects an out-of-range gram-sized value', () => {
    const result = validateMeasurementForm({
      date: '2026-02-01',
      bb: '32000',
      tb: '50',
      lila: '13',
      lk: '34'
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
      lk: '34,1'
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
      lk: '40,5'
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('LiLa');
  });

  test('classifies first, naik, tidak naik, and tidak ditimbang records', () => {
    expect(calculateWeightGainStatus(
      { tglUkur: '2026-01-31', bb: 2.8 },
      null,
      child
    )).toBe('B');

    expect(calculateWeightGainStatus(
      { tglUkur: '2026-02-01', bb: 3.4 },
      { tglUkur: '2026-01-01', bb: 2.5 },
      child
    )).toBe('N');

    expect(calculateWeightGainStatus(
      { tglUkur: '2026-02-01', bb: 3.1 },
      { tglUkur: '2026-01-01', bb: 2.5 },
      child
    )).toBe('T');

    expect(calculateWeightGainStatus(
      { tglUkur: '2026-03-01', bb: 3.4 },
      { tglUkur: '2026-01-01', bb: 2.5 },
      child
    )).toBe('O');
  });

  test('returns all six WHO growth status fields for a saved measurement', () => {
    const statuses = getMeasurementStatuses({
      tglUkur: '2026-02-01',
      bb: 3.2,
      tb: 50,
      caraUkur: 'Terlentang'
    }, child);

    expect(statuses.age).toBe(1);
    expect(statuses).toHaveProperty('statusBbu');
    expect(statuses).toHaveProperty('statusTbu');
    expect(statuses).toHaveProperty('statusBbtb');
    expect(statuses).toHaveProperty('statusImtu');
    expect(statuses.statusLilau).toBe('-');
    expect(statuses).toHaveProperty('statusLku');
  });

  test('classifies LILA/U and LK/U from WHO LMS medians', () => {
    const statuses = getMeasurementStatuses({
      tglUkur: '2026-04-01',
      bb: 6.38,
      tb: 61.43,
      lila: 13.4817,
      lk: 40.5135,
      caraUkur: 'Terlentang'
    }, child);

    expect(statuses.statusLilau).toBe('LILA Normal');
    expect(statuses.statusLku).toBe('Normal');
    expect(calculateCircumferenceZScore(13.4817, 'lila', 3, 'L')).toBeCloseTo(0, 5);
    expect(calculateCircumferenceZScore(40.5135, 'lk', 3, 'L')).toBeCloseTo(0, 5);
  });

  test('matches WHO LMS golden medians for all six indicators', () => {
    expect(calculateZScore(3.3464, 'BBU', 0, 'L')).toBeCloseTo(0, 10);
    expect(calculateZScore(49.1477, 'TBU', 0, 'P')).toBeCloseTo(0, 10);
    expect(calculateZScore(3.3278, 'BBTB', 3, 'L', 50, 'Terlentang')).toBeCloseTo(0, 10);

    const bmiMedianWeight = 16.8987 * Math.pow(61.4292 / 100, 2);
    expect(calculateZScore(bmiMedianWeight, 'IMTU', 3, 'L', 61.4292, 'Terlentang')).toBeCloseTo(0, 10);
    expect(calculateCircumferenceZScore(13.0284, 'lila', 3, 'P')).toBeCloseTo(0, 10);
    expect(calculateCircumferenceZScore(34.4618, 'lk', 0, 'L')).toBeCloseTo(0, 10);
  });

  test('keeps WHO age boundaries and length-height conversion auditable', () => {
    expect(calculateCircumferenceZScore(13, 'lila', 2, 'L')).toBeNull();
    expect(calculateCircumferenceZScore(13.4817, 'lila', 3, 'L')).toBeCloseTo(0, 10);
    expect(calculateCircumferenceZScore(16.5191, 'lila', 60, 'L')).toBeCloseTo(0, 10);
    expect(calculateCircumferenceZScore(49.9229, 'lk', 60, 'P')).toBeCloseTo(0, 10);

    expect(calculateZScore(87.1161, 'TBU', 24, 'L', null, 'Berdiri')).toBeCloseTo(0, 10);
    expect(calculateZScore(88.672, 'TBU', 25, 'L', null, 'Terlentang')).toBeCloseTo(0, 10);
  });

  test('uses documented z-score status boundaries', () => {
    const lilaLms = [0.3928, 13.4817, 0.07475];
    const belowMinusThree = calculateWhoLmsValue(-3.01, lilaLms);
    const betweenMinusThreeAndMinusTwo = calculateWhoLmsValue(-2.5, lilaLms);
    const abovePlusTwo = calculateWhoLmsValue(2.01, lilaLms);

    expect(getCircumferenceStatus(belowMinusThree, 'lila', 3, 'L')).toBe('LILA Sangat Rendah');
    expect(getCircumferenceStatus(betweenMinusThreeAndMinusTwo, 'lila', 3, 'L')).toBe('LILA Rendah');
    expect(getCircumferenceStatus(abovePlusTwo, 'lila', 3, 'L')).toBe('LILA Tinggi');
    const weightForAgeLms = [0.3487, 3.3464, 0.14602];
    expect(calculateGiziStatus(calculateWhoLmsValue(-3.01, weightForAgeLms), 'BBU', 0, 'L')).toBe('Berat Sangat Kurang');
    expect(calculateGiziStatus(calculateWhoLmsValue(-2.5, weightForAgeLms), 'BBU', 0, 'L')).toBe('Berat Kurang');
  });

  test('builds six WHO chart models and omits LILA points below three months', () => {
    const models = getGrowthChartModels([
      { tglUkur: '2026-02-01', bb: 4.4, tb: 54.7, lila: 12.7, lk: 37.3, caraUkur: 'Terlentang' },
      { tglUkur: '2026-04-01', bb: 6.4, tb: 61.4, lila: 13.5, lk: 40.5, caraUkur: 'Terlentang' }
    ], child);

    expect(Object.keys(models)).toEqual(['bbu', 'tbu', 'bbtb', 'imtu', 'lilau', 'lku']);
    expect(models.bbu.curves).toHaveLength(5);
    expect(models.lilau.curves[0].points[0].x).toBe(3);
    expect(models.lilau.childPoints).toHaveLength(1);
    expect(models.lku.childPoints).toHaveLength(2);
  });

  test('loads every previous measurement and plots them chronologically as multiple points', async () => {
    const completeChild = {
      id: 'child-1',
      nama: 'Bayi Satu',
      tglLahir: '2026-01-01',
      lastMeasurementDate: '2026-08-15',
      jk: 'L',
      desa: 'Desa Satu',
      posyandu: 'Posyandu Satu'
    };
    const records = [
      { id: 'm-aug', data: { childId: 'child-1', tglUkur: '2026-08-15', bb: 7.5, tb: 67.4, lila: 14.1, lk: 43.2 } },
      { id: 'm-jul', data: { childId: 'child-1', tglUkur: '2026-07-10', bb: 7.1, tb: 65.8, lila: 13.9, lk: 42.5 } },
      { id: 'm-jun', data: { childId: 'child-1', tglUkur: '2026-06-05', bb: 6.7, tb: 63.9, lila: 13.7, lk: 41.8 } }
    ];
    const requestedEnds = [];
    const readPage = async (request) => {
      requestedEnds.push(request.measurementEnd);
      const latest = records.find((record) => record.data.tglUkur <= request.measurementEnd);
      return {
        items: [{ id: completeChild.id, data: completeChild }],
        measurements: latest ? [latest] : [],
        total: 1
      };
    };

    const history = await fetchChildMeasurementHistory(completeChild, new Date('2026-08-16T00:00:00'), readPage);
    expect(history.map((measurement) => measurement.tglUkur)).toEqual([
      '2026-08-15', '2026-07-10', '2026-06-05'
    ]);
    expect(requestedEnds).toEqual(['2026-08-15', '2026-08-14', '2026-07-09', '2026-06-04']);

    const models = getGrowthChartModels(history, completeChild);
    expect(models.bbu.childPoints).toHaveLength(3);
    expect(models.bbu.childPoints.map((point) => point.x)).toEqual([...models.bbu.childPoints.map((point) => point.x)].sort((a, b) => a - b));
  });

  test('breaks growth lines when the previous calendar month was not weighed or status is O', () => {
    const completeChild = { tglLahir: '2025-10-01', jk: 'L' };
    const models = getGrowthChartModels([
      { tglUkur: '2026-01-10', bb: 3.4, tb: 51, lila: 12.1, lk: 35, caraUkur: 'Terlentang', statusNaik: 'B' },
      { tglUkur: '2026-02-10', bb: 4.3, tb: 55, lila: 12.6, lk: 37, caraUkur: 'Terlentang', statusNaik: 'N' },
      { tglUkur: '2026-04-10', bb: 5.8, tb: 61, lila: 13.2, lk: 40, caraUkur: 'Terlentang', statusNaik: 'O' },
      { tglUkur: '2026-05-10', bb: 6.3, tb: 63, lila: 13.5, lk: 41, caraUkur: 'Terlentang', statusNaik: 'N' },
    ], completeChild);

    for (const model of Object.values(models)) {
      expect(model.childPoints.map((point) => point.breakBefore)).toEqual([false, false, true, false]);
    }
  });

  test('does not connect across a recorded month with a missing value for that chart', () => {
    const models = getGrowthChartModels([
      { tglUkur: '2026-03-10', bb: 5.1, tb: 58, lila: 12.9, lk: 39, caraUkur: 'Terlentang', statusNaik: 'N' },
      { tglUkur: '2026-04-10', bb: 5.7, tb: 61, lila: 13.2, lk: null, caraUkur: 'Terlentang', statusNaik: 'N' },
      { tglUkur: '2026-05-10', bb: 6.2, tb: 63, lila: 13.5, lk: 41, caraUkur: 'Terlentang', statusNaik: 'N' },
    ], { tglLahir: '2026-01-01', jk: 'L' });

    expect(models.bbu.childPoints.map((point) => point.breakBefore)).toEqual([false, false, false]);
    expect(models.lku.childPoints.map((point) => point.breakBefore)).toEqual([false, true]);
  });

  test('builds an anonymous AI payload without child identity or measurement dates', () => {
    const privateChild = {
      id: 'child-private-123',
      nama: 'Bayi Sangat Rahasia',
      nik: '3509040101260001',
      tglLahir: '2026-01-01',
      jk: 'P',
      alamat: 'Jalan Rahasia 10',
      desa: 'Desa Rahasia',
      posyandu: 'Posyandu Rahasia'
    };
    const payload = buildAnonymousGrowthSummaryPayload([
      { tglUkur: '2026-02-01', bb: 4.2, tb: 53, lila: 12.1, lk: 36, caraUkur: 'Terlentang', statusNaik: 'B' },
      { tglUkur: '2026-04-01', bb: 6.1, tb: 61, lila: 13.3, lk: 40, caraUkur: 'Terlentang', statusNaik: 'O' }
    ], privateChild);
    const encoded = JSON.stringify(payload);

    expect(payload.sex).toBe('P');
    expect(payload.measurements).toHaveLength(2);
    expect(payload.measurements[0].ageMonths).toBe(1);
    expect(payload.measurements[0].lilaCm).toBeNull();
    expect(payload.measurements[1].ageMonths).toBe(3);
    expect(payload.measurements[1].gapBefore).toBe(true);
    expect(payload.measurements[1].statuses).toHaveProperty('bbu');
    expect(payload.measurements[1].zScores).toHaveProperty('lku');

    for (const privateValue of [
      privateChild.id,
      privateChild.nama,
      privateChild.nik,
      privateChild.tglLahir,
      privateChild.alamat,
      privateChild.desa,
      privateChild.posyandu,
      '2026-02-01',
      '2026-04-01'
    ]) {
      expect(encoded).not.toContain(privateValue);
    }
    for (const forbiddenField of ['childId', 'nama', 'nik', 'tglLahir', 'tglUkur', 'alamat', 'desa', 'posyandu']) {
      expect(encoded).not.toContain(`"${forbiddenField}"`);
    }
  });

  test('uses a transparent local summary when the external AI service is unavailable', () => {
    const result = buildLocalGrowthSummaryFallback({
      sex: 'L',
      measurements: [{
        ageMonths: 5,
        gapBefore: true,
        weightTrend: 'O',
        statuses: { bbu: 'Berat Normal', tbu: 'Normal', bbtb: 'Gizi Baik', imtu: 'Gizi Baik', lilau: 'LILA Normal', lku: 'Normal' }
      }]
    });

    expect(result.provider).toBe('E-Posyandu (mode cadangan)');
    expect(result.stored).toBe(false);
    expect(result.observations.join(' ')).toContain('bulan sebelumnya tidak ditimbang');
    expect(result.followUp.join(' ')).toContain('garis pertumbuhan berikutnya tidak terputus');
  });
});
