// @ts-nocheck

/** Formatting, parsing, and input helpers shared by the UI.
 *
 * Classification, LMS/WHO calculations, N/T/O/B, and analytics are owned by
 * the Python service.  The two compatibility exports at the bottom deliberately
 * do not calculate locally; callers must use the Python response instead.
 */

export function formatChildName(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/(^|[\s'-])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

/** @deprecated KBM is determined by Python analysis. */
export const getKBM = (_ageInMonths) => null;

export const generateRandomDigits = (length) => {
    let result = '';
    for (let index = 0; index < length; index += 1) {
        result += Math.floor(Math.random() * 10);
    }
    return result;
};

export const formatDate = (date) => {
    if (!date)
        return '';
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
        return date;
    const d = new Date(date);
    if (Number.isNaN(d.getTime()))
        return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export const formatIndoDate = (dateString) => {
    if (!dateString)
        return '-';
    const d = new Date(dateString);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const formatIndoDateTime = (timestamp) => {
    if (!timestamp)
        return '-';
    const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const getAgeInMonths = (birthDateString, refDate = new Date()) => {
    if (!birthDateString)
        return 0;
    const [year, month, day] = String(birthDateString).slice(0, 10).split('-').map(Number);
    if (!year || !month || !day)
        return 0;
    let months = (refDate.getFullYear() - year) * 12 + (refDate.getMonth() - (month - 1));
    if (refDate.getDate() < day)
        months -= 1;
    return Math.max(months, 0);
};

export const normalizeDecimalInput = (value) => {
    const raw = String(value ?? '').trim();
    let result = '';
    let hasSeparator = false;
    for (const char of raw) {
        if (char >= '0' && char <= '9') {
            result += char;
            continue;
        }
        if (!hasSeparator && char.trim() !== '') {
            result += '.';
            hasSeparator = true;
        }
    }
    return result;
};

export const parseLocaleNumber = (value) => {
    const normalized = normalizeDecimalInput(value).trim();
    if (!normalized)
        return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
};

export const parseLocaleNumberForRange = (value, minimum, maximum, decimalShiftLimit = 2) => {
    const normalized = normalizeDecimalInput(value).trim();
    if (!normalized)
        return null;
    const direct = Number(normalized);
    if (Number.isFinite(direct) && direct >= minimum && direct <= maximum)
        return direct;
    if (!normalized.includes('.')) {
        for (let shift = 1; shift <= decimalShiftLimit; shift += 1) {
            const candidate = Number(normalized) / Math.pow(10, shift);
            if (Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum)
                return candidate;
        }
    }
    return null;
};

/** @deprecated Use the Python analysis response. */
export const calculateZScore = () => null;

/** @deprecated Use the Python analysis response. */
export const calculateGiziStatus = () => '-';
