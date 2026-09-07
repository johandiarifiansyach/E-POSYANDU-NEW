// @ts-nocheck
export const CATEGORY_OPTIONS = [
  { value: 'Semua', label: 'Semua PMT', shortLabel: 'Semua' },
  { value: 'Underweight', label: 'Underweight (BB Kurang/Sangat Kurang)', shortLabel: 'Underweight' },
  { value: 'Wasting', label: 'Wasting (Gizi Kurang/Buruk)', shortLabel: 'Wasting' },
  { value: 'TidakNaik', label: 'BB Tidak Naik (N/T)', shortLabel: 'Tidak Naik' },
];

export function maxWeeksForCategory(category) {
  if (category === 'Wasting') return 8;
  if (category === 'Underweight') return 4;
  return 2;
}

export function categoryLabel(category) {
  if (category === 'TidakNaik') return 'BB Tidak Naik';
  return category || '-';
}

export function categoryMetric(category) {
  if (category === 'Wasting') return 'BB/TB';
  if (category === 'Underweight') return 'BB/U';
  return 'N/T';
}

export function numericValue(value) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getMonitoringForWeek(program, week) {
  const monitorings = program?.monitorings ?? program?.pemantauan;
  if (Array.isArray(monitorings)) {
    return monitorings.find((item) => Number(item?.week ?? item?.minggu) === Number(week))
      || monitorings[Number(week)]
      || null;
  }
  return monitorings?.[week] ?? monitorings?.[String(week)] ?? null;
}

export function baselineForProgram(program, child) {
  const initialDate = program?.initialMeasurementDate || program?.tanggalAwalPengukuran || program?.tglPemberian;
  return {
    date: initialDate || child?.lastMeasurementDate,
    weight: numericValue(program.initialBB ?? program.bbAwal) ?? numericValue(child?.currentBB) ?? numericValue(child?.bbLahir),
    height: numericValue(program.initialTB ?? program.tbAwal) ?? numericValue(child?.currentTB) ?? numericValue(child?.pbLahir),
  };
}

export function monitoringStatus(program, child, monitoring, week, baseline) {
  // PMT monitoring classifications are produced by Python together with the
  // measurement analysis.  Do not infer N/T or WHO status from raw values in
  // this synchronous presentation helper.
  return monitoring?.pythonStatus
    ?? monitoring?.python?.status
    ?? monitoring?.analysis?.status
    ?? '-';
}

/**
 * Recommends the next PMT action without exposing a picker to cadres.
 *
 * Python remains the authority for the underlying status/risk analysis.  The
 * UI consumes a recommendation already attached to the analysis when one is
 * available, and only uses this conservative category fallback for legacy
 * records that predate the Python result fields.
 */
export function automaticRecommendation(program, child, monitoring) {
  const candidates = [
    monitoring?.pythonRecommendation,
    monitoring?.recommendation,
    monitoring?.analysis?.recommendation,
    monitoring?.analysis?.recommendations?.[0],
    monitoring?.analysis?.nutritionConcern?.recommendations?.[0],
    monitoring?.analysis?.nutritionEducation?.recommendations?.[0],
    program?.pythonRecommendation,
    program?.recommendation,
    child?.pythonRecommendation,
  ];
  const provided = candidates.find((value) => typeof value === 'string' && value.trim());
  if (provided) return provided.trim();

  if (program?.category === 'TidakNaik') {
    return 'Berikan edukasi khusus status berat badan tidak naik dan jadwalkan pemantauan lebih dekat.';
  }
  if (program?.category === 'Wasting' || program?.category === 'Underweight') {
    return 'Berikan edukasi gizi sesuai usia, lanjutkan PMT sesuai jadwal, dan pantau hasil pengukuran berikutnya.';
  }
  return 'Lanjutkan pemantauan pertumbuhan dan penimbangan berikutnya sesuai jadwal.';
}
