import { AlertTriangle, CheckCircle2, TrendingUp, X } from '../../ui/icons';
import { Button } from '../../components/base';
import { MeasurementAnalysisSkeleton } from '../../components/base/LoadingSkeletons';

type AnyRecord = Record<string, any>;
export type MeasurementAnalysisState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  result?: AnyRecord;
  error?: string;
};

export type MeasurementAnalysisDialogProps = {
  child: AnyRecord;
  measurement?: AnyRecord;
  state: MeasurementAnalysisState;
  onClose: () => void;
  onOpenChart?: () => void;
};

const WHO_STATUS_FIELDS: Array<[string, string, string]> = [
  ['bbuStatus', 'BB/U', 'bbuZScore'],
  ['tbuStatus', 'PB/TB/U', 'tbuZScore'],
  ['bbtbStatus', 'BB/PB atau BB/TB', 'bbtbZScore'],
  ['imtuStatus', 'IMT/U', 'imtuZScore'],
  ['lilaStatus', 'LILA/U', 'lilaZScore'],
  ['lkStatus', 'LK/U', 'lkZScore']
];

const RISK_LABELS: Record<string, string> = {
  underweight: 'Risiko underweight',
  stunting: 'Risiko stunting',
  wasting: 'Risiko wasting'
};

function score(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2).replace('.', ',') : '—';
}

