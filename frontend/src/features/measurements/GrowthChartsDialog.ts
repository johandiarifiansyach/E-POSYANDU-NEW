// @ts-nocheck
import Native, { useEffect, useMemo, useRef, useState } from '../../runtime/dom';
import { Button } from '../../components';
import { FileDown, Loader2, X } from '../../ui/icons';
import { showError, showSuccess } from '../../ui/notifications';
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

export default function GrowthChartsDialog({ child, history, onClose }) {
  const [activeType, setActiveType] = useState('bbu');
  const [exporting, setExporting] = useState('');
  const models = useMemo(() => getGrowthChartModels(history, child), [history, child]);
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
