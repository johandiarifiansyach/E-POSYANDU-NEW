/**
 * Metadata used by the growth-chart dialog.
 *
 * WHO reference curves, point calculation, segmentation, and rendering are
 * owned by the Python analysis service.  Keeping only labels here prevents a
 * browser-side implementation from becoming a second source of truth.
 */

export const GROWTH_CHART_TYPES = ['bbu', 'tbu', 'bbtb', 'imtu', 'lilau', 'lku'] as const;

export const GROWTH_CHART_LABELS = {
  bbu: 'BB/U',
  tbu: 'PB atau TB/U',
  bbtb: 'BB/PB atau BB/TB',
  imtu: 'IMT/U',
  lilau: 'LILA/U',
  lku: 'LK/U',
} as const;

export function safeChildFileName(child: any): string {
  const name = String(child?.nama || 'balita')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return name || 'balita';
}
