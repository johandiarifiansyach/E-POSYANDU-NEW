// Table pages own their columns and data loading; this shell standardizes scrolling.
import Native, { type DomChild } from '../runtime/dom';

type DataTableProps = { children?: DomChild; className?: string; ariaLabel?: string };

export const DataTable = ({ children, className = '', ariaLabel = 'Tabel data' }: DataTableProps) => Native.createElement(
    'div',
    { className: `ios-table-scroll overflow-x-auto ${className}`, role: 'region', tabIndex: 0, 'aria-label': ariaLabel },
    children
);
