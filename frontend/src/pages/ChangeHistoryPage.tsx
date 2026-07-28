import { History } from 'lucide-react';
import { Card, ChangeLogData, formatIndoDateTime } from './LegacyApp';

type ChangeHistoryPageProps = {
  changeLogs: ChangeLogData[];
};

export default function ChangeHistoryPage({ changeLogs }: ChangeHistoryPageProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Riwayat Perubahan Identitas</h2>
        <p className="text-slate-500 text-sm">
          Mencatat semua perubahan data identitas balita yang dilakukan oleh petugas.
        </p>
      </div>

      <div className="space-y-4">
        {changeLogs.length === 0 ? (
          <div className="p-8 text-center text-slate-400 bg-white rounded-2xl border border-dashed border-slate-300">
            Belum ada riwayat perubahan data.
          </div>
        ) : (
          changeLogs.map((log) => (
            <Card key={log.id} className="p-4 border-l-4 border-l-amber-500">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h4 className="font-bold text-slate-800">{log.childName}</h4>
                  <p className="text-xs text-slate-500">
                    {formatIndoDateTime(log.timestamp)} - Oleh: {log.changedBy}
                  </p>
                </div>
                <History className="w-5 h-5 text-amber-500" />
              </div>
              <div className="bg-slate-50 rounded-lg p-3 space-y-2 text-xs">
                {log.changes.map((change, index) => (
                  <div
                    key={index}
                    className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center border-b border-slate-200 last:border-0 pb-1 last:pb-0"
                  >
                    <span className="font-semibold text-slate-600 w-24 uppercase">{change.field}</span>
                    <div className="flex items-center gap-2 flex-1">
                      <span className="text-rose-500 line-through bg-rose-50 px-1 rounded">
                        {String(change.oldValue || '-')}
                      </span>
                      <span className="text-slate-400">-&gt;</span>
                      <span className="text-emerald-600 font-bold bg-emerald-50 px-1 rounded">
                        {String(change.newValue || '-')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
