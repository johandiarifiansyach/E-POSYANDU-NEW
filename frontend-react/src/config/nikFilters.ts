/** Filter choices for the child registry NIK source. */
export const NIK_STATUS_OPTIONS = [
  { value: 'all', label: 'Semua NIK' },
  { value: 'missing', label: 'Tidak Punya NIK' },
  { value: 'present', label: 'Punya NIK' },
] as const;

export type NikStatus = typeof NIK_STATUS_OPTIONS[number]['value'];

export function isNikStatus(value: unknown): value is NikStatus {
  return NIK_STATUS_OPTIONS.some((option) => option.value === value);
}

export function childHasManualNik(child: Record<string, unknown>): boolean {
  return child.hasNIK === true || child.has_national_id === true;
}

/**
 * Manual NIKs are explicitly entered in the identity form (`hasNIK=true`).
 * Automatically generated temporary NIKs remain visible but are marked red
 * in the table and belong to the "Tidak Punya NIK" group.
 */
export function childMatchesNikStatus(child: Record<string, unknown>, status: NikStatus): boolean {
  if (status === 'all') return true;
  const hasNik = childHasManualNik(child);
  return status === 'present' ? hasNik : !hasNik;
}
