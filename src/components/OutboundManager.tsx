import React, { useState, useMemo, useEffect } from 'react';
import { StockItem, OutboundItem, Warehouse } from '../types';
import { findSkuId, getBarcodeForSku } from '../data/barcodeMap';
import { formatNumber, getStatusBadgeClass, isStockPickable, getAvailableStockPool } from '../utils/calculations';
import OrderFileImport from './OrderFileImport';
import { 
  Scan, 
  Plus, 
  MapPin, 
  Calendar, 
  AlertTriangle, 
  CheckCircle, 
  ShoppingCart, 
  Trash2, 
  Volume2, 
  HelpCircle, 
  ArrowRight,
  PackageCheck,
  Zap,
  Tag,
  Upload,
  FileSpreadsheet
} from 'lucide-react';

interface OutboundManagerProps {
  stock: StockItem[];
  orderHistory?: OutboundItem[];
  warehouses?: Warehouse[];
  onProcessOutbound: (items: Omit<OutboundItem, 'id' | 'timestamp'>[]) => Promise<boolean>;
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

export default function OutboundManager({ stock, orderHistory = [], warehouses = [], onProcessOutbound }: OutboundManagerProps) {
  const [refNumber, setRefNumber] = useState(`OUT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`);
  const [batchNumber, setBatchNumber] = useState('');
  const [activeSubTab, setActiveSubTab] = useState<'scan' | 'import'>('scan');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>(() => warehouses?.[0]?.id || 'WH-CENTRAL');

  const availableWarehouses = useMemo(() => {
    return warehouses && warehouses.length > 0
      ? warehouses
      : [{ id: 'WH-CENTRAL', name: 'Gudang Pusat', code: 'CENTRAL', address: '-', isMain: true }];
  }, [warehouses]);

  useEffect(() => {
    if (!selectedWarehouseId || !availableWarehouses.some(w => w.id === selectedWarehouseId)) {
      setSelectedWarehouseId(availableWarehouses[0]?.id || 'WH-CENTRAL');
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

  // Add current selected line item to draft outbound queue
  const handleAddToQueue = (e: React.FormEvent) => {
    e.preventDefault();
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
      alert(`Stok tidak mencukupi! Tersedia sisa ${availableLimit} pcs di lokasi ${selectedLine.location} (termasuk antrean draft).`);
      return;
    }

    // Append to queue as Pending Draft Order so it passes server scan validation & enters Picking/Packing queue cleanly
    const activeWhObj = availableWarehouses.find(w => w.id === selectedWarehouseId);
    const queueItem: Omit<OutboundItem, 'id' | 'timestamp'> = {
      referenceNumber: refNumber,
      batchNumber: batchNumber.trim() || undefined,
      skuId: selectedLine.skuId,
      skuName: selectedLine.skuName,
      expiredDate: selectedLine.expiredDate,
      qty: outboundQty,
      location: selectedLine.location,
      scanned: false,
      warehouseId: selectedLine.warehouseId || selectedWarehouseId || 'WH-CENTRAL',
      warehouseName: selectedLine.warehouseName || activeWhObj?.name || 'Gudang Pusat',
      picked: false,
      status: 'Pending'
    };

    setOutboundQueue([...outboundQueue, queueItem]);
    triggerBeep();

    // Reset input states
    setScannedSkuId('');
    setMatchedStockLines([]);
    setSelectedLine(null);
    setOutboundQty(0);
    setScanningMessage('✓ Item ditambahkan ke daftar validasi outbound.');
  };

  const handleRemoveFromQueue = (index: number) => {
    const updated = [...outboundQueue];
    updated.splice(index, 1);
    setOutboundQueue(updated);
  };

  const handleFinalizeOutbound = async () => {
    if (outboundQueue.length === 0) {
      alert('Daftar validasi outbound masih kosong.');
      return;
    }

    if(!await onProcessOutbound(outboundQueue))return;
    setOutboundQueue([]);
    // Regenerate ref number
    setRefNumber(`OUT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`);
    alert('✓ Sukses! Data outbound berhasil divalidasi dan stok dikurangi secara real-time.');
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

  return (
    <div className="space-y-6">
      {/* Upper Reference Header */}
      <div className="bg-[#11141B] rounded-xl p-4 border border-slate-800/60 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">No. Dokumen Outbound</span>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-mono font-bold text-lg text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-lg">
                {refNumber}
              </span>
              <button
                onClick={() => setRefNumber(`OUT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`)}
                className="text-xs font-semibold text-emerald-450 hover:text-emerald-400 underline bg-transparent border-none cursor-pointer"
              >
                Ubah No. Doc
              </button>
            </div>
          </div>

          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Gudang Sumber</span>
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
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Nomor Batch (Opsional)</span>
            <input
              type="text"
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              placeholder="Misal: BATCH-QC-01"
              className="mt-1 px-3 py-1.5 text-xs font-bold font-mono bg-[#161B25] border border-slate-800 rounded-lg text-white outline-none focus:ring-2 focus:ring-emerald-500 w-48 placeholder:text-slate-600"
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

      {/* Sub Tab Switcher: Scan Satuan vs Import Massal */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
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
          <span>Scan / Input Cepat</span>
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
          <span>Import Massal File (Excel / CSV)</span>
        </button>
      </div>

      {activeSubTab === 'import' ? (
        <OrderFileImport
          stock={stock}
          orderHistory={orderHistory}
          warehouseId={selectedWarehouseId}
        />
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
              <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Ditembak Manual / Input Manual SKU Barcode</label>
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
                Papan Simulasi Fisik (Klik Barcode)
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
                Validasi Lokasi & Kuantitas Outbound
              </h3>

              <form onSubmit={handleAddToQueue} className="space-y-4">
                <div className="bg-[#161B25] rounded-xl p-3 border border-slate-800">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Barang Terpilih</p>
                  <h4 className="font-bold text-white mt-1">{selectedLine.skuName}</h4>
                  <p className="text-xs text-slate-400 mt-0.5 font-mono">SKU ID: {selectedLine.skuId}</p>
                </div>

                {/* Location Picker with stock availability */}
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1.5">Pilih Lokasi Pengambilan</label>
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
                  className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-450 text-slate-950 font-extrabold rounded-xl text-sm flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-500/10 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Masukkan ke Daftar Outbound
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
                <ShoppingCart className="w-5 h-5 text-indigo-400" />
                Daftar Validasi Barang Outbound ({outboundQueue.length})
              </h3>
              <span className="text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-1 rounded-full font-bold animate-pulse-soft">
                Draf Keranjang
              </span>
            </div>

            {/* Queue items list */}
            <div className="p-4 flex-1 overflow-y-auto max-h-[380px] divide-y divide-slate-800/60">
              {outboundQueue.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-20 text-slate-500 h-full">
                  <ShoppingCart className="w-12 h-12 stroke-1 mb-2 animate-bounce text-slate-600" />
                  <p className="text-sm font-bold text-slate-400">Daftar Validasi Outbound Kosong</p>
                  <p className="text-xs text-slate-500 mt-1 max-w-[280px]">
                    Scan atau masukkan SKU ID produk di sebelah kiri untuk melunasi validasi barang keluar.
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
                        <p className="text-[10px] text-slate-550 font-medium">Valid</p>
                      </div>
                      <button
                        onClick={() => handleRemoveFromQueue(idx)}
                        className="p-1 text-slate-500 hover:text-rose-450 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer"
                        title="Hapus dari draf"
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
                  <span>Total Produk Keluar:</span>
                  <span className="font-extrabold text-white text-base">
                    {formatNumber(outboundQueue.reduce((sum, item) => sum + item.qty, 0))} pcs
                  </span>
                </div>
              )}
              <button
                disabled={outboundQueue.length === 0}
                onClick={handleFinalizeOutbound}
                className={`w-full py-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer ${outboundQueue.length === 0 ? 'bg-slate-800/50 text-slate-600 shadow-none cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-450 text-slate-950 shadow-emerald-500/10'}`}
              >
                <CheckCircle className="w-4 h-4" />
                DUKUNG & PROSES OUTBOUND (SIMPAN STOK)
              </button>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
