import SkeletonBlock from './SkeletonBlock';

export function AppLoadingSkeleton() {
  return <div className="app-loading-screen">
    <div className="app-loading-shell" role="status" aria-live="polite" aria-label="Memuat konten aplikasi">
      <aside className="app-loading-sidebar" aria-hidden="true">
        <div className="app-loading-brand"><SkeletonBlock className="app-loading-brand-icon" /><SkeletonBlock className="app-loading-brand-name" /></div>
        <nav className="app-loading-nav">{Array.from({ length: 8 }, (_, index) => <div className="app-loading-nav-item" key={`loading-nav-${index}`}><SkeletonBlock className="app-loading-nav-icon" /><SkeletonBlock className="app-loading-nav-label" /></div>)}</nav>
      </aside>
      <div className="app-loading-workspace">
        <header className="app-loading-topbar" aria-hidden="true">
          <div className="app-loading-topbar-copy"><SkeletonBlock className="app-loading-topbar-title" /><SkeletonBlock className="app-loading-topbar-subtitle" /></div>
          <div className="app-loading-topbar-actions">
            <SkeletonBlock className="app-loading-theme-button" />
            <div className="app-loading-user"><SkeletonBlock className="app-loading-user-avatar" /><div className="app-loading-user-copy"><SkeletonBlock className="app-loading-user-name" /><SkeletonBlock className="app-loading-user-role" /></div></div>
          </div>
        </header>
        <main className="app-loading-content" aria-hidden="true">
          <div className="app-loading-page-heading"><SkeletonBlock className="app-loading-title" /><SkeletonBlock className="app-loading-subtitle" /></div>
          <section className="app-loading-toolbar">
            {Array.from({ length: 3 }, (_, index) => <div className="app-loading-filter" key={`loading-filter-${index}`}><SkeletonBlock className="app-loading-filter-label" /><SkeletonBlock className="app-loading-filter-control" /></div>)}
            <SkeletonBlock className="app-loading-toolbar-button" />
          </section>
          <div className="app-loading-grid">{Array.from({ length: 6 }, (_, index) => <div className="app-loading-card" key={`loading-card-${index}`}><div className="app-loading-card-heading"><SkeletonBlock className="app-loading-card-title" /><SkeletonBlock className="app-loading-card-icon" /></div><SkeletonBlock className="app-loading-card-value" /><SkeletonBlock className="app-loading-card-line" /></div>)}</div>
          <section className="app-loading-panel">
            <div className="app-loading-panel-heading"><div className="app-loading-panel-copy"><SkeletonBlock className="app-loading-panel-title" /><SkeletonBlock className="app-loading-panel-subtitle" /></div><SkeletonBlock className="app-loading-panel-action" /></div>
            <div className="app-loading-list">{Array.from({ length: 4 }, (_, index) => <div className="app-loading-list-row" key={`loading-row-${index}`}><SkeletonBlock className="app-loading-list-avatar" /><div className="app-loading-list-copy"><SkeletonBlock className="app-loading-list-name" /><SkeletonBlock className="app-loading-list-meta" /></div><SkeletonBlock className="app-loading-list-chip" /><SkeletonBlock className="app-loading-list-action" /></div>)}</div>
          </section>
        </main>
      </div>
      <div className="app-loading-mobile-dock" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <SkeletonBlock className={`app-loading-mobile-action action-${index}`} key={`loading-mobile-${index}`} />)}</div>
    </div>
  </div>;
}

export function LoginLoadingSkeleton({ includeTurnstile = false }: { includeTurnstile?: boolean } = {}) {
  return <div className="login-shell login-loading-shell" role="status" aria-live="polite" aria-busy="true" aria-label="Memuat halaman login">
    <div className="login-batik-background" aria-hidden="true" />
    <div className="login-theme-toggle login-loading-theme-toggle" aria-hidden="true"><SkeletonBlock className="login-loading-theme-icon" /></div>
    <main className="login-stage"><div className="login-stack"><section className="login-glass-card login-loading-card" aria-hidden="true">
      <div className="login-brand"><div className="login-logo-shell"><SkeletonBlock className="login-loading-logo" /></div><SkeletonBlock className="login-loading-title" /><SkeletonBlock className="login-loading-organization" /><div className="login-brand-rule"><SkeletonBlock className="login-loading-rule login-loading-rule-blue" /><SkeletonBlock className="login-loading-rule login-loading-rule-indigo" /><SkeletonBlock className="login-loading-rule login-loading-rule-cyan" /></div></div>
      <div className="login-form login-loading-form"><div className="login-field"><SkeletonBlock className="login-loading-label login-loading-label-username" /><SkeletonBlock className="login-loading-input" /></div><div className="login-field"><SkeletonBlock className="login-loading-label login-loading-label-password" /><div className="login-password-field login-loading-password-field"><SkeletonBlock className="login-loading-input" /><SkeletonBlock className="login-loading-password-toggle" /></div></div>{includeTurnstile ? <div className="login-turnstile login-loading-turnstile"><SkeletonBlock className="login-loading-turnstile-block" /></div> : null}<SkeletonBlock className="login-loading-submit" /></div>
    </section></div></main>
    <footer className="login-footer login-loading-footer" aria-hidden="true"><p><SkeletonBlock className="login-loading-footer-copy" /></p><div className="login-version-button"><SkeletonBlock className="login-loading-footer-version" /></div></footer>
  </div>;
}

