import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import * as Native from '../../frontend/src/runtime/dom';
import {
  createSafeWorksheet,
  ensureXlsx,
  hardenSpreadsheetWorksheet,
  validateSpreadsheetFile
} from '../../frontend/src/services/xlsx';

test.describe('DOM security boundary', () => {
  test('rejects executable URLs and string event handlers', () => {
    expect(Native.sanitizeDomUrl('java\nscript:alert(1)')).toBeNull();
    expect(Native.sanitizeDomUrl('vbscript:msgbox(1)')).toBeNull();
    expect(Native.isBlockedHtmlProp('onclick')).toBe(true);
  });

  test('rejects raw HTML props and unsafe CSS URLs', () => {
    expect(Native.isBlockedHtmlProp('innerHTML')).toBe(true);
    expect(Native.isBlockedHtmlProp('srcdoc')).toBe(true);
    expect(Native.isSafeInlineStyleValue('url(https://attacker.invalid/pixel)')).toBe(false);
    expect(Native.isSafeInlineStyleValue('50%')).toBe(true);
  });

  test('adds opener isolation to new-tab links', () => {
    expect(Native.safeRelForTarget('_blank')).toBe('noopener noreferrer');
    expect(Native.safeRelForTarget('_blank', 'nofollow')).toBe('nofollow noopener noreferrer');
  });
});

test.describe('spreadsheet security boundary', () => {
  test('accepts a matching XLSX signature and rejects disguised files', async () => {
    const xlsx = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
      'identitas.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    );
    const disguised = new File(
      [new TextEncoder().encode('<script>alert(1)</script>')],
      'identitas.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    );

    await expect(validateSpreadsheetFile(xlsx)).resolves.toBeUndefined();
    await expect(validateSpreadsheetFile(disguised)).rejects.toThrow('Isi berkas tidak cocok');
  });

  test('rejects macro-enabled workbook extensions', async () => {
    const macroWorkbook = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
      'identitas.xlsm',
      { type: 'application/vnd.ms-excel.sheet.macroEnabled.12' }
    );

    await expect(validateSpreadsheetFile(macroWorkbook)).rejects.toThrow('Hanya berkas .xls atau .xlsx');
  });

  test('forces formula-like text cells to remain strings', () => {
    const worksheet = {
      A1: { v: '=HYPERLINK("https://attacker.invalid")', f: 'HYPERLINK("https://attacker.invalid")' },
      A2: { v: '+628123456789', F: 'A2:A2' },
      A3: { v: 'Nama Balita', t: 's' },
      '!ref': 'A1:A3'
    };

    hardenSpreadsheetWorksheet(worksheet);

    expect(worksheet.A1).toEqual({ v: '=HYPERLINK("https://attacker.invalid")', t: 's' });
    expect(worksheet.A2).toEqual({ v: '+628123456789', t: 's' });
    expect(worksheet.A3).toEqual({ v: 'Nama Balita', t: 's' });
  });

  test('uses patched bundled SheetJS and preserves hardened cells after writing', async () => {
    const xlsx = await ensureXlsx();
    expect(xlsx.version).toBe('0.20.3');

    const worksheet = createSafeWorksheet(xlsx, [['Nama'], ['=1+1']]);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Data');
    const encoded = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' });
    const restored = xlsx.read(encoded, { type: 'array', cellFormula: false });
    const formulaLikeCell = restored.Sheets.Data.A2;

    expect(formulaLikeCell.t).toBe('s');
    expect(formulaLikeCell.v).toBe('=1+1');
    expect(formulaLikeCell.f).toBeUndefined();
  });
});
