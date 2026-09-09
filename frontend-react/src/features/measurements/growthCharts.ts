/** React-facing chart metadata and filename helpers. */
export const GROWTH_CHART_TYPES = ['bbu', 'tbu', 'bbtb', 'imtu', 'lilau', 'lku'] as const;
export const GROWTH_CHART_LABELS = { bbu: 'BB/U', tbu: 'PB atau TB/U', bbtb: 'BB/PB atau BB/TB', imtu: 'IMT/U', lilau: 'LILA/U', lku: 'LK/U' } as const;
export function safeChildFileName(child: Record<string, unknown>): string {
  const name = String(child?.nama || 'balita').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return name || 'balita';
}
