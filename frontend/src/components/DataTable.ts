// Table pages own their columns and data loading; this shell standardizes scrolling.
// @ts-nocheck
import Native from '../runtime/dom';

export const DataTable = ({ children, className = '', ariaLabel = 'Tabel data' }) => Native.createElement(
    'div',
    { className: `ios-table-scroll overflow-x-auto ${className}`, role: 'region', tabIndex: 0, 'aria-label': ariaLabel },
    children
);
