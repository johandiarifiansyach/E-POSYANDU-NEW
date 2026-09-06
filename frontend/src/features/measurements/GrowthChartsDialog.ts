// @ts-nocheck
import Native, { useEffect, useMemo, useState } from '../../runtime/dom';
import { Button } from '../../components';
import { FileDown, Loader2, X } from '../../ui/icons';
import { showError, showSuccess } from '../../ui/notifications';
import { requestGrowthAnalysis, requestPythonGrowthChart } from '../../api/analysisApi';
import { GROWTH_CHART_LABELS, GROWTH_CHART_TYPES, safeChildFileName } from './growthCharts';
import { GrowthAnalysisSkeleton, GrowthChartSkeleton } from '../../ui/skeleton';

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function parseSafeSvg(markup) {
  if (typeof markup !== 'string' || !markup.trim() || typeof DOMParser === 'undefined') return null;
  const documentView = typeof document !== 'undefined' ? document : null;
  if (!documentView) return null;
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) return null;
  // The Python service emits a fixed SVG vocabulary. Remove executable SVG
  // features defensively before placing it in the DOM.
  svg.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((node) => node.remove());
  svg.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase().includes('href')) {
        node.removeAttribute(attribute.name);
      }
    });
  });
  return documentView.importNode(svg, true);
}

function GrowthSvg({ svg, title }) {
  // Keep the imported SVG in the virtual tree. Mounting it from an effect
  // leaves the virtual container empty; any later state update (for example
  // when the Python analysis arrives) would reconcile away the chart.
  const imported = parseSafeSvg(svg);
  return Native.createElement('div', {
    className: 'growth-chart-python-svg',
    role: 'img',
    'aria-label': `${title}, grafik standar WHO dan hasil pengukuran anak`,
  }, imported || Native.createElement('div', { className: 'growth-chart-python-warning', role: 'status' }, 'Grafik Python tidak dapat ditampilkan: format SVG tidak valid.'));
}

