import Native from '../runtime/dom';

type SkeletonBlockProps = {
  className?: string;
};

type TableLoadingSkeletonProps = {
  columnCount: number;
  rowCount?: number;
};

type ExclusiveBreastfeedingTableSkeletonProps = {
  rowCount?: number;
};

export function SkeletonBlock({ className = '' }: SkeletonBlockProps) {
  return Native.createElement('span', {
    className: `app-skeleton-block${className ? ` ${className}` : ''}`,
    'aria-hidden': 'true'
  });
}

export function AppLoadingSkeleton() {
  return Native.createElement(
    'div',
    { className: 'app-loading-screen' },
    Native.createElement(
      'div',
      { className: 'app-loading-shell', role: 'status', 'aria-live': 'polite', 'aria-label': 'Memuat konten aplikasi' },
      Native.createElement(
        'aside',
        { className: 'app-loading-sidebar', 'aria-hidden': 'true' },
        Native.createElement(
          'div',
          { className: 'app-loading-brand' },
          SkeletonBlock({ className: 'app-loading-brand-icon' }),
          SkeletonBlock({ className: 'app-loading-brand-name' })
        ),
        Native.createElement(
          'nav',
          { className: 'app-loading-nav' },
          ...Array.from({ length: 8 }, (_, index) =>
            Native.createElement(
              'div',
              { className: 'app-loading-nav-item', key: `loading-nav-${index}` },
              SkeletonBlock({ className: 'app-loading-nav-icon' }),
              SkeletonBlock({ className: 'app-loading-nav-label' })
            )
          )
        )
      ),
      Native.createElement(
        'div',
        { className: 'app-loading-workspace' },
        Native.createElement(
          'header',
          { className: 'app-loading-topbar', 'aria-hidden': 'true' },
          Native.createElement(
            'div',
            { className: 'app-loading-topbar-copy' },
            SkeletonBlock({ className: 'app-loading-topbar-title' }),
            SkeletonBlock({ className: 'app-loading-topbar-subtitle' })
          ),
          Native.createElement(
            'div',
            { className: 'app-loading-topbar-actions' },
            SkeletonBlock({ className: 'app-loading-theme-button' }),
            Native.createElement(
              'div',
              { className: 'app-loading-user' },
              SkeletonBlock({ className: 'app-loading-user-avatar' }),
              Native.createElement(
                'div',
                { className: 'app-loading-user-copy' },
                SkeletonBlock({ className: 'app-loading-user-name' }),
                SkeletonBlock({ className: 'app-loading-user-role' })
              )
            )
          )
        ),
        Native.createElement(
          'main',
          { className: 'app-loading-content', 'aria-hidden': 'true' },
          Native.createElement(
            'div',
            { className: 'app-loading-page-heading' },
            SkeletonBlock({ className: 'app-loading-title' }),
            SkeletonBlock({ className: 'app-loading-subtitle' })
          ),
          Native.createElement(
            'section',
            { className: 'app-loading-toolbar' },
            ...Array.from({ length: 3 }, (_, index) =>
              Native.createElement(
                'div',
                { className: 'app-loading-filter', key: `loading-filter-${index}` },
                SkeletonBlock({ className: 'app-loading-filter-label' }),
                SkeletonBlock({ className: 'app-loading-filter-control' })
              )
            ),
            SkeletonBlock({ className: 'app-loading-toolbar-button' })
          ),
          Native.createElement(
            'div',
            { className: 'app-loading-grid' },
            ...Array.from({ length: 6 }, (_, index) =>
              Native.createElement(
                'div',
                { className: 'app-loading-card', key: `loading-card-${index}` },
                Native.createElement(
                  'div',
                  { className: 'app-loading-card-heading' },
                  SkeletonBlock({ className: 'app-loading-card-title' }),
                  SkeletonBlock({ className: 'app-loading-card-icon' })
                ),
                SkeletonBlock({ className: 'app-loading-card-value' }),
                SkeletonBlock({ className: 'app-loading-card-line' })
              )
            )
          ),
          Native.createElement(
            'section',
            { className: 'app-loading-panel' },
            Native.createElement(
              'div',
              { className: 'app-loading-panel-heading' },
              Native.createElement(
                'div',
                { className: 'app-loading-panel-copy' },
                SkeletonBlock({ className: 'app-loading-panel-title' }),
                SkeletonBlock({ className: 'app-loading-panel-subtitle' })
              ),
              SkeletonBlock({ className: 'app-loading-panel-action' })
            ),
            Native.createElement(
              'div',
              { className: 'app-loading-list' },
              ...Array.from({ length: 4 }, (_, index) =>
                Native.createElement(
                  'div',
                  { className: 'app-loading-list-row', key: `loading-row-${index}` },
                  SkeletonBlock({ className: 'app-loading-list-avatar' }),
                  Native.createElement(
                    'div',
                    { className: 'app-loading-list-copy' },
                    SkeletonBlock({ className: 'app-loading-list-name' }),
                    SkeletonBlock({ className: 'app-loading-list-meta' })
                  ),
                  SkeletonBlock({ className: 'app-loading-list-chip' }),
                  SkeletonBlock({ className: 'app-loading-list-action' })
                )
              )
            )
          )
        )
      ),
      Native.createElement(
        'div',
        { className: 'app-loading-mobile-dock', 'aria-hidden': 'true' },
        ...Array.from({ length: 5 }, (_, index) => SkeletonBlock({ className: `app-loading-mobile-action action-${index}` }))
      )
    )
  );
}