function percent(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${Math.round(parsed * 100)}%` : '—';
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function PosterGuidance({ poster }: { poster?: AnyRecord | null }) {
  if (!poster) return null;
  const points = list(poster.keyPoints);
  const portions = list(poster.portionExamples);
  return <div className="measurement-analysis-poster">
    {poster.asset ? <img className="measurement-analysis-poster-image" src={String(poster.asset)} alt={String(poster.title || 'Poster Isi Piringku sesuai usia')} loading="lazy" decoding="async" /> : null}
    <div className="measurement-analysis-poster-copy">
      <strong>{String(poster.title || 'Isi Piringku sesuai usia')}</strong>
      {points.length ? <ul>{points.map((point, index) => <li key={`point-${index}`}>{point}</li>)}</ul> : null}
      {portions.length ? <div className="measurement-analysis-poster-portions"><span>Contoh porsi dari poster</span><ul>{portions.map((portion, index) => <li key={`portion-${index}`}>{portion}</li>)}</ul></div> : null}
      {poster.sourceFile ? <small>Sumber: {String(poster.sourceFile)}</small> : null}
    </div>
  </div>;
}

function Guidance({ guidance, normal = false }: { guidance: AnyRecord; normal?: boolean }) {
  const education = list(guidance.education);
  const recommendations = list(guidance.recommendations ?? guidance.followUp);
  const findings = Array.isArray(guidance.findings) ? guidance.findings : [];
  const materials = Array.isArray(guidance.matchedGuidance) ? guidance.matchedGuidance : [];
  return <section className={`measurement-analysis-card measurement-analysis-guidance ${normal ? '' : 'measurement-analysis-card-alert'}`}>
    <div className="measurement-analysis-card-heading"><span aria-hidden="true">{normal ? <CheckCircle2 /> : <AlertTriangle />}</span><div><h3>{String(guidance.title || (normal ? 'Edukasi mempertahankan pertumbuhan' : 'Edukasi dan rekomendasi tindak lanjut'))}</h3><p>{String(guidance.summary || 'Status gizi memerlukan pemantauan dan tindak lanjut dari tenaga kesehatan.')}</p></div></div>
    {findings.length ? <div className="measurement-analysis-guidance-findings">{findings.map((finding: AnyRecord, index: number) => <span key={`finding-${index}`}>{String(finding.indicator || 'Indikator')}: {String(finding.status || '—')}</span>)}</div> : null}
    {materials.length ? <div className="measurement-analysis-guidance-list measurement-analysis-guidance-sources"><strong>Materi tatalaksana yang digunakan</strong><ul>{materials.map((material: AnyRecord, index: number) => <li key={`material-${index}`}>{String(material.title || material.id || 'Panduan status gizi')}</li>)}</ul></div> : null}
    <PosterGuidance poster={guidance.posterGuidance} />
    {education.length ? <div className="measurement-analysis-guidance-list"><strong>{normal ? 'Edukasi sesuai usia dan persentase skrining' : 'Edukasi singkat'}</strong><ul>{education.map((item, index) => <li key={`education-${index}`}>{item}</li>)}</ul></div> : null}
    {recommendations.length ? <div className="measurement-analysis-guidance-list"><strong>{guidance.urgency === 'segera' ? 'Rekomendasi tindak lanjut segera' : 'Rekomendasi tindak lanjut'}</strong><ul>{recommendations.map((item, index) => <li key={`recommendation-${index}`}>{item}</li>)}</ul></div> : null}
    {guidance.disclaimer ? <small className="measurement-analysis-guidance-disclaimer">{String(guidance.disclaimer)}</small> : null}
  </section>;
}

/** Complete React counterpart of the legacy measurement-analysis dialog. */
export default function MeasurementAnalysisDialog({ child, measurement, state, onClose, onOpenChart }: MeasurementAnalysisDialogProps) {
  const result = state.result || {};
  const item = result.item || {};
  const anomaly = result.anomaly || { detected: false, count: 0, items: [] };
  const risk = result.risk || {};
  const concern = result.nutritionConcern || null;
  const education = result.nutritionEducation || null;
  const pending = state.status === 'loading';
  return <div className="growth-chart-backdrop measurement-analysis-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="growth-chart-dialog measurement-analysis-dialog" role="dialog" aria-modal="true" aria-labelledby="react-measurement-analysis-title">
      <header className="growth-chart-header"><div><h2 id="react-measurement-analysis-title">Analisis Pengukuran</h2><p>{String(child?.nama || 'Balita')} • {String(measurement?.tglUkur || 'pengukuran terbaru')}</p></div><button type="button" className="growth-chart-close" onClick={onClose} aria-label="Tutup analisis"><X /></button></header>
      <div className="growth-chart-body measurement-analysis-body">
        {pending ? <MeasurementAnalysisSkeleton /> : state.status === 'error' ? <div className="measurement-analysis-warning" role="status"><AlertTriangle /><span>{state.error || 'Analisis pertumbuhan belum tersedia. Deteksi cepat tetap ditampilkan.'}</span></div> : <>
          <section className={`measurement-analysis-card ${anomaly.detected ? 'measurement-analysis-card-alert' : 'measurement-analysis-card-ok'}`}><div className="measurement-analysis-card-heading">{anomaly.detected ? <AlertTriangle /> : <CheckCircle2 />}<div><h3>{anomaly.detected ? 'Anomali data terdeteksi' : 'Tidak ada anomali terdeteksi'}</h3><p>{anomaly.detected ? `${anomaly.count || anomaly.items?.length || 0} temuan perlu diperiksa sebelum data dianggap final.` : 'Perubahan pengukuran masih berada dalam pola yang wajar.'}</p></div></div>{Array.isArray(anomaly.items) && anomaly.items.length ? <ul className="measurement-analysis-list">{anomaly.items.map((entry: AnyRecord, index: number) => <li key={`anomaly-${index}`}><strong>{String(entry.message || 'Perubahan data')}</strong>{entry.previousValue !== undefined && entry.previousValue !== null ? ` Sebelumnya ${String(entry.previousValue)}; sekarang ${String(entry.currentValue)}.` : null}</li>)}</ul> : null}</section>
          <section className="measurement-analysis-card measurement-analysis-who-card"><div className="measurement-analysis-card-heading"><CheckCircle2 /><div><h3>Status gizi WHO</h3><p>{result.calculator === 'python-deterministic-lms' ? 'Dihitung dengan rumus LMS WHO deterministik; ini adalah hasil resmi status gizi.' : 'Hasil kalkulasi pertumbuhan dari layanan Python.'}</p></div></div><div className="measurement-analysis-who-grid">{WHO_STATUS_FIELDS.map(([statusKey, label, scoreKey]) => <div className="measurement-analysis-who-item" key={statusKey}><span>{label}</span><strong>{String(item[statusKey] || '—')}</strong><small>Skor-z: {score(item[scoreKey])}</small></div>)}</div></section>
          {concern ? <Guidance guidance={concern} /> : <section className="measurement-analysis-card"><div className="measurement-analysis-card-heading"><TrendingUp /><div><h3>Prediksi risiko</h3><p>{String(risk.disclaimer || 'Screening otomatis, bukan diagnosis. Konfirmasi oleh tenaga kesehatan.')}</p></div></div><div className="measurement-analysis-risk-grid">{Object.entries(RISK_LABELS).map(([key, label]) => { const prediction = risk.predictions?.[key] || {}; return <div className="measurement-analysis-risk" key={key}><span>{label}</span><strong>{percent(prediction.probability)}</strong><small>{String(prediction.explanation || 'Model analisis pertumbuhan belum mengembalikan prediksi.')}</small></div>; })}</div></section>}
          {!concern && education ? <Guidance guidance={education} normal /> : null}
        </>}
      </div>
      <footer className="growth-chart-actions"><Button type="button" variant="secondary" onClick={onOpenChart} disabled={!onOpenChart}><TrendingUp /> Buka grafik pertumbuhan</Button><Button type="button" onClick={onClose}>Tutup</Button></footer>
    </section>
  </div>;
}
