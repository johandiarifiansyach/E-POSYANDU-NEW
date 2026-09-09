// @ts-nocheck
export function matchesLocation(record, desa, posyandu) {
  return (!desa || record?.desa === desa) && (!posyandu || record?.posyandu === posyandu);
}
export function filterByLocation(records, desa, posyandu) {
  return (records || []).filter((record) => matchesLocation(record, desa, posyandu));
}

export function getScopedLocation(user, { roles, viewDesa, viewPosyandu }) {
  return {
    desa: user?.role === roles.KADER || user?.role === roles.BIDAN ? user.desa : viewDesa,
    posyandu: user?.role === roles.KADER ? user.posyandu : viewPosyandu,
  };
}
