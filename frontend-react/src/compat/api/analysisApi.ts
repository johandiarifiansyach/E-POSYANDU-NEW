/** Python growth-risk, anomaly, and screening analysis via the private Queue. */
// @ts-nocheck
import { apiRequest, createBackgroundJob, waitForBackgroundJob } from './legacyClient';

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

/** Read the status calculated by the Python service, never a browser rule. */
export function pythonWeightGainStatus(assessment) {
  return assessment?.analysis?.weightGainStatus
    ?? assessment?.analysis?.historySignals?.weightGain?.current
    ?? assessment?.weightGainStatus
    ?? assessment?.weight_gain_status
    ?? null;
}

/**
 * A result is usable for display when Python has persisted at least one
 * derived field.  During a rolling read fallback the pending flag may be
 * stale even though the response already contains valid statuses; callers
 * should keep those values visible instead of replacing them with a skeleton.
 */
export function hasUsableAnalysis(assessment) {
  if (!assessment || typeof assessment !== 'object') return false;
  const values = [
    assessment.bbuStatus,
    assessment.tbuStatus,
    assessment.bbtbStatus,
    assessment.imtuStatus,
    assessment.lilaStatus,
    assessment.lkStatus,
    assessment.exclusiveBreastfeedingStatus,
    assessment.analysis,
  ];
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') {
      const text = value.trim();
      return text.length > 0 && text !== '-';
    }
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
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

/**
 * Calculate WHO statuses synchronously through the authenticated operations
 * gateway. The endpoint is batched so a table page performs one Python call,
 * rather than one background job per child.
 */
export async function requestPythonAnthropometry(entries) {
  const items = (entries || [])
    .filter((entry) => entry?.measurement && entry?.child)
    .map((entry, index) => ({
      ...analysisItem(entry.child, entry.measurement, entry.history || []),
      rowNumber: index + 1,
    }));
  if (!items.length) return { items: [], total: 0, calculator: 'python-deterministic-lms' };
  return apiRequest('/analysis/anthropometry', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
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
    nutritionEducation: item.analysis.nutritionEducation || null,
    graphAnalysis: item.analysis.graphAnalysis || null,
    weightGainStatus: pythonWeightGainStatus(item),
    exclusiveBreastfeeding: item.analysis.exclusiveBreastfeeding || null,
    calculator: result.calculator || 'python-deterministic-lms',
    standardsVersion: result.standardsVersion || null,
  };
}

/**
 * Ask Python to interpret the same chronological points used by the growth
 * charts. Both the explanation and the chart rendering are owned by the
 * private analysis service.
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
      nutritionEducation: null,
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

/**
 * Render the selected WHO chart in the private Python service. This direct
 * request is intentionally separate from the background ML job: chart data is
 * small, deterministic, and should not wait behind the queue.
 */
export async function requestPythonGrowthChart(child, history, chartType) {
  const points = (history || [])
    .filter((item) => item?.tglUkur)
    .slice()
    .sort((left, right) => new Date(left.tglUkur).getTime() - new Date(right.tglUkur).getTime())
    .map((item) => {
      const date = String(item.tglUkur).slice(0, 10);
      const parsedAge = Number(item.ageInMonths);
      return {
        // Age is persisted/derived at the authenticated Python boundary. Do
        // not rederive it in the browser when an imported row is incomplete.
        ageMonths: Number.isFinite(parsedAge) ? parsedAge : null,
        weightKg: numberOrNull(item.bb),
        heightCm: numberOrNull(item.tb),
        lilaCm: numberOrNull(item.lila),
        headCircumferenceCm: numberOrNull(item.lk),
        measurementMethod: item.caraUkur || null,
        measurementDate: date,
        weightGainStatus: weightGainStatusValue(item),
      };
    })
    .filter((item) => Number.isFinite(item.ageMonths));
  return apiRequest('/analysis/growth-chart', {
    method: 'POST',
    body: JSON.stringify({
      chartType,
      sex: String(child?.jk || '').toUpperCase() === 'P' ? 'P' : 'L',
      // The Python SVG is also used for PNG/PDF export, so include the
      // location beside the child's name in the rendered chart identity.
      childName: [
        child?.nama || 'Balita',
        child?.posyandu ? `Posyandu: ${child.posyandu}` : '',
        child?.desa || child?.village ? `Desa: ${child.desa || child.village}` : '',
      ].filter(Boolean).join(' • '),
      language: 'id',
      points,
    }),
  });
}
