import React, { useState, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { normalizeDateToDmy } from '../utils/calculations';
import {
  RotateCcw,
  QrCode,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Search,
  Download,
  Users,
  Building2,
  PackageCheck,
  Calendar,
  Layers,
  Sparkles,
  ArrowRight,
  Trash2,
  RefreshCw,
  Clock,
  Filter,
  FileText,
  Tag,
  ShieldAlert
} from 'lucide-react';
import { StockItem, CatalogItem, ReturnItem, UserAccount } from '../types';

interface ReturnManagerProps {
  stock: StockItem[];
  catalog: CatalogItem[];
  returnHistory: ReturnItem[];
  currentUser: UserAccount | null;
  onAddStockItem: (newItem: Omit<StockItem, 'id' | 'totalQtySku'>) => Promise<boolean> | void;
  onAddStockItemsBatch?: (newItems: Omit<StockItem, 'id' | 'totalQtySku'>[]) => Promise<boolean> | void;
  onSaveReturnHistory: (newHistory: ReturnItem[]) => void;
}

export default function ReturnManager({
  stock,
  catalog,
  returnHistory,
  currentUser,
  onAddStockItem,
  onAddStockItemsBatch,
  onSaveReturnHistory
}: ReturnManagerProps) {
  // Active Tab: 'single' (Manual / Scan), 'import' (Excel Import), 'history' (Daftar & Export)
  const [activeSubTab, setActiveSubTab] = useState<'single' | 'import' | 'history'>('single');

  // --- TAB 1: FORM INPUT RETUR MANUAL ---
  const [scanSkuInput, setScanSkuInput] = useState('');
  const [selectedSku, setSelectedSku] = useState<CatalogItem | StockItem | null>(null);
  const [expiredDateInput, setExpiredDateInput] = useState('');
  const [qtyInput, setQtyInput] = useState<number | ''>('');
  const [customerInput, setCustomerInput] = useState('');
  const [batchNumberInput, setBatchNumberInput] = useState('');
  const [reasonInput, setReasonInput] = useState('Kemasan Rusak / Defect');
  const [itemCondition, setItemCondition] = useState<'BAGUS' | 'RUSAK'>('RUSAK');
  const [customReason, setCustomReason] = useState('');
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // --- TAB 2: IMPORT MASSAL EXCEL ---
  const [pasteText, setPasteText] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreviewRows, setImportPreviewRows] = useState<Array<{
    skuId: string;
    skuName: string;
    expiredDate: string;
    qty: number;
    customerName: string;
    batchNumber: string;
    reason: string;
    isValid: boolean;
    errorMsg?: string;
  }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- TAB 3: DAFTAR & EXPORT ---
  const [selectedCustomerFilter, setSelectedCustomerFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateRangeFilter, setDateRangeFilter] = useState<'ALL' | 'TODAY' | 'WEEK'>('ALL');

  // List of existing customers for dropdown suggestions
  const customerList = useMemo(() => {
    const set = new Set<string>();
    returnHistory.forEach(item => {
      if (item.customerName) set.add(item.customerName.trim());
    });
    set.add('PT. Retail Nusantara Utama');
    set.add('Toko Berkah Sejahtera');
    set.add('Indomaret Logistics Hub');
    set.add('Shopee Express Hub Jakarta');
    return Array.from(set).sort();
  }, [returnHistory]);

  // Lookup SKU Metadata when user types/scans SKU ID
  const handleSkuSearch = (val: string) => {
    setScanSkuInput(val);
    const cleanVal = val.trim().toUpperCase();
    if (!cleanVal) {
      setSelectedSku(null);
      return;
    }

    // Match exact or partial in catalog
    const foundCatalog = catalog.find(
      c => c.skuId.toUpperCase() === cleanVal || c.skuName.toUpperCase().includes(cleanVal)
    );
    if (foundCatalog) {
      setSelectedSku(foundCatalog);
      return;
    }

    // Match in stock
    const foundStock = stock.find(
      s => s.skuId.toUpperCase() === cleanVal || s.skuName.toUpperCase().includes(cleanVal)
    );
    if (foundStock) {
      setSelectedSku(foundStock);
      return;
    }

    setSelectedSku(null);
  };

  // Submit Manual / Single Return Item
  const handleProcessSingleReturn = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessToast(null);
    setErrorToast(null);

    const skuId = scanSkuInput.trim().toUpperCase();
    if (!skuId) {
      setErrorToast('Mohon masukkan atau scan SKU ID.');
      return;
    }

    const qty = Number(qtyInput);
    if (!qty || qty <= 0) {
      setErrorToast('Jumlah Qty retur harus berupa angka lebih dari 0.');
      return;
    }

    const ed = normalizeDateToDmy(expiredDateInput.trim());
    if (!ed) {
      setErrorToast('Mohon masukkan Expired Date (ED).');
      return;
    }

    const customer = customerInput.trim() || 'Umum / Customer Retur';
    const batch = batchNumberInput.trim() || `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const finalReason = reasonInput === 'Lainnya' ? (customReason.trim() || 'Lainnya') : reasonInput;

    const skuName = selectedSku ? selectedSku.skuName : (stock.find(s => s.skuId.toUpperCase() === skuId)?.skuName || `SKU ${skuId}`);
    const operatorName = currentUser?.fullName || currentUser?.username || 'Operator WMS';

    // Route to KARANTINA if condition is RUSAK or reason indicates defect/damage
    const isDamaged = itemCondition === 'RUSAK' || 
      finalReason.toLowerCase().includes('rusak') || 
      finalReason.toLowerCase().includes('defect') || 
      finalReason.toLowerCase().includes('cacat') || 
      finalReason.toLowerCase().includes('kadaluarsa');

    const allocatedLocation = isDamaged ? 'KARANTINA' : 'TRANSIT';
    const allocatedStatus = isDamaged ? 'Damage' : 'AMAN';

    // 1. Add to stock with allocated location
    onAddStockItem({
      skuId,
      skuName,
      expiredDate: ed,
      location: allocatedLocation,
      qty,
      qtyCtnSize: (selectedSku as any)?.qtyCtnSize || 144,
      qtyCtn: 0,
      qtyInnerSize: (selectedSku as any)?.qtyInnerSize || 12,
      qtyInner: 0,
      qtyLoose: 0,
      status: allocatedStatus
    });

    // 2. Add to Return History
    const newReturnRecord: ReturnItem = {
      id: `ret_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      skuId,
      skuName,
      expiredDate: ed,
      qty,
      customerName: customer,
      batchNumber: batch,
      reason: finalReason,
      location: allocatedLocation,
      operator: operatorName,
      status: isDamaged ? 'KARANTINA' : 'TRANSIT'
    };

    onSaveReturnHistory([newReturnRecord, ...returnHistory]);

    // Show success feedback
    setSuccessToast(
      `Berhasil! Retur ${skuId} (${qty} pcs) dialokasikan ke lokasi ${allocatedLocation} (${isDamaged ? 'Isolasi Karantina (Tidak Masuk Stok Jual)' : 'Staging Transit'}).`
    );

    // Reset inputs
    setScanSkuInput('');
    setSelectedSku(null);
    setQtyInput('');
    setExpiredDateInput('');
    setBatchNumberInput('');
    setCustomReason('');
  };

  // --- PARSE IMPORT EXCEL & TEXT PASTE ---
  const parseRawRowsToPreview = (rawRows: any[]) => {
    const previewList: typeof importPreviewRows = [];

    rawRows.forEach(row => {
      // Flexible column mapping
      const skuId = String(
        row['SKU ID'] || row['SKU'] || row['Kode Barang'] || row['skuId'] || row['sku_id'] || row['sku'] || ''
      ).trim().toUpperCase();

      const expiredDate = normalizeDateToDmy(String(
        row['ED'] || row['Expired Date'] || row['Tanggal ED'] || row['EXPIRED'] || row['expiredDate'] || row['ed'] || ''
      ).trim());

      const qtyNum = parseInt(
        String(row['Qty'] || row['QTY'] || row['Quantity'] || row['Jumlah'] || row['qty'] || '0').replace(/[^0-9]/g, ''),
        10
      ) || 0;

      const customerName = String(
        row['Customer'] || row['Nama Customer'] || row['Toko'] || row['Pelanggan'] || row['customerName'] || row['customer'] || 'Umum / Customer Retur'
      ).trim();

      const batchNumber = String(
        row['Batch Number'] || row['Batch'] || row['No Batch'] || row['Batch No'] || row['batchNumber'] || row['batch'] || ''
      ).trim() || `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

      const reason = String(
        row['Alasan'] || row['Alasan Retur'] || row['Keterangan'] || row['reason'] || 'Import Retur Massal'
      ).trim();

      if (!skuId && !expiredDate && !qtyNum) return; // Skip empty row

      let isValid = true;
      let errorMsg = '';

      if (!skuId) {
        isValid = false;
        errorMsg = 'SKU ID kosong';
      } else if (qtyNum <= 0) {
        isValid = false;
        errorMsg = 'Qty harus > 0';
      } else if (!expiredDate) {
        isValid = false;
        errorMsg = 'ED kosong';
      }

      // Find matching name
      const foundName = catalog.find(c => c.skuId.toUpperCase() === skuId)?.skuName ||
        stock.find(s => s.skuId.toUpperCase() === skuId)?.skuName ||
        `SKU ${skuId}`;

      previewList.push({
        skuId,
        skuName: foundName,
        expiredDate,
        qty: qtyNum,
        customerName,
        batchNumber,
        reason,
        isValid,
        errorMsg
      });
    });

    setImportPreviewRows(previewList);
  };

  // Handle Paste Text Area parsing (Tab delimited)
  const handleParsePasteText = () => {
    if (!pasteText.trim()) {
      setImportPreviewRows([]);
      return;
    }

    const lines = pasteText.trim().split('\n');
    const rawData: any[] = [];

    lines.forEach(line => {
      const parts = line.split('\t').map(p => p.trim());
      if (parts.length >= 3) {
        // If header line, skip
        if (parts[0].toLowerCase().includes('sku') && parts[1].toLowerCase().includes('ed')) return;

        rawData.push({
          'SKU ID': parts[0],
          'ED': parts[1],
          'Qty': parts[2],
          'Customer': parts[3] || 'Umum',
          'Batch Number': parts[4] || '',
          'Alasan': parts[5] || 'Retur Excel Paste'
        });
      }
    });

    parseRawRowsToPreview(rawData);
  };

  const processFile = (file: File) => {
    setImportFile(file);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet);
        parseRawRowsToPreview(jsonRows);
      } catch (err) {
        console.error('Error parsing excel:', err);
        setErrorToast('Gagal membaca file Excel. Pastikan format file .xlsx / .xls valid.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Handle File Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
    if (e.target) e.target.value = '';
  };

  // Submit Mass Import to Stock & Return History
  const handleCommitMassImport = async () => {
    const validRows = importPreviewRows.filter(r => r.isValid);
    if (validRows.length === 0) {
      setErrorToast('Tidak ada data valid yang dapat di-import.');
      return;
    }

    const operatorName = currentUser?.fullName || currentUser?.username || 'Operator WMS';
    const newRecords: ReturnItem[] = [];
    const stockItemsToCreate: Omit<StockItem, 'id' | 'totalQtySku'>[] = [];
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    validRows.forEach((item, index) => {
      const reasonLower = (item.reason || '').toLowerCase();
      const isDamaged =
        reasonLower.includes('rusak') ||
        reasonLower.includes('defect') ||
        reasonLower.includes('cacat') ||
        reasonLower.includes('kadaluarsa');
      const allocatedLocation = isDamaged ? 'KARANTINA' : 'TRANSIT';
      const allocatedStatus = isDamaged ? 'Damage' : 'AMAN';
      const catMatch = catalog.find(c => c.skuId.toUpperCase() === item.skuId.toUpperCase());

      // 1. Collect stock item for atomic batch write
      stockItemsToCreate.push({
        skuId: item.skuId,
        skuName: item.skuName,
        expiredDate: item.expiredDate,
        location: allocatedLocation,
        qty: item.qty,
        qtyCtnSize: (catMatch as any)?.qtyCtnSize || 144,
        qtyCtn: 0,
        qtyInnerSize: (catMatch as any)?.qtyInnerSize || 12,
        qtyInner: 0,
        qtyLoose: 0,
        status: allocatedStatus
      });

      // 2. Build history record
      newRecords.push({
        id: `ret_imp_${nowMs}_${index}`,
        timestamp: nowIso,
        skuId: item.skuId,
        skuName: item.skuName,
        expiredDate: item.expiredDate,
        qty: item.qty,
        customerName: item.customerName,
        batchNumber: item.batchNumber,
        reason: item.reason,
        location: allocatedLocation,
        operator: operatorName,
        status: isDamaged ? 'KARANTINA' : 'TRANSIT'
      });
    });

    try {
      if (onAddStockItemsBatch) {
        await onAddStockItemsBatch(stockItemsToCreate);
      } else {
        for (const stockItem of stockItemsToCreate) {
          await onAddStockItem(stockItem);
        }
      }
    } catch (err: any) {
      setErrorToast(err?.message || 'Gagal menyimpan stok retur massal.');
      return;
    }

    onSaveReturnHistory([...newRecords, ...returnHistory]);

    const totalPcs = validRows.reduce((acc, r) => acc + r.qty, 0);
    const quarantineCount = newRecords.filter(r => r.status === 'KARANTINA').length;
    setSuccessToast(
      `Sukses! ${validRows.length} baris barang retur (${totalPcs} pcs) dari import Excel telah dimasukkan (${validRows.length - quarantineCount} TRANSIT, ${quarantineCount} KARANTINA).`
    );

    // Clear state
    setImportPreviewRows([]);
    setPasteText('');
    setImportFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setActiveSubTab('history');
  };

  // Download Sample Template Excel
  const handleDownloadTemplate = () => {
    const sampleData = [
      {
        'SKU ID': 'WR-001',
        'ED': '12/12/2028',
        'Qty': 50,
        'Customer': 'PT. Retail Nusantara Utama',
        'Batch Number': 'BATCH-2026-08A',
        'Alasan Retur': 'Kemasan Rusak'
      },
      {
        'SKU ID': 'WR-002',
        'ED': '15/05/2028',
        'Qty': 20,
        'Customer': 'Toko Berkah Sejahtera',
        'Batch Number': 'BATCH-2026-08B',
        'Alasan Retur': 'Salah Kirim'
      },
      {
        'SKU ID': 'EGL-001',
        'ED': '20/10/2027',
        'Qty': 100,
        'Customer': 'Indomaret Logistics Hub',
        'Batch Number': 'BATCH-2026-08C',
        'Alasan Retur': 'Customer Cancel'
      }
    ];

    const worksheet = XLSX.utils.json_to_sheet(sampleData);
    worksheet['!cols'] = [
      { wch: 15 },
      { wch: 15 },
      { wch: 10 },
      { wch: 30 },
      { wch: 20 },
      { wch: 25 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'TEMPLATE_IMPORT_RETUR');
    XLSX.writeFile(workbook, 'Template_Import_Retur_WMS.xlsx');
  };

  // --- TAB 3: FILTERED HISTORY & EXPORT MASSAL PER CUSTOMER ---
  const filteredHistory = useMemo(() => {
    let list = [...returnHistory];

    // Filter Customer
    if (selectedCustomerFilter !== 'ALL') {
      list = list.filter(
        item => item.customerName.trim().toLowerCase() === selectedCustomerFilter.trim().toLowerCase()
      );
    }

    // Filter Date Range
    if (dateRangeFilter === 'TODAY') {
      const todayStr = new Date().toISOString().slice(0, 10);
      list = list.filter(item => item.timestamp.startsWith(todayStr));
    } else if (dateRangeFilter === 'WEEK') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      list = list.filter(item => item.timestamp >= weekAgo);
    }

    // Filter Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        item =>
          item.skuId.toLowerCase().includes(q) ||
          item.skuName.toLowerCase().includes(q) ||
          item.customerName.toLowerCase().includes(q) ||
          item.batchNumber.toLowerCase().includes(q) ||
          (item.reason && item.reason.toLowerCase().includes(q))
      );
    }

    return list;
  }, [returnHistory, selectedCustomerFilter, dateRangeFilter, searchQuery]);

  // Statistics Metrics
  const historyStats = useMemo(() => {
    const totalRecords = filteredHistory.length;
    const totalPcs = filteredHistory.reduce((acc, item) => acc + item.qty, 0);
    const uniqueSkus = new Set(filteredHistory.map(i => i.skuId)).size;
    const uniqueCustomers = new Set(filteredHistory.map(i => i.customerName)).size;
    return { totalRecords, totalPcs, uniqueSkus, uniqueCustomers };
  }, [filteredHistory]);

  // EXPORT MASSAL EXCEL (Multi-sheet or Per Customer)
  const handleExportExcelRetur = () => {
    if (filteredHistory.length === 0) {
      setErrorToast('Tidak ada data retur yang dapat diekspor.');
      return;
    }

    const timestampStr = new Date().toISOString().slice(0, 10);
    const isSingleCustomer = selectedCustomerFilter !== 'ALL';

    // SHEET 1: RINGKASAN PER CUSTOMER
    const customerMap = new Map<string, { totalTx: number; totalPcs: number; skus: Set<string>; lastDate: string }>();

    returnHistory.forEach(item => {
      const cust = item.customerName.trim() || 'Umum';
      const existing = customerMap.get(cust) || { totalTx: 0, totalPcs: 0, skus: new Set(), lastDate: item.timestamp };
      existing.totalTx += 1;
      existing.totalPcs += item.qty;
      existing.skus.add(item.skuId);
      if (item.timestamp > existing.lastDate) existing.lastDate = item.timestamp;
      customerMap.set(cust, existing);
    });

    const summaryRows: any[] = [];
    let idx = 1;
    customerMap.forEach((val, custName) => {
      summaryRows.push({
        'No': idx++,
        'Nama Customer / Toko': custName,
        'Total Transaksi Retur': val.totalTx,
        'Total Kuantitas (Pcs)': val.totalPcs,
        'Jumlah SKU Berbeda': val.skus.size,
        'Tanggal Retur Terakhir': new Date(val.lastDate).toLocaleString('id-ID')
      });
    });

    const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    wsSummary['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 22 }, { wch: 22 }, { wch: 20 }, { wch: 25 }];

    // SHEET 2: DETAIL TRANSAKSI RETUR
    const detailRows = filteredHistory.map((item, index) => ({
      'No': index + 1,
      'Tanggal & Jam': new Date(item.timestamp).toLocaleString('id-ID'),
      'Nama Customer / Toko': item.customerName,
      'Batch Number': item.batchNumber,
      'SKU ID': item.skuId,
      'Nama SKU': item.skuName,
      'Expired Date (ED)': item.expiredDate,
      'Jumlah Retur (Pcs)': item.qty,
      'Lokasi Staging': item.location,
      'Alasan Retur': item.reason || '-',
      'Petugas Operator': item.operator
    }));

    const wsDetail = XLSX.utils.json_to_sheet(detailRows);
    wsDetail['!cols'] = [
      { wch: 6 },
      { wch: 22 },
      { wch: 28 },
      { wch: 18 },
      { wch: 15 },
      { wch: 35 },
      { wch: 15 },
      { wch: 18 },
      { wch: 15 },
      { wch: 30 },
      { wch: 20 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      wsDetail,
      isSingleCustomer ? `RETUR_${selectedCustomerFilter.slice(0, 20)}` : 'DETAIL_RETUR'
    );
    XLSX.utils.book_append_sheet(workbook, wsSummary, 'SUMMARY_PER_CUSTOMER');

    const fileName = isSingleCustomer
      ? `Laporan_Retur_${selectedCustomerFilter.replace(/[^a-zA-Z0-9]/g, '_')}_${timestampStr}.xlsx`
      : `Laporan_Massal_Retur_Semua_Customer_${timestampStr}.xlsx`;

    XLSX.writeFile(workbook, fileName);
    setSuccessToast(`Laporan Retur Excel berhasil diekspor: ${fileName}`);
  };

  return (
    <div className="space-y-6 pb-12">
      {/* HEADER TITLE BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 translate-x-12 -translate-y-12 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div className="flex items-center gap-4">
            <div className="p-3.5 bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/30 rounded-2xl text-emerald-400 shadow-lg shadow-emerald-500/10">
              <RotateCcw className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-extrabold text-white tracking-tight">
                  Management Retur Barang (Inbound Return)
                </h2>
                <span className="bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                  Auto Transit Staging
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1 max-w-2xl">
                Penerimaan barang retur dari customer, input manual / scan barcode, import massal via Excel, otomatis dialokasikan ke lokasi <strong className="text-emerald-400">TRANSIT</strong>, serta laporan export massal per customer.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <button
              onClick={() => setActiveSubTab('single')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border cursor-pointer ${
                activeSubTab === 'single'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-800'
              }`}
            >
              <QrCode className="w-4 h-4" />
              <span>Terima Retur (Scan / Manual)</span>
            </button>

            <button
              onClick={() => setActiveSubTab('import')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border cursor-pointer ${
                activeSubTab === 'import'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Upload className="w-4 h-4" />
              <span>Import Massal Excel</span>
            </button>

            <button
              onClick={() => setActiveSubTab('history')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border cursor-pointer ${
                activeSubTab === 'history'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-black shadow-md shadow-emerald-500/20'
                  : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-800'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Daftar & Export Massal ({returnHistory.length})</span>
            </button>
          </div>
        </div>
      </div>

      {/* SUCCESS / ERROR NOTIFICATION TOAST BANNER */}
      {successToast && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center justify-between text-emerald-400 text-xs font-bold shadow-lg animate-in fade-in duration-200">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
            <span>{successToast}</span>
          </div>
          <button
            onClick={() => setSuccessToast(null)}
            className="text-emerald-400/70 hover:text-emerald-300 ml-4 font-bold cursor-pointer"
          >
            Tutup
          </button>
        </div>
      )}

      {errorToast && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 flex items-center justify-between text-rose-400 text-xs font-bold shadow-lg animate-in fade-in duration-200">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
            <span>{errorToast}</span>
          </div>
          <button
            onClick={() => setErrorToast(null)}
            className="text-rose-400/70 hover:text-rose-300 ml-4 font-bold cursor-pointer"
          >
            Tutup
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-TAB 1: TERIMA RETUR MANUAL / SCAN BARCODE */}
      {/* ========================================================================= */}
      {activeSubTab === 'single' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Form Left Column */}
          <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-black text-white flex items-center gap-2">
                  <QrCode className="w-5 h-5 text-emerald-400" />
                  Form Terima Retur Barang Manual
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Scan barcode / ketik SKU ID untuk mencari metadata barang dari katalog.
                </p>
              </div>
              <span className="bg-slate-800 text-slate-300 text-xs px-2.5 py-1 rounded-lg border border-slate-700 font-mono font-bold">
                Lokasi: TRANSIT
              </span>
            </div>

            <form onSubmit={handleProcessSingleReturn} className="space-y-5">
              {/* 1. SKU ID / Scan Barcode */}
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5 flex items-center justify-between">
                  <span>1. SKU ID / Scan Barcode <span className="text-rose-400">*</span></span>
                  <span className="text-[10px] text-slate-500 font-normal">Ketik atau tempel hasil scanner</span>
                </label>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-500" />
                  <input
                    type="text"
                    value={scanSkuInput}
                    onChange={e => handleSkuSearch(e.target.value)}
                    placeholder="Contoh: WR-001, WR-002, EGL-001..."
                    className="w-full pl-10 pr-4 py-3 bg-slate-950 border border-slate-800 rounded-xl text-white font-bold text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none uppercase tracking-wide placeholder:text-slate-600"
                    autoFocus
                  />
                </div>

                {/* SKU Info Card */}
                {selectedSku ? (
                  <div className="mt-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 flex items-center justify-between text-xs">
                    <div>
                      <p className="text-emerald-400 font-extrabold text-sm">{selectedSku.skuName}</p>
                      <p className="text-slate-400 text-[11px] mt-0.5 font-mono">
                        SKU ID: <strong className="text-white">{selectedSku.skuId}</strong> | Qty/CTN: {selectedSku.qtyCtnSize || 144} pcs
                      </p>
                    </div>
                    <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-black px-2 py-1 rounded border border-emerald-500/30 uppercase">
                      SKU Valid
                    </span>
                  </div>
                ) : scanSkuInput.trim().length > 0 ? (
                  <p className="text-[11px] text-amber-400 mt-1.5 flex items-center gap-1 font-semibold">
                    <AlertCircle className="w-3.5 h-3.5" />
                    SKU belum terdaftar di katalog, nama SKU akan dibuat otomatis.
                  </p>
                ) : null}
              </div>

              {/* 2. Expired Date & Quantity */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    2. Expired Date (ED) <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={expiredDateInput}
                    onChange={e => setExpiredDateInput(e.target.value)}
                    placeholder="Contoh: 15/08/2028 atau 2028-08-15"
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white font-bold text-xs focus:border-emerald-500 outline-none placeholder:text-slate-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    3. Kuantitas Retur (Pcs) <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={qtyInput}
                    onChange={e => setQtyInput(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                    placeholder="Masukkan jumlah Pcs..."
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white font-black text-sm focus:border-emerald-500 outline-none placeholder:text-slate-600"
                  />
                </div>
              </div>

              {/* 3. Customer / Toko & Batch Number */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    4. Nama Customer / Toko
                  </label>
                  <input
                    type="text"
                    list="customer-suggestions"
                    value={customerInput}
                    onChange={e => setCustomerInput(e.target.value)}
                    placeholder="e.g. PT. Retail Nusantara, Toko Berkah..."
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white font-semibold text-xs focus:border-emerald-500 outline-none placeholder:text-slate-600"
                  />
                  <datalist id="customer-suggestions">
                    {customerList.map((c, i) => (
                      <option key={i} value={c} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    5. Batch Number
                  </label>
                  <input
                    type="text"
                    value={batchNumberInput}
                    onChange={e => setBatchNumberInput(e.target.value)}
                    placeholder="e.g. BATCH-2026-08A"
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono text-xs font-bold focus:border-emerald-500 outline-none placeholder:text-slate-600"
                  />
                </div>
              </div>

              {/* 4. Kondisi Fisik & Alasan Retur */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    6. Kondisi Fisik Barang
                  </label>
                  <select
                    value={itemCondition}
                    onChange={e => setItemCondition(e.target.value as 'BAGUS' | 'RUSAK')}
                    className={`w-full px-3.5 py-2.5 bg-slate-950 border rounded-xl font-bold text-xs outline-none cursor-pointer ${
                      itemCondition === 'RUSAK'
                        ? 'border-rose-500/50 text-rose-400 bg-rose-500/10'
                        : 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10'
                    }`}
                  >
                    <option value="RUSAK" className="bg-slate-950 text-rose-400">
                      🚨 RUSAK / CACAT (Masuk Lokasi KARANTINA)
                    </option>
                    <option value="BAGUS" className="bg-slate-950 text-emerald-400">
                      ✅ BAGUS / UTUH (Masuk Lokasi TRANSIT)
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    7. Alasan Retur Barang
                  </label>
                  <select
                    value={reasonInput}
                    onChange={e => setReasonInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white font-semibold text-xs focus:border-emerald-500 outline-none cursor-pointer"
                  >
                    <option value="Kemasan Rusak / Defect">Kemasan Rusak / Defect / Segel Terbuka</option>
                    <option value="Salah Kirim Kuantitas (Over)">Salah Kirim Kuantitas / Over Item</option>
                    <option value="Toko Tutup / Refused Delivery">Toko Tutup / Refused Delivery oleh Pembeli</option>
                    <option value="Pembeli Batal / Cancel Order">Pembeli Batal / Cancel Order Marketplace</option>
                    <option value="Mendekati Kadaluarsa (Near ED)">Mendekati Kadaluarsa / Near ED</option>
                    <option value="Lainnya">Lainnya (Ketik Catatan Kustom)</option>
                  </select>

                  {reasonInput === 'Lainnya' && (
                    <input
                      type="text"
                      value={customReason}
                      onChange={e => setCustomReason(e.target.value)}
                      placeholder="Tuliskan catatan alasan retur..."
                      className="mt-2 w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs focus:border-emerald-500 outline-none"
                    />
                  )}
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 active:scale-[0.99]"
              >
                <CheckCircle2 className="w-5 h-5" />
                <span>Proses Retur (Masuk Ke Lokasi TRANSIT)</span>
              </button>
            </form>
          </div>

          {/* Right Column: Workflow Steps & Quick Summary */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <h3 className="text-sm font-black text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                SOP Flow Penerimaan Retur
              </h3>

              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                  <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-black text-xs flex items-center justify-center shrink-0">
                    1
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Scan Barcode / Input SKU ID</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Verifikasi identitas fisik barang retur yang diserahkan kurir/pembeli.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                  <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-black text-xs flex items-center justify-center shrink-0">
                    2
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Input Expired Date & Jumlah Pcs</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Pastikan ED dihitung presisi untuk pengelolaan FEFO gudang.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                  <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-black text-xs flex items-center justify-center shrink-0">
                    3
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Otomatis Dialokasikan ke "TRANSIT"</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Stok retur langsung masuk area staging <span className="text-amber-400 font-bold">TRANSIT</span> untuk di-inspeksi tim QC.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Recent Returns Preview */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-emerald-400" />
                  Retur Terakhir Masuk
                </h4>
                <button
                  onClick={() => setActiveSubTab('history')}
                  className="text-xs text-emerald-400 hover:underline font-bold"
                >
                  Lihat Semua
                </button>
              </div>

              <div className="space-y-2">
                {returnHistory.slice(0, 4).map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-slate-950 border border-slate-800/80 rounded-xl flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-white">{item.skuId}</span>
                        <span className="bg-amber-500/10 text-amber-400 text-[10px] font-bold px-1.5 py-0.5 rounded border border-amber-500/20">
                          {item.location}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate max-w-[200px] mt-0.5">
                        {item.customerName} | Batch: {item.batchNumber}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-emerald-400 font-extrabold text-sm">{item.qty} pcs</span>
                      <p className="text-[10px] text-slate-500 font-mono">
                        {new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-TAB 2: IMPORT MASSAL EXCEL RETUR */}
      {/* ========================================================================= */}
      {activeSubTab === 'import' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-black text-white flex items-center gap-2">
                <Upload className="w-5 h-5 text-emerald-400" />
                Import Massal File Excel / Copy-Paste Data Retur
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Unggah file Excel (.xlsx / .xls) atau tempel data terpisah Tab dari Excel untuk memproses puluhan/ratusan barang retur sekaligus.
              </p>
            </div>

            <button
              onClick={handleDownloadTemplate}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shrink-0"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Download Template Excel (.xlsx)</span>
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Option A: Upload File Excel */}
            <div 
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer.files?.[0]) {
                  processFile(e.dataTransfer.files[0]);
                }
              }}
              className="bg-slate-950 border-2 border-dashed border-slate-800 hover:border-emerald-500/50 rounded-2xl p-6 text-center transition-all flex flex-col items-center justify-center space-y-3"
            >
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
                <FileSpreadsheet className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-bold text-white">Upload File Excel Retur (.xlsx / .csv)</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Kolom wajib: SKU ID, ED, Qty, Customer, Batch Number
                </p>
              </div>

              <label className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl cursor-pointer transition-all shadow-md shadow-emerald-500/10">
                Pilih File Excel
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx, .xls, .csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>

              {importFile && (
                <p className="text-xs text-emerald-400 font-mono font-bold">
                  File terpilih: {importFile.name}
                </p>
              )}
            </div>

            {/* Option B: Copy Paste Excel Text */}
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-2">
              <label className="block text-xs font-bold text-slate-300 flex items-center justify-between">
                <span>Atau Copy-Paste Langsung dari Excel</span>
                <span className="text-[10px] text-slate-500">Format Tab-delimited</span>
              </label>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder={"Contoh Format (Salin baris Excel):\nSKU ID\tED\tQty\tCustomer\tBatch\nWR-001\t12/12/2028\t50\tPT. Retail Utama\tBATCH-01\nWR-002\t15/05/2028\t20\tToko Berkah\tBATCH-02"}
                className="w-full h-32 p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white font-mono focus:border-emerald-500 outline-none resize-none placeholder:text-slate-600"
              />
              <button
                onClick={handleParsePasteText}
                disabled={!pasteText.trim()}
                className="w-full py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                <span>Pratinjau Teks Tempel</span>
              </button>
            </div>
          </div>

          {/* TABLE PREVIEW BEFORE COMMIT */}
          {importPreviewRows.length > 0 && (
            <div className="space-y-4 pt-4 border-t border-slate-800 animate-in fade-in duration-300">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div className="flex items-center gap-4 text-xs font-bold text-slate-300">
                  <span>Total Baris: <strong className="text-white">{importPreviewRows.length}</strong></span>
                  <span>Siap Import: <strong className="text-emerald-400">{importPreviewRows.filter(r => r.isValid).length}</strong></span>
                  <span>Error: <strong className="text-rose-400">{importPreviewRows.filter(r => !r.isValid).length}</strong></span>
                  <span>Total Qty: <strong className="text-emerald-400">{importPreviewRows.filter(r => r.isValid).reduce((a, b) => a + b.qty, 0)} pcs</strong></span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setImportPreviewRows([])}
                    className="px-3 py-1.5 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 rounded-lg text-xs font-bold transition-all cursor-pointer border border-rose-500/20"
                  >
                    Reset Pratinjau
                  </button>

                  <button
                    onClick={handleCommitMassImport}
                    disabled={importPreviewRows.filter(r => r.isValid).length === 0}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl transition-all cursor-pointer flex items-center gap-2 shadow-lg shadow-emerald-500/20 disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Proses Import Retur Massal ({importPreviewRows.filter(r => r.isValid).length} Baris)</span>
                  </button>
                </div>
              </div>

              {/* Preview Table */}
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800">
                    <tr>
                      <th className="p-3">Status</th>
                      <th className="p-3">SKU ID</th>
                      <th className="p-3">Nama SKU</th>
                      <th className="p-3">Expired Date</th>
                      <th className="p-3 text-right">Qty (Pcs)</th>
                      <th className="p-3">Customer</th>
                      <th className="p-3">Batch Number</th>
                      <th className="p-3">Alasan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 bg-slate-900/50">
                    {importPreviewRows.map((row, idx) => (
                      <tr key={idx} className={row.isValid ? 'hover:bg-slate-800/40' : 'bg-rose-500/5'}>
                        <td className="p-3">
                          {row.isValid ? (
                            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-black px-2 py-0.5 rounded uppercase">
                              Valid
                            </span>
                          ) : (
                            <span className="bg-rose-500/10 text-rose-400 border border-rose-500/20 text-[10px] font-black px-2 py-0.5 rounded uppercase">
                              {row.errorMsg || 'Error'}
                            </span>
                          )}
                        </td>
                        <td className="p-3 font-extrabold text-white font-mono">{row.skuId}</td>
                        <td className="p-3 truncate max-w-[200px] text-slate-200">{row.skuName}</td>
                        <td className="p-3 font-mono">{row.expiredDate}</td>
                        <td className="p-3 text-right font-black text-emerald-400">{row.qty} pcs</td>
                        <td className="p-3 text-slate-300 font-semibold">{row.customerName}</td>
                        <td className="p-3 font-mono text-slate-400">{row.batchNumber}</td>
                        <td className="p-3 text-slate-400 text-[11px]">{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-TAB 3: DAFTAR RIWAYAT & EXPORT MASSAL PER CUSTOMER */}
      {/* ========================================================================= */}
      {activeSubTab === 'history' && (
        <div className="space-y-6">
          {/* STATS SUMMARY CARDS */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Transaksi</p>
                <p className="text-xl font-extrabold text-white mt-1">{historyStats.totalRecords} Transaksi</p>
              </div>
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
                <FileText className="w-5 h-5" />
              </div>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Customer</p>
                <p className="text-xl font-extrabold text-amber-400 mt-1">{historyStats.uniqueCustomers} Customer</p>
              </div>
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-400">
                <Users className="w-5 h-5" />
              </div>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Retur Pcs</p>
                <p className="text-xl font-extrabold text-emerald-400 mt-1">{historyStats.totalPcs.toLocaleString('id-ID')} Pcs</p>
              </div>
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
                <PackageCheck className="w-5 h-5" />
              </div>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">SKU Retur Berbeda</p>
                <p className="text-xl font-extrabold text-sky-400 mt-1">{historyStats.uniqueSkus} SKU</p>
              </div>
              <div className="p-3 bg-sky-500/10 border border-sky-500/20 rounded-xl text-sky-400">
                <Tag className="w-5 h-5" />
              </div>
            </div>
          </div>

          {/* FILTER & EXPORT HEADER CONTROLS */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              {/* Filter Customer Dropdown */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-2 rounded-xl text-xs">
                  <Building2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="font-bold text-slate-400 whitespace-nowrap">Filter Customer:</span>
                  <select
                    value={selectedCustomerFilter}
                    onChange={e => setSelectedCustomerFilter(e.target.value)}
                    className="bg-transparent text-white font-extrabold outline-none cursor-pointer pr-2 max-w-[220px] truncate"
                  >
                    <option value="ALL" className="bg-slate-900 text-white">-- Semua Customer ({customerList.length}) --</option>
                    {customerList.map((cust, idx) => (
                      <option key={idx} value={cust} className="bg-slate-900 text-white">
                        {cust}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Filter Date Range */}
                <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 p-1 rounded-xl text-xs font-bold">
                  <button
                    onClick={() => setDateRangeFilter('ALL')}
                    className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                      dateRangeFilter === 'ALL' ? 'bg-emerald-500 text-slate-950 font-black' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Semua
                  </button>
                  <button
                    onClick={() => setDateRangeFilter('TODAY')}
                    className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                      dateRangeFilter === 'TODAY' ? 'bg-emerald-500 text-slate-950 font-black' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Hari Ini
                  </button>
                  <button
                    onClick={() => setDateRangeFilter('WEEK')}
                    className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                      dateRangeFilter === 'WEEK' ? 'bg-emerald-500 text-slate-950 font-black' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    7 Hari Terakhir
                  </button>
                </div>
              </div>

              {/* Search Input & Export Button */}
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <div className="relative w-full sm:w-64">
                  <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Cari SKU, Customer, Batch..."
                    className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:border-emerald-500 outline-none"
                  />
                </div>

                <button
                  onClick={handleExportExcelRetur}
                  className="w-full sm:w-auto px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 whitespace-nowrap shrink-0"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {selectedCustomerFilter === 'ALL'
                      ? 'Export Massal Excel (Semua Customer)'
                      : `Export Excel Customer (${selectedCustomerFilter.slice(0, 15)}...)`}
                  </span>
                </button>
              </div>
            </div>

            {/* Active Filters Info Pill */}
            {(selectedCustomerFilter !== 'ALL' || dateRangeFilter !== 'ALL' || searchQuery.trim()) && (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 p-2.5 rounded-xl text-xs">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                  <Filter className="w-3.5 h-3.5" />
                  <span>
                    Menampilkan <strong className="text-white">{filteredHistory.length}</strong> transaksi ter-filter
                    {selectedCustomerFilter !== 'ALL' && ` untuk customer: ${selectedCustomerFilter}`}
                  </span>
                </div>
                <button
                  onClick={() => {
                    setSelectedCustomerFilter('ALL');
                    setDateRangeFilter('ALL');
                    setSearchQuery('');
                  }}
                  className="text-emerald-400 hover:underline font-bold text-[11px] cursor-pointer"
                >
                  Reset Filter
                </button>
              </div>
            )}
          </div>

          {/* TABLE RIWAYAT RETUR */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-black text-white flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-emerald-400" />
                Daftar Transaksi Retur Masuk ({filteredHistory.length})
              </h3>
              <span className="text-xs text-slate-400 font-mono">
                Lokasi Default: <strong className="text-emerald-400">TRANSIT</strong>
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800">
                  <tr>
                    <th className="p-3 text-center w-12">No</th>
                    <th className="p-3">Tanggal & Jam</th>
                    <th className="p-3">Customer / Toko</th>
                    <th className="p-3">Batch Number</th>
                    <th className="p-3">SKU ID</th>
                    <th className="p-3">Nama Barang / SKU</th>
                    <th className="p-3">ED</th>
                    <th className="p-3 text-right">Qty (Pcs)</th>
                    <th className="p-3 text-center">Staging</th>
                    <th className="p-3">Alasan Retur</th>
                    <th className="p-3">Petugas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 bg-slate-900/30">
                  {filteredHistory.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="p-8 text-center text-slate-500 font-bold">
                        Belum ada data transaksi retur yang sesuai dengan filter.
                      </td>
                    </tr>
                  ) : (
                    filteredHistory.map((item, idx) => (
                      <tr key={item.id || idx} className="hover:bg-slate-800/40 transition-colors">
                        <td className="p-3 text-center font-bold text-slate-500">{idx + 1}</td>
                        <td className="p-3 text-slate-400 font-mono text-[11px] whitespace-nowrap">
                          {new Date(item.timestamp).toLocaleString('id-ID', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </td>
                        <td className="p-3 font-extrabold text-white">{item.customerName}</td>
                        <td className="p-3 font-mono text-amber-400 font-bold whitespace-nowrap">
                          {item.batchNumber}
                        </td>
                        <td className="p-3 font-black text-emerald-400 font-mono whitespace-nowrap">
                          {item.skuId}
                        </td>
                        <td className="p-3 text-slate-200 font-medium truncate max-w-[220px]">
                          {item.skuName}
                        </td>
                        <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{item.expiredDate}</td>
                        <td className="p-3 text-right font-black text-emerald-400 text-sm whitespace-nowrap">
                          {item.qty.toLocaleString('id-ID')} Pcs
                        </td>
                        <td className="p-3 text-center whitespace-nowrap">
                          <span className="bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                            {item.location}
                          </span>
                        </td>
                        <td className="p-3 text-slate-300 text-[11px] max-w-[200px] truncate">
                          {item.reason || '-'}
                        </td>
                        <td className="p-3 text-slate-400 text-[11px] font-medium whitespace-nowrap">
                          {item.operator}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
