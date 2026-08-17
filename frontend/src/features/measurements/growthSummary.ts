// @ts-nocheck
import { getAgeInMonths, parseLocaleNumber } from '../../shared/dashboardUtils';
import { getMeasurementStatuses } from './measurementRules';

function positiveNumber(value) {
  const parsed = parseLocaleNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteScore(value) {
  return Number.isFinite(value) ? Math.round(Number(value) * 100) / 100 : null;
}

function safeStatus(value) {
  const status = String(value || '').trim();
  return status && status !== '-' ? status.slice(0, 48) : null;
}

function calendarMonthIndex(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return Number.isInteger(year) && month >= 1 && month <= 12 ? year * 12 + month - 1 : null;
}

export function buildAnonymousGrowthSummaryPayload(history, child) {
  const sex = String(child?.jk || '').toUpperCase() === 'P' ? 'P' : 'L';
  const chronological = (history || [])
    .filter((measurement) => measurement?.tglUkur)
    .map((measurement) => ({
      measurement,
      ageMonths: getAgeInMonths(child?.tglLahir, new Date(measurement.tglUkur)),
      monthIndex: calendarMonthIndex(measurement.tglUkur),
    }))
    .filter((item) => Number.isInteger(item.ageMonths) && item.ageMonths >= 0 && item.ageMonths <= 60)
    .sort((left, right) => new Date(left.measurement.tglUkur).getTime() - new Date(right.measurement.tglUkur).getTime())
    .slice(-61);

  return {
    sex,
    measurements: chronological.map((item, index) => {
      const statuses = getMeasurementStatuses(item.measurement, child, new Date(item.measurement.tglUkur));
      const previous = chronological[index - 1];
      const gapBefore = index > 0 && (
        String(item.measurement.statusNaik || '').toUpperCase() === 'O'
        || (item.monthIndex !== null && previous?.monthIndex !== null && item.monthIndex - previous.monthIndex > 1)
      );
      const method = ['Terlentang', 'Berdiri'].includes(item.measurement.caraUkur)
        ? item.measurement.caraUkur
        : null;
      const weightTrend = ['B', 'N', 'T', 'O'].includes(String(item.measurement.statusNaik || '').toUpperCase())
        ? String(item.measurement.statusNaik).toUpperCase()
        : null;

      return {
        ageMonths: item.ageMonths,
        weightKg: positiveNumber(item.measurement.bb),
        lengthHeightCm: positiveNumber(item.measurement.tb),
        lilaCm: item.ageMonths >= 3 ? positiveNumber(item.measurement.lila) : null,
        headCircumferenceCm: positiveNumber(item.measurement.lk),
        measurementMethod: method,
        weightTrend,
        gapBefore,
        statuses: {
          bbu: safeStatus(statuses.statusBbu),
          tbu: safeStatus(statuses.statusTbu),
          bbtb: safeStatus(statuses.statusBbtb),
          imtu: safeStatus(statuses.statusImtu),
          lilau: safeStatus(statuses.statusLilau),
          lku: safeStatus(statuses.statusLku),
        },
        zScores: {
          bbu: finiteScore(statuses.zScoreBbu),
          tbu: finiteScore(statuses.zScoreTbu),
          bbtb: finiteScore(statuses.zScoreBbtb),
          imtu: finiteScore(statuses.zScoreImtu),
          lilau: finiteScore(statuses.zScoreLilau),
          lku: finiteScore(statuses.zScoreLku),
        },
      };
    }),
  };
}

const STATUS_LABELS = {
  bbu: 'BB/U',
  tbu: 'PB atau TB/U',
  bbtb: 'BB/PB atau BB/TB',
  imtu: 'IMT/U',
  lilau: 'LILA/U',
  lku: 'LK/U',
};

const TREND_LABELS = {
  B: 'pengukuran pertama',
  N: 'berat badan naik',
  T: 'berat badan tidak naik',
  O: 'bulan sebelumnya tidak ditimbang',
};

export function buildLocalGrowthSummaryFallback(payload) {
  const measurements = payload?.measurements || [];
  const latest = measurements.at(-1);
  const observations = [];
  const statusEntries = latest
    ? Object.entries(latest.statuses || {}).filter(([, status]) => status)
    : [];
  if (statusEntries.length) {
    observations.push(`Hasil terakhir: ${statusEntries
      .map(([key, status]) => `${STATUS_LABELS[key] || key.toUpperCase()} ${status}`)
      .join('; ')}.`);
  }
  if (latest?.weightTrend && TREND_LABELS[latest.weightTrend]) {
    observations.push(`Kode kenaikan berat terakhir menunjukkan ${TREND_LABELS[latest.weightTrend]}.`);
  }
  const gapCount = measurements.filter((measurement) => measurement.gapBefore).length;
  if (gapCount > 0) {
    observations.push(`Terdapat ${gapCount} jeda pada rangkaian pengukuran karena bulan sebelumnya tidak ditimbang.`);
  }
  if (measurements.length < 2) {
    observations.push('Baru tersedia satu titik pengukuran sehingga perubahan antarbulan belum dapat dibandingkan.');
  }
  if (!observations.length) {
    observations.push('Data yang tersedia belum cukup untuk menjelaskan pola pertumbuhan.');
  }

  const normalStatuses = new Set(['Normal', 'Berat Normal', 'Gizi Baik', 'LILA Normal']);
  const needsConfirmation = statusEntries.some(([, status]) => !normalStatuses.has(status));
  const followUp = ['Lanjutkan pengukuran rutin setiap bulan dengan alat dan cara ukur yang sesuai.'];
  if (gapCount > 0) {
    followUp.push('Pertahankan jadwal penimbangan bulanan agar garis pertumbuhan berikutnya tidak terputus.');
  }
  if (needsConfirmation) {
    followUp.push('Konfirmasi kembali hasil ukur dan konsultasikan hasil yang tidak normal kepada tenaga kesehatan.');
  } else {
    followUp.push('Tetap gunakan hasil WHO pada aplikasi sebagai dasar pemantauan berikutnya.');
  }

  return {
    overview: measurements.length
      ? `${measurements.length} pengukuran anonim tersedia sampai usia ${latest.ageMonths} bulan.`
      : 'Belum ada pengukuran valid yang dapat diringkas.',
    observations: observations.slice(0, 4),
    followUp: followUp.slice(0, 4),
    disclaimer: 'Ringkasan otomatis hanya membantu membaca pola. Keputusan status gizi tetap mengikuti hasil WHO dan penilaian tenaga kesehatan.',
    anonymous: true,
    stored: false,
    provider: 'E-Posyandu (mode cadangan)',
    model: 'aturan lokal',
  };
}
