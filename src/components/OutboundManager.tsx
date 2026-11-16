import React, { useState, useMemo, useEffect } from 'react';
import { StockItem, OutboundItem, Warehouse, UserAccount, BranchOperationType, ChannelOperationType } from '../types';
import { resolveOrderType } from '../utils/orderType';
import { findSkuId, getBarcodeForSku } from '../data/barcodeMap';
import { formatNumber, getStatusBadgeClass, isStockPickable, getAvailableStockPool } from '../utils/calculations';
import { ensureCentralWarehouse, isCentralWarehouse } from '../utils/warehouseRouting';
import OrderFileImport from './OrderFileImport';
import { useLanguage } from '../i18n/LanguageContext';
import { 
  Scan, 
  Plus, 
  Calendar, 
  CheckCircle, 
  ShoppingCart, 
  Trash2, 
  Volume2, 
  PackageCheck,
  Zap,
  Tag,
  FileSpreadsheet,
  History,
  Search,
  Download,
  Building2,
  Clock,
  Layers,
  ArrowRight
} from 'lucide-react';

interface OutboundManagerProps {
  stock: StockItem[];
  orderHistory?: OutboundItem[];
  warehouses?: Warehouse[];
  onProcessOutbound: (items: Omit<OutboundItem, 'id' | 'timestamp'>[]) => Promise<boolean>;
  currentUser?: UserAccount | null;
  branchOperationType?: BranchOperationType;
}

const parseDateForSort = (dateStr: string): number => {
  if (!dateStr) return 9999999999999;
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
  }
  const time = new Date(dateStr).getTime();
  return isNaN(time) ? 9999999999999 : time;
};

const formatIsoDateTime = (isoStr?: string): string => {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
};

const generateQuickRef = () => {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100 + Math.random() * 900);
  return `OUT-QUICK-${ymd}-${rand}`;
};

