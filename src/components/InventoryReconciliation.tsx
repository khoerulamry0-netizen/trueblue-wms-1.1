import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { 
  Scale, 
  UploadCloud, 
  FileSpreadsheet, 
  Download, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Search, 
  Layers, 
  Box, 
  Building2, 
  Calendar, 
  Clock, 
  Copy, 
  Check, 
  Filter, 
  Eye, 
  History, 
  ShieldCheck, 
  ChevronDown, 
  ChevronUp, 
  AlertCircle,
  FileText,
  HelpCircle,
  CheckCheck
} from 'lucide-react';
import type { StockItem, OutboundItem, CatalogItem, Warehouse, UserAccount } from '../types';
import { getActiveBranch } from '../supabase';
import { formatNumber } from '../utils/calculations';
import { 
  reconcileInventory, 
  parseErpTable, 
  detectColumnMapping, 
  exportReconciliationToExcel,
  buildReconcileTemplateWorkbook,
  type ColumnMapping, 
  type ErpRowInput, 
  type ReconciliationItem, 
  type ReconciliationSummary, 
  type ReconciliationSession,
  type ReconciliationStatus
} from '../utils/inventoryReconciliation';

interface Props {
  stock: StockItem[];
  orderHistory?: OutboundItem[];
  catalog?: CatalogItem[];
  warehouses?: Warehouse[];
  currentUser?: UserAccount | null;
}

const STORAGE_HISTORY_KEY = 'trueblue_wms_recon_history';

