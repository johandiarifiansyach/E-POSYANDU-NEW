import type { WorkSheet } from 'xlsx';

type XlsxModule = typeof import('xlsx');

const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;
const FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/;
const FORBIDDEN_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const ALLOWED_SPREADSHEET_MIME_TYPES = new Set([
    '',
    'application/octet-stream',
    'application/zip',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
let xlsxLoadPromise: Promise<XlsxModule> | null = null;

function hasBytes(bytes: Uint8Array, expected: readonly number[]) {
    return expected.every((value, index) => bytes[index] === value);
}

export async function validateSpreadsheetFile(file: File) {
    if (!(file instanceof File)) throw new Error('Berkas impor tidak valid.');
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension !== 'xls' && extension !== 'xlsx') {
        throw new Error('Hanya berkas .xls atau .xlsx tanpa macro yang diizinkan.');
    }
    if (file.size <= 0 || file.size > MAX_SPREADSHEET_BYTES) {
        throw new Error('Ukuran berkas Excel harus lebih dari 0 dan maksimal 10 MB.');
    }
    if (!ALLOWED_SPREADSHEET_MIME_TYPES.has(String(file.type || '').toLowerCase())) {
        throw new Error('Tipe berkas tidak cocok dengan dokumen Excel yang diizinkan.');
    }

    const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const isOle = hasBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const isZip = hasBytes(bytes, [0x50, 0x4b, 0x03, 0x04])
        || hasBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
        || hasBytes(bytes, [0x50, 0x4b, 0x07, 0x08]);
    if ((extension === 'xls' && !isOle) || (extension === 'xlsx' && !isZip)) {
        throw new Error('Isi berkas tidak cocok dengan ekstensi Excel. Berkas ditolak.');
    }
}

export function sanitizeImportedCellText(value: unknown, maximumLength = 500) {
    const sanitized = String(value ?? '').normalize('NFC').replace(FORBIDDEN_TEXT_CONTROLS, '').trim();
    if (Array.from(sanitized).length > maximumLength) {
        throw new Error(`Teks impor melebihi batas ${maximumLength} karakter.`);
    }
    return sanitized;
}

export function hardenSpreadsheetWorksheet(worksheet: WorkSheet) {
    Object.entries(worksheet || {}).forEach(([address, cell]) => {
        if (address.startsWith('!') || !cell || typeof cell !== 'object') return;
        if (typeof cell.v !== 'string' || !FORMULA_PREFIX.test(cell.v)) return;
        cell.t = 's';
        delete cell.f;
        delete cell.F;
    });
    return worksheet;
}

export function createSafeWorksheet(xlsx: Pick<XlsxModule, 'utils'>, rows: unknown[][]) {
    return hardenSpreadsheetWorksheet(xlsx.utils.aoa_to_sheet(rows));
}

export const ensureXlsx = (): Promise<XlsxModule> => {
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = import('xlsx').catch((error: unknown) => {
        xlsxLoadPromise = null;
        console.error('Library Excel yang dibundel gagal dimuat:', error);
        throw new Error('Gagal memuat library Excel yang dibundel aplikasi.');
    });
    return xlsxLoadPromise;
};
