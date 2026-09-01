// @ts-nocheck
import Native from '../../runtime/dom';
import { AlertTriangle, CheckCircle2, Loader2, TrendingUp, X } from '../../ui/icons';
import { Button } from '../../components';

const RISK_LABELS = { underweight: 'Risiko underweight', stunting: 'Risiko stunting', wasting: 'Risiko wasting' };
const RISK_COLORS = { tinggi: 'measurement-analysis-risk-high', sedang: 'measurement-analysis-risk-medium', rendah: 'measurement-analysis-risk-low' };
const WHO_STATUS_FIELDS = [
  ['bbuStatus', 'BB/U', 'bbuZScore'],
  ['tbuStatus', 'PB/TB/U', 'tbuZScore'],
  ['bbtbStatus', 'BB/PB atau BB/TB', 'bbtbZScore'],
  ['imtuStatus', 'IMT/U', 'imtuZScore'],
  ['lilaStatus', 'LILA/U', 'lilaZScore'],
  ['lkStatus', 'LK/U', 'lkZScore'],
];

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '—';
}

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2).replace('.', ',') : '—';
}

export default function MeasurementAnalysisDialog({ child, measurement, state, onClose, onOpenChart }) {
  const analysis = state?.result || {};
  const whoItem = analysis.item || {};
  const anomaly = analysis.anomaly || { detected: false, count: 0, items: [] };
  const risk = analysis.risk || {};
  const predictions = risk.predictions || {};
  const concern = analysis.nutritionConcern || null;
  const pending = state?.status === 'loading';
  const failed = state?.status === 'error';
  return Native.createElement('div', {
    className: 'growth-chart-backdrop measurement-analysis-backdrop',
    role: 'presentation',
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) onClose();
    },
  },
    Native.createElement('section', {
      className: 'growth-chart-dialog measurement-analysis-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'measurement-analysis-dialog-title',
    },
      Native.createElement('header', { className: 'growth-chart-header' },
        Native.createElement('div', null,
          Native.createElement('h2', { id: 'measurement-analysis-dialog-title' }, 'Analisis Pengukuran'),
          Native.createElement('p', null, `${child?.nama || 'Balita'} • ${measurement?.tglUkur || 'pengukuran terbaru'}`)
        ),
        Native.createElement('button', { type: 'button', className: 'growth-chart-close', onClick: onClose, 'aria-label': 'Tutup analisis' }, Native.createElement(X, { className: 'h-5 w-5' }))
      ),
      Native.createElement('div', { className: 'growth-chart-body measurement-analysis-body' },
        pending && Native.createElement('div', { className: 'measurement-analysis-pending', role: 'status' },
          Native.createElement(Loader2, { className: 'h-5 w-5 animate-spin' }),
          Native.createElement('span', null, 'Analisis pertumbuhan sedang diproses… hasil akan diperbarui otomatis.')
        ),
        failed && Native.createElement('div', { className: 'measurement-analysis-warning', role: 'status' },
          Native.createElement(AlertTriangle, { className: 'h-5 w-5' }),
          Native.createElement('span', null, state.error || 'Analisis pertumbuhan belum tersedia. Deteksi cepat tetap ditampilkan.')
        ),
        Native.createElement('section', { className: anomaly.detected ? 'measurement-analysis-card measurement-analysis-card-alert' : 'measurement-analysis-card measurement-analysis-card-ok' },
          Native.createElement('div', { className: 'measurement-analysis-card-heading' },
            anomaly.detected ? Native.createElement(AlertTriangle, { className: 'h-5 w-5' }) : Native.createElement(CheckCircle2, { className: 'h-5 w-5' }),
            Native.createElement('div', null,
              Native.createElement('h3', null, anomaly.detected ? 'Anomali data terdeteksi' : 'Tidak ada anomali terdeteksi'),
              Native.createElement('p', null, anomaly.detected ? `${anomaly.count || anomaly.items?.length || 0} temuan perlu diperiksa sebelum data dianggap final.` : 'Perubahan pengukuran masih berada dalam pola yang wajar.')
            )
          ),
          anomaly.items?.length > 0 && Native.createElement('ul', { className: 'measurement-analysis-list' }, anomaly.items.map((item, index) =>
            Native.createElement('li', { key: `${item.code}-${index}` },
              Native.createElement('strong', null, item.message),
              item.previousValue !== null && item.previousValue !== undefined && Native.createElement('span', null, ` Sebelumnya ${item.previousValue}; sekarang ${item.currentValue}.`)
            )
          ))
        ),
        Native.createElement('section', { className: 'measurement-analysis-card measurement-analysis-who-card' },
          Native.createElement('div', { className: 'measurement-analysis-card-heading' },
            Native.createElement(CheckCircle2, { className: 'h-5 w-5' }),
            Native.createElement('div', null,
              Native.createElement('h3', null, 'Status gizi WHO'),
              Native.createElement('p', null, analysis.calculator === 'python-deterministic-lms'
                ? 'Dihitung dengan rumus LMS WHO deterministik; ini adalah hasil resmi status gizi.'
                : 'Menunggu hasil kalkulasi pertumbuhan.')
            )
          ),
          Native.createElement('div', { className: 'measurement-analysis-who-grid' }, WHO_STATUS_FIELDS.map(([statusKey, label, scoreKey]) =>
            Native.createElement('div', { key: statusKey, className: 'measurement-analysis-who-item' },
              Native.createElement('span', null, label),
              Native.createElement('strong', null, whoItem[statusKey] || (pending ? 'Menunggu…' : '—')),
              Native.createElement('small', null, `Skor-z: ${score(whoItem[scoreKey])}`)
            )
          ))
        ),
        concern
          ? Native.createElement('section', { className: 'measurement-analysis-card measurement-analysis-card-alert measurement-analysis-guidance' },
            Native.createElement('div', { className: 'measurement-analysis-card-heading' },
              Native.createElement(AlertTriangle, { className: 'h-5 w-5' }),
              Native.createElement('div', null,
                Native.createElement('h3', null, concern.title || 'Edukasi dan tindak lanjut'),
                Native.createElement('p', null, concern.summary || 'Status gizi memerlukan tindak lanjut tenaga kesehatan.')
              )
            ),
            concern.findings?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-findings' },
              concern.findings.map((finding, index) => Native.createElement('span', { key: `finding-${index}` }, `${finding.indicator}: ${finding.status}`))
            ),
            concern.education?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list' },
              Native.createElement('strong', null, 'Edukasi singkat'),
              Native.createElement('ul', null, concern.education.map((value, index) => Native.createElement('li', { key: `education-${index}` }, value)))
            ),
            concern.followUp?.length > 0 && Native.createElement('div', { className: 'measurement-analysis-guidance-list' },
              Native.createElement('strong', null, concern.urgency === 'segera' ? 'Tindak lanjut segera' : 'Tindak lanjut'),
              Native.createElement('ul', null, concern.followUp.map((value, index) => Native.createElement('li', { key: `follow-up-${index}` }, value)))
            ),
            concern.disclaimer && Native.createElement('small', { className: 'measurement-analysis-guidance-disclaimer' }, concern.disclaimer)
          )
          : Native.createElement('section', { className: 'measurement-analysis-card' },
          Native.createElement('div', { className: 'measurement-analysis-card-heading' },
            Native.createElement(TrendingUp, { className: 'h-5 w-5' }),
            Native.createElement('div', null,
              Native.createElement('h3', null, 'Prediksi risiko'),
              Native.createElement('p', null, risk.disclaimer || 'Screening otomatis, bukan diagnosis. Konfirmasi oleh tenaga kesehatan.')
            )
          ),
          Native.createElement('div', { className: 'measurement-analysis-risk-grid' }, Object.entries(RISK_LABELS).map(([key, label]) => {
            const prediction = predictions[key] || {};
            const level = String(prediction.level || 'menunggu').toLowerCase();
            return Native.createElement('div', { key, className: `measurement-analysis-risk ${RISK_COLORS[level] || ''}` },
              Native.createElement('span', null, label),
              Native.createElement('strong', null, pending && !prediction.probability ? 'Menunggu…' : percent(prediction.probability)),
              Native.createElement('small', null, prediction.explanation || 'Model analisis pertumbuhan belum mengembalikan prediksi.')
            );
          }))
        )
      ),
      Native.createElement('footer', { className: 'growth-chart-actions' },
        Native.createElement(Button, { type: 'button', variant: 'secondary', onClick: onOpenChart }, Native.createElement(TrendingUp, { className: 'h-4 w-4' }), ' Buka grafik pertumbuhan'),
        Native.createElement(Button, { type: 'button', variant: 'primary', onClick: onClose }, 'Tutup')
      )
    )
  );
}
