import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FileText,
  FileUp,
  Filter,
  Gift,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Ruler,
  Search,
  Trash2,
  Utensils,
  X
} from 'lucide-react';
import {
  Badge,
  Button,
  calculateGiziStatus,
  Card,
  ChildData,
  formatIndoDate,
  getAgeInMonths,
  KenaikanBadge,
  MeasurementData,
  MONTHS,
  MpasiData,
  ROLES,
  StatusBadge,
  UserRole
} from './LegacyApp';

type PmtCategory = 'Wasting' | 'Underweight' | 'TidakNaik';

type ChildrenTablePageProps = {
  activeTab: string;
  currentFilterDate: Date;
  currentPage: number;
  displayData: ChildData[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  filterMonth: number;
  filterYear: number;
  handleExportMpasi: () => void;
  handleExportPengukuranSigizi: () => void;
  handleExportSigizi: () => void;
  handleExportTable: () => void;
  handleImportIdentitas: (event: ChangeEvent<HTMLInputElement>) => void;
  handlePermanentDelete: (id: string | undefined) => void;
  handleRestore: (id: string | undefined) => void;
  itemsPerPage: number;
  loading: boolean;
  monthlyMeasurements: Record<string, MeasurementData>;
  mpasiLogs: Record<string, MpasiData>;
  paginatedData: ChildData[];
  searchTerm: string;
  setChildToDelete: (child: ChildData) => void;
  setChildToMpasi: (child: ChildData) => void;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  setEditingChild: (child: ChildData) => void;
  setPmtModalData: (data: { child: ChildData; category: PmtCategory }) => void;
  setSearchTerm: (value: string) => void;
  onOpenMeasurement: (child: ChildData) => void;
  setShowAddModal: (value: boolean) => void;
  setSortOrder: (value: string) => void;
  sortOrder: string;
  user: UserRole;
};

function getPageTitle(activeTab: string, filterMonth: number, filterYear: number) {
  if (activeTab === 'recycle_bin') return 'Daftar Sampah (Recycle Bin)';
  if (activeTab === 'recent') return `Balita Baru (${MONTHS[filterMonth - 1]} ${filterYear})`;
  if (activeTab === 'problem_underweight') return 'Daftar Balita Underweight (BB/U)';
  if (activeTab === 'problem_stunting') return 'Daftar Balita Stunting (TB/U)';
  if (activeTab === 'problem_wasting') return 'Daftar Balita Wasting (BB/TB)';
  if (activeTab === 'problem_tidak_naik') return 'Daftar Balita Tidak Naik (T)';
  if (activeTab === 'mpasi') return 'Balita MPASI (6-23 Bulan)';
  return 'Data Balita Lengkap';
}

function getPmtCategory(activeTab: string): PmtCategory {
  if (activeTab === 'problem_underweight') return 'Underweight';
  if (activeTab === 'problem_tidak_naik') return 'TidakNaik';
  return 'Wasting';
}

export default function ChildrenTablePage({
  activeTab,
  currentFilterDate,
  currentPage,
  displayData,
  fileInputRef,
  filterMonth,
  filterYear,
  handleExportMpasi,
  handleExportPengukuranSigizi,
  handleExportSigizi,
  handleExportTable,
  handleImportIdentitas,
  handlePermanentDelete,
  handleRestore,
  itemsPerPage,
  loading,
  monthlyMeasurements,
  mpasiLogs,
  paginatedData,
  searchTerm,
  setChildToDelete,
  setChildToMpasi,
  setCurrentPage,
  setEditingChild,
  setPmtModalData,
  setSearchTerm,
  onOpenMeasurement,
  setShowAddModal,
  setSortOrder,
  sortOrder,
  user
}: ChildrenTablePageProps) {
  const totalPages = Math.ceil(displayData.length / itemsPerPage);

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">{getPageTitle(activeTab, filterMonth, filterYear)}</h2>
          <p className="text-slate-500 text-sm">
            {activeTab === 'mpasi'
              ? `Menampilkan ${displayData.length} balita usia 6-23 bulan untuk pemantauan MPASI.`
              : `Menampilkan ${displayData.length} data balita.`}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 w-full xl:w-auto">
          <div className="relative w-full sm:w-60">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              className="pl-9 pr-4 py-2.5 w-full border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 outline-none shadow-sm"
              placeholder="Cari Nama / NIK..."
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>

          <div className="relative w-full sm:w-48">
            <select
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
              className="appearance-none pl-9 pr-8 py-2.5 w-full border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 outline-none bg-white cursor-pointer shadow-sm"
            >
              <option value="recent">Terbaru Ditambahkan</option>
              <option value="oldest_input">Awal Diinput</option>
              <option value="name_asc">Nama (A-Z)</option>
              <option value="name_desc">Nama (Z-A)</option>
              <option value="age_oldest">Umur Tertua</option>
              <option value="age_youngest">Umur Termuda</option>
            </select>
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 pointer-events-none" />
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1 sm:pb-0 no-scrollbar">
            {activeTab === 'recent' && (
              <>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImportIdentitas}
                  accept=".xls,.xlsx"
                  style={{ display: 'none' }}
                />
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  variant="primary"
                  className="bg-indigo-600 hover:bg-indigo-700 whitespace-nowrap"
                >
                  <FileUp className="w-4 h-4" /> <span className="hidden sm:inline">Import</span>
                </Button>
                <Button
                  onClick={handleExportSigizi}
                  variant="primary"
                  className="bg-blue-600 hover:bg-blue-700 whitespace-nowrap"
                >
                  <FileDown className="w-4 h-4" /> <span className="hidden sm:inline">Export Sigizi</span>
                </Button>
              </>
            )}

            {activeTab === 'mpasi' && (
              <Button onClick={handleExportMpasi} variant="primary" className="bg-orange-600 hover:bg-orange-700 whitespace-nowrap">
                <FileDown className="w-4 h-4" /> <span className="hidden sm:inline">Export MPASI</span>
              </Button>
            )}

            {['data_balita', 'problem_underweight', 'problem_stunting', 'problem_wasting', 'problem_tidak_naik'].includes(activeTab) && (
              <Button onClick={handleExportTable} variant="primary" className="bg-teal-600 hover:bg-teal-700 whitespace-nowrap">
                <FileText className="w-4 h-4" /> <span className="hidden sm:inline">Export Tabel</span>
              </Button>
            )}

            {activeTab !== 'recent' && activeTab !== 'recycle_bin' && activeTab !== 'mpasi' && (
              <Button onClick={handleExportPengukuranSigizi} variant="primary" className="bg-emerald-600 hover:bg-emerald-700 whitespace-nowrap">
                <FileDown className="w-4 h-4" /> <span className="hidden sm:inline">Export Pengukuran</span>
              </Button>
            )}

            {activeTab !== 'recycle_bin' && (
              <Button onClick={() => setShowAddModal(true)} className="whitespace-nowrap">
                <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Tambah</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      <Card className="overflow-hidden shadow-lg border border-slate-200 flex flex-col">
        <div className="overflow-auto max-h-[70vh] w-full relative">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 sticky top-0 z-20 shadow-sm">
              <tr>
                <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 md:sticky md:left-0 bg-slate-50 z-20">No</th>
                <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 md:sticky md:left-[48px] bg-slate-50 z-20 md:shadow-lg">Identitas</th>
                <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200">Ortu</th>
                {user.role === ROLES.GIZI && (
                  <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200">Desa</th>
                )}
                {(user.role === ROLES.BIDAN || user.role === ROLES.GIZI) && (
                  <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200">Posyandu</th>
                )}

                {activeTab === 'mpasi' ? (
                  <>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Tgl Monitor</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">ASI</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Mkn Pokok</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Kacang</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Susu</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Daging</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Telur</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Vit A</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Sayur Lain</th>
                    <th className="px-2 py-3 text-center text-[10px] font-bold text-slate-500 uppercase border-r border-slate-200 bg-orange-50/50">Intervensi</th>
                  </>
                ) : (
                  <>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50">BB<br />(kg)</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50">PB/TB<br />(cm)</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50">LILA<br />(cm)</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-blue-50/50">LK<br />(cm)</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-indigo-50/50">Status<br />Kenaikan</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50">Status<br />BB/U</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50">Status<br />PB/TB-U</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50">Status<br />BB/PB atau BB/TB</th>
                    <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-200 bg-emerald-50/50">Status<br />IMT/U</th>
                  </>
                )}
                <th className="px-4 py-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider">Aksi</th>
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={15} className="px-6 py-12 text-center text-slate-400">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />Memuat Data...
                  </td>
                </tr>
              ) : paginatedData.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-6 py-12 text-center text-slate-400">Tidak ada data ditemukan</td>
                </tr>
              ) : (
                paginatedData.map((child, index) => {
                  if (!child.id) return null;
                  const realIndex = (currentPage - 1) * itemsPerPage + index + 1;
                  const mpasiLog = mpasiLogs[child.id];
                  const hasMpasi = !!mpasiLog;
                  const measurement = monthlyMeasurements[child.id];
                  const age = getAgeInMonths(child.tglLahir, measurement?.tglUkur ? new Date(measurement.tglUkur) : currentFilterDate);
                  const statusBbu = calculateGiziStatus(measurement?.bb, 'BBU', age, child.jk);
                  const statusTbu = calculateGiziStatus(measurement?.tb, 'TBU', age, child.jk, null, measurement?.caraUkur);
                  const statusBbtb = calculateGiziStatus(measurement?.bb, 'BBTB', age, child.jk, measurement?.tb, measurement?.caraUkur);
                  const statusImtu = calculateGiziStatus(measurement?.bb, 'IMTU', age, child.jk, measurement?.tb, measurement?.caraUkur);

                  return (
                    <tr key={child.id} className="hover:bg-slate-50 transition-colors text-xs">
                      <td className="px-4 py-3 whitespace-nowrap text-slate-500 border-r border-slate-100 text-center md:sticky md:left-0 bg-white z-10">{realIndex}</td>
                      <td className="px-4 py-3 whitespace-nowrap border-r border-slate-100 md:sticky md:left-[48px] bg-white z-10 md:shadow-lg">
                        <div className="font-bold text-slate-900">{child.nama}</div>
                        <div className={`text-[10px] font-mono ${!child.hasNIK ? 'text-red-600 font-bold' : 'text-slate-500'}`}>{child.nik}</div>
                        <div className="flex gap-1 mt-1">
                          <Badge color={child.jk === 'L' ? 'blue' : 'pink'}>{child.jk === 'L' ? 'L' : 'P'}</Badge>
                          <span className="text-[10px] text-slate-400">{formatIndoDate(child.tglLahir)} ({age} Bln)</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap border-r border-slate-100">
                        <div className="font-medium text-slate-700">{child.namaOrtu}</div>
                      </td>
                      {user.role === ROLES.GIZI && (
                        <td className="px-4 py-3 whitespace-nowrap border-r border-slate-100 text-slate-600">{child.desa}</td>
                      )}
                      {(user.role === ROLES.BIDAN || user.role === ROLES.GIZI) && (
                        <td className="px-4 py-3 whitespace-nowrap border-r border-slate-100 text-slate-600">{child.posyandu}</td>
                      )}

                      {activeTab === 'mpasi' ? (
                        <>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? formatIndoDate(mpasiLog.tglMonitoring) : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? mpasiLog.asi : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.makananPokok?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.kacang?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.susu?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.daging?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.telur?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.sayurVitA?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? (mpasiLog.sayurLain?.length ? 'Ya' : 'Tidak') : '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 text-[10px]">{hasMpasi ? mpasiLog.intervensiGizi : '-'}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10">{measurement?.bb || '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10">{measurement?.tb || '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10">{measurement?.lila || '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 font-mono bg-blue-50/10">{measurement?.lk || '-'}</td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 bg-indigo-50/10"><KenaikanBadge status={measurement?.statusNaik} /></td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10"><StatusBadge status={statusBbu} /></td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10"><StatusBadge status={statusTbu} /></td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10"><StatusBadge status={statusBbtb} /></td>
                          <td className="px-2 py-3 text-center border-r border-slate-100 bg-emerald-50/10"><StatusBadge status={statusImtu} /></td>
                        </>
                      )}

                      <td className="px-4 py-3 whitespace-nowrap text-center">
                        <div className="flex justify-center gap-1">
                          {activeTab === 'recycle_bin' ? (
                            <>
                              <Button variant="actionGreen" onClick={() => handleRestore(child.id)} title="Pulihkan"><RotateCcw className="w-3 h-3" /></Button>
                              <Button variant="actionRed" onClick={() => handlePermanentDelete(child.id)} title="Hapus Permanen"><X className="w-3 h-3" /></Button>
                            </>
                          ) : (
                            <>
                              {activeTab === 'mpasi' && (
                                <Button variant="actionOrange" onClick={() => setChildToMpasi(child)} title="Input MPASI">
                                  <Utensils className="w-3 h-3" />
                                </Button>
                              )}
                              {['problem_wasting', 'problem_underweight', 'problem_tidak_naik'].includes(activeTab) && (
                                <Button
                                  variant="actionBlue"
                                  onClick={() => setPmtModalData({ child, category: getPmtCategory(activeTab) })}
                                  title="Beri PMT"
                                >
                                  <Gift className="w-3 h-3" />
                                </Button>
                              )}
                              <Button variant="actionBlue" onClick={() => setEditingChild(child)} title="Edit Identitas"><Pencil className="w-3 h-3" /></Button>
                              <Button variant="actionGreen" onClick={() => onOpenMeasurement(child)} title="Pengukuran Balita"><Ruler className="w-3 h-3" /></Button>
                              <Button variant="actionRed" onClick={() => setChildToDelete(child)} title="Hapus Balita"><Trash2 className="w-3 h-3" /></Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="bg-slate-50 p-4 border-t border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-4 rounded-b-2xl shadow-lg mt-0">
          <span className="text-xs text-slate-500 font-medium">
            Menampilkan {paginatedData.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0} - {Math.min(currentPage * itemsPerPage, displayData.length)} dari {displayData.length} data
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              className="px-3 py-1.5 h-8"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="px-3 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-200 rounded-lg min-w-[80px] text-center shadow-sm">
              Hal {currentPage} / {Math.max(1, totalPages)}
            </span>
            <Button
              variant="secondary"
              disabled={currentPage >= totalPages || displayData.length === 0}
              onClick={() => setCurrentPage((page) => page + 1)}
              className="px-3 py-1.5 h-8"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