export function DashboardPageSkeleton() {
  return <div className="app-page-skeleton" aria-hidden="true"><div className="app-page-skeleton-header"><SkeletonBlock className="app-page-skeleton-title" /><SkeletonBlock className="app-page-skeleton-line" /></div><div className="app-page-skeleton-grid">{Array.from({ length: 6 }, (_, index) => <div className="app-page-skeleton-card" key={`page-card-${index}`}><SkeletonBlock className="app-page-skeleton-card-label" /><SkeletonBlock className="app-page-skeleton-card-value" /><SkeletonBlock className="app-page-skeleton-card-line" /></div>)}</div></div>;
}

export function TableLoadingSkeleton({ columnCount, rowCount = 6 }: { columnCount: number; rowCount?: number }) {
  return <>{Array.from({ length: rowCount }, (_, rowIndex) => <tr className="app-table-loading-row" key={`table-row-${rowIndex}`} aria-hidden="true">{Array.from({ length: columnCount }, (_, columnIndex) => <td className="app-table-loading-cell" key={`table-cell-${rowIndex}-${columnIndex}`}><div className={columnIndex === 1 ? 'app-table-loading-stack' : 'app-table-loading-content'}><SkeletonBlock className={`app-table-cell-skeleton app-table-cell-skeleton-${columnIndex === 0 ? 'index' : columnIndex === columnCount - 1 ? 'action' : 'line'}`} />{columnIndex === 1 ? <SkeletonBlock className="app-table-cell-skeleton app-table-cell-skeleton-secondary" /> : null}</div></td>)}</tr>)}</>;
}

export function ExclusiveBreastfeedingTableSkeleton({ rowCount = 6 }: { rowCount?: number } = {}) {
  return <>{Array.from({ length: rowCount }, (_, index) => <tr className="app-asi-table-skeleton-row" key={`asi-loading-row-${index}`} aria-hidden="true"><td className="px-4 py-3 text-center"><SkeletonBlock className="app-asi-skeleton-number" /></td><td className="px-4 py-3"><div className="app-asi-skeleton-stack"><SkeletonBlock className="app-asi-skeleton-name" /><SkeletonBlock className="app-asi-skeleton-nik" /></div></td><td className="px-4 py-3"><SkeletonBlock className="app-asi-skeleton-age" /></td><td className="px-4 py-3"><SkeletonBlock className="app-asi-skeleton-date" /></td><td className="px-4 py-3"><div className="app-asi-skeleton-stack"><SkeletonBlock className="app-asi-skeleton-location" /><SkeletonBlock className="app-asi-skeleton-village" /></div></td><td className="px-4 py-3 text-center"><SkeletonBlock className="app-asi-skeleton-status" /></td></tr>)}</>;
}

export function MeasurementAnalysisSkeleton() {
  const labels = ['BB/U', 'PB/TB/U', 'BB/PB atau BB/TB', 'IMT/U', 'LILA/U', 'LK/U'];
  return <div className="measurement-analysis-skeleton" role="status" aria-live="polite" aria-label="Menunggu hasil analisis"><div className="measurement-analysis-skeleton-banner"><SkeletonBlock className="measurement-analysis-skeleton-icon" /><div className="measurement-analysis-skeleton-copy"><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-wide" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /></div></div><section className="measurement-analysis-card measurement-analysis-skeleton-card"><AnalysisHeading /><div className="measurement-analysis-who-grid">{labels.map((label) => <div className="measurement-analysis-who-item measurement-analysis-skeleton-item" key={label}><span>{label}</span><SkeletonBlock className="measurement-analysis-skeleton-value" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-short" /></div>)}</div></section><section className="measurement-analysis-card measurement-analysis-skeleton-card"><AnalysisHeading /><div className="measurement-analysis-risk-grid">{['Risiko underweight', 'Risiko stunting', 'Risiko wasting'].map((label) => <div className="measurement-analysis-risk measurement-analysis-skeleton-risk" key={label}><span>{label}</span><SkeletonBlock className="measurement-analysis-skeleton-risk-value" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-wide" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /></div>)}</div></section><section className="measurement-analysis-card measurement-analysis-skeleton-card measurement-analysis-skeleton-guidance"><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-wide" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-wide" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /></section></div>;
}

function AnalysisHeading() {
  return <div className="measurement-analysis-skeleton-heading"><SkeletonBlock className="measurement-analysis-skeleton-heading-icon" /><div className="measurement-analysis-skeleton-copy"><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-wide" /></div></div>;
}

export function GrowthAnalysisSkeleton() {
  return <section className="growth-chart-analysis growth-chart-analysis-skeleton" role="status" aria-live="polite" aria-label="Menunggu analisis pertumbuhan"><div className="growth-chart-analysis-skeleton-header"><div className="measurement-analysis-skeleton-copy"><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-short" /></div><SkeletonBlock className="growth-chart-analysis-skeleton-confidence" /></div><SkeletonBlock className="growth-chart-analysis-skeleton-summary" /><div className="growth-chart-analysis-grid">{Array.from({ length: 4 }, (_, index) => <article className="growth-chart-analysis-indicator growth-chart-analysis-skeleton-indicator" key={`growth-indicator-${index}`}><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-short" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-wide" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /></article>)}</div></section>;
}

export function GrowthChartSkeleton() {
  return <div className="growth-chart-python-loading growth-chart-python-skeleton" role="status" aria-live="polite" aria-label="Memuat grafik pertumbuhan"><SkeletonBlock className="growth-chart-python-skeleton-plot" /><div className="growth-chart-python-skeleton-caption"><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-medium" /><SkeletonBlock className="measurement-analysis-skeleton-line measurement-analysis-skeleton-line-short" /></div></div>;
}
