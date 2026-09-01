/** Python growth-risk, anomaly, and screening analysis via the private Queue. */
// @ts-nocheck
import { createBackgroundJob, waitForBackgroundJob } from './legacyClient';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMonthsOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function exclusiveBreastfeedingValue(measurement) {
  return measurement?.asi ?? measurement?.exclusiveBreastfeeding ?? measurement?.exclusive_breastfeeding ?? null;
}

function weightGainStatusValue(measurement) {
  return measurement?.statusNaik ?? measurement?.weightGainStatus ?? measurement?.weight_gain_status ?? null;
}

function analysisItem(child, measurement, history) {
  const currentId = String(measurement?.id || '');
  const historyPayload = (history || [])
    .filter((item) => String(item?.id || '') !== currentId)
    .filter((item) => item?.tglUkur)
    .map((item) => ({
      measurementDate: String(item.tglUkur).slice(0, 10),
      weightKg: numberOrNull(item.bb),
      heightCm: numberOrNull(item.tb),
      lilaCm: numberOrNull(item.lila),
      headCircumferenceCm: numberOrNull(item.lk),
      // Keep a missing historical age as null so the analysis service can
      // infer it from the measurement date and the current age.  Zero is a
      // valid newborn age and must not be used as a missing-value sentinel.
      ageMonths: ageMonthsOrNull(item.ageInMonths),
      sex: String(child?.jk || '').toUpperCase() === 'P' ? 'P' : 'L',
      measurementMethod: item.caraUkur || null,
      exclusiveBreastfeeding: exclusiveBreastfeedingValue(item),
      weightGainStatus: weightGainStatusValue(item),
    }));

  return {
    weightKg: numberOrNull(measurement?.bb),
    heightCm: numberOrNull(measurement?.tb),
    lilaCm: numberOrNull(measurement?.lila),
    headCircumferenceCm: numberOrNull(measurement?.lk),
    ageMonths: Number.isFinite(Number(measurement?.ageInMonths)) ? Number(measurement.ageInMonths) : 0,
    sex: String(child?.jk || '').toUpperCase() === 'P' ? 'P' : 'L',
    measurementMethod: measurement?.caraUkur || null,
    measurementDate: String(measurement?.tglUkur || '').slice(0, 10),
    exclusiveBreastfeeding: exclusiveBreastfeedingValue(measurement),
    weightGainStatus: weightGainStatusValue(measurement),
    rowNumber: 1,
    recordId: currentId || String(child?.id || ''),
    nik: String(child?.nik || ''),
    history: historyPayload,
  };
}

export async function requestMeasurementAnalysis(child, measurement, history) {
  const job = await createBackgroundJob('nutrition_report', {
    items: [analysisItem(child, measurement, history)],
  });
  if (job.queueConfigured === false) {
    throw new Error('Antrean analisis belum aktif. Hasil analisis pertumbuhan belum tersedia.');
  }
  // The queue worker may be waking from a restart or waiting behind another
  // report.  Its visibility lease is five minutes, so a 45-second client
  // timeout could show "Pekerjaan masih diproses" even though the job was
  // healthy and about to complete.  Keep polling for two minutes while the
  // dialog remains open, which avoids dropping a valid result prematurely.
  const completed = await waitForBackgroundJob(job.id, { intervalMs: 1_000, timeoutMs: 120_000 });
  const result = completed.result && typeof completed.result === 'object' ? completed.result : {};
  const item = Array.isArray(result.items) ? result.items[0] : null;
  if (!item || !item.analysis) {
    throw new Error('Respons analisis pertumbuhan belum memuat hasil screening.');
  }
  return {
    item,
    anomaly: item.analysis.anomaly || { detected: false, count: 0, severity: 'none', items: [] },
    risk: item.analysis.risk || { predictions: {}, overall: { level: 'rendah', probability: 0 } },
    nutritionConcern: item.analysis.nutritionConcern || null,
    graphAnalysis: item.analysis.graphAnalysis || null,
    calculator: result.calculator || 'python-deterministic-lms',
    standardsVersion: result.standardsVersion || null,
  };
}

/**
 * Ask Python to interpret the same chronological points used by the growth
 * charts.  The chart is intentionally rendered in the browser, while its
 * explanation and trend signals come from the private analysis service.
 */
export async function requestGrowthAnalysis(child, history) {
  const measurements = (history || [])
    .filter((item) => item?.tglUkur)
    .slice()
    .sort((left, right) => new Date(right.tglUkur).getTime() - new Date(left.tglUkur).getTime());
  const latest = measurements[0];
  if (!latest) {
    return {
      item: null,
      anomaly: { detected: false, count: 0, severity: 'none', items: [] },
      risk: { predictions: {}, overall: { level: 'rendah', probability: 0 } },
      graphAnalysis: {
        model: 'growth-trend-logistic-v1',
        summary: 'Belum ada riwayat pengukuran untuk dianalisis.',
        points: 0,
        confidence: 0,
        indicators: [],
        conclusions: ['Tambahkan minimal dua pengukuran bertanggal untuk membaca arah grafik.'],
        recommendations: [],
        anomalies: [],
      },
      calculator: 'python-deterministic-lms',
      standardsVersion: null,
    };
  }
  return requestMeasurementAnalysis(child, latest, measurements);
}