/**
 * Login has a deliberately different shell from the authenticated app. Keep
 * its loading state inside the same glass card so the transition never jumps
 * from the dashboard layout into the login form.
 */
export function LoginLoadingSkeleton({ includeTurnstile = false }: { includeTurnstile?: boolean } = {}) {
  return Native.createElement(
    'div',
    {
      className: 'login-shell login-loading-shell',
      role: 'status',
      'aria-live': 'polite',
      'aria-label': 'Memuat halaman login'
    },
    Native.createElement('div', { className: 'login-batik-background', 'aria-hidden': 'true' }),
    Native.createElement(
      'div',
      { className: 'login-theme-toggle login-loading-theme-toggle', 'aria-hidden': 'true' },
      SkeletonBlock({ className: 'login-loading-theme-icon' })
    ),
    Native.createElement(
      'main',
      { className: 'login-stage' },
      Native.createElement(
        'div',
        { className: 'login-stack' },
        Native.createElement(
          'section',
          { className: 'login-glass-card login-loading-card', 'aria-hidden': 'true' },
          Native.createElement(
            'div',
            { className: 'login-brand' },
            Native.createElement(
              'div',
              { className: 'login-logo-shell' },
              SkeletonBlock({ className: 'login-loading-logo' })
            ),
            SkeletonBlock({ className: 'login-loading-title' }),
            SkeletonBlock({ className: 'login-loading-organization' }),
            Native.createElement(
              'div',
              { className: 'login-brand-rule', 'aria-hidden': 'true' },
              SkeletonBlock({ className: 'login-loading-rule' })
            )
          ),
          Native.createElement(
            'div',
            { className: 'login-form login-loading-form' },
            Native.createElement(
              'div',
              { className: 'login-field' },
              SkeletonBlock({ className: 'login-loading-label login-loading-label-username' }),
              SkeletonBlock({ className: 'login-loading-input' })
            ),
            Native.createElement(
              'div',
              { className: 'login-field' },
              SkeletonBlock({ className: 'login-loading-label login-loading-label-password' }),
              Native.createElement(
                'div',
                { className: 'login-password-field login-loading-password-field' },
                SkeletonBlock({ className: 'login-loading-input' }),
                SkeletonBlock({ className: 'login-loading-password-toggle' })
              )
            ),
            includeTurnstile
              ? Native.createElement(
                'div',
                { className: 'login-turnstile login-loading-turnstile' },
                SkeletonBlock({ className: 'login-loading-turnstile-block' })
              )
              : null,
            SkeletonBlock({ className: 'login-loading-submit' })
          )
        )
      )
    ),
    Native.createElement(
      'footer',
      { className: 'login-footer login-loading-footer', 'aria-hidden': 'true' },
      Native.createElement('p', null, SkeletonBlock({ className: 'login-loading-footer-copy' })),
      Native.createElement(
        'div',
        { className: 'login-version-button' },
        SkeletonBlock({ className: 'login-loading-footer-version' })
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
    Native.Fragment,
    null,
    ...Array.from({ length: rowCount }, (_, rowIndex) =>
      Native.createElement(
        'tr',
        { className: 'app-table-loading-row', key: `table-row-${rowIndex}`, 'aria-hidden': 'true' },
        ...Array.from({ length: columnCount }, (_, columnIndex) =>
          Native.createElement(
            'td',
            { className: 'app-table-loading-cell', key: `table-cell-${rowIndex}-${columnIndex}` },
            Native.createElement(
              'div',
              { className: columnIndex === 1 ? 'app-table-loading-stack' : 'app-table-loading-content' },
              SkeletonBlock({ className: `app-table-cell-skeleton app-table-cell-skeleton-${columnIndex === 0 ? 'index' : columnIndex === columnCount - 1 ? 'action' : 'line'}` }),
              columnIndex === 1 && SkeletonBlock({ className: 'app-table-cell-skeleton app-table-cell-skeleton-secondary' })
            )
          )
        )
      )
    )
  );
}

export function AdminAccountTableSkeleton({ rowCount = 6 }: { rowCount?: number } = {}) {
  return Native.createElement(
    Native.Fragment,
    null,
    ...Array.from({ length: rowCount }, (_, rowIndex) =>
      Native.createElement(
        'tr',
        { className: 'admin-account-loading-row', key: `admin-account-loading-${rowIndex}`, 'aria-hidden': 'true' },
        Native.createElement(
          'td',
          null,
          Native.createElement('div', { className: 'admin-account-loading-identity' },
            SkeletonBlock({ className: 'admin-account-loading-avatar' }),
            Native.createElement('div', { className: 'admin-account-loading-copy' },
              SkeletonBlock({ className: 'admin-account-loading-name' }),
              SkeletonBlock({ className: 'admin-account-loading-email' })))
        ),
        Native.createElement('td', null,
          Native.createElement('div', { className: 'admin-account-loading-copy' },
            SkeletonBlock({ className: 'admin-account-loading-role' }),
            SkeletonBlock({ className: 'admin-account-loading-scope' }))),
        Native.createElement('td', null, SkeletonBlock({ className: 'admin-account-loading-access' })),
        Native.createElement('td', null,
          Native.createElement('div', { className: 'admin-account-loading-copy' },
            SkeletonBlock({ className: 'admin-account-loading-status' }),
            SkeletonBlock({ className: 'admin-account-loading-active' }))),
        Native.createElement('td', null, SkeletonBlock({ className: 'admin-account-loading-seen' })),
        Native.createElement('td', null,
          Native.createElement('div', { className: 'admin-account-loading-actions' },
            SkeletonBlock({ className: 'admin-account-loading-action' }),
            SkeletonBlock({ className: 'admin-account-loading-action' })))
      )
    )
  );
}

export function ChangeHistoryLoadingSkeleton({ rowCount = 4 }: { rowCount?: number } = {}) {
  return Native.createElement(
    'div',
    { className: 'change-history-loading-list', 'aria-hidden': 'true' },
    ...Array.from({ length: rowCount }, (_, index) =>
      Native.createElement(
        'article',
        { className: 'app-card change-history-loading-card', key: `change-history-loading-${index}` },
        Native.createElement('div', { className: 'change-history-loading-heading' },
          Native.createElement('div', { className: 'change-history-loading-copy' },
            SkeletonBlock({ className: 'change-history-loading-title' }),
            SkeletonBlock({ className: 'change-history-loading-meta' })),
          SkeletonBlock({ className: 'change-history-loading-icon' })),
        Native.createElement('div', { className: 'change-history-loading-details' },
          SkeletonBlock({ className: 'change-history-loading-detail' }),
          SkeletonBlock({ className: 'change-history-loading-detail change-history-loading-detail-short' }))
      )
    )
  );
}

export function ExclusiveBreastfeedingTableSkeleton({ rowCount = 6 }: ExclusiveBreastfeedingTableSkeletonProps = {}) {
  return Native.createElement(
    Native.Fragment,
    null,
    ...Array.from({ length: rowCount }, (_, index) =>
      Native.createElement(
        'tr',
        { className: 'app-asi-table-skeleton-row', key: `asi-loading-row-${index}`, 'aria-hidden': 'true' },
        Native.createElement(
          'td',
          { className: 'px-4 py-3 text-center' },
          SkeletonBlock({ className: 'app-asi-skeleton-number' })
        ),
        Native.createElement(
          'td',
          { className: 'px-4 py-3' },
          Native.createElement(
            'div',
            { className: 'app-asi-skeleton-stack' },
            SkeletonBlock({ className: 'app-asi-skeleton-name' }),
            SkeletonBlock({ className: 'app-asi-skeleton-nik' })
          )
        ),
        Native.createElement(
          'td',
          { className: 'px-4 py-3' },
          SkeletonBlock({ className: 'app-asi-skeleton-age' })
        ),
        Native.createElement(
          'td',
          { className: 'px-4 py-3' },
          SkeletonBlock({ className: 'app-asi-skeleton-date' })
        ),
        Native.createElement(
          'td',
          { className: 'px-4 py-3' },
          Native.createElement(
            'div',
            { className: 'app-asi-skeleton-stack' },
            SkeletonBlock({ className: 'app-asi-skeleton-location' }),
            SkeletonBlock({ className: 'app-asi-skeleton-village' })
          )
        ),
        Native.createElement(
          'td',
          { className: 'px-4 py-3 text-center' },
          SkeletonBlock({ className: 'app-asi-skeleton-status' })
        )
      )
    )
  );
}