export default function InventoryReconciliation({
  stock,
  orderHistory = [],
  catalog = [],
  warehouses = [],
  currentUser
}: Props) {
  const activeBranch = getActiveBranch();

  // File & Upload States
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [rawTable, setRawTable] = useState<unknown[][]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({ skuCol: 0, qtyCol: 1 });
  const [detectedHeaderNames, setDetectedHeaderNames] = useState<{ sku?: string; qty?: string; name?: string; warehouse?: string }>({});
  const [mappingOpen, setMappingOpen] = useState(false);
  const [allowAggregateDuplicates, setAllowAggregateDuplicates] = useState(false);

  // Snapshot & Scope Controls
  const [erpSnapshotTime, setErpSnapshotTime] = useState<string>(() => {
    const now = new Date();
    return now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
  });
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('ALL');

  // Reconciliation Results
  const [reconciliationItems, setReconciliationItems] = useState<ReconciliationItem[] | null>(null);
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Table Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ReconciliationStatus>('ALL');
  const [copiedSku, setCopiedSku] = useState<string | null>(null);

  // History Drawer
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<ReconciliationSession[]>([]);

  // Load History from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`${STORAGE_HISTORY_KEY}_${activeBranch}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setHistorySessions(parsed);
        }
      }
    } catch {
      // Ignore localStorage read errors
    }
  }, [activeBranch]);

  // Save Session to History
  const saveSessionToHistory = (session: ReconciliationSession) => {
    try {
      const updated = [session, ...historySessions.slice(0, 19)]; // Keep up to 20 historical runs
      setHistorySessions(updated);
      localStorage.setItem(`${STORAGE_HISTORY_KEY}_${activeBranch}`, JSON.stringify(updated));
    } catch {
      // Ignore quota errors
    }
  };

  // Check Snapshot Staleness (> 12 hours)
  const isSnapshotStale = useMemo(() => {
    if (!erpSnapshotTime) return false;
    const snapDate = new Date(erpSnapshotTime).getTime();
    const now = Date.now();
    const diffHours = (now - snapDate) / (1000 * 60 * 60);
    return diffHours > 12;
  }, [erpSnapshotTime]);

  // Handle File Selection
  const handleFileChange = (file: File) => {
    if (!file) return;
    setErrorMessage('');
    setSelectedFile(file);

    // File size guard (max 15MB)
    if (file.size > 15 * 1024 * 1024) {
      setErrorMessage('Ukuran file melebihi batas maksimal 15MB. Silakan gunakan file Excel/CSV yang lebih ringkas.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        
        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          throw new Error('Tidak ada worksheet yang dapat dibaca dalam file.');
        }

        setSheetNames(workbook.SheetNames);
        const firstSheet = workbook.SheetNames[0];
        setSelectedSheet(firstSheet);

        const sheet = workbook.Sheets[firstSheet];
        const table = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

        if (!table || table.length < 2) {
          throw new Error('Worksheet kosong atau tidak memiliki baris data.');
        }

        setRawTable(table);

        // Auto-detect columns
        const { mapping, detectedHeaders } = detectColumnMapping(table[0]);
        setColumnMapping(mapping);
        setDetectedHeaderNames(detectedHeaders);
      } catch (err: any) {
        setErrorMessage(err?.message || 'Gagal membaca format file spreadsheet.');
        setRawTable([]);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Switch Sheet
  const handleSheetChange = (sheetName: string) => {
    if (!selectedFile) return;
    setSelectedSheet(sheetName);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[sheetName];
        const table = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
        setRawTable(table);

        if (table && table.length > 0) {
          const { mapping, detectedHeaders } = detectColumnMapping(table[0]);
          setColumnMapping(mapping);
          setDetectedHeaderNames(detectedHeaders);
        }
      } catch (err: any) {
        setErrorMessage(err?.message || 'Gagal membaca sheet terpilih.');
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  };

  // Process Reconciliation
  const handleExecuteReconciliation = () => {
    if (!rawTable || rawTable.length < 2) {
      setErrorMessage('Silakan upload file Excel Mabang ERP terlebih dahulu.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage('');
    setValidationWarnings([]);

    try {
      // 1. Parse raw table
      const { rows, parsingErrors } = parseErpTable(rawTable, columnMapping);

      if (parsingErrors.length > 0) {
        setErrorMessage(parsingErrors.join(' | '));
        setIsProcessing(false);
        return;
      }

      // 2. Run reconciliation calculation (Pure & Read-Only)
      const result = reconcileInventory(
        rows,
        stock,
        orderHistory,
        catalog,
        {
          warehouseId: selectedWarehouseId,
          allowAggregateDuplicateErp: allowAggregateDuplicates
        }
      );

      setReconciliationItems(result.items);
      setSummary(result.summary);
      setValidationWarnings(result.validationWarnings);

      // 3. Save snapshot to history
      const session: ReconciliationSession = {
        id: `RECON_${Date.now()}`,
        createdAt: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
        erpSnapshotTime: erpSnapshotTime.replace('T', ' '),
        fileName: selectedFile?.name || 'mabang-erp-data.xlsx',
        warehouseId: selectedWarehouseId,
        summary: result.summary,
        items: result.items,
        createdBy: currentUser?.fullName || currentUser?.username || 'Operator'
      };
      saveSessionToHistory(session);

    } catch (err: any) {
      setErrorMessage(err?.message || 'Terjadi kesalahan saat memproses rekonsiliasi.');
    } finally {
      setIsProcessing(false);
    }
  };

  // Reset Everything
  const handleReset = () => {
    setSelectedFile(null);
    setSheetNames([]);
    setSelectedSheet('');
    setRawTable([]);
    setReconciliationItems(null);
    setSummary(null);
    setValidationWarnings([]);
    setErrorMessage('');
    setSearchQuery('');
    setStatusFilter('ALL');
  };

  // Download Sample Template
  const handleDownloadTemplate = () => {
    const wb = buildReconcileTemplateWorkbook();
    XLSX.writeFile(wb, 'Template_Mabang_ERP_Stok.xlsx');
  };

  // Export Current Results to Excel
  const handleExportResults = () => {
    if (!summary || !reconciliationItems) return;

    const session: ReconciliationSession = {
      id: `RECON_EXPORT_${Date.now()}`,
      createdAt: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
      erpSnapshotTime: erpSnapshotTime.replace('T', ' '),
      fileName: selectedFile?.name || 'mabang-erp-export.xlsx',
      warehouseId: selectedWarehouseId,
      summary,
      items: reconciliationItems,
      createdBy: currentUser?.fullName || 'Operator'
    };

    exportReconciliationToExcel(session, activeBranch);
  };

  // Copy SKU handler
  const handleCopySku = (sku: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(sku);
    }
    setCopiedSku(sku);
    setTimeout(() => setCopiedSku(null), 1800);
  };

  // Filtered Items for Display
  const filteredItems = useMemo(() => {
    if (!reconciliationItems) return [];

    let list = reconciliationItems;

    if (statusFilter !== 'ALL') {
      list = list.filter(it => it.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(it => 
        it.sku.toLowerCase().includes(q) ||
        it.skuName.toLowerCase().includes(q) ||
        it.locations.some(loc => loc.toLowerCase().includes(q)) ||
        it.issues.some(iss => iss.toLowerCase().includes(q))
      );
    }

    return list;
  }, [reconciliationItems, statusFilter, searchQuery]);

  return (
    <div className="space-y-6 pb-14 text-slate-100">
      {/* Top Banner / Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141B] border border-slate-800/80 p-5 rounded-2xl shadow-xl">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-500/20 via-teal-500/10 to-indigo-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0 shadow-inner">
            <Scale className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg sm:text-xl font-black tracking-tight text-white">
                Rekonsiliasi Stok (Mabang ERP vs TrueBlue WMS)
              </h1>
              <span className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-0.5 rounded-full">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                READ-ONLY · NON-DESTRUCTIVE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Mencocokkan saldo persediaan Mabang ERP terhadap akumulasi fisik <strong>GOOD + DAMAGE</strong> di cabang <span className="font-mono font-bold text-emerald-400">{activeBranch}</span> tanpa memodifikasi saldo persediaan.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#161B25] hover:bg-slate-800 border border-slate-700/60 text-slate-300 hover:text-white text-xs font-bold transition cursor-pointer"
            title="Lihat riwayat rekonsiliasi yang pernah dilakukan"
          >
            <History className="w-3.5 h-3.5 text-indigo-400" />
            <span>Riwayat ({historySessions.length})</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadTemplate}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#161B25] hover:bg-slate-800 border border-slate-700/60 text-slate-300 hover:text-white text-xs font-bold transition cursor-pointer"
            title="Download contoh file Excel Mabang ERP"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>Template Excel</span>
          </button>

          {reconciliationItems && (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold transition cursor-pointer"
              title="Reset dan muat file baru"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Snapshot Staleness Warning */}
      {isSnapshotStale && (
        <div className="flex items-center gap-2.5 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            <strong>Perhatian Snapshot Tanggal:</strong> Waktu snapshot data ERP berjarak lebih dari 12 jam dari saat ini ({erpSnapshotTime.replace('T', ' ')}). Potensi ada selisih mutasi transaksi fisik (Inbound/Outbound) yang terjadi di antara rentang waktu tersebut.
          </span>
        </div>
      )}

      {/* Error Message Box */}
      {errorMessage && (
        <div className="flex items-center gap-2.5 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Section 1: File Upload & Parameter Setup */}
      <div className="bg-[#11141B] border border-slate-800/80 rounded-2xl p-5 shadow-lg space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Upload Area */}
          <div className="lg:col-span-2 space-y-3">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
              1. Upload File Excel / CSV Mabang ERP
            </label>

            <div className="border-2 border-dashed border-slate-700 hover:border-emerald-500/60 bg-[#161B25]/50 hover:bg-[#161B25] rounded-xl p-6 transition-colors flex flex-col items-center justify-center text-center cursor-pointer relative group">
              <input
                type="file"
                accept=".xlsx, .xls, .csv"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileChange(e.target.files[0]);
                  }
                }}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
              <UploadCloud className="w-10 h-10 text-emerald-400/80 group-hover:text-emerald-400 transition-transform group-hover:scale-110 mb-2" />
              <p className="text-xs font-bold text-slate-200">
                {selectedFile ? selectedFile.name : 'Klik atau seret file Excel/CSV Mabang ERP ke sini'}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                Format didukung: <strong>.xlsx, .xls, .csv</strong> (Maksimal 15MB)
              </p>
              {selectedFile && (
                <span className="mt-2 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                  {(selectedFile.size / 1024).toFixed(1)} KB · Siap dianalisis
                </span>
              )}
            </div>

            {/* Sheet Selector if multiple sheets exist */}
            {sheetNames.length > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">Pilih Worksheet:</span>
                <select
                  value={selectedSheet}
                  onChange={(e) => handleSheetChange(e.target.value)}
                  className="bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg px-2.5 py-1 text-xs outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                >
                  {sheetNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Scope & Snapshot Configuration */}
          <div className="space-y-4 bg-[#161B25]/70 border border-slate-800 rounded-xl p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              2. Parameter Rekonsiliasi
            </h3>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Waktu Snapshot ERP
              </label>
              <input
                type="datetime-local"
                value={erpSnapshotTime}
                onChange={(e) => setErpSnapshotTime(e.target.value)}
                className="w-full bg-[#12161F] border border-slate-700 text-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <span className="text-[10px] text-slate-500 mt-0.5 block">
                Sesuaikan dengan jam ekspor data dari sistem Mabang.
              </span>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Cakupan Gudang WMS
              </label>
              <select
                value={selectedWarehouseId}
                onChange={(e) => setSelectedWarehouseId(e.target.value)}
                className="w-full bg-[#12161F] border border-slate-700 text-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="ALL">Semua Gudang di Cabang Ini</option>
                {warehouses.map((wh) => (
                  <option key={wh.id} value={wh.id}>
                    {wh.id} — {wh.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="pt-2 border-t border-slate-800">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowAggregateDuplicates}
                  onChange={(e) => setAllowAggregateDuplicates(e.target.checked)}
                  className="w-4 h-4 mt-0.5 rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-[11px] text-slate-300">
                  <strong>Gabungkan SKU duplikat di Excel:</strong> Jika file Mabang memiliki beberapa baris untuk SKU yang sama (misal multi-batch/lot), jumlahkan totalnya secara otomatis.
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Column Mapping Collapsible */}
        {rawTable.length > 0 && (
          <div className="border border-slate-800 rounded-xl overflow-hidden bg-[#161B25]/30">
            <button
              type="button"
              onClick={() => setMappingOpen(!mappingOpen)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-bold text-slate-300 hover:text-white bg-[#161B25]/80 transition cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Filter className="w-3.5 h-3.5 text-emerald-400" />
                Pemetaan Kolom Spreadsheet ({detectedHeaderNames.sku || 'SKU'} → Kolom {columnMapping.skuCol + 1}, {detectedHeaderNames.qty || 'Qty'} → Kolom {columnMapping.qtyCol + 1})
              </span>
              <span className="text-[11px] text-slate-400 flex items-center gap-1 font-normal">
                {mappingOpen ? 'Tutup Pengaturan' : 'Ubah Mapping Kolom'}
                {mappingOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </span>
            </button>

            {mappingOpen && (
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-[#11141B] border-t border-slate-800">
                {/* SKU Column */}
                <div>
                  <label className="block text-[10px] font-bold text-emerald-400 uppercase mb-1">
                    Kolom SKU (Wajib)
                  </label>
                  <select
                    value={columnMapping.skuCol}
                    onChange={(e) => setColumnMapping({ ...columnMapping, skuCol: Number(e.target.value) })}
                    className="w-full bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                  >
                    {rawTable[0].map((header, idx) => (
                      <option key={idx} value={idx}>
                        Kolom {idx + 1}: {String(header || `(Kolom ${idx + 1})`)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Qty Column */}
                <div>
                  <label className="block text-[10px] font-bold text-emerald-400 uppercase mb-1">
                    Kolom Stok ERP / SISA erp (Wajib)
                  </label>
                  <select
                    value={columnMapping.qtyCol}
                    onChange={(e) => setColumnMapping({ ...columnMapping, qtyCol: Number(e.target.value) })}
                    className="w-full bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                  >
                    {rawTable[0].map((header, idx) => (
                      <option key={idx} value={idx}>
                        Kolom {idx + 1}: {String(header || `(Kolom ${idx + 1})`)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Product Name Column */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                    Kolom Nama Barang (Opsional)
                  </label>
                  <select
                    value={columnMapping.nameCol ?? -1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setColumnMapping({ ...columnMapping, nameCol: v >= 0 ? v : undefined });
                    }}
                    className="w-full bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                  >
                    <option value={-1}>-- Tidak Ada / Lewati --</option>
                    {rawTable[0].map((header, idx) => (
                      <option key={idx} value={idx}>
                        Kolom {idx + 1}: {String(header || `(Kolom ${idx + 1})`)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Warehouse Column */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                    Kolom Gudang (Opsional)
                  </label>
                  <select
                    value={columnMapping.warehouseCol ?? -1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setColumnMapping({ ...columnMapping, warehouseCol: v >= 0 ? v : undefined });
                    }}
                    className="w-full bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                  >
                    <option value={-1}>-- Tidak Ada / Lewati --</option>
                    {rawTable[0].map((header, idx) => (
                      <option key={idx} value={idx}>
                        Kolom {idx + 1}: {String(header || `(Kolom ${idx + 1})`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Action Button */}
        <div className="flex justify-end pt-2">
          <button
            type="button"
            disabled={!selectedFile || isProcessing || rawTable.length < 2}
            onClick={handleExecuteReconciliation}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs uppercase tracking-wider transition shadow-lg shadow-emerald-500/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
          >
            {isProcessing ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Menganalisis Data...</span>
              </>
            ) : (
              <>
                <Scale className="w-4 h-4" />
                <span>Proses & Preview Rekonsiliasi</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Validation Warnings Box */}
      {validationWarnings.length > 0 && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs space-y-1.5">
          <div className="font-bold text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" />
            Catatan Validasi Data Spreadsheet ({validationWarnings.length} Issue):
          </div>
          <ul className="list-disc list-inside space-y-1 pl-1 text-[11px] text-amber-100 max-h-32 overflow-y-auto">
            {validationWarnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Section 2: Executive Dashboard Cards */}
      {summary && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            {/* Total SKU Card */}
            <div className="bg-[#11141B] border border-slate-800 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-slate-400">Total SKU</span>
              <span className="text-xl font-black text-white font-mono mt-0.5 block">
                {formatNumber(summary.totalSkus)}
              </span>
              <span className="text-[10px] text-slate-500">Union ERP & WMS</span>
            </div>

            {/* MATCH Card */}
            <div className="bg-[#11141B] border border-emerald-500/30 bg-emerald-500/5 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                SKU Match
              </span>
              <span className="text-xl font-black text-emerald-400 font-mono mt-0.5 block">
                {formatNumber(summary.matchedCount)}
              </span>
              <span className="text-[10px] text-emerald-500 font-semibold">
                {summary.accuracyRate}% Akurasi
              </span>
            </div>

            {/* SELISIH Card */}
            <div className="bg-[#11141B] border border-rose-500/30 bg-rose-500/5 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-rose-400 flex items-center gap-1">
                <XCircle className="w-3 h-3 text-rose-400" />
                SKU Selisih
              </span>
              <span className="text-xl font-black text-rose-400 font-mono mt-0.5 block">
                {formatNumber(summary.diffCount)}
              </span>
              <span className="text-[10px] text-rose-400">Selisih kuantitas fisik</span>
            </div>

            {/* Unit Selisih Card */}
            <div className="bg-[#11141B] border border-slate-800 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-slate-400">Unit Selisih</span>
              <span className={`text-xl font-black font-mono mt-0.5 block ${summary.totalNetDiff === 0 ? 'text-emerald-400' : summary.totalNetDiff > 0 ? 'text-sky-400' : 'text-rose-400'}`}>
                {summary.totalNetDiff > 0 ? `+${formatNumber(summary.totalNetDiff)}` : formatNumber(summary.totalNetDiff)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                Absolut: {formatNumber(summary.totalAbsDiff)} pcs
              </span>
            </div>

            {/* WMS GOOD Card */}
            <div className="bg-[#11141B] border border-slate-800 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-emerald-400">WMS Good (Layak)</span>
              <span className="text-xl font-black text-white font-mono mt-0.5 block">
                {formatNumber(summary.totalWmsGoodUnits)}
              </span>
              <span className="text-[10px] text-slate-500">Stok siap picking/kirim</span>
            </div>

            {/* WMS DAMAGE Card */}
            <div className="bg-[#11141B] border border-amber-500/30 bg-amber-500/5 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-amber-400">WMS Damage (Rusak)</span>
              <span className="text-xl font-black text-amber-400 font-mono mt-0.5 block">
                {formatNumber(summary.totalWmsDamageUnits)}
              </span>
              <span className="text-[10px] text-amber-500">Fisik rusak terisolasi</span>
            </div>

            {/* Needs Review / Anomali Card */}
            <div className="bg-[#11141B] border border-slate-800 p-3.5 rounded-xl shadow-md">
              <span className="block text-[10px] font-bold uppercase text-slate-400">Perlu Review</span>
              <span className="text-xl font-black text-amber-300 font-mono mt-0.5 block">
                {formatNumber(summary.needsReviewCount + summary.erpOnlyCount + summary.wmsOnlyCount)}
              </span>
              <span className="text-[10px] text-slate-500">
                ERP:{summary.erpOnlyCount} · WMS:{summary.wmsOnlyCount}
              </span>
            </div>
          </div>

          {/* Section 3: Filter Pills, Search Bar & Export Button */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#11141B] border border-slate-800 p-3.5 rounded-xl">
            {/* Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { key: 'ALL', label: `Semua (${summary.totalSkus})` },
                { key: 'MATCH', label: `MATCH (${summary.matchedCount})`, color: 'text-emerald-400 border-emerald-500/30' },
                { key: 'SELISIH', label: `SELISIH (${summary.diffCount})`, color: 'text-rose-400 border-rose-500/30' },
                { key: 'ERP_ONLY', label: `ERP ONLY (${summary.erpOnlyCount})`, color: 'text-indigo-400 border-indigo-500/30' },
                { key: 'WMS_ONLY', label: `WMS ONLY (${summary.wmsOnlyCount})`, color: 'text-sky-400 border-sky-500/30' },
                { key: 'NEEDS_REVIEW', label: `NEEDS REVIEW (${summary.needsReviewCount})`, color: 'text-amber-400 border-amber-500/30' },
              ].map(f => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setStatusFilter(f.key as any)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer border ${
                    statusFilter === f.key
                      ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md'
                      : 'bg-[#161B25] text-slate-400 hover:text-white border-slate-700/60'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Search and Export */}
            <div className="flex items-center gap-2">
              <div className="relative min-w-[220px]">
                <input
                  type="text"
                  placeholder="Cari SKU / Nama Produk..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-500"
                />
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
              </div>

              <button
                type="button"
                onClick={handleExportResults}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs transition cursor-pointer shrink-0 shadow-sm"
                title="Download laporan lengkap format Excel (.xlsx)"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>Export Excel</span>
              </button>
            </div>
          </div>

          {/* Section 4: Data Comparison Table */}
          <div className="border border-slate-800 rounded-2xl overflow-hidden bg-[#11141B] shadow-xl">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-[#161B25] text-slate-400 uppercase font-bold text-[10px] border-b border-slate-800 sticky top-0 z-10">
                  <tr>
                    <th className="py-3 px-3 text-center w-12">No</th>
                    <th className="py-3 px-4 min-w-[200px]">SKU / Nama Produk</th>
                    <th className="py-3 px-3 text-right">ERP Qty</th>
                    <th className="py-3 px-3 text-right">WMS Good</th>
                    <th className="py-3 px-3 text-right">WMS Damage</th>
                    <th className="py-3 px-3 text-right">WMS Total</th>
                    <th className="py-3 px-3 text-right">Selisih</th>
                    <th className="py-3 px-3 text-center w-28">Status</th>
                    <th className="py-3 px-4 min-w-[150px]">Lokasi Rak WMS</th>
                    <th className="py-3 px-4 min-w-[180px]">Catatan / Keterangan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200 font-sans">
                  {filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-12 text-center text-slate-500 font-medium">
                        Tidak ada data rekonsiliasi yang sesuai dengan filter atau pencarian.
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map((it, idx) => (
                      <tr
                        key={it.sku}
                        className={`hover:bg-slate-800/30 transition-colors ${
                          it.status === 'SELISIH' ? 'bg-rose-500/5' : it.status === 'NEEDS_REVIEW' ? 'bg-amber-500/5' : ''
                        }`}
                      >
                        {/* No */}
                        <td className="py-2.5 px-3 text-center font-mono text-slate-500 text-[11px]">
                          {idx + 1}
                        </td>

                        {/* SKU & Name with Copy button */}
                        <td className="py-2.5 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleCopySku(it.sku)}
                              className="inline-flex items-center gap-1 font-mono font-bold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[11px] transition cursor-pointer group active:scale-95"
                              title="Salin SKU ID"
                            >
                              <span>{it.sku}</span>
                              {copiedSku === it.sku ? (
                                <Check className="w-3 h-3 text-emerald-300" />
                              ) : (
                                <Copy className="w-2.5 h-2.5 text-emerald-500/70 group-hover:text-emerald-300" />
                              )}
                            </button>
                            {!it.inCatalog && (
                              <span className="text-[9px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1 rounded" title="SKU belum terdaftar di Katalog Master">
                                Non-Katalog
                              </span>
                            )}
                          </div>
                          <div className="text-slate-300 text-xs font-medium mt-0.5 line-clamp-1">
                            {it.skuName}
                          </div>
                        </td>

                        {/* ERP Qty */}
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-indigo-300 text-xs">
                          {formatNumber(it.erpQty)}
                        </td>

                        {/* WMS Good with Reserved Tooltip */}
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-400 text-xs">
                          {formatNumber(it.wmsGoodQty)}
                          {it.wmsLockedQty > 0 && (
                            <span className="block font-normal text-[10px] text-slate-500 font-sans" title="Stok dialokasikan untuk order aktif">
                              ({it.wmsAvailableGoodQty} bebas / {it.wmsLockedQty} order)
                            </span>
                          )}
                        </td>

                        {/* WMS Damage */}
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-amber-400 text-xs">
                          {it.wmsDamageQty > 0 ? (
                            <span className="bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                              {formatNumber(it.wmsDamageQty)}
                            </span>
                          ) : (
                            <span className="text-slate-600">0</span>
                          )}
                        </td>

                        {/* WMS Total (Good + Damage + Other) */}
                        <td className="py-2.5 px-3 text-right font-mono font-black text-white text-xs">
                          {formatNumber(it.wmsTotalQty)}
                          {(it.wmsExpiredQty > 0 || it.wmsQuarantineQty > 0) && (
                            <span className="block font-normal text-[10px] text-slate-400 font-sans">
                              (ED:{it.wmsExpiredQty} · QC:{it.wmsQuarantineQty})
                            </span>
                          )}
                        </td>

                        {/* Difference (WMS Total - ERP Qty) */}
                        <td className="py-2.5 px-3 text-right font-mono font-black text-xs">
                          {it.difference === 0 ? (
                            <span className="text-emerald-400 font-bold">0</span>
                          ) : it.difference > 0 ? (
                            <span className="text-sky-400">+{formatNumber(it.difference)}</span>
                          ) : (
                            <span className="text-rose-400">{formatNumber(it.difference)}</span>
                          )}
                        </td>

                        {/* Status Badge */}
                        <td className="py-2.5 px-3 text-center whitespace-nowrap">
                          {it.status === 'MATCH' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              MATCH
                            </span>
                          )}
                          {it.status === 'SELISIH' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black bg-rose-500/15 border border-rose-500/30 text-rose-400 animate-pulse">
                              <XCircle className="w-3 h-3 text-rose-400" />
                              SELISIH
                            </span>
                          )}
                          {it.status === 'ERP_ONLY' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
                              ERP ONLY
                            </span>
                          )}
                          {it.status === 'WMS_ONLY' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-sky-500/15 border border-sky-500/30 text-sky-400">
                              WMS ONLY
                            </span>
                          )}
                          {it.status === 'NEEDS_REVIEW' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-500/15 border border-amber-500/30 text-amber-300">
                              <AlertTriangle className="w-3 h-3 text-amber-400" />
                              REVIEW
                            </span>
                          )}
                        </td>

                        {/* Locations in WMS */}
                        <td className="py-2.5 px-4 font-mono text-[11px] text-slate-300">
                          {it.locations.length > 0 ? (
                            <span className="line-clamp-2" title={it.locations.join(', ')}>
                              {it.locations.join(', ')}
                            </span>
                          ) : (
                            <span className="text-slate-600 italic">-</span>
                          )}
                        </td>

                        {/* Issues / Notes */}
                        <td className="py-2.5 px-4 text-[11px] text-slate-400">
                          {it.issues.length > 0 ? (
                            <span className="text-amber-300 line-clamp-2" title={it.issues.join(' | ')}>
                              {it.issues.join(' · ')}
                            </span>
                          ) : (
                            <span className="text-emerald-500/80 font-medium">
                              {it.erpQty === 0 && it.wmsTotalQty === 0 ? 'Stok sama-sama 0 (Valid & Cocok)' : 'Valid & Cocok'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Table Footer Summary */}
            <div className="bg-[#161B25] px-5 py-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
              <div>
                Menampilkan <strong>{filteredItems.length}</strong> dari <strong>{reconciliationItems.length}</strong> SKU total.
              </div>
              <div className="flex items-center gap-4 text-[11px] font-mono">
                <span>Total ERP: <strong>{formatNumber(summary.totalErpUnits)}</strong> pcs</span>
                <span>WMS Fisik: <strong>{formatNumber(summary.totalWmsUnits)}</strong> pcs</span>
                <span className={summary.totalNetDiff === 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                  Net: {summary.totalNetDiff > 0 ? `+${formatNumber(summary.totalNetDiff)}` : formatNumber(summary.totalNetDiff)} pcs
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* History Modal / Drawer */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
          <div className="w-full max-w-3xl bg-[#0E121A] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#121722]">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-bold text-slate-100">
                  Riwayat Rekonsiliasi Tersimpan (Cabang {activeBranch})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-3">
              {historySessions.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs">
                  Belum ada riwayat rekonsiliasi yang tersimpan di perangkat ini.
                </div>
              ) : (
                historySessions.map((sess, idx) => (
                  <div
                    key={sess.id || idx}
                    className="p-4 rounded-xl border border-slate-800 bg-[#12161F] hover:bg-[#161B25] transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2 font-bold text-slate-200">
                        <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{sess.fileName}</span>
                        <span className="font-mono text-[10px] text-slate-400 font-normal">
                          ({sess.createdAt})
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>Oleh: <strong className="text-slate-300">{sess.createdBy}</strong></span>
                        <span>Snapshot: <strong className="text-slate-300">{sess.erpSnapshotTime}</strong></span>
                        <span>Gudang: <strong className="text-slate-300">{sess.warehouseId === 'ALL' ? 'Semua Gudang' : sess.warehouseId}</strong></span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-2 font-mono text-[11px]">
                        <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                          Match: {sess.summary.matchedCount}
                        </span>
                        <span className="text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded">
                          Selisih: {sess.summary.diffCount}
                        </span>
                        <span className="text-slate-300 bg-slate-800 px-2 py-0.5 rounded">
                          Akurasi: {sess.summary.accuracyRate}%
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setReconciliationItems(sess.items);
                          setSummary(sess.summary);
                          setHistoryOpen(false);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-bold text-xs transition cursor-pointer"
                      >
                        Buka Hasil
                      </button>
                      <button
                        type="button"
                        onClick={() => exportReconciliationToExcel(sess, activeBranch)}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                        title="Download file Excel dari sesi ini"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
