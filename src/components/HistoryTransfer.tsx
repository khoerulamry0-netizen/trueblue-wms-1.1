import React, { useState, useMemo } from 'react';
import { DccLog } from '../types';
import { formatNumber, formatToWibString } from '../utils/calculations';
import * as XLSX from 'xlsx';
import { 
  Search, 
  Calendar, 
  ArrowLeftRight, 
  User, 
  MoveRight, 
  ArrowUpRight, 
  ArrowDownLeft,
  Download,
  Filter,
  FileSpreadsheet,
  CheckSquare,
  Square,
  Edit,
  Trash2,
  X
} from 'lucide-react';

interface HistoryTransferProps {
  logs: DccLog[];
  currentUser: { username: string; role: string; fullName: string } | null;
  onEditTransferLog?: (updatedLog: DccLog, oldLog: DccLog) => boolean;
  onDeleteTransferLog?: (log: DccLog) => boolean;
  onClearAllTransferLogs?: () => Promise<boolean> | void;
}

export default function HistoryTransfer({ 
  logs, 
  currentUser,
  onEditTransferLog,
  onDeleteTransferLog,
  onClearAllTransferLogs
}: HistoryTransferProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'TRANSFER'>('ALL');
  const [sortBy, setSortBy] = useState<'timestamp' | 'qty'>('timestamp');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Date filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Row selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Toggle optional columns
  const [includeDescription, setIncludeDescription] = useState(true);

  // Edit states
  const [editingLog, setEditingLog] = useState<DccLog | null>(null);
  const [editDescription, setEditDescription] = useState('');
  const [editQty, setEditQty] = useState(0);
  const [editLocationFrom, setEditLocationFrom] = useState('');
  const [editLocationTo, setEditLocationTo] = useState('');

  const handleStartEdit = (log: DccLog) => {
    setEditingLog(log);
    setEditDescription(log.description || '');
    setEditQty(log.qty);
    setEditLocationFrom(log.locationFrom || '');
    setEditLocationTo(log.locationTo || '');
  };

  const handleSaveEdit = () => {
    if (!editingLog) return;
    if (editQty <= 0) {
      alert('Kuantitas harus lebih besar dari 0.');
      return;
    }
    if (!editLocationFrom.trim() || !editLocationTo.trim()) {
      alert('Lokasi asal dan tujuan tidak boleh kosong.');
      return;
    }

    const updatedLog: DccLog = {
      ...editingLog,
      description: editDescription.trim(),
      qty: editQty,
      locationFrom: editLocationFrom.trim(),
      locationTo: editLocationTo.trim()
    };

    if (onEditTransferLog) {
      const success = onEditTransferLog(updatedLog, editingLog);
      if (success) {
        setEditingLog(null);
      }
    }
  };

  const handleDelete = (log: DccLog) => {
    if (window.confirm(`Apakah Anda yakin ingin menghapus log mutasi ini? Stok sejumlah ${log.qty} pcs akan dikembalikan.`)) {
      if (onDeleteTransferLog) {
        onDeleteTransferLog(log);
      }
    }
  };

  // Handle Sort Toggle
  const toggleSort = (field: 'timestamp' | 'qty') => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  // Filter logs for transfer types: TRANSFER_IN, TRANSFER_OUT, TRANSFER
  const transferLogs = useMemo(() => {
    return logs.filter(log => 
      log.type === 'TRANSFER_IN' || 
      log.type === 'TRANSFER_OUT' || 
      log.type === 'TRANSFER'
    );
  }, [logs]);

  // Filter & Search
  const filteredLogs = useMemo(() => {
    let result = [...transferLogs];

    // Filter by type
    if (typeFilter !== 'ALL') {
      result = result.filter(log => log.type === typeFilter);
    }

    // Filter by date range
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      result = result.filter(log => new Date(log.timestamp) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      result = result.filter(log => new Date(log.timestamp) <= end);
    }

    // Search filter
    if (searchTerm.trim() !== '') {
      const term = searchTerm.toLowerCase();
      result = result.filter(log => 
        log.skuId.toLowerCase().includes(term) ||
        log.skuName.toLowerCase().includes(term) ||
        log.locationFrom.toLowerCase().includes(term) ||
        log.locationTo.toLowerCase().includes(term) ||
        log.description.toLowerCase().includes(term) ||
        log.user.toLowerCase().includes(term)
      );
    }

    // Sort
    result.sort((a, b) => {
      let valA = sortBy === 'timestamp' ? new Date(a.timestamp).getTime() : a.qty;
      let valB = sortBy === 'timestamp' ? new Date(b.timestamp).getTime() : b.qty;

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [transferLogs, searchTerm, typeFilter, sortBy, sortOrder, startDate, endDate]);

  // Handle Select / Deselect individual row
  const handleToggleSelectRow = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  // Handle Select / Deselect all filtered rows
  const handleToggleSelectAll = () => {
    const allFilteredIds = filteredLogs.map(item => item.id);
    const areAllInSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selectedIds.includes(id));

    if (areAllInSelected) {
      // Remove all filtered ids from selection
      setSelectedIds(prev => prev.filter(id => !allFilteredIds.includes(id)));
    } else {
      // Add all filtered ids to selection
      setSelectedIds(prev => {
        const union = new Set([...prev, ...allFilteredIds]);
        return Array.from(union);
      });
    }
  };

  const isAllSelected = filteredLogs.length > 0 && filteredLogs.every(item => selectedIds.includes(item.id));
  const isSomeSelected = filteredLogs.length > 0 && filteredLogs.some(item => selectedIds.includes(item.id)) && !isAllSelected;

  // Export to Excel .xlsx
  const handleExportExcel = () => {
    const itemsToExport = selectedIds.length > 0 
      ? filteredLogs.filter(log => selectedIds.includes(log.id)) 
      : filteredLogs;

    if (itemsToExport.length === 0) {
      alert('Tidak ada data yang dipilih atau terdeteksi untuk diekspor.');
      return;
    }

    try {
      const exportData = itemsToExport.map(log => {
        const typeLabel = log.type === 'TRANSFER_IN' 
          ? 'Transfer IN (External)' 
          : log.type === 'TRANSFER_OUT' 
            ? 'Transfer OUT (External)' 
            : 'Pemindahan Rak Internal';

        const row: any = {
          'Tanggal & Waktu': formatToWibString(log.timestamp),
          'Tipe': typeLabel,
          'SKU ID': log.skuId,
          'Nama Barang': log.skuName,
          'Dari Lokasi': log.locationFrom,
          'Ke Lokasi': log.locationTo,
          'Jumlah Pcs': log.qty
        };

        if (includeDescription) {
          row['Deskripsi / Dokumen'] = log.description || '-';
        }

        row['Operator'] = log.user;

        return row;
      });

      const worksheet = XLSX.utils.json_to_sheet(exportData);
      
      const colWidths = [
        { wch: 18 }, // Tanggal & Waktu
        { wch: 22 }, // Tipe
        { wch: 15 }, // SKU ID
        { wch: 30 }, // Nama Barang
        { wch: 12 }, // Dari Lokasi
        { wch: 12 }, // Ke Lokasi
        { wch: 12 }  // Jumlah Pcs
      ];
      if (includeDescription) {
        colWidths.push({ wch: 25 }); // Deskripsi / Dokumen
      }
      colWidths.push({ wch: 15 }); // Operator
      worksheet['!cols'] = colWidths;

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Riwayat Transfer');
      
      const timestamp = new Date().toISOString().substring(0, 10);
      XLSX.writeFile(workbook, `Hasil_Ekspor_Transfer_${timestamp}.xlsx`);
    } catch (error) {
      console.error(error);
      alert('Gagal mengekspor data ke Excel.');
    }
  };

  return (
    <div className="space-y-6" id="history-transfer-view">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141B] rounded-2xl p-6 border border-slate-800/60 shadow-md">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-white flex items-center gap-2">
            <ArrowLeftRight className="w-5 h-5 text-emerald-400" />
            Riwayat Transfer (In & Out)
          </h2>
          <p className="text-slate-400 mt-1 text-xs md:text-sm">
            Log mutasi lengkap mencakup Transfer IN (External), Transfer OUT (External), serta pemindahan rak internal.
          </p>
        </div>
        
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-300 font-bold bg-[#161B25] hover:bg-[#1f2635] px-3.5 py-2.5 rounded-xl border border-slate-800 cursor-pointer select-none transition-colors">
            <input 
              type="checkbox"
              checked={includeDescription}
              onChange={(e) => setIncludeDescription(e.target.checked)}
              className="w-4 h-4 rounded border-slate-800 bg-[#11141B] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
            />
            Sertakan Kolom Deskripsi/Dokumen
          </label>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Ekspor Excel (.xlsx) {selectedIds.length > 0 && `(${selectedIds.length} Terpilih)`}
          </button>
          {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && transferLogs.length > 0 && selectedIds.length === 0 && (
            <button
              onClick={() => {
                if (onClearAllTransferLogs) {
                  onClearAllTransferLogs();
                }
              }}
              className="flex items-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
              Hapus Semua Riwayat
            </button>
          )}
        </div>
      </div>

      {/* Control Filters */}
      <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Search */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Cari Mutasi / SKU</label>
            <div className="relative">
              <input
                type="text"
                placeholder="Cari SKU, lokasi, operator, keterangan..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none placeholder:text-slate-500"
              />
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            </div>
          </div>

          {/* Mutation Type Filter */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Jenis Mutasi</label>
            <div className="relative">
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as any)}
                className="w-full pl-3 pr-8 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer font-bold appearance-none"
              >
                <option value="ALL">Semua Jenis Pergerakan ({transferLogs.length})</option>
                <option value="TRANSFER_IN">📥 Transfer IN (External)</option>
                <option value="TRANSFER_OUT">📤 Transfer OUT (External)</option>
                <option value="TRANSFER">🔄 Pemindahan Rak Internal</option>
              </select>
              <Filter className="w-4 h-4 text-emerald-400 absolute right-3 top-2.5 pointer-events-none" />
            </div>
          </div>

          {/* Date Filter: Start Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Tanggal Mulai</label>
            <div className="relative">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer [color-scheme:dark]"
              />
              <Calendar className="w-4 h-4 text-emerald-400 absolute left-3 top-2.5" />
            </div>
          </div>

          {/* Date Filter: End Date */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1.5">Tanggal Selesai</label>
            <div className="relative">
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none cursor-pointer [color-scheme:dark]"
              />
              <Calendar className="w-4 h-4 text-emerald-400 absolute left-3 top-2.5" />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between pt-2 border-t border-slate-800/40 gap-2">
          {/* Reset Filters button */}
          {(searchTerm || typeFilter !== 'ALL' || startDate || endDate) ? (
            <button
              onClick={() => {
                setSearchTerm('');
                setTypeFilter('ALL');
                setStartDate('');
                setEndDate('');
              }}
              className="text-[11px] font-bold text-emerald-400 hover:text-emerald-350 cursor-pointer flex items-center gap-1.5"
            >
              Reset Filter & Tanggal
            </button>
          ) : <div />}

          {/* Sort Controls */}
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Urutkan:</span>
            <div className="flex gap-2">
              <button
                onClick={() => toggleSort('timestamp')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${sortBy === 'timestamp' ? 'bg-slate-800 border-emerald-500/20 text-emerald-400' : 'bg-[#161B25] border-slate-800 text-slate-400 hover:text-white'}`}
              >
                <Calendar className="w-3.5 h-3.5" />
                Waktu {sortBy === 'timestamp' && (sortOrder === 'asc' ? '▲' : '▼')}
              </button>
              <button
                onClick={() => toggleSort('qty')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${sortBy === 'qty' ? 'bg-slate-800 border-emerald-500/20 text-emerald-400' : 'bg-[#161B25] border-slate-800 text-slate-400 hover:text-white'}`}
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
                Qty {sortBy === 'qty' && (sortOrder === 'asc' ? '▲' : '▼')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Table List */}
      <div className="bg-[#11141B] rounded-xl border border-slate-800/60 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#151922] text-slate-400 uppercase font-bold text-[10px] border-b border-slate-800/80">
                <th className="py-3 px-4 text-center w-12">
                  <input 
                    type="checkbox"
                    checked={isAllSelected}
                    ref={el => {
                      if (el) {
                        el.indeterminate = isSomeSelected;
                      }
                    }}
                    onChange={handleToggleSelectAll}
                    className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                  />
                </th>
                <th className="py-3 px-4">Tanggal & Waktu</th>
                <th className="py-3 px-4">Tipe</th>
                <th className="py-3 px-4">SKU / Nama Barang</th>
                <th className="py-3 px-4 text-center">Dari Lokasi</th>
                <th className="py-3 px-4 text-center">Ke Lokasi</th>
                <th className="py-3 px-4 text-right">Jumlah Pcs</th>
                <th className="py-3 px-4">Deskripsi / Dokumen</th>
                <th className="py-3 px-4">Operator</th>
                {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && <th className="py-3 px-4 text-center w-28">Aksi</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-300 text-xs">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-500 font-medium">
                    <ArrowLeftRight className="w-8 h-8 mx-auto mb-2 text-slate-600 stroke-1" />
                    Belum ada riwayat mutasi yang terekam atau cocok dengan filter.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr 
                    key={log.id} 
                    className={`hover:bg-slate-800/20 transition-colors ${selectedIds.includes(log.id) ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''}`}
                  >
                    <td className="py-3 px-4 text-center">
                      <input 
                        type="checkbox"
                        checked={selectedIds.includes(log.id)}
                        onChange={() => handleToggleSelectRow(log.id)}
                        className="w-4 h-4 rounded border-slate-800 bg-[#161B25] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                      />
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap text-slate-400 font-mono">
                      {formatToWibString(log.timestamp)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {log.type === 'TRANSFER_IN' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                          <ArrowDownLeft className="w-3 h-3 text-indigo-400" />
                          TRANS IN
                        </span>
                      ) : log.type === 'TRANSFER_OUT' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-violet-500/10 text-violet-400 border border-violet-500/20">
                          <ArrowUpRight className="w-3 h-3 text-violet-400" />
                          TRANS OUT
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <MoveRight className="w-3 h-3 text-emerald-400" />
                          INTERNAL
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div>
                        <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded text-[11px] mr-1.5">
                          {log.skuId}
                        </span>
                        <span className="font-medium text-slate-300">{log.skuName}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center font-mono font-bold text-slate-400">
                      {log.locationFrom}
                    </td>
                    <td className="py-3 px-4 text-center font-mono font-bold text-slate-250">
                      {log.locationTo}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-emerald-400 font-mono">
                      {formatNumber(log.qty)}
                    </td>
                    <td className="py-3 px-4 text-slate-300 font-medium">
                      {log.description}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap font-semibold text-slate-400">
                      <span className="flex items-center gap-1">
                        <User className="w-3.5 h-3.5 text-slate-500" />
                        {log.user}
                      </span>
                    </td>
                    {(currentUser?.role === 'Administrator' || currentUser?.role === 'Admin') && (
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        <button
                          onClick={() => handleStartEdit(log)}
                          className="p-1 text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 rounded transition-colors mr-2 cursor-pointer inline-flex items-center"
                          title="Edit"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(log)}
                          className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors cursor-pointer inline-flex items-center"
                          title="Hapus"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Sums */}
        <div className="bg-[#151922] px-4 py-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-450 font-medium">
          <div>
            Menampilkan <span className="text-white font-bold">{filteredLogs.length}</span> baris riwayat mutasi
          </div>
          <div className="flex gap-4">
            <span>Inbound Ext: <span className="text-indigo-400 font-bold">{formatNumber(filteredLogs.filter(l => l.type === 'TRANSFER_IN').reduce((s, i) => s + i.qty, 0))} pcs</span></span>
            <span>Outbound Ext: <span className="text-violet-400 font-bold">{formatNumber(filteredLogs.filter(l => l.type === 'TRANSFER_OUT').reduce((s, i) => s + i.qty, 0))} pcs</span></span>
            <span>Internal: <span className="text-emerald-400 font-bold">{formatNumber(filteredLogs.filter(l => l.type === 'TRANSFER').reduce((s, i) => s + i.qty, 0))} pcs</span></span>
          </div>
        </div>
      </div>

      {/* Edit Modal Dialog */}
      {editingLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0E121A] border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-850 bg-[#121722]">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <Edit className="w-4 h-4 text-emerald-400" />
                Edit Riwayat Mutasi (Transfer)
              </h3>
              <button 
                onClick={() => setEditingLog(null)}
                className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4">
              <div>
                <span className="text-[10px] font-bold text-emerald-400 uppercase bg-emerald-500/10 px-2 py-0.5 rounded font-mono">
                  {editingLog.skuId}
                </span>
                <span className="text-xs font-semibold text-slate-300 ml-2">{editingLog.skuName}</span>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Deskripsi / Dokumen</label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Dari Lokasi</label>
                  <input
                    type="text"
                    value={editLocationFrom}
                    onChange={(e) => setEditLocationFrom(e.target.value)}
                    disabled={editingLog.type === 'TRANSFER_IN'}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono uppercase disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Ke Lokasi</label>
                  <input
                    type="text"
                    value={editLocationTo}
                    onChange={(e) => setEditLocationTo(e.target.value)}
                    disabled={editingLog.type === 'TRANSFER_OUT'}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono uppercase disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Qty (Pcs)</label>
                  <input
                    type="number"
                    value={editQty}
                    onChange={(e) => setEditQty(Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-800 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 bg-[#121722] border-t border-slate-850">
              <button
                onClick={() => setEditingLog(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-xs transition-all shadow-md cursor-pointer"
              >
                Simpan Perubahan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
