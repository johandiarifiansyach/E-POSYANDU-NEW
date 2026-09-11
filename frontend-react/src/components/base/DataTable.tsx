import { forwardRef, memo, type ReactNode } from 'react';

export type DataTableProps = {
  children?: ReactNode;
  className?: string;
  ariaLabel?: string;
};

const DataTable = memo(
  forwardRef<HTMLDivElement, DataTableProps>(function DataTable(
    { children, className = '', ariaLabel = 'Tabel data' },
    ref,
  ) {
    return <div ref={ref} className={`ios-table-scroll overflow-x-auto ${className}`} role="region" tabIndex={0} aria-label={ariaLabel}>{children}</div>;
  }),
);

export default DataTable;
