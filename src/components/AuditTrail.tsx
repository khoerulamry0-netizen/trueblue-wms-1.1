import React, { useState, useMemo } from 'react';
import { DccLog } from '../types';
import { formatToWibString, formatNumber } from '../utils/calculations';
import { 
  Search, 
  Filter, 
  Download, 
  Clock, 
  User, 
  Info, 
  FileSpreadsheet, 
  Tag, 
  MapPin, 
  X,
  FileText,
  Calendar,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface AuditTrailProps {
  logs: DccLog[];
  onClearLogs?: () => void;
}

export default function AuditTrail({ logs, onClearLogs }: AuditTrailProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('ALL');
  const [selectedOperator, setSelectedOperator] = useState<string>('ALL');
  const [selectedDateRange, setSelectedDateRange] = useState<string>('ALL');
  const [selectedLogDetail, setSelectedLogDetail] = useState<DccLog | null>(null);

  // Extract unique operators list for filter dropdown
  const operators = useMemo(() => {
    const list = new Set<string>();
    logs.forEach(log => {
      if (log.user) list.add(log.user);
    });
    return Array.from(list).sort();
  }, [logs]);

  // Handle advanced filtering
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 1. Search filter (SKU ID or Product Name)
      const matchesSearch = 
        log.skuId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.skuName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.description && log.description.toLowerCase().includes(searchQuery.toLowerCase()));

      // 2. Type filter
      const matchesType = selectedType === 'ALL' || log.type === selectedType;

      // 3. Operator filter
      const matchesOperator = selectedOperator === 'ALL' || log.user === selectedOperator;

      // 4. Date range filter
      let matchesDate = true;
      if (selectedDateRange !== 'ALL' && log.timestamp) {
        const logDate = new Date(log.timestamp);
        const currentDate = new Date(2026, 6, 12); // July 12, 2026 current context
        const diffTime = currentDate.getTime() - logDate.getTime();
        const diffDays = diffTime / (1000 * 60 * 60 * 24);

        if (selectedDateRange === 'TODAY') {
          // Same calendar day
          matchesDate = diffDays <= 1 && logDate.getDate() === currentDate.getDate();
        } else if (selectedDateRange === '7DAYS') {
          matchesDate = diffDays <= 7;
        } else if (selectedDateRange === '30DAYS') {
          matchesDate = diffDays <= 30;
        }
      }

      return matchesSearch && matchesType && matchesOperator && matchesDate;
    });
  }, [logs, searchQuery, selectedType, selectedOperator, selectedDateRange]);

  // CSV Exporter
  const handleExportCSV = () => {
    if (filteredLogs.length === 0) {
      alert('Tidak ada data mutasi yang cocok untuk diekspor.');
      return;
    }

    const headers = [
      'ID Log',
      'Waktu (WIB)',
      'Tipe Mutasi',
      'SKU ID',
      'Nama Barang',
      'Lokasi Asal',
      'Lokasi Tujuan',
      'Jumlah (pcs)',
      'Operator',
      'Keterangan / Alasan Mutasi'
    ];

    const csvRows = [headers.join(',')];

    filteredLogs.forEach(log => {
      const row = [
        `"${log.id}"`,
        `"${formatToWibString(log.timestamp, true)}"`,
        `"${log.type}"`,
        `"${log.skuId}"`,
        `"${log.skuName.replace(/"/g, '""')}"`,
        `"${log.locationFrom || '-'}"`,
        `"${log.locationTo || '-'}"`,
        log.qty,
        `"${log.user || '-'}"`,
        `"${(log.description || '').replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(','));
    });

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + csvRows.join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Audit_Trail_Mutasi_WMS_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Get transaction type badges with distinctive styling
  const getTypeBadge = (type: string) => {
    const styles: Record<string, string> = {
      'INBOUND': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      'OUTBOUND': 'bg-rose-500/10 text-rose-450 border-rose-500/20',
      'TRANSFER': 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
      'ADJUSTMENT': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      'TRANSFER_IN': 'bg-teal-500/10 text-teal-400 border-teal-500/20',
      'TRANSFER_OUT': 'bg-pink-500/10 text-pink-400 border-pink-500/20'
    };

    const label: Record<string, string> = {
      'INBOUND': 'Inbound / Masuk',
      'OUTBOUND': 'Outbound / Keluar',
      'TRANSFER': 'Transfer Internal',
      'ADJUSTMENT': 'Audit Adjusment',
      'TRANSFER_IN': 'Transfer Masuk (Ext)',
      'TRANSFER_OUT': 'Transfer Keluar (Ext)'
    };

    return (
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border shrink-0 ${styles[type] || 'bg-slate-500/10 text-slate-400'}`}>
        {label[type] || type}
      </span>
    );
  };

  return (
    <div className="space-y-6" id="audit-trail-tab">
      {/* Title Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-[#11141B] via-[#151922] to-[#121c25] rounded-2xl p-6 shadow-xl border border-rose-500/10 text-white">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-rose-400" />
            <span className="text-xs font-black uppercase tracking-widest text-rose-450">Audit Security Logs</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white mt-1">
            Audit Trail & Riwayat Mutasi Lengkap
          </h1>
          <p className="text-slate-350 mt-1 text-sm md:text-base">
            Pencatatan logs real-time, mendalam, transparan & akuntabel terhadap setiap mutasi atau perubahan stok fisik.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-lg transition-all text-xs"
            title="Export logs ke spreadsheet CSV"
          >
            <Download className="w-4 h-4" />
            <span>Ekspor CSV</span>
          </button>
        </div>
      </div>

      {/* Advanced Filters Block */}
      <div className="bg-[#11141B] border border-slate-800/60 rounded-xl p-5 shadow-sm">
        <div className="flex items-center gap-1.5 text-slate-400 text-xs font-bold uppercase tracking-wider mb-4">
          <Filter className="w-3.5 h-3.5 text-indigo-400" />
          <span>Filter & Pencarian Lanjutan</span>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Search SKU ID/Product Name */}
          <div className="relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <Search className="w-4 h-4 text-slate-500" />
            </span>
            <input
              type="text"
              placeholder="Cari SKU ID, nama, keterangan..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950/40 hover:bg-slate-950/60 focus:bg-slate-950 border border-slate-800 focus:border-indigo-500/60 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 outline-none transition-all"
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter Transaction Type */}
          <div>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="w-full bg-slate-950/40 hover:bg-slate-950/60 focus:bg-slate-950 border border-slate-800 focus:border-indigo-500/60 rounded-lg px-3 py-2 text-xs text-white outline-none cursor-pointer transition-all"
            >
              <option value="ALL" className="bg-slate-950">Semua Tipe Transaksi</option>
              <option value="INBOUND" className="bg-slate-950">Inbound (Masuk)</option>
              <option value="OUTBOUND" className="bg-slate-950">Outbound (Keluar)</option>
              <option value="TRANSFER" className="bg-slate-950">Transfer Rak Internal</option>
              <option value="ADJUSTMENT" className="bg-slate-950">Cek Fisik / Adjustment</option>
              <option value="TRANSFER_IN" className="bg-slate-950">Transfer Masuk (Luar)</option>
              <option value="TRANSFER_OUT" className="bg-slate-950">Transfer Keluar (Luar)</option>
            </select>
          </div>

          {/* Filter Operator Staf */}
          <div>
            <select
              value={selectedOperator}
              onChange={(e) => setSelectedOperator(e.target.value)}
              className="w-full bg-slate-950/40 hover:bg-slate-950/60 focus:bg-slate-950 border border-slate-800 focus:border-indigo-500/60 rounded-lg px-3 py-2 text-xs text-white outline-none cursor-pointer transition-all"
            >
              <option value="ALL" className="bg-slate-950">Semua Operator Staf</option>
              {operators.map(op => (
                <option key={op} value={op} className="bg-slate-950">{op}</option>
              ))}
            </select>
          </div>

          {/* Filter Date Range */}
          <div>
            <select
              value={selectedDateRange}
              onChange={(e) => setSelectedDateRange(e.target.value)}
              className="w-full bg-slate-950/40 hover:bg-slate-950/60 focus:bg-slate-950 border border-slate-800 focus:border-indigo-500/60 rounded-lg px-3 py-2 text-xs text-white outline-none cursor-pointer transition-all"
            >
              <option value="ALL" className="bg-slate-950">Semua Waktu</option>
              <option value="TODAY" className="bg-slate-950">Hari Ini</option>
              <option value="7DAYS" className="bg-slate-950">7 Hari Terakhir</option>
              <option value="30DAYS" className="bg-slate-950">30 Hari Terakhir</option>
            </select>
          </div>
        </div>

        {/* Info stats */}
        <div className="flex flex-wrap items-center justify-between text-[11px] text-slate-500 mt-4 border-t border-slate-800/40 pt-3">
          <p>
            Menampilkan <span className="text-slate-300 font-bold">{filteredLogs.length}</span> dari <span className="text-slate-300 font-bold">{logs.length}</span> baris riwayat audit.
          </p>
          {(searchQuery || selectedType !== 'ALL' || selectedOperator !== 'ALL' || selectedDateRange !== 'ALL') && (
            <button
              onClick={() => {
                setSearchQuery('');
                setSelectedType('ALL');
                setSelectedOperator('ALL');
                setSelectedDateRange('ALL');
              }}
              className="text-indigo-400 hover:text-indigo-300 font-extrabold flex items-center gap-1 underline transition-all cursor-pointer"
            >
              Reset Semua Filter
            </button>
          )}
        </div>
      </div>

      {/* Main Audit Trail Logs Table */}
      <div className="bg-[#11141B] border border-slate-800/60 rounded-xl shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-slate-950/40 text-slate-400 text-[10px] font-black uppercase tracking-wider border-b border-slate-850">
                <th className="py-3 px-4 w-12 text-center">No</th>
                <th className="py-3 px-4 w-40">Waktu (WIB)</th>
                <th className="py-3 px-4 w-32">Operator</th>
                <th className="py-3 px-4 w-44">Tipe Mutasi</th>
                <th className="py-3 px-4">Barang & SKU</th>
                <th className="py-3 px-4 w-28 text-center">Qty Mutasi</th>
                <th className="py-3 px-4 w-52">Detail Mutasi (Rak Asal &rarr; Tujuan)</th>
                <th className="py-3 px-4 w-16 text-center">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850 text-xs text-slate-300">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500 italic">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <AlertCircle className="w-8 h-8 text-slate-650" />
                      <p>Tidak ditemukan data mutasi yang cocok dengan kriteria filter.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log, index) => {
                  const displayTime = formatToWibString(log.timestamp, true);
                  return (
                    <tr 
                      key={log.id} 
                      className="hover:bg-slate-800/10 transition-colors cursor-pointer"
                      onClick={() => setSelectedLogDetail(log)}
                    >
                      <td className="py-3 px-4 text-center text-[10px] font-mono text-slate-500 font-bold">
                        {index + 1}
                      </td>
                      <td className="py-3 px-4 font-mono text-[10px] text-slate-400">
                        {displayTime}
                      </td>
                      <td className="py-3 px-4 font-bold text-white flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-full bg-slate-800 text-[9px] flex items-center justify-center text-rose-400 font-extrabold uppercase border border-slate-700">
                          {(log.user || 'U')[0]}
                        </div>
                        <span className="truncate max-w-[110px]" title={log.user}>{log.user || '-'}</span>
                      </td>
                      <td className="py-3 px-4">
                        {getTypeBadge(log.type)}
                      </td>
                      <td className="py-3 px-4">
                        <div>
                          <p className="font-bold text-white text-xs">{log.skuName}</p>
                          <p className="text-[10px] font-mono text-indigo-400 mt-0.5">{log.skuId}</p>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center font-black text-white font-mono text-sm">
                        {formatNumber(log.qty)}
                      </td>
                      <td className="py-3 px-4">
                        {log.type === 'TRANSFER' || log.type === 'TRANSFER_OUT' || log.type === 'TRANSFER_IN' ? (
                          <p className="text-[11px] font-medium text-slate-300 flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 bg-slate-950/40 rounded border border-slate-800 font-mono text-[10px]">{log.locationFrom || 'Rak'}</span>
                            <span className="text-slate-500 font-bold">&rarr;</span>
                            <span className="px-1.5 py-0.5 bg-indigo-950/20 rounded border border-indigo-500/20 font-mono text-[10px] text-indigo-400">{log.locationTo || 'Rak'}</span>
                          </p>
                        ) : (
                          <p className="text-[11px] text-slate-400 truncate max-w-[200px]" title={log.description}>
                            {log.description}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedLogDetail(log);
                          }}
                          className="p-1 text-slate-500 hover:text-indigo-400 bg-slate-950/20 hover:bg-indigo-500/10 rounded border border-transparent hover:border-indigo-500/20 transition-all cursor-pointer"
                          title="Lihat detail log"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Log Detail Overlay Modal */}
      <AnimatePresence>
        {selectedLogDetail && (
          <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              className="bg-[#11141B] border border-slate-800 max-w-lg w-full rounded-2xl overflow-hidden shadow-2xl text-white font-sans"
            >
              {/* Header */}
              <div className="bg-slate-950/40 px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-indigo-400" />
                  <span className="font-extrabold text-sm text-slate-300">Rincian Riwayat Mutasi</span>
                </div>
                <button 
                  onClick={() => setSelectedLogDetail(null)}
                  className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg cursor-pointer transition-all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content body */}
              <div className="p-6 space-y-4">
                {/* ID and Status badge */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-slate-500 font-bold bg-slate-950/30 px-2 py-0.5 rounded border border-slate-800">
                    ID: {selectedLogDetail.id}
                  </span>
                  {getTypeBadge(selectedLogDetail.type)}
                </div>

                {/* SKU and name */}
                <div className="bg-slate-950/30 rounded-xl p-4 border border-slate-850">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Barang</span>
                  <h4 className="text-base font-extrabold text-white mt-1">{selectedLogDetail.skuName}</h4>
                  <p className="text-xs font-mono text-indigo-400 mt-1 flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5" />
                    <span>SKU ID: {selectedLogDetail.skuId}</span>
                  </p>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Timestamp */}
                  <div className="bg-slate-950/15 rounded-lg p-3 border border-slate-800/40">
                    <span className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1 mb-1">
                      <Calendar className="w-3 h-3 text-indigo-400" />
                      Waktu Transaksi
                    </span>
                    <p className="text-xs font-mono text-slate-200">{formatToWibString(selectedLogDetail.timestamp, true)}</p>
                  </div>

                  {/* Operator */}
                  <div className="bg-slate-950/15 rounded-lg p-3 border border-slate-800/40">
                    <span className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1 mb-1">
                      <User className="w-3 h-3 text-indigo-400" />
                      Operator
                    </span>
                    <p className="text-xs font-bold text-white">{selectedLogDetail.user || 'Staf Operator'}</p>
                  </div>

                  {/* Quantity */}
                  <div className="bg-slate-950/15 rounded-lg p-3 border border-slate-800/40 col-span-2 flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-400 uppercase">Jumlah Mutasi</span>
                    <span className="text-lg font-black text-white font-mono">{formatNumber(selectedLogDetail.qty)} pcs</span>
                  </div>
                </div>

                {/* Locations if transfer */}
                {selectedLogDetail.type === 'TRANSFER' || selectedLogDetail.type === 'TRANSFER_OUT' || selectedLogDetail.type === 'TRANSFER_IN' ? (
                  <div className="bg-slate-950/30 rounded-xl p-4 border border-slate-850 space-y-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5 text-indigo-400" />
                      Alur Perpindahan Rak
                    </span>
                    <div className="flex items-center justify-between text-xs">
                      <div className="text-center p-2 bg-slate-950/50 rounded-lg border border-slate-800 flex-1">
                        <span className="text-[9px] text-slate-500 block uppercase font-bold">Rak Asal</span>
                        <span className="font-mono font-bold text-white text-xs block mt-1">{selectedLogDetail.locationFrom || '-'}</span>
                      </div>
                      <span className="text-slate-500 font-extrabold px-3 text-lg">&rarr;</span>
                      <div className="text-center p-2 bg-indigo-950/15 rounded-lg border border-indigo-500/10 flex-1">
                        <span className="text-[9px] text-indigo-400 block uppercase font-bold">Rak Tujuan</span>
                        <span className="font-mono font-bold text-emerald-400 text-xs block mt-1">{selectedLogDetail.locationTo || '-'}</span>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Reason description */}
                <div className="bg-slate-950/30 rounded-xl p-4 border border-slate-850">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Alasan & Deskripsi Mutasi</span>
                  <p className="text-xs text-slate-200 mt-1.5 leading-relaxed bg-slate-950/40 p-2.5 rounded-lg border border-slate-800 font-medium">
                    {selectedLogDetail.description || 'Mutasi stock tercatat otomatis oleh sistem.'}
                  </p>
                </div>
              </div>

              {/* Footer action */}
              <div className="bg-slate-950/40 px-6 py-4 border-t border-slate-800 flex justify-end">
                <button
                  onClick={() => setSelectedLogDetail(null)}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-4 py-2 rounded-xl cursor-pointer shadow-md transition-all uppercase tracking-wider"
                >
                  Selesai
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