function formatAnalysisValue(value, unit) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2).replace('.', ',')} ${unit}` : '—';
}

function posterGuidanceBlock(poster, keyPrefix) {
  if (!poster) return null;
  const keyPoints = Array.isArray(poster.keyPoints) ? poster.keyPoints : [];
  const portions = Array.isArray(poster.portionExamples) ? poster.portionExamples : [];
  return Native.createElement('div', { className: 'measurement-analysis-poster' },
    poster.asset && Native.createElement('img', {
      className: 'measurement-analysis-poster-image',
      src: poster.asset,
      alt: poster.title || 'Poster Isi Piringku sesuai usia',
      loading: 'lazy',
      decoding: 'async',
    }),
    Native.createElement('div', { className: 'measurement-analysis-poster-copy' },
      Native.createElement('strong', null, poster.title || 'Isi Piringku sesuai usia'),
      keyPoints.length > 0 && Native.createElement('ul', null, keyPoints.map((value, index) => Native.createElement('li', { key: `${keyPrefix}-point-${index}` }, value))),
      portions.length > 0 && Native.createElement('div', { className: 'measurement-analysis-poster-portions' },
        Native.createElement('span', null, 'Contoh porsi dari poster'),
        Native.createElement('ul', null, portions.map((value, index) => Native.createElement('li', { key: `${keyPrefix}-portion-${index}` }, value)))
      ),
      poster.sourceFile && Native.createElement('small', null, `Sumber: ${poster.sourceFile}`)
    )
  );
}

function GrowthAnalysisPanel({ state }) {
  if (state.status === 'loading') {
    return Native.createElement(GrowthAnalysisSkeleton, null);
  }
  if (state.status === 'error') {
    return Native.createElement('div', { className: 'growth-chart-analysis growth-chart-analysis-warning', role: 'status' },
      Native.createElement('strong', null, 'Analisis pertumbuhan belum tersedia.'),
      Native.createElement('span', null, state.error || 'Layanan Python belum mengembalikan penjelasan tren.')
    );
  }
  const analysis = state.result || {};
  const indicators = Array.isArray(analysis.indicators) ? analysis.indicators : [];
  const conclusions = Array.isArray(analysis.conclusions) ? analysis.conclusions : [];
  const recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
  const concern = analysis.nutritionConcern || null;
  const education = analysis.nutritionEducation || null;
  return Native.createElement('section', { className: 'growth-chart-analysis', 'aria-label': 'Analisis Pertumbuhan' },
    Native.createElement('div', { className: 'growth-chart-analysis-header' },
      Native.createElement('div', null,
        Native.createElement('h3', null, 'Analisis Pertumbuhan'),
        Native.createElement('p', null, analysis.model ? `Model skrining: ${analysis.model}` : 'Model skrining tren grafik')
      ),
      Number.isFinite(Number(analysis.confidence)) && Native.createElement('span', { className: 'growth-chart-analysis-confidence' }, `Keyakinan ${(Number(analysis.confidence) * 100).toFixed(0)}%`)
    ),
    Native.createElement('p', { className: 'growth-chart-analysis-summary' }, analysis.summary || 'Belum ada kesimpulan tren.'),
    concern && Native.createElement('section', { className: 'measurement-analysis-guidance' },
      Native.createElement('div', { className: 'growth-chart-analysis-list' },
        Native.createElement('strong', null, concern.title || 'Edukasi singkat dan tindak lanjut'),
        Native.createElement('p', null, concern.summary || 'Status gizi memerlukan tindak lanjut tenaga kesehatan.')
      ),
      concern.findings?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-findings' },
        concern.findings.map((finding, index) => Native.createElement('span', { key: `growth-finding-${index}` }, `${finding.indicator}: ${finding.status}`))
      ),
      concern.matchedGuidance?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list measurement-analysis-guidance-sources' },
        Native.createElement('strong', null, 'Materi tatalaksana yang digunakan'),
        Native.createElement('ul', null, concern.matchedGuidance.map((material, index) => Native.createElement('li', { key: `growth-material-${index}` },
          material.title || material.id || 'Panduan status gizi'
        )))
      ),
      posterGuidanceBlock(concern.posterGuidance, 'growth-problem-poster'),
      concern.education?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list' },
        Native.createElement('strong', null, 'Edukasi singkat'),
        Native.createElement('ul', null, concern.education.map((value, index) => Native.createElement('li', { key: `growth-education-${index}` }, value)))
      ),
      concern.followUp?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list' },
        Native.createElement('strong', null, concern.urgency === 'segera' ? 'Tindak lanjut segera' : 'Tindak lanjut'),
        Native.createElement('ul', null, concern.followUp.map((value, index) => Native.createElement('li', { key: `growth-follow-up-${index}` }, value)))
      ),
      concern.disclaimer && Native.createElement('small', { className: 'measurement-analysis-guidance-disclaimer' }, concern.disclaimer)
    ),
    !concern && education && Native.createElement('section', { className: 'measurement-analysis-guidance' },
      Native.createElement('div', { className: 'growth-chart-analysis-list' },
        Native.createElement('strong', null, education.title || 'Edukasi mempertahankan pertumbuhan'),
        Native.createElement('p', null, `${education.ageGroup || 'Sesuai usia'} • Sinyal skrining tertinggi ${Number.isFinite(Number(education.riskPercentage)) ? `${education.riskPercentage}%` : 'belum tersedia'} (${education.riskLevel || 'rendah'})`)
      ),
      posterGuidanceBlock(education.posterGuidance, 'growth-normal-poster'),
      education.education?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list' },
        Native.createElement('strong', null, 'Edukasi sesuai usia dan persentase skrining'),
        Native.createElement('ul', null, education.education.map((value, index) => Native.createElement('li', { key: `growth-normal-education-${index}` }, value)))
      ),
      education.followUp?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list' },
        Native.createElement('strong', null, 'Pemantauan'),
        Native.createElement('ul', null, education.followUp.map((value, index) => Native.createElement('li', { key: `growth-normal-follow-up-${index}` }, value)))
      ),
      education.disclaimer && Native.createElement('small', { className: 'measurement-analysis-guidance-disclaimer' }, education.disclaimer)
    ),
    indicators.length > 0 && Native.createElement('div', { className: 'growth-chart-analysis-grid' }, indicators.map((indicator) =>
      Native.createElement('article', { key: indicator.key || indicator.label, className: `growth-chart-analysis-indicator growth-chart-analysis-${indicator.trend || 'neutral'}` },
        Native.createElement('strong', null, indicator.label || indicator.key || 'Indikator'),
        Native.createElement('span', null, indicator.trendLabel || '—'),
        Native.createElement('small', null, indicator.points >= 2
          ? `${formatAnalysisValue(indicator.firstValue, indicator.unit)} → ${formatAnalysisValue(indicator.latestValue, indicator.unit)} (${formatAnalysisValue(indicator.delta, indicator.unit)})`
          : 'Memerlukan minimal dua titik bertanggal'),
        Native.createElement('p', null, indicator.explanation || '')
      )
    )),
    conclusions.length > 0 && Native.createElement('div', { className: 'growth-chart-analysis-list' },
      Native.createElement('strong', null, 'Kesimpulan'),
      Native.createElement('ul', null, conclusions.map((value, index) => Native.createElement('li', { key: `conclusion-${index}` }, value)))
    ),
    recommendations.length > 0 && Native.createElement('div', { className: 'growth-chart-analysis-list' },
      Native.createElement('strong', null, 'Saran tindak lanjut'),
      Native.createElement('ul', null, recommendations.map((value, index) => Native.createElement('li', { key: `recommendation-${index}` }, value)))
    ),
    analysis.disclaimer && Native.createElement('p', { className: 'growth-chart-analysis-disclaimer' }, analysis.disclaimer)
  );
}

export default function GrowthChartsDialog({ child, history, onClose }) {
  const [activeType, setActiveType] = useState('bbu');
  const [exporting, setExporting] = useState('');
  const [pythonState, setPythonState] = useState({ status: 'loading', result: null, error: null });
  const [chartState, setChartState] = useState({ status: 'loading', svg: '', error: null });
  const activeAnomalyCount = Array.isArray(pythonState.result?.anomalies)
    ? pythonState.result.anomalies.length
    : 0;
  const historyKey = useMemo(() => (history || []).map((item) => `${item?.id || ''}:${item?.tglUkur || ''}`).join('|'), [history]);

  useEffect(() => {
    let active = true;
    setPythonState({ status: 'loading', result: null, error: null });
    void requestGrowthAnalysis(child, history)
      .then((response) => {
        if (!response.graphAnalysis) throw new Error('Respons analisis pertumbuhan belum memuat ringkasan grafik.');
        if (active) setPythonState({ status: 'success', result: response.graphAnalysis, error: null });
      })
      .catch((error) => {
        if (active) setPythonState({ status: 'error', result: null, error: error instanceof Error ? error.message : 'Analisis pertumbuhan belum tersedia.' });
      });
    return () => { active = false; };
  }, [child?.id, historyKey]);

  useEffect(() => {
    let active = true;
    setChartState({ status: 'loading', svg: '', error: null });
    void requestPythonGrowthChart(child, history, activeType)
      .then((response) => {
        if (!response?.svg) throw new Error('Renderer Python tidak mengembalikan SVG grafik.');
        if (active) setChartState({ status: 'success', svg: response.svg, error: null });
      })
      .catch((error) => {
        if (active) setChartState({ status: 'error', svg: '', error: error instanceof Error ? error.message : 'Grafik Python belum tersedia.' });
      });
    return () => { active = false; };
  }, [child?.id, historyKey, activeType]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !exporting) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, exporting]);

  const downloadPythonSvg = async () => {
    setExporting('svg');
    try {
      if (chartState.status !== 'success' || !chartState.svg) {
        throw new Error('Grafik Python belum selesai dirender.');
      }
      const blob = new Blob([chartState.svg], { type: 'image/svg+xml;charset=utf-8' });
      downloadBlob(blob, `grafik-${activeType}-${safeChildFileName(child)}.svg`);
      showSuccess(`Grafik ${GROWTH_CHART_LABELS[activeType]} berhasil diunduh dari Python.`);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Grafik Python belum dapat diunduh.');
    } finally {
      setExporting('');
    }
  };

  return Native.createElement('div', {
    className: 'growth-chart-backdrop',
    role: 'presentation',
    onPointerDown: (event) => {
      if (event.target === event.currentTarget && !exporting) onClose();
    },
  },
    Native.createElement('section', {
      className: 'growth-chart-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'growth-chart-dialog-title',
    },
      Native.createElement('header', { className: 'growth-chart-header' },
        Native.createElement('div', null,
          Native.createElement('h2', { id: 'growth-chart-dialog-title' }, 'Grafik Pertumbuhan WHO'),
          Native.createElement('p', null, `${child?.nama || 'Balita'} • ${child?.jk === 'P' ? 'Perempuan' : 'Laki-laki'} • usia 0–60 bulan`)
        ),
        Native.createElement('button', {
          type: 'button',
          className: 'growth-chart-close',
          onClick: onClose,
          disabled: Boolean(exporting),
          'aria-label': 'Tutup grafik pertumbuhan',
        }, Native.createElement(X, { className: 'h-5 w-5' }))
      ),
      Native.createElement('div', { className: 'growth-chart-body' },
        Native.createElement('div', { className: 'growth-chart-tabs', role: 'tablist', 'aria-label': 'Pilih jenis grafik pertumbuhan' },
          GROWTH_CHART_TYPES.map((type) => Native.createElement('button', {
            key: type,
            type: 'button',
            role: 'tab',
            'aria-selected': activeType === type,
            className: activeType === type ? 'is-active' : '',
            onClick: () => setActiveType(type),
          }, GROWTH_CHART_LABELS[type]))
        ),
        chartState.status === 'success'
          ? Native.createElement(GrowthSvg, { svg: chartState.svg, title: GROWTH_CHART_LABELS[activeType] })
          : chartState.status === 'loading'
            ? Native.createElement(GrowthChartSkeleton, null)
          : Native.createElement('div', { className: 'growth-chart-python-warning', role: 'status' }, 'Grafik Python belum tersedia: ', chartState.error || 'kesalahan tidak diketahui.'),
        Native.createElement('p', { className: 'growth-chart-footnote' },
          `Garis menunjukkan -3, -2, median, +2, dan +3 SD standar WHO. Kurva -1 dan +1 SD berwarna kuning khusus pada BB/PB atau BB/TB, IMT/U, LILA/U, dan LK/U. Titik hasil anak dihubungkan per segmen mengikuti warna jenis kelamin; garis terputus jika ada bulan tanpa pengukuran atau status O.`
        ),
        activeAnomalyCount > 0 && Native.createElement('div', { className: 'growth-chart-anomaly-note', role: 'alert' },
          `Ditemukan ${activeAnomalyCount} titik anomali: tinggi/panjang badan lebih rendah dari pengukuran sebelumnya. Periksa ulang alat dan cara ukur.`
        ),
        Native.createElement(GrowthAnalysisPanel, { state: pythonState })
      ),
      Native.createElement('footer', { className: 'growth-chart-actions' },
        Native.createElement(Button, {
          type: 'button',
          variant: 'secondary',
          onClick: downloadPythonSvg,
          disabled: Boolean(exporting),
        }, exporting === 'svg' ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }) : Native.createElement(FileDown, { className: 'h-4 w-4' }),
          exporting === 'svg' ? 'Menyiapkan SVG...' : `Unduh ${GROWTH_CHART_LABELS[activeType]} (SVG)`
        ),
        Native.createElement(Button, {
          type: 'button',
          variant: 'primary',
          onClick: downloadPythonSvg,
          disabled: Boolean(exporting),
        }, exporting === 'svg' ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }) : Native.createElement(FileDown, { className: 'h-4 w-4' }),
          exporting === 'svg' ? 'Menyiapkan SVG...' : 'Unduh Grafik Python (SVG)'
        )
      )
    )
  );
}
