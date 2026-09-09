/** React-owned PMT monitoring presentation rules. Python remains authoritative
 * for the underlying nutritional classifications. */
export const CATEGORY_OPTIONS = [
  { value: 'Semua', label: 'Semua PMT', shortLabel: 'Semua' },
  { value: 'Underweight', label: 'Underweight (BB Kurang/Sangat Kurang)', shortLabel: 'Underweight' },
  { value: 'Wasting', label: 'Wasting (Gizi Kurang/Buruk)', shortLabel: 'Wasting' },
  { value: 'TidakNaik', label: 'BB Tidak Naik (N/T)', shortLabel: 'Tidak Naik' }
] as const;

export function maxWeeksForCategory(category: string): number {
  if (category === 'Wasting') return 8;
  if (category === 'Underweight') return 4;
  return 2;
}
export function categoryLabel(category: string): string { return category === 'TidakNaik' ? 'BB Tidak Naik' : category || '-'; }
export function categoryMetric(category: string): string { return category === 'Wasting' ? 'BB/TB' : category === 'Underweight' ? 'BB/U' : 'N/T'; }
export function numericValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
export function getMonitoringForWeek(program: Record<string, any>, week: number): Record<string, any> | null {
  const monitorings = program?.monitorings ?? program?.pemantauan;
  if (Array.isArray(monitorings)) return monitorings.find((item) => Number(item?.week ?? item?.minggu) === Number(week)) || monitorings[Number(week)] || null;
  return monitorings?.[week] ?? monitorings?.[String(week)] ?? null;
}
export function baselineForProgram(program: Record<string, any>, child?: Record<string, any>) {
  const initialDate = program?.initialMeasurementDate || program?.tanggalAwalPengukuran || program?.tglPemberian;
  return { date: initialDate || child?.lastMeasurementDate, weight: numericValue(program.initialBB ?? program.bbAwal) ?? numericValue(child?.currentBB) ?? numericValue(child?.bbLahir), height: numericValue(program.initialTB ?? program.tbAwal) ?? numericValue(child?.currentTB) ?? numericValue(child?.pbLahir) };
}
export function monitoringStatus(_program: Record<string, any>, _child: Record<string, any> | undefined, monitoring: Record<string, any> | null, _week?: number, _baseline?: Record<string, any>) {
  return monitoring?.pythonStatus ?? monitoring?.python?.status ?? monitoring?.analysis?.status ?? '-';
}
export function automaticRecommendation(program: Record<string, any>, child: Record<string, any> | undefined, monitoring: Record<string, any> | null) {
  const candidates = [monitoring?.pythonRecommendation, monitoring?.recommendation, monitoring?.analysis?.recommendation, monitoring?.analysis?.recommendations?.[0], monitoring?.analysis?.nutritionConcern?.recommendations?.[0], monitoring?.analysis?.nutritionEducation?.recommendations?.[0], program?.pythonRecommendation, program?.recommendation, child?.pythonRecommendation];
  const provided = candidates.find((value) => typeof value === 'string' && value.trim());
  if (provided) return provided.trim();
  if (program?.category === 'TidakNaik') return 'Berikan edukasi khusus status berat badan tidak naik dan jadwalkan pemantauan lebih dekat.';
  if (program?.category === 'Wasting' || program?.category === 'Underweight') return 'Berikan edukasi gizi sesuai usia, lanjutkan PMT sesuai jadwal, dan pantau hasil pengukuran berikutnya.';
  return 'Lanjutkan pemantauan pertumbuhan dan penimbangan berikutnya sesuai jadwal.';
}
