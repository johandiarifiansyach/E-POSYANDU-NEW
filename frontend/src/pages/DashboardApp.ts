// Compatibility entrypoint for existing page imports and the application router.
export { Dashboard } from '../app/dashboard';
export { db, appId } from '../app/session';

export {
    DATA_WILAYAH,
    ROLES,
    DASHBOARD_TABS,
    COMPACT_SIDEBAR_MEDIA_QUERY,
    MONTHS,
    YEARS
} from '../shared/constants';

export {
    formatChildName,
    getKBM,
    formatDate,
    formatIndoDate,
    formatIndoDateTime,
    getAgeInMonths,
    calculateZScore,
    calculateGiziStatus,
    generateRandomDigits
} from '../shared/formatters';

export {
    normalizeDecimalInput,
    parseLocaleNumber,
    parseLocaleNumberForRange
} from '../shared/validators';

export { ensureXlsx } from '../services/exportService';

export { Card, InputGroup, LocationFilterPanel } from '../ui/dashboardPrimitives';
export { Button, Select, Badge, KenaikanBadge, StatusBadge } from '../components';