export default function OutboundManager({
  stock,
  orderHistory = [],
  warehouses = [],
  onProcessOutbound,
  currentUser,
  branchOperationType = 'HYBRID',
}: OutboundManagerProps) {
  const { t, language } = useLanguage();
  // Main Navigation Tab: Input vs Riwayat Khusus Outbound Cepat
  const [activeMainTab, setActiveMainTab] = useState<'input' | 'history'>('input');

  const [selectedOrderType, setSelectedOrderType] = useState<ChannelOperationType | null>(() =>
    branchOperationType === 'HYBRID' ? null : branchOperationType
  );
  useEffect(() => {
    if (branchOperationType === 'B2B' || branchOperationType === 'ONLINE') {
      setSelectedOrderType(branchOperationType);
    } else {
      setSelectedOrderType(null);
    }
  }, [branchOperationType]);
  const effectiveOrderType: ChannelOperationType | null =
    branchOperationType === 'HYBRID' ? selectedOrderType : branchOperationType;

  const [refNumber, setRefNumber] = useState(generateQuickRef);
  const [batchNumber, setBatchNumber] = useState('');
  const [activeSubTab, setActiveSubTab] = useState<'scan' | 'import'>('scan');
  const availableWarehouses = useMemo(() => {
    return ensureCentralWarehouse(warehouses);
  }, [warehouses]);

  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>(() => {
    const list = ensureCentralWarehouse(warehouses);
    return list[0]?.id || 'WH-CENTRAL';
  });

  // History Tab Filters
  const [historySearch, setHistorySearch] = useState('');
  const [historyDateFilter, setHistoryDateFilter] = useState<'all' | 'today' | '7days' | '30days'>('all');
  const [historyWarehouseFilter, setHistoryWarehouseFilter] = useState<string>('all');

  useEffect(() => {
    if (availableWarehouses.length > 0) {
      const centralWh = availableWarehouses.find(isCentralWarehouse) || availableWarehouses[0];
      if (!selectedWarehouseId || !availableWarehouses.some(w => w.id === selectedWarehouseId)) {
        setSelectedWarehouseId(centralWh.id);
      }
    }
  }, [availableWarehouses, selectedWarehouseId]);

  const availableStock = useMemo(() => {
    const activeWh = (selectedWarehouseId || 'WH-CENTRAL').toUpperCase();
    return getAvailableStockPool(stock, orderHistory).filter(
      item => (item.warehouseId || 'WH-CENTRAL').toUpperCase() === activeWh
    );
  }, [stock, orderHistory, selectedWarehouseId]);
  
  // Scanned / Manual Input states
  const [scannedSkuId, setScannedSkuId] = useState('');
  const [matchedStockLines, setMatchedStockLines] = useState<StockItem[]>([]);
  const [selectedLine, setSelectedLine] = useState<StockItem | null>(null);
  const [outboundQty, setOutboundQty] = useState<number>(0);
  const [scanningMessage, setScanningMessage] = useState<string | null>(null);
  const [scanningError, setScanningError] = useState<string | null>(null);
  
  // Audio state
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Active Outbound Queue before processed (Draft)
  const [outboundQueue, setOutboundQueue] = useState<Omit<OutboundItem, 'id' | 'timestamp'>[]>([]);

  // Sound generator
  const triggerBeep = () => {
    if (!soundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1100, audioCtx.currentTime); // High pitch beep
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.12); // Short beep 120ms
    } catch (e) {
      console.warn('Audio feedback blocked by browser policies', e);
    }
  };

  const triggerErrorSound = () => {
    if (!soundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(150, audioCtx.currentTime); // Low error buzz
      gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.3); // Longer low buzz
    } catch (e) {
      console.warn(e);
    }
  };

  // Search SKU lines when SKU is scanned / input
  const handleBarcodeSubmit = (skuToSearch: string) => {
    const cleanSku = skuToSearch.trim();
    if (!cleanSku) return;

    setScanningError(null);
    setScanningMessage(null);

    const resolvedSku = findSkuId(cleanSku).trim().toLowerCase();
    const matches = availableStock
      .filter(item => item.qty > 0 && isStockPickable(item) && (
        item.skuId.toLowerCase() === resolvedSku ||
        (cleanSku !== '-' && getBarcodeForSku(item.skuId, item.barcode).trim().toLowerCase() === cleanSku.toLowerCase())
      ))
      .sort((a, b) => {
        const expDiff = parseDateForSort(a.expiredDate) - parseDateForSort(b.expiredDate);
        if (expDiff !== 0) return expDiff;
        return a.location.localeCompare(b.location);
      });

    if (matches.length > 0) {
      triggerBeep();
      setMatchedStockLines(matches);
      setSelectedLine(matches[0]); // Default select first matching line
      setScannedSkuId(cleanSku);
      setScanningMessage(`✓ SKU ${cleanSku} berhasil di-scan! Ditemukan di ${matches.length} lokasi.`);
      setOutboundQty(1); // Default Qty to 1
    } else {
      triggerErrorSound();
      setMatchedStockLines([]);
      setSelectedLine(null);
      setScanningError(`❌ SKU "${cleanSku}" tidak ditemukan di lokasi penyimpanan aktif.`);
    }
  };

  // Mock Barcode Gun click helper
  const handleMockScan = (skuId: string) => {
    setScannedSkuId(skuId);
    handleBarcodeSubmit(skuId);
  };

  // Add current selected line item to outbound queue (Prepared directly as Completed so stock is deducted immediately)
  const handleAddToQueue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveOrderType) {
      triggerErrorSound();
      alert('Cabang HYBRID wajib memilih Jenis Order (B2B atau ONLINE) sebelum menambahkan item.');
      return;
    }
    if (!selectedLine) return;

    if (outboundQty <= 0) {
      alert('Kuantitas outbound harus lebih dari 0.');
      return;
    }

    // Check availability limit
    const alreadyInQueueQty = outboundQueue
      .filter(item => item.skuId === selectedLine.skuId && item.location === selectedLine.location && item.expiredDate === selectedLine.expiredDate)
      .reduce((sum, item) => sum + item.qty, 0);

    const availableLimit = selectedLine.qty - alreadyInQueueQty;

    if (outboundQty > availableLimit) {
      triggerErrorSound();
      alert(`Stok tidak mencukupi! Tersedia sisa ${availableLimit} pcs di lokasi ${selectedLine.location} (termasuk antrean draf).`);
      return;
    }

    const activeWhObj = availableWarehouses.find(w => w.id === selectedWarehouseId);
    const nowIso = new Date().toISOString();
    const operatorName = currentUser?.fullName || currentUser?.username || 'Operator';

    // Outbound Cepat: Status langsung 'Completed', picked: true, stockDeducted: true sehingga memotong stok instan tanpa picking/packing
    const queueItem: Omit<OutboundItem, 'id' | 'timestamp'> = {
      referenceNumber: refNumber,
      batchNumber: batchNumber.trim() || undefined,
      skuId: selectedLine.skuId,
      skuName: selectedLine.skuName,
      expiredDate: selectedLine.expiredDate,
      qty: outboundQty,
      location: selectedLine.location,
      scanned: true,
      warehouseId: selectedLine.warehouseId || selectedWarehouseId || 'WH-CENTRAL',
      warehouseName: selectedLine.warehouseName || activeWhObj?.name || 'Gudang Pusat',
      picked: true,
      isPicked: true,
      stockDeducted: true,
      status: 'Completed',
      outboundType: 'quick',
      isQuickOutbound: true,
      orderType: effectiveOrderType,
      orderSource: effectiveOrderType === 'ONLINE' ? 'QUICK_OUTBOUND_ONLINE' : 'QUICK_OUTBOUND_B2B',
      completedAt: nowIso,
      pickedAt: nowIso,
      packedAt: nowIso,
      createdBy: operatorName,
      pickedBy: operatorName,
      packedBy: operatorName,
      notes: 'Outbound Cepat (Potong Stok Langsung)'
    };

    setOutboundQueue([...outboundQueue, queueItem]);
    triggerBeep();

    // Reset input states
    setScannedSkuId('');
    setMatchedStockLines([]);
    setSelectedLine(null);
    setOutboundQty(0);
    setScanningMessage('✓ Item berhasil dimasukkan ke daftar Outbound Cepat.');
  };

  const handleRemoveFromQueue = (index: number) => {
    const updated = [...outboundQueue];
    updated.splice(index, 1);
    setOutboundQueue(updated);
  };

  const handleFinalizeOutbound = async () => {
    if (!effectiveOrderType) {
      alert('Pilih Jenis Order (B2B atau ONLINE) terlebih dahulu.');
      return;
    }
    if (outboundQueue.length === 0) {
      alert('Daftar item Outbound Cepat masih kosong.');
      return;
    }
    const normalizedQueue = outboundQueue.map((item) => ({
      ...item,
      orderType:
        resolveOrderType(item) === 'UNASSIGNED'
          ? effectiveOrderType
          : resolveOrderType(item),
      orderSource:
        item.orderSource ||
        (effectiveOrderType === 'ONLINE' ? 'QUICK_OUTBOUND_ONLINE' : 'QUICK_OUTBOUND_B2B'),
    }));

    const success = await onProcessOutbound(normalizedQueue);
    if (!success) return;

    setOutboundQueue([]);
    if (branchOperationType === 'HYBRID') {
      setSelectedOrderType(null);
    }
    // Regenerate unique ref number
    setRefNumber(generateQuickRef());
    setScanningMessage('✓ Sukses! Outbound Cepat selesai dan stok sistem langsung dipotong secara real-time.');
  };

  // List of distinct SKUs with available pickable stock to display as clickable barcodes for testing
  const quickBarcodes = useMemo(() => {
    const uniqueMap = new Map<string, string>();
    availableStock.forEach(item => {
      if (item.qty > 0 && isStockPickable(item) && uniqueMap.size < 6) {
        uniqueMap.set(item.skuId, item.skuName);
      }
    });
    return Array.from(uniqueMap.entries());
  }, [availableStock]);

  // Dedicated History for Quick Outbound (Filtered cleanly from regular B2B/Online orders)
  const quickOutboundHistory = useMemo(() => {
    return (orderHistory || []).filter(item => {
      return item.isQuickOutbound === true || item.outboundType === 'quick' || item.referenceNumber?.startsWith('OUT-QUICK-');
    }).sort((a, b) => {
      const timeA = new Date(a.completedAt || a.timestamp).getTime();
      const timeB = new Date(b.completedAt || b.timestamp).getTime();
      return timeB - timeA;
    });
  }, [orderHistory]);

  // Filtered History based on Search, Date, and Warehouse
  const filteredQuickHistory = useMemo(() => {
    return quickOutboundHistory.filter(item => {
      // Warehouse filter
      if (historyWarehouseFilter !== 'all' && (item.warehouseId || 'WH-CENTRAL').toUpperCase() !== historyWarehouseFilter.toUpperCase()) {
        return false;
      }

      // Date filter
      if (historyDateFilter !== 'all') {
        const itemDate = new Date(item.completedAt || item.timestamp);
        const now = new Date();
        const diffMs = now.getTime() - itemDate.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (historyDateFilter === 'today') {
          const isSameDay = itemDate.getDate() === now.getDate() &&
            itemDate.getMonth() === now.getMonth() &&
            itemDate.getFullYear() === now.getFullYear();
          if (!isSameDay) return false;
        } else if (historyDateFilter === '7days' && diffDays > 7) {
          return false;
        } else if (historyDateFilter === '30days' && diffDays > 30) {
          return false;
        }
      }

      // Search filter
      if (historySearch.trim()) {
        const term = historySearch.toLowerCase().trim();
        const matchesRef = item.referenceNumber?.toLowerCase().includes(term);
        const matchesSku = item.skuId?.toLowerCase().includes(term);
        const matchesName = item.skuName?.toLowerCase().includes(term);
        const matchesUser = (item.createdBy || item.pickedBy || item.packedBy || '')?.toLowerCase().includes(term);
        const matchesLoc = item.location?.toLowerCase().includes(term);
        if (!matchesRef && !matchesSku && !matchesName && !matchesUser && !matchesLoc) {
          return false;
        }
      }

      return true;
    });
  }, [quickOutboundHistory, historyWarehouseFilter, historyDateFilter, historySearch]);

  // Quick Outbound History KPIs
  const historyStats = useMemo(() => {
    const totalTransactions = new Set(filteredQuickHistory.map(item => item.referenceNumber)).size;
    const totalPcs = filteredQuickHistory.reduce((sum, item) => sum + item.qty, 0);
    const totalSkus = new Set(filteredQuickHistory.map(item => item.skuId)).size;
    return { totalTransactions, totalPcs, totalSkus };
  }, [filteredQuickHistory]);

  // Export to CSV Function
  const handleExportHistoryCsv = () => {
    if (filteredQuickHistory.length === 0) {
      alert('Tidak ada data riwayat outbound cepat untuk diexport.');
      return;
    }

    const headers = ['Waktu Selesai', 'No Dokumen', 'SKU ID', 'Nama Produk', 'Lokasi Rak', 'Expired Date', 'Qty (Pcs)', 'Gudang', 'Petugas', 'Status'];
    const rows = filteredQuickHistory.map(item => [
      `"${formatIsoDateTime(item.completedAt || item.timestamp)}"`,
      `"${item.referenceNumber}"`,
      `"${item.skuId}"`,
      `"${(item.skuName || '').replace(/"/g, '""')}"`,
      `"${item.location}"`,
      `"${item.expiredDate || '-'}"`,
      item.qty,
      `"${item.warehouseName || item.warehouseId || 'WH-CENTRAL'}"`,
      `"${item.createdBy || item.pickedBy || 'Operator'}"`,
      `"Selesai (Stok Terpotong Langsung)"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Riwayat_Outbound_Cepat_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Top Main Tab Navigation */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveMainTab('input')}
            className={`flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${
              activeMainTab === 'input'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-[#11141B] text-slate-400 hover:text-white border border-slate-800/80'
            }`}
          >
            <Zap className="w-4 h-4 fill-current" />
            <span>{t('quick.inputTab')}</span>
            {outboundQueue.length > 0 && (
              <span className="bg-slate-950 text-emerald-400 px-2 py-0.5 rounded-full text-[10px] font-bold">
                {outboundQueue.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveMainTab('history')}
            className={`flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${
              activeMainTab === 'history'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-[#11141B] text-slate-400 hover:text-white border border-slate-800/80'
            }`}
          >
            <History className="w-4 h-4" />
            <span>{t('quick.historyTab')}</span>
            <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full text-[10px] font-bold">
              {quickOutboundHistory.length}
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-semibold text-[11px]">
            <CheckCircle className="w-3.5 h-3.5" />
                {t('quick.directStock')}
          </span>
        </div>
      </div>

      {/* TAB 1: INPUT OUTBOUND CEPAT */}
      {activeMainTab === 'input' && (
        <div className="space-y-6">
          {/* Upper Reference Header */}
          <div className="bg-[#11141B] rounded-xl p-4 border border-slate-800/60 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('quick.documentNo')}</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono font-bold text-lg text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-lg flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-emerald-400 fill-emerald-400" />
                    {refNumber}
                  </span>
                  <button
                    onClick={() => setRefNumber(generateQuickRef())}
                    className="text-xs font-semibold text-emerald-450 hover:text-emerald-400 underline bg-transparent border-none cursor-pointer"
                  >
                    Ubah No. Doc
                  </button>
                </div>
              </div>

              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('quick.sourceWarehouse')}</span>
                <select
                  value={selectedWarehouseId}
                  onChange={(e) => {
                    setSelectedWarehouseId(e.target.value);
                    setMatchedStockLines([]);
                    setSelectedLine(null);
                  }}
                  className="mt-1 px-3 py-1.5 text-xs font-bold bg-[#161B25] border border-slate-800 rounded-lg text-white outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  {availableWarehouses.map(wh => (
                    <option key={wh.id} value={wh.id}>
                      [{wh.code}] {wh.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                  Jenis Order {branchOperationType === 'HYBRID' ? '(Wajib Pilih)' : '(Terkunci Cabang)'}
                </span>
                {branchOperationType === 'HYBRID' ? (
                  <div className="mt-1 inline-flex items-center gap-1.5" role="group" aria-label="Pilih jenis order outbound cepat">
                    {(['B2B', 'ONLINE'] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        disabled={outboundQueue.length > 0 && selectedOrderType !== null && selectedOrderType !== opt}
                        onClick={() => setSelectedOrderType(opt)}
                        className={`px-3 py-1.5 text-xs font-extrabold rounded-lg border transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                          selectedOrderType === opt
                            ? opt === 'B2B'
                              ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-sm'
                              : 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-sm'
                            : 'bg-[#161B25] text-slate-300 border-slate-700 hover:border-slate-500'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span
                    className={`mt-1 inline-flex items-center px-3 py-1.5 text-xs font-extrabold rounded-lg border ${
                      branchOperationType === 'B2B'
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                        : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                    }`}
                  >
                    TERKUNCI: {branchOperationType}
                  </span>
                )}
              </div>

              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('quick.batchNumber')}</span>
                <input
                  type="text"
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                  placeholder="Misal: BATCH-QC-01 / Penjualan Langsung"
                  className="mt-1 px-3 py-1.5 text-xs font-bold font-mono bg-[#161B25] border border-slate-800 rounded-lg text-white outline-none focus:ring-2 focus:ring-emerald-500 w-56 placeholder:text-slate-600"
                />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-300">
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => setSoundEnabled(e.target.checked)}
                  className="rounded border-slate-800 text-emerald-500 focus:ring-emerald-500 bg-[#161B25] w-4 h-4"
                />
                <Volume2 className="w-4 h-4 text-slate-400" />
                Efek Suara Beep
              </label>
            </div>
          </div>

          {branchOperationType === 'HYBRID' && !effectiveOrderType && (
            <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-200 flex items-center justify-between gap-3">
              <span>Cabang ini bertipe HYBRID. Pilih wajib jenis order <strong>B2B</strong> atau <strong>ONLINE</strong> di atas sebelum memindai, mengimpor, atau memproses Outbound Cepat.</span>
            </div>
          )}

          {/* Sub Tab Switcher: Scan Satuan vs Import Massal */}
          <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
            <button
              type="button"
              onClick={() => setActiveSubTab('scan')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${
                activeSubTab === 'scan'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border border-slate-800/80'
              }`}
            >
              <Scan className="w-4 h-4" />
              <span>{t('quick.scanInput')}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab('import')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${
                activeSubTab === 'import'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'bg-[#11141B] text-slate-400 hover:text-white border border-slate-800/80'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
              <span>{t('quick.bulkImport')}</span>
            </button>
          </div>

          {activeSubTab === 'import' ? (
            !effectiveOrderType ? (
              <div className="rounded-xl border border-amber-500/30 bg-[#11141B] p-6 text-center text-sm text-amber-300 font-bold">
                Pilih jenis order B2B atau ONLINE terlebih dahulu sebelum melakukan import file Outbound Cepat.
              </div>
            ) : (
              <OrderFileImport
                stock={stock}
                orderHistory={orderHistory}
                warehouseId={selectedWarehouseId}
                defaultOrderType={effectiveOrderType}
              />
            )
          ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* LEFT COLUMN - BARCODE SCANNING SIMULATOR */}
            <div className="lg:col-span-6 space-y-6">
              <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md">
                <h3 className="text-base font-bold text-white mb-4 flex items-center gap-2">
                  <Scan className="w-5 h-5 text-emerald-400 animate-pulse" />
                  Pemindai Barcode (Scanner Simulator)
                </h3>

                {/* Visual Scanner Layout */}
                <div className="relative border-2 border-dashed border-slate-800 rounded-xl p-8 bg-[#161B25] flex flex-col items-center justify-center overflow-hidden min-h-[220px]">
                  {/* Laser beam animation */}
                  <div className="absolute left-0 right-0 h-0.5 bg-rose-500 shadow-lg shadow-rose-500/80 animate-laser z-10"></div>
                  
                  {/* Camera-like corners */}
                  <div className="absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 border-emerald-500"></div>
                  <div className="absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 border-emerald-500"></div>
                  <div className="absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 border-emerald-500"></div>
                  <div className="absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 border-emerald-500"></div>

                  {/* Barcode SVG illustration */}
                  <div className="opacity-70 flex flex-col items-center">
                    <svg className="w-48 h-20 text-slate-200 fill-current" viewBox="0 0 100 30" xmlns="http://www.w3.org/2000/svg">
                      <rect x="0" y="0" width="4" height="30" />
                      <rect x="6" y="0" width="2" height="30" />
                      <rect x="10" y="0" width="6" height="30" />
                      <rect x="18" y="0" width="1" height="30" />
                      <rect x="22" y="0" width="3" height="30" />
                      <rect x="28" y="0" width="5" height="30" />
                      <rect x="36" y="0" width="2" height="30" />
                      <rect x="40" y="0" width="4" height="30" />
                      <rect x="46" y="0" width="1" height="30" />
                      <rect x="50" y="0" width="8" height="30" />
                      <rect x="60" y="0" width="2" height="30" />
                      <rect x="64" y="0" width="4" height="30" />
                      <rect x="70" y="0" width="6" height="30" />
                      <rect x="78" y="0" width="2" height="30" />
                      <rect x="82" y="0" width="1" height="30" />
                      <rect x="85" y="0" width="5" height="30" />
                      <rect x="92" y="0" width="3" height="30" />
                      <rect x="97" y="0" width="3" height="30" />
                    </svg>
                    <span className="text-[10px] text-slate-500 font-mono tracking-[4px] mt-2 uppercase">Barcode Scanner</span>
                  </div>

                  {/* Feedback Notifications inside viewport */}
                  <div className="absolute inset-x-4 bottom-4 z-20 text-center">
                    {scanningMessage && (
                      <div className="bg-emerald-950/90 border border-emerald-800 text-emerald-400 px-3 py-1.5 rounded-lg text-xs font-semibold animate-pulse-soft">
                        {scanningMessage}
                      </div>
                    )}
                    {scanningError && (
                      <div className="bg-rose-950/90 border border-rose-900 text-rose-400 px-3 py-1.5 rounded-lg text-xs font-semibold">
                        {scanningError}
                      </div>
                    )}
                  </div>
                </div>

                {/* Input Form triggers */}
                <div className="mt-4">
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Ditembak Barcode Gun / Input Manual SKU</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Ketik SKU ID (e.g. 1019, 9144-01, SN010)"
                      value={scannedSkuId}
                      onChange={(e) => setScannedSkuId(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleBarcodeSubmit(scannedSkuId);
                        }
                      }}
                      className="flex-1 px-3 py-2 text-sm bg-[#161B25] border border-slate-800 rounded-xl font-mono focus:ring-2 focus:ring-emerald-500 text-white outline-none uppercase"
                    />
                    <button
                      type="button"
                      onClick={() => handleBarcodeSubmit(scannedSkuId)}
                      className="px-4 py-2 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-emerald-500/10"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      Tembak Scan
                    </button>
                  </div>
                </div>

                {/* Simulated Handheld Gun Click board */}
                <div className="mt-6 border-t border-slate-800/60 pt-4">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Tag className="w-3 h-3 text-slate-500" />
                    Papan Simulasi Fisik (Klik Barcode Cepat)
                  </h4>
                  <p className="text-[10px] text-slate-500 mb-3">
                    Gunakan tombol di bawah ini untuk mensimulasikan tembakan barcode gun sungguhan pada produk:
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {quickBarcodes.map(([sku, name]) => (
                      <button
                        key={sku}
                        onClick={() => handleMockScan(sku)}
                        className="p-2 border border-slate-800 bg-[#161B25] hover:border-emerald-500/40 hover:bg-emerald-500/10 rounded-xl text-left transition-all cursor-pointer group"
                        type="button"
                      >
                        <span className="block font-mono font-bold text-slate-200 text-xs group-hover:text-emerald-400">{sku}</span>
                        <span className="block text-[10px] text-slate-400 line-clamp-1 mt-0.5">{name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* OUTBOUND QUANTITY & LOCATION FORM */}
              {matchedStockLines.length > 0 && selectedLine && (
                <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md">
                  <h3 className="text-base font-bold text-white mb-4 flex items-center gap-2">
                    <PackageCheck className="w-5 h-5 text-emerald-450" />
                    {language === 'en' ? 'Outbound Location & Quantity Validation' : 'Validasi Lokasi & Kuantitas Outbound'}
                  </h3>

                  <form onSubmit={handleAddToQueue} className="space-y-4">
                    <div className="bg-[#161B25] rounded-xl p-3 border border-slate-800">
                      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Barang Terpilih</p>
                      <h4 className="font-bold text-white mt-1">{selectedLine.skuName}</h4>
                      <p className="text-xs text-slate-400 mt-0.5 font-mono">SKU ID: {selectedLine.skuId}</p>
                    </div>

                    {/* Location Picker with stock availability */}
                    <div>
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-1.5">Pilih Lokasi Rak Pengambilan (FEFO)</label>
                      <div className="space-y-2 max-h-[140px] overflow-y-auto">
                        {matchedStockLines.map(line => {
                          const isSelected = selectedLine.id === line.id;
                          return (
                            <div 
                              key={line.id}
                              onClick={() => setSelectedLine(line)}
                              className={`flex items-center justify-between p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${isSelected ? 'bg-indigo-500/10 border-indigo-500/40 text-white font-semibold' : 'bg-[#161B25] border-slate-800 hover:bg-slate-800/40 text-slate-300'}`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[11px] font-bold bg-slate-950/40 border border-slate-800 px-1.5 py-0.5 rounded text-slate-200">
                                  {line.location}
                                </span>
                                <span className="text-slate-400">Exp: {line.expiredDate}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span>Tersedia: <strong className="text-white">{formatNumber(line.qty)}</strong> pcs</span>
                                <span className="text-[10px] text-slate-500">({line.qtyCtn} Ctn, {line.qtyInner} Inr, {line.qtyLoose} Ls)</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Outbound Qty Input */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Qty Keluar (Pcs)</label>
                        <div className="relative">
                          <input
                            type="number"
                            required
                            min="1"
                            max={selectedLine.qty}
                            value={outboundQty === 0 ? '' : outboundQty}
                            onChange={(e) => setOutboundQty(Math.min(selectedLine.qty, parseInt(e.target.value, 10) || 0))}
                            className="w-full px-3 py-2 text-sm bg-[#161B25] border border-slate-800 text-white rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                          />
                          <span className="absolute right-3 top-2 text-xs font-semibold text-slate-500">Pcs</span>
                        </div>
                      </div>

                      <div>
                        <span className="block text-xs font-bold text-slate-400 uppercase mb-1">Status Expired</span>
                        <span className={`inline-block px-3 py-1.5 rounded-lg text-xs font-bold mt-0.5 ${getStatusBadgeClass(selectedLine.status)}`}>
                          {selectedLine.status === 'Damage' ? '⚠️ Damage' : selectedLine.status === 'Expired' ? '⏰ Expired' : selectedLine.status}
                        </span>
                      </div>
                    </div>

                    {/* Add to list trigger */}
                    <button
                      type="submit"
                      disabled={!effectiveOrderType}
                      className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-450 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-extrabold rounded-xl text-sm flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-500/10 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      {effectiveOrderType ? t('quick.addToQueue') : 'Pilih Jenis Order (B2B / ONLINE) Dahulu'}
                    </button>
                  </form>
                </div>
              )}
            </div>

            {/* RIGHT COLUMN - OUTBOUND QUEUE LIST */}
            <div className="lg:col-span-6">
              <div className="bg-[#11141B] rounded-xl border border-slate-800/60 shadow-md h-full flex flex-col min-h-[420px]">
                <div className="p-5 border-b border-slate-800/60 bg-slate-950/40 rounded-t-xl flex justify-between items-center">
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <ShoppingCart className="w-5 h-5 text-emerald-400" />
                    {t('quick.queue')} ({outboundQueue.length})
                  </h3>
                  <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-full font-bold flex items-center gap-1">
                    <Zap className="w-3 h-3 fill-current" />
                    {t('quick.cutStock')}
                  </span>
                </div>

                {/* Queue items list */}
                <div className="p-4 flex-1 overflow-y-auto max-h-[380px] divide-y divide-slate-800/60">
                  {outboundQueue.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center py-20 text-slate-500 h-full">
                      <ShoppingCart className="w-12 h-12 stroke-1 mb-2 animate-bounce text-slate-600" />
                      <p className="text-sm font-bold text-slate-400">Daftar Item Masih Kosong</p>
                      <p className="text-xs text-slate-500 mt-1 max-w-[280px]">
                        Scan atau ketik SKU ID produk di sebelah kiri, pilih lokasi rak, lalu masukkan kuantitas barang yang keluar.
                      </p>
                    </div>
                  ) : (
                    outboundQueue.map((item, idx) => (
                      <div key={idx} className="py-3 flex justify-between items-start text-xs group">
                        <div className="space-y-1 pr-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-bold text-emerald-400 text-xs bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                              {item.skuId}
                            </span>
                            <span className="font-mono text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.5 rounded-md font-semibold">
                              Lokasi: {item.location}
                            </span>
                          </div>
                          <p className="font-semibold text-white text-sm line-clamp-1">{item.skuName}</p>
                          <div className="flex gap-3 text-slate-400 text-[11px] items-center">
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3 text-slate-500" />
                              Exp: {item.expiredDate}
                            </span>
                            <span className="flex items-center gap-1 text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                              <CheckCircle className="w-3 h-3" />
                              Scan Ok
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="text-right">
                            <p className="font-extrabold text-white text-sm">{formatNumber(item.qty)} pcs</p>
                            <p className="text-[10px] text-emerald-450 font-medium">Potong Stok</p>
                          </div>
                          <button
                            onClick={() => handleRemoveFromQueue(idx)}
                            className="p-1 text-slate-500 hover:text-rose-450 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer"
                            title="Hapus dari daftar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Bottom Actions */}
                <div className="p-5 border-t border-slate-800/60 bg-slate-950/40 rounded-b-xl space-y-4">
                  {outboundQueue.length > 0 && (
                    <div className="flex justify-between items-center text-xs text-slate-400">
                      <span>Total Kuantitas Keluar:</span>
                      <span className="font-extrabold text-white text-base">
                        {formatNumber(outboundQueue.reduce((sum, item) => sum + item.qty, 0))} pcs
                      </span>
                    </div>
                  )}
                  <button
                    disabled={outboundQueue.length === 0 || !effectiveOrderType}
                    onClick={handleFinalizeOutbound}
                    className={`w-full py-3.5 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                      outboundQueue.length === 0 || !effectiveOrderType
                        ? 'bg-slate-800/50 text-slate-600 shadow-none cursor-not-allowed' 
                        : 'bg-emerald-500 hover:bg-emerald-450 text-slate-950 shadow-emerald-500/20'
                    }`}
                  >
                    <Zap className="w-4 h-4 fill-current" />
                    SIMPAN & PROSES OUTBOUND CEPAT (POTONG STOK LANGSUNG)
                  </button>
                  <p className="text-[11px] text-center text-slate-500">
                    ⚡ Transaksi ini langsung menyelesaikan order dan memotong stok rak seketika tanpa antrean picking/packing.
                  </p>
                </div>
              </div>
            </div>
          </div>
          )}
        </div>
      )}

      {/* TAB 2: RIWAYAT OUTBOUND CEPAT (TERPISAH KHUSUS) */}
      {activeMainTab === 'history' && (
        <div className="space-y-6">
          {/* KPI Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#11141B] p-4 rounded-xl border border-slate-800/60 shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Transaksi</span>
                <span className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Zap className="w-4 h-4 fill-current" />
                </span>
              </div>
              <p className="text-2xl font-black text-white mt-2 font-mono">
                {formatNumber(historyStats.totalTransactions)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">Dokumen Outbound Cepat</p>
            </div>

            <div className="bg-[#11141B] p-4 rounded-xl border border-slate-800/60 shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Stok Terpotong</span>
                <span className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <CheckCircle className="w-4 h-4" />
                </span>
              </div>
              <p className="text-2xl font-black text-emerald-400 mt-2 font-mono">
                {formatNumber(historyStats.totalPcs)} <span className="text-xs font-normal text-slate-400">pcs</span>
              </p>
              <p className="text-[11px] text-slate-500 mt-1">Langsung terpotong dari rak</p>
            </div>

            <div className="bg-[#11141B] p-4 rounded-xl border border-slate-800/60 shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total SKU Terlibat</span>
                <span className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
                  <Layers className="w-4 h-4" />
                </span>
              </div>
              <p className="text-2xl font-black text-white mt-2 font-mono">
                {formatNumber(historyStats.totalSkus)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">Variasi SKU produk</p>
            </div>

            <div className="bg-[#11141B] p-4 rounded-xl border border-slate-800/60 shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Gudang Aktif</span>
                <span className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                  <Building2 className="w-4 h-4" />
                </span>
              </div>
              <p className="text-lg font-black text-white mt-2 truncate">
                {historyWarehouseFilter === 'all' 
                  ? 'Semua Gudang' 
                  : (availableWarehouses.find(w => w.id === historyWarehouseFilter)?.name || historyWarehouseFilter)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">Filter cabang / lokasi</p>
            </div>
          </div>

          {/* Filter Bar & Export */}
          <div className="bg-[#11141B] p-4 rounded-xl border border-slate-800/60 shadow-md flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
            <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              {/* Search input */}
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-3 text-slate-500" />
                <input
                  type="text"
                  placeholder="Cari No Dokumen, SKU ID, Nama Barang, Petugas, atau Rak..."
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-[#161B25] border border-slate-800 rounded-xl text-white outline-none focus:ring-2 focus:ring-emerald-500 placeholder:text-slate-600"
                />
              </div>

              {/* Date Filter */}
              <div className="flex items-center gap-1.5 shrink-0">
                <Clock className="w-4 h-4 text-slate-500 ml-1" />
                <select
                  value={historyDateFilter}
                  onChange={(e) => setHistoryDateFilter(e.target.value as any)}
                  className="px-3 py-2 text-xs font-bold bg-[#161B25] border border-slate-800 rounded-xl text-white outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  <option value="all">Semua Waktu</option>
                  <option value="today">Hari Ini</option>
                  <option value="7days">7 Hari Terakhir</option>
                  <option value="30days">30 Hari Terakhir</option>
                </select>
              </div>

              {/* Warehouse Filter */}
              <div className="flex items-center gap-1.5 shrink-0">
                <Building2 className="w-4 h-4 text-slate-500 ml-1" />
                <select
                  value={historyWarehouseFilter}
                  onChange={(e) => setHistoryWarehouseFilter(e.target.value)}
                  className="px-3 py-2 text-xs font-bold bg-[#161B25] border border-slate-800 rounded-xl text-white outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  <option value="all">Semua Gudang</option>
                  {availableWarehouses.map(wh => (
                    <option key={wh.id} value={wh.id}>
                      [{wh.code}] {wh.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Export CSV button */}
            <button
              type="button"
              onClick={handleExportHistoryCsv}
              className="px-4 py-2 bg-[#161B25] hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer shrink-0"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Export CSV</span>
            </button>
          </div>

          {/* History Table */}
          <div className="bg-[#11141B] rounded-xl border border-slate-800/60 shadow-md overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 text-[11px] uppercase tracking-wider font-bold">
                    <th className="py-3 px-4">Waktu Selesai</th>
                    <th className="py-3 px-4">No. Dokumen Outbound</th>
                    <th className="py-3 px-4">SKU & Nama Barang</th>
                    <th className="py-3 px-4">Lokasi Rak</th>
                    <th className="py-3 px-4">Exp Date</th>
                    <th className="py-3 px-4 text-right">Qty Keluar</th>
                    <th className="py-3 px-4">Gudang</th>
                    <th className="py-3 px-4">Petugas</th>
                    <th className="py-3 px-4 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {filteredQuickHistory.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-16 text-slate-500">
                        <History className="w-10 h-10 mx-auto stroke-1 mb-2 text-slate-600" />
                        <p className="text-sm font-bold text-slate-400">Belum Ada Riwayat Outbound Cepat</p>
                        <p className="text-xs text-slate-500 mt-1">
                          Transaksi yang diproses lewat tab "Input Outbound Cepat" akan otomatis tersimpan di sini.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    filteredQuickHistory.map((item, idx) => (
                      <tr key={item.id || idx} className="hover:bg-slate-800/20 transition-colors">
                        <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap">
                          {formatIsoDateTime(item.completedAt || item.timestamp)}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-lg text-xs">
                            <Zap className="w-3 h-3 fill-current shrink-0" />
                            {item.referenceNumber}
                          </span>
                          {item.batchNumber && (
                            <span className="block text-[10px] text-slate-500 mt-0.5 font-mono">
                              Batch: {item.batchNumber}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 max-w-[240px]">
                          <div className="font-mono font-bold text-white text-xs">{item.skuId}</div>
                          <div className="text-slate-400 text-[11px] line-clamp-1 mt-0.5">{item.skuName}</div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className="font-mono font-bold text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded">
                            {item.location}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap">
                          {item.expiredDate || '-'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-extrabold text-white text-sm whitespace-nowrap">
                          {formatNumber(item.qty)} <span className="text-[10px] font-normal text-slate-400">pcs</span>
                        </td>
                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                          {item.warehouseName || item.warehouseId || 'Gudang Pusat'}
                        </td>
                        <td className="py-3 px-4 text-slate-300 whitespace-nowrap">
                          {item.createdBy || item.pickedBy || item.packedBy || 'Operator'}
                        </td>
                        <td className="py-3 px-4 text-center whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle className="w-3 h-3" />
                            ✓ Stok Terpotong (Selesai Langsung)
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {filteredQuickHistory.length > 0 && (
              <div className="p-4 border-t border-slate-800/60 bg-slate-950/40 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  Menampilkan <strong>{filteredQuickHistory.length}</strong> transaksi Outbound Cepat
                </span>
                <span className="font-mono">
                  Total kuantitas: <strong className="text-emerald-400 font-bold">{formatNumber(historyStats.totalPcs)}</strong> pcs
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
