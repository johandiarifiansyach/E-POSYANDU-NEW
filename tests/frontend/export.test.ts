import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import {
  buildSigiziMeasurementExportItems,
  getMpasiExportRows,
  getPmtExportRows,
  getSelectedMonthRange,
  getSigiziIdentityRows,
  getSigiziMeasurementRows,
  latestMeasurementsByChild,
  toExportBinary
} from '../../frontend/src/services/exportService';

test.describe('export feature', () => {
  test('builds an inclusive range for a leap-year month', () => {
    expect(getSelectedMonthRange(2, 2028)).toEqual({
      start: '2028-02-01',
      end: '2028-02-29'
    });
  });

  test('keeps only the latest measurement for each child', () => {
    const latest = latestMeasurementsByChild([
      { childId: 'child-1', tglUkur: '2026-01-01', bb: 3 },
      { childId: 'child-1', tglUkur: '2026-02-01', bb: 3.2 },
      { childId: 'child-2', tglUkur: '2026-02-01', bb: 4 }
    ]);

    expect(latest['child-1'].bb).toBe(3.2);
    expect(Object.keys(latest)).toHaveLength(2);
  });

  test('converts export flags to the XLS numeric format', () => {
    expect(toExportBinary('Ya')).toBe(1);
    expect(toExportBinary('Tidak')).toBe(0);
    expect(toExportBinary(['Ya'])).toBe(1);
  });

  test('exports MPASI and ASI columns with the expected values', () => {
    const children = [{ id: 'child-1', nik: '3509040201260001', nama: 'Bayi Satu' }];
    const mpasiRows = getMpasiExportRows(children, {
      'child-1': {
        tglMonitoring: '2026-08-01',
        asi: 'Ya',
        makananPokok: 'Tidak',
        kacang: 'Ya',
        susu: 'Ya',
        daging: 'Tidak',
        telur: 'Ya',
        sayurVitA: 'Ya',
        sayurLain: 'Tidak',
        intervensiGizi: 'Ya'
      }
    });
    const asiRows = getSigiziMeasurementRows([{
      nik: '3509040201260001',
      nama: 'Bayi Satu',
      tglUkur: '2026-08-01',
      asiBulan0: 'Ya',
      asiBulan1: 'Tidak'
    }]);

    expect(mpasiRows[0]).toEqual([
      1, '3509040201260001', 'Bayi Satu', '2026-08-01',
      1, 0, 1, 1, 0, 1, 1, 0, 1
    ]);
    expect(asiRows[0].slice(11, 18)).toEqual(['ya', 'tidak', '', '', '', '', '']);
  });

  test('exports the complete SigiZI identity field set', () => {
    const rows = getSigiziIdentityRows([{
      anakKe: 1,
      tglLahir: '2026-07-29',
      jk: 'P',
      noKK: '3509040101010001',
      nik: '3509042907260001',
      nama: 'Bayi Satu',
      usiaKehamilan: 39,
      bbLahir: 3.2,
      pbLahir: 49.5,
      lkLahir: 33.2,
      bukuKIA: 'Ya',
      bukuKIAKecil: 'Tidak',
      imd: 'Ya',
      namaOrtu: 'Orang Tua',
      nikOrtu: '3509040101010002',
      noHpOrtu: '081234567890',
      alamat: 'Jalan Sehat',
      rt: '001',
      rw: '002',
      createdAt: '2026-08-01T00:00:00.000Z'
    }], 8, 2026);

    expect(rows[0]).toEqual([
      1, 1, '2026-07-29', 'Perempuan', '3509040101010001', '3509042907260001',
      'Bayi Satu', 39, 3.2, 49.5, 33.2, 'Ya', 'Tidak', 'Ya', 'Orang Tua',
      '3509040101010002', '081234567890', 'Jalan Sehat', '001', '002', '', ''
    ]);
  });

  test('builds a SigiZI measurement export from cached history when the API is unavailable', () => {
    const items = buildSigiziMeasurementExportItems([{
      id: 'child-1',
      nik: '3509040201260001',
      nama: 'Bayi Satu',
      tglLahir: '2026-01-01'
    }], [
      { id: 'm-feb', childId: 'child-1', tglUkur: '2026-02-01', bb: 4.2, asi: 'Ya' },
      { id: 'm-mar', childId: 'child-1', tglUkur: '2026-03-01', bb: 5.1, asi: 'Tidak' },
      { id: 'm-aug-old', childId: 'child-1', tglUkur: '2026-08-01', bb: 7.2, createdAt: '2026-08-01T08:00:00Z' },
      { id: 'm-aug-latest', childId: 'child-1', tglUkur: '2026-08-15', bb: 7.5, tb: 67.4, createdAt: '2026-08-15T08:00:00Z' }
    ], '2026-08-01', '2026-08-31');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nik: '3509040201260001',
      nama: 'Bayi Satu',
      tglUkur: '2026-08-15',
      bb: 7.5,
      tb: 67.4,
      asiBulan1: 'Ya',
      asiBulan2: 'Tidak'
    });
    expect(getSigiziMeasurementRows(items)[0].slice(1, 6)).toEqual([
      '3509040201260001', 'Bayi Satu', '2026-08-15', 7.5, 67.4
    ]);
  });

  test('creates one export row per PMT monitoring week', () => {
    const rows = getPmtExportRows('Wasting', [{
      childId: 'child-1',
      category: 'Wasting',
      tglPemberian: '2026-08-01',
      jenisPmt: 'Pabrikan',
      sumberAnggaran: 'DAK Non Fisik',
      pmtSesuaiJuknis: 'Ya',
      monitorings: [{ week: 1, bb: '3,2', tb: '50', days: [true] }]
    }], {
      'child-1': { nik: '3509040201260001', nama: 'Bayi Satu' }
    });

    expect(rows).toHaveLength(8);
    expect(rows[0].slice(0, 6)).toEqual([
      '3509040201260001', 'Bayi Satu', '2026-08-01', 1, 1, 1
    ]);
    expect(rows[0][10]).toBe(1);
    expect(rows[0][12]).toBe(1);
  });
});
