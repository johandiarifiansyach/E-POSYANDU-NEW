// @ts-nocheck
import { parseMeasurementDecimal } from './measurementRules';

/** Immediate client-side guard shown while the Python job is in the queue. */
export function quickMeasurementAnomaly(history, measurement) {
  const currentDate = String(measurement?.tglUkur || '').slice(0, 10);
  const previous = (history || [])
    .filter((item) => item?.id !== measurement?.id && item?.tglUkur && String(item.tglUkur).slice(0, 10) < currentDate)
    .sort((left, right) => String(left.tglUkur).localeCompare(String(right.tglUkur)))
    .pop();
  const currentHeight = parseMeasurementDecimal(measurement?.tb);
  const previousHeight = parseMeasurementDecimal(previous?.tb);
  const items = [];
  if (currentHeight !== null && previousHeight !== null && currentHeight < previousHeight - 0.1) {
    items.push({
      code: 'height_decreased',
      severity: 'high',
      field: 'height_cm',
      message: 'Tinggi/panjang badan lebih rendah dari pengukuran sebelumnya. Periksa ulang alat, cara ukur, dan satuan; tinggi badan tidak mungkin turun.',
      currentValue: currentHeight,
      previousValue: previousHeight,
      delta: currentHeight - previousHeight,
      detection: 'quick-client-guard',
    });
  }
  return {
    detected: items.length > 0,
    count: items.length,
    severity: items.length ? 'high' : 'none',
    version: 'quick-height-guard-v1',
    items,
  };
}
