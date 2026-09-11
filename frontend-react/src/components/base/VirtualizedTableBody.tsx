import { Fragment, useCallback, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";

const VIRTUALIZATION_THRESHOLD = 50;
const DEFAULT_ROW_HEIGHT = 112;

export type VirtualizedTableBodyProps<T> = {
  items: readonly T[];
  colSpan: number;
  renderRow: (item: T, index: number) => ReactNode;
  rowKey: (item: T, index: number) => string | number;
  estimateRowHeight?: number;
  className?: string;
};

/**
 * Table-safe virtualization for large, already-filtered result sets.  The
 * first 50 rows intentionally use normal table flow to preserve exact native
 * row sizing; larger sets render only the viewport plus a small overscan.
 */
export default function VirtualizedTableBody<T>({
  items,
  colSpan,
  renderRow,
  rowKey,
  estimateRowHeight = DEFAULT_ROW_HEIGHT,
  className,
}: VirtualizedTableBodyProps<T>) {
  const virtualized = items.length > VIRTUALIZATION_THRESHOLD;
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  // DataTable owns the scroll node. Resolve it from the table body and store
  // it in state so the virtualizer is re-measured after the ref is attached.
  const bodyRef = useCallback((node: HTMLTableSectionElement | null) => {
    const next = node?.closest(".ios-table-scroll") as HTMLDivElement | null;
    setScrollElement((current) => (current === next ? current : next));
  }, []);
  const virtualizer = useVirtualizer({
    count: virtualized ? items.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimateRowHeight,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const visibleRows = useMemo(
    () =>
      virtualItems.map((virtualItem) => ({
        virtualItem,
        item: items[virtualItem.index],
      })),
    [items, virtualItems],
  );

  if (!virtualized) {
    return (
      <tbody ref={bodyRef} className={className}>
        {items.map((item, index) => (
          <Fragment key={rowKey(item, index)}>{renderRow(item, index)}</Fragment>
        ))}
      </tbody>
    );
  }

  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  const topSpacer = first?.start ?? 0;
  const bottomSpacer = last
    ? Math.max(0, virtualizer.getTotalSize() - last.end)
    : virtualizer.getTotalSize();

  return (
    <tbody ref={bodyRef} className={className}>
      {topSpacer > 0 ? (
        <tr aria-hidden="true" className="virtual-table-spacer">
          <td colSpan={colSpan} style={{ height: topSpacer, padding: 0, border: 0 }} />
        </tr>
      ) : null}
      {visibleRows.map(({ virtualItem, item }) => (
        <Fragment key={rowKey(item, virtualItem.index)}>
          {renderRow(item, virtualItem.index)}
        </Fragment>
      ))}
      {bottomSpacer > 0 ? (
        <tr aria-hidden="true" className="virtual-table-spacer">
          <td colSpan={colSpan} style={{ height: bottomSpacer, padding: 0, border: 0 }} />
        </tr>
      ) : null}
    </tbody>
  );
}
