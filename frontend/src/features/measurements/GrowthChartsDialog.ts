// @ts-nocheck
import Native, { useEffect, useMemo, useRef, useState } from '../../runtime/dom';
import { getGrowthAiSummary } from '../../api/aiApi';
import { Button } from '../../components';
import { FileDown, Loader2, Sparkles, X } from '../../ui/icons';
import { showError, showSuccess } from '../../ui/notifications';
import {
  drawGrowthChart,
  getGrowthChartModels,
  GROWTH_CHART_LABELS,
  GROWTH_CHART_TYPES,
  renderGrowthChartCanvas,
  safeChildFileName,
} from './growthCharts';
import {
  buildAnonymousGrowthSummaryPayload,
  buildLocalGrowthSummaryFallback,
} from './growthSummary';

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

export default function GrowthChartsDialog({ child, history, onClose }) {
  const [activeType, setActiveType] = useState('bbu');
  const [exporting, setExporting] = useState('');
  const [aiState, setAiState] = useState({ status: 'idle', result: null, message: '' });
  const models = useMemo(() => getGrowthChartModels(history, child), [history, child]);
  const anonymousPayload = useMemo(
    () => buildAnonymousGrowthSummaryPayload(history, child),
    [history, child]
  );
  const activeModel = models[activeType];

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

  const requestAiSummary = async () => {
    if (!anonymousPayload.measurements.length) {
      setAiState({
        status: 'error',
        result: null,
        message: 'Belum ada riwayat pengukuran valid yang dapat diringkas.'
      });
      return;
    }
    setAiState({ status: 'loading', result: null, message: '' });
    try {
      const result = await getGrowthAiSummary(anonymousPayload);
      setAiState({ status: 'success', result, message: '' });
    } catch (error) {
      setAiState({
        status: 'fallback',
        result: buildLocalGrowthSummaryFallback(anonymousPayload),
        message: error instanceof Error
          ? error.message
          : 'Ringkasan AI sementara tidak tersedia. Silakan coba lagi.'
      });
    }
  };

  const renderAiSummary = () => {
    if (aiState.status === 'loading') {
      return Native.createElement('div', {
        className: 'growth-ai-loading',
        role: 'status',
        'aria-live': 'polite',
      },
        Native.createElement(Loader2, { className: 'h-5 w-5 animate-spin' }),
        Native.createElement('div', null,
          Native.createElement('strong', null, 'Menyusun ringkasan anonim...'),
          Native.createElement('span', null, 'Status WHO tetap dihitung oleh aplikasi.')
        )
      );
    }

    if (aiState.status === 'error') {
      return Native.createElement('div', { className: 'growth-ai-error', role: 'alert' },
        Native.createElement('p', null, aiState.message),
        Native.createElement(Button, {
          type: 'button',
          variant: 'secondary',
          onClick: requestAiSummary,
          className: 'growth-ai-retry',
        }, 'Coba Lagi')
      );
    }

    if (['success', 'fallback'].includes(aiState.status) && aiState.result) {
      return Native.createElement('div', {
        className: 'growth-ai-result',
        role: 'status',
        'aria-live': 'polite',
      },
        aiState.status === 'fallback' && Native.createElement('p', {
          className: 'growth-ai-fallback-note',
          role: 'note',
        }, 'Layanan AI belum tersambung. Ringkasan berikut dibuat di perangkat dengan aturan lokal tanpa mengirim data keluar.'),
        Native.createElement('p', { className: 'growth-ai-overview' }, aiState.result.overview),
        Native.createElement('div', { className: 'growth-ai-columns' },
          Native.createElement('section', null,
            Native.createElement('h4', null, 'Hal yang terpantau'),
            Native.createElement('ul', null,
              aiState.result.observations.map((item, index) => Native.createElement('li', { key: `observation-${index}` }, item))
            )
          ),
          Native.createElement('section', null,
            Native.createElement('h4', null, 'Tindak lanjut'),
            Native.createElement('ul', null,
              aiState.result.followUp.map((item, index) => Native.createElement('li', { key: `follow-up-${index}` }, item))
            )
          )
        ),
        Native.createElement('p', { className: 'growth-ai-disclaimer' }, aiState.result.disclaimer),
        Native.createElement('p', { className: 'growth-ai-provider' },
          `${aiState.result.provider} • data anonim • tidak disimpan oleh permintaan ini`
        )
      );
    }

    return Native.createElement('div', { className: 'growth-ai-consent' },
      Native.createElement('p', null,
        'AI hanya menerima usia, jenis kelamin, angka antropometri, tren, serta hasil WHO. Nama, NIK, tanggal lahir, tanggal ukur, alamat, desa, dan Posyandu tidak dikirim.'
      ),
      Native.createElement(Button, {
        type: 'button',
        variant: 'primary',
        onClick: requestAiSummary,
        disabled: !anonymousPayload.measurements.length,
        className: 'growth-ai-button',
      },
        Native.createElement(Sparkles, { className: 'h-4 w-4' }),
        'Buat Ringkasan AI'
      )
    );
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
        Native.createElement(GrowthCanvas, { model: activeModel }),
        Native.createElement('p', { className: 'growth-chart-footnote' },
          `Garis menunjukkan -3, -2, median, +2, dan +3 SD standar WHO. ${activeModel.childPoints.length} titik biru hasil anak dihubungkan berdasarkan urutan pengukuran.`
        ),
        Native.createElement('section', {
          className: `growth-ai-panel is-${aiState.status}`,
          'aria-labelledby': 'growth-ai-title',
        },
          Native.createElement('div', { className: 'growth-ai-heading' },
            Native.createElement('span', { className: 'growth-ai-icon' },
              Native.createElement(Sparkles, { className: 'h-5 w-5' })
            ),
            Native.createElement('div', null,
              Native.createElement('h3', { id: 'growth-ai-title' }, 'Ringkasan AI Pertumbuhan'),
              Native.createElement('p', null, 'Penjelasan pola dari riwayat dan status WHO yang sudah dihitung')
            )
          ),
          Native.createElement('div', { className: 'growth-ai-content' }, renderAiSummary())
        )
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
