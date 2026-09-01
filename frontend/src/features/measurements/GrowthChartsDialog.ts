// @ts-nocheck
import Native, { useEffect, useMemo, useRef, useState } from '../../runtime/dom';
import { Button } from '../../components';
import { FileDown, Loader2, X } from '../../ui/icons';
import { showError, showSuccess } from '../../ui/notifications';
import { requestGrowthAnalysis, requestPythonGrowthChart } from '../../api/analysisApi';
import {
  drawGrowthChart,
  getGrowthChartModels,
  GROWTH_CHART_LABELS,
  GROWTH_CHART_TYPES,
  renderGrowthChartCanvas,
  safeChildFileName,
} from './growthCharts';

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

function GrowthCanvas({ model }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (canvasRef.current) drawGrowthChart(canvasRef.current, model);
  });
  return Native.createElement('div', { className: 'growth-chart-canvas-shell' },
    Native.createElement('canvas', {
      ref: canvasRef,
      width: 1200,
      height: 720,
      className: 'growth-chart-canvas',
      role: 'img',
      'aria-label': `${model.title}, grafik standar WHO dan hasil pengukuran anak`,
    })
  );
}

function mountSafeSvg(container, markup) {
  if (!container || typeof markup !== 'string') return;
  const documentView = container.ownerDocument;
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) return;
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
  const imported = documentView.importNode(svg, true);
  container.replaceChildren(imported);
}

function GrowthSvg({ svg, title }) {
  const containerRef = useRef(null);
  useEffect(() => {
    mountSafeSvg(containerRef.current, svg);
  }, [svg]);
  return Native.createElement('div', {
    ref: containerRef,
    className: 'growth-chart-python-svg',
    role: 'img',
    'aria-label': `${title}, grafik standar WHO dan hasil pengukuran anak`,
  });
}

function formatAnalysisValue(value, unit) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2).replace('.', ',')} ${unit}` : '—';
}

function GrowthAnalysisPanel({ state }) {
  if (state.status === 'loading') {
    return Native.createElement('div', { className: 'growth-chart-analysis growth-chart-analysis-loading', role: 'status' },
      Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }),
      Native.createElement('span', null, 'Analisis tren pertumbuhan sedang diproses…')
    );
  }
  if (state.status === 'error') {
    return Native.createElement('div', { className: 'growth-chart-analysis growth-chart-analysis-warning', role: 'status' },
      Native.createElement('strong', null, 'Analisis pertumbuhan belum tersedia.'),
      Native.createElement('span', null, state.error || 'Grafik tetap dapat dibaca, tetapi penjelasan tren belum diterima.')
    );
  }
  const analysis = state.result || {};
  const indicators = Array.isArray(analysis.indicators) ? analysis.indicators : [];
  const conclusions = Array.isArray(analysis.conclusions) ? analysis.conclusions : [];
  const recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
  const concern = analysis.nutritionConcern || null;
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
  const models = useMemo(() => getGrowthChartModels(history, child), [history, child]);
  const activeModel = models[activeType];
  const activeAnomalyCount = activeModel.childPoints.filter((point) => point.anomaly).length;
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

  const downloadPng = async () => {
    setExporting('png');
    try {
      const canvas = renderGrowthChartCanvas(activeModel, { width: 1600, height: 960 });
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG tidak dapat dibuat.')), 'image/png');
      });
      downloadBlob(blob, `grafik-${activeType}-${safeChildFileName(child)}.png`);
      showSuccess(`Grafik ${GROWTH_CHART_LABELS[activeType]} berhasil diunduh sebagai PNG.`);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Grafik PNG belum dapat diunduh.');
    } finally {
      setExporting('');
    }
  };

  const downloadPdf = async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;
      for (let index = 0; index < GROWTH_CHART_TYPES.length; index += 1) {
        const type = GROWTH_CHART_TYPES[index];
        if (index > 0) pdf.addPage('a4', 'landscape');
        const canvas = renderGrowthChartCanvas(models[type], { width: 1600, height: 960 });
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', margin, margin, pageWidth - margin * 2, pageHeight - margin * 2, undefined, 'FAST');
      }
      pdf.save(`semua-grafik-pertumbuhan-${safeChildFileName(child)}.pdf`);
      showSuccess('Enam grafik pertumbuhan berhasil diunduh dalam satu PDF.');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'PDF grafik pertumbuhan belum dapat dibuat.');
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
          ? Native.createElement(GrowthSvg, { svg: chartState.svg, title: activeModel.title })
          : chartState.status === 'loading'
            ? Native.createElement('div', { className: 'growth-chart-python-loading', role: 'status' }, Native.createElement(Loader2, { className: 'h-5 w-5 animate-spin' }), ' Memuat grafik dari Python…')
            : Native.createElement(Native.Fragment, null,
              Native.createElement('div', { className: 'growth-chart-python-warning', role: 'status' }, 'Grafik Python belum tersedia: ', chartState.error || 'kesalahan tidak diketahui.'),
              Native.createElement(GrowthCanvas, { model: activeModel })),
        Native.createElement('p', { className: 'growth-chart-footnote' },
          `Garis menunjukkan -3, -2, median, +2, dan +3 SD standar WHO. ${activeModel.childPoints.length} titik hasil anak dihubungkan berdasarkan urutan pengukuran.`
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
          onClick: downloadPng,
          disabled: Boolean(exporting),
        }, exporting === 'png' ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }) : Native.createElement(FileDown, { className: 'h-4 w-4' }),
          exporting === 'png' ? 'Membuat PNG...' : `Unduh ${GROWTH_CHART_LABELS[activeType]} (PNG)`
        ),
        Native.createElement(Button, {
          type: 'button',
          variant: 'primary',
          onClick: downloadPdf,
          disabled: Boolean(exporting),
        }, exporting === 'pdf' ? Native.createElement(Loader2, { className: 'h-4 w-4 animate-spin' }) : Native.createElement(FileDown, { className: 'h-4 w-4' }),
          exporting === 'pdf' ? 'Membuat PDF...' : 'Unduh Semua Grafik (PDF)'
        )
      )
    )
  );
}
