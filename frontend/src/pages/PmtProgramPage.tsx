import { AlertCircle, Calendar, FileDown, Minus, TrendingDown } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ChildData,
  formatIndoDate,
  PmtProgramData
} from './LegacyApp';

type PmtProgramPageProps = {
  childrenData: ChildData[];
  pmtPrograms: PmtProgramData[];
  onExportPmt: () => void;
  onOpenMonitoring: (program: PmtProgramData, child: ChildData) => void;
};

export default function PmtProgramPage({
  childrenData,
  pmtPrograms,
  onExportPmt,
  onOpenMonitoring
}: PmtProgramPageProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-800">Program Pemberian PMT</h2>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="bg-indigo-50 px-4 py-2 rounded-lg text-indigo-700 text-sm font-semibold">
            Total Penerima: {pmtPrograms.length} Balita
          </div>
          <Button onClick={onExportPmt} variant="primary" className="bg-indigo-600 hover:bg-indigo-700">
            <FileDown className="w-4 h-4" /> Export PMT (XLS)
          </Button>
        </div>
      </div>

      {(['Wasting', 'Underweight', 'TidakNaik'] as const).map((cat) => {
        const programs = pmtPrograms.filter((program) => program.category === cat);
        if (programs.length === 0) return null;

        return (
          <div key={cat} className="space-y-3">
            <h3 className="text-lg font-bold text-slate-700 flex items-center gap-2">
              {cat === 'Wasting' && <AlertCircle className="text-rose-500" />}
              {cat === 'Underweight' && <TrendingDown className="text-orange-500" />}
              {cat === 'TidakNaik' && <Minus className="text-amber-500" />}
              Kategori: {cat}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {programs.map((program) => (
                <Card key={program.id} className="p-4 border-l-4 border-l-indigo-500">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h4 className="font-bold text-slate-800">{program.childName}</h4>
                      <p className="text-xs text-slate-500">Mulai: {formatIndoDate(program.tglPemberian)}</p>
                    </div>
                    <Badge color="blue">{program.jenisPmt}</Badge>
                  </div>
                  <div className="text-xs text-slate-600 mb-3 space-y-1">
                    <p>Anggaran: {program.sumberAnggaran}</p>
                    <p>Status: <span className="font-bold text-emerald-600">{program.status}</span></p>
                  </div>
                  <Button
                    variant="actionBlue"
                    className="w-full text-xs"
                    onClick={() => {
                      const child = childrenData.find((item) => item.id === program.childId);
                      if (child) onOpenMonitoring(program, child);
                    }}
                  >
                    <Calendar className="w-3 h-3" /> Pantau Mingguan
                  </Button>
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
