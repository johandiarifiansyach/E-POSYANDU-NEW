import Native from '../runtime/dom';

type SkeletonBlockProps = {
  className?: string;
};

type AppLoadingSkeletonProps = {
  message?: string;
};

type TableLoadingSkeletonProps = {
  columnCount: number;
  rowCount?: number;
};

export function SkeletonBlock({ className = '' }: SkeletonBlockProps) {
  return Native.createElement('span', {
    className: `app-skeleton-block${className ? ` ${className}` : ''}`,
    'aria-hidden': 'true'
  });
}

export function AppLoadingSkeleton({ message = 'Menyiapkan aplikasi' }: AppLoadingSkeletonProps) {
  return Native.createElement(
    'div',
    { className: 'app-loading-screen' },
    Native.createElement(
      'div',
      { className: 'app-loading-shell', role: 'status', 'aria-live': 'polite', 'aria-label': message },
      Native.createElement(
        'div',
        { className: 'app-loading-surface' },
        Native.createElement(
          'div',
          { className: 'app-loading-header' },
          SkeletonBlock({ className: 'app-loading-badge' }),
          SkeletonBlock({ className: 'app-loading-title' }),
          SkeletonBlock({ className: 'app-loading-subtitle' })
        ),
        Native.createElement(
          'div',
          { className: 'app-loading-grid' },
          ...Array.from({ length: 4 }, (_, index) =>
            Native.createElement(
              'div',
              { className: 'app-loading-card', key: `loading-card-${index}` },
              SkeletonBlock({ className: 'app-loading-card-title' }),
              SkeletonBlock({ className: 'app-loading-card-value' }),
              SkeletonBlock({ className: 'app-loading-card-line' })
            )
          )
        ),
        Native.createElement('p', { className: 'app-loading-caption' }, message)
      )
    )
  );
}

export function DashboardPageSkeleton() {
  return Native.createElement(
    'div',
    { className: 'app-page-skeleton', 'aria-hidden': 'true' },
    Native.createElement(
      'div',
      { className: 'app-page-skeleton-header' },
      SkeletonBlock({ className: 'app-page-skeleton-title' }),
      SkeletonBlock({ className: 'app-page-skeleton-line' })
    ),
    Native.createElement(
      'div',
      { className: 'app-page-skeleton-grid' },
      ...Array.from({ length: 6 }, (_, index) =>
        Native.createElement(
          'div',
          { className: 'app-page-skeleton-card', key: `page-card-${index}` },
          SkeletonBlock({ className: 'app-page-skeleton-card-label' }),
          SkeletonBlock({ className: 'app-page-skeleton-card-value' }),
          SkeletonBlock({ className: 'app-page-skeleton-card-line' })
        )
      )
    )
  );
}

export function TableLoadingSkeleton({ columnCount, rowCount = 6 }: TableLoadingSkeletonProps) {
  return Native.createElement(
    'tr',
    null,
    Native.createElement(
      'td',
      { colSpan: columnCount, className: 'px-4 py-5' },
      Native.createElement(
        'div',
        { className: 'app-table-skeleton', 'aria-hidden': 'true' },
        ...Array.from({ length: rowCount }, (_, index) =>
          Native.createElement(
            'div',
            { className: 'app-table-skeleton-row', key: `table-row-${index}` },
            SkeletonBlock({ className: 'app-table-skeleton-index' }),
            Native.createElement(
              'div',
              { className: 'app-table-skeleton-main' },
              SkeletonBlock({ className: 'app-table-skeleton-name' }),
              SkeletonBlock({ className: 'app-table-skeleton-meta' })
            ),
            SkeletonBlock({ className: 'app-table-skeleton-chip' }),
            SkeletonBlock({ className: 'app-table-skeleton-action' })
          )
        )
      )
    )
  );
}