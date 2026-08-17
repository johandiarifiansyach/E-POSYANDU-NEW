// @ts-nocheck
import { WHO_0_TO_5 } from '../data/anthropometry';

export function formatChildName(value) {
    return value
        .toLowerCase()
        .replace(/(^|[\s'-])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

const KBM_TABLE = {
    1: 800, 2: 900, 3: 800, 4: 600, 5: 500,
    6: 400, 7: 300, 8: 300, 9: 300, 10: 300,
    11: 200
};

export const getKBM = (ageInMonths) => {
    if (ageInMonths <= 1)
        return 800;
    if (ageInMonths > 60)
        return 200;
    if (ageInMonths >= 11)
        return 200;
    return KBM_TABLE[ageInMonths] || 200;
};

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
    const [year, month, day] = birthDateString.slice(0, 10).split('-').map(Number);
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

const toPositiveNumber = (value) => {
    const numberValue = parseLocaleNumber(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
};

const calculateLmsZScore = (value, [l, m, s]) => {
    if (l === 0)
        return Math.log(value / m) / s;
    return (Math.pow(value / m, l) - 1) / (l * s);
};

const getAdjustedLengthHeight = (value, ageMonths, caraUkur) => {
    if (ageMonths <= 24 && caraUkur === 'Berdiri')
        return value + 0.7;
    if (ageMonths > 24 && caraUkur === 'Terlentang')
        return value - 0.7;
    return value;
};

export const calculateZScore = (val, type, ageMonths, gender, secondaryVal = null, caraUkur) => {
    const primaryValue = toPositiveNumber(val);
    const age = Math.floor(ageMonths);
    if (primaryValue === null || age < 0 || age > 60)
        return null;
    if (type === 'BBU')
        return calculateLmsZScore(primaryValue, WHO_0_TO_5.weightForAge[gender][age]);
    const measuredLengthHeight = toPositiveNumber(secondaryVal);
    const lengthHeight = type === 'TBU' ? primaryValue : measuredLengthHeight;
    if (lengthHeight === null)
        return null;
    const adjustedLengthHeight = getAdjustedLengthHeight(lengthHeight, age, caraUkur);
    if (type === 'TBU')
        return calculateLmsZScore(adjustedLengthHeight, WHO_0_TO_5.lengthHeightForAge[gender][age]);
    if (type === 'IMTU') {
        const bmi = primaryValue / Math.pow(adjustedLengthHeight / 100, 2);
        return calculateLmsZScore(bmi, WHO_0_TO_5.bmiForAge[gender][age]);
    }
    const isLength = age <= 24;
    const minimumLengthHeight = isLength ? 45 : 65;
    const standards = isLength ? WHO_0_TO_5.weightForLength : WHO_0_TO_5.weightForHeight;
    const index = Math.round((adjustedLengthHeight - minimumLengthHeight) * 2);
    const standard = standards[gender][index];
    if (!standard)
        return null;
    return calculateLmsZScore(primaryValue, standard);
};

const getGiziLabel = (zScore, type) => {
    if (zScore === null)
        return "-";
    if (type === 'BBU') {
        if (zScore < -3)
            return "Berat Sangat Kurang";
        if (zScore < -2)
            return "Berat Kurang";
        if (zScore <= 1)
            return "Berat Normal";
        return "Risiko Berat Lebih";
    }
    if (type === 'TBU') {
        if (zScore < -3)
            return "Sangat Pendek";
        if (zScore < -2)
            return "Pendek";
        if (zScore <= 3)
            return "Normal";
        return "Tinggi";
    }
    if (type === 'BBTB' || type === 'IMTU') {
        if (zScore < -3)
            return "Gizi Buruk";
        if (zScore < -2)
            return "Gizi Kurang";
        if (zScore <= 1)
            return "Gizi Baik";
        if (zScore <= 2)
            return "Risiko Gizi Lebih";
        if (zScore <= 3)
            return "Gizi Lebih";
        return "Obesitas";
    }
    return "-";
};

export const calculateGiziStatus = (val, type, ageMonths, gender, secondaryVal = null, caraUkur) => {
    const zScore = calculateZScore(val, type, ageMonths, gender, secondaryVal, caraUkur);
    return getGiziLabel(zScore, type);
};
