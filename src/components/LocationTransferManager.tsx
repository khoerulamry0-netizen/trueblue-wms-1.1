import React, { useState, useMemo, useRef } from 'react';
import { StockItem, DccLog } from '../types';
import { formatNumber } from '../utils/calculations';
import * as XLSX from 'xlsx';
import HistoryTransfer from './HistoryTransfer';
import { 
  ArrowLeftRight, 
  MapPin, 
  Search, 
  UploadCloud, 
  CheckCircle, 
  AlertTriangle, 
  DownloadCloud, 
  Layers, 
  MoveRight,
  Package,
  History,
  X,
  FileSpreadsheet,
  Plus
} from 'lucide-react';

interface LocationTransferManagerProps {
  stock: StockItem[];
  logs: DccLog[];
  onBulkInternalTransfer?: (items: {
    skuId: string;
    qty: number;
    expiredDate: string;
    fromLocation: string;
    toLocation: string;
    warehouseId?: string;
    refNo?: string;
    operator?: string;
  }[]) => boolean;
  currentUser: { username: string; role: string; fullName: string } | null;
  onEditTransferLog?: (updatedLog: DccLog, oldLog: DccLog) => boolean;
  onDeleteTransferLog?: (log: DccLog) => boolean;
  onClearAllTransferLogs?: () => Promise<boolean> | void;
}

export default function LocationTransferManager({ 
  stock, 
  logs, 
  onBulkInternalTransfer,
  currentUser,
  onEditTransferLog,
  onDeleteTransferLog,
  onClearAllTransferLogs
}: LocationTransferManagerProps) {
  const [activeTab, setActiveTab] = useState<'manual' | 'bulk' | 'history'>('manual');

  // Manual Transfer State
  const [fromLoc, setFromLoc] = useState('');
  const [toLoc, setToLoc] = useState('');
  const [searchManual, setSearchManual] = useState('');
  const [cart, setCart] = useState<{skuId: string, skuName: string, expiredDate: string, warehouseId?: string, maxQty: number, qty: number}[]>([]);
  
  // Bulk State
  const [inputText, setInputText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Locations derived from stock
  const allLocations = useMemo(() => {
    const locs = new Set<string>();
    stock.forEach(s => { if(s.location) locs.add(s.location); });
    return Array.from(locs).sort();
  }, [stock]);

  // Available stock in selected 'fromLoc'
  const sourceStock = useMemo(() => {
    if (!fromLoc) return [];
    let items = stock.filter(s => s.location === fromLoc && s.qty > 0);
    if (searchManual) {
      const q = searchManual.toLowerCase();
      items = items.filter(s => s.skuId.toLowerCase().includes(q) || s.skuName.toLowerCase().includes(q));
    }
    return items;
  }, [stock, fromLoc, searchManual]);

  const sanitizeLocation = (val: string) => val.trim().toUpperCase();

  const addToCart = (item: StockItem) => {
    const existing = cart.find(c => c.skuId === item.skuId && c.expiredDate === item.expiredDate && (c.warehouseId || 'WH-CENTRAL') === (item.warehouseId || 'WH-CENTRAL'));
    if (existing) {
      alert('SKU ini sudah ada di daftar transfer. Silakan sesuaikan Qty-nya.');
      return;
    }
    setCart([...cart, {
      skuId: item.skuId,
      skuName: item.skuName,
      expiredDate: item.expiredDate,
      warehouseId: item.warehouseId,
      maxQty: item.qty,
      qty: 1
    }]);
  };

  const updateCartQty = (idx: number, val: number) => {
    const newCart = [...cart];
    if (val > newCart[idx].maxQty) val = newCart[idx].maxQty;
    if (val < 1) val = 1;
    newCart[idx].qty = val;
    setCart(newCart);
  };

  const removeCartItem = (idx: number) => {
    setCart(cart.filter((_, i) => i !== idx));
  };

  const processManualTransfer = () => {
    if (!onBulkInternalTransfer) return;
    if (!toLoc) {
      alert('Pilih lokasi tujuan terlebih dahulu!');
      return;
    }
    if (fromLoc === toLoc) {
      alert('Lokasi asal dan tujuan tidak boleh sama!');
      return;
    }
    
    const payload = cart.map(c => ({
      skuId: c.skuId,
      qty: c.qty,
      expiredDate: c.expiredDate,
      fromLocation: fromLoc,
      toLocation: toLoc,
      warehouseId: c.warehouseId,
      operator: currentUser?.fullName || 'Operator'
    }));

    const success = onBulkInternalTransfer(payload);
    if (success) {
      alert('Transfer manual berhasil diproses!');
      setCart([]);
      setSearchManual('');
    }
  };

  // --- Bulk Transfer Logic ---
  const handleDownloadTemplate = () => {
    const wb = XLSX.utils.book_new();
    const wsData = [
      ['Lokasi Asal', 'Lokasi Tujuan', 'SKU ID', 'Qty (Pcs)']
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 10 }];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, 'Template_Transfer_Antar_Lokasi.xlsx');
  };

  const parsedBulkRows = useMemo(() => {
    if (!inputText.trim()) return [];
    const rows = inputText.split('\n');
    return rows.map((row, index) => {
      if (!row.trim()) return null;
      const cols = row.split(/\t|,|;/);
      if (cols.length < 3) return null;
      
      const rFromLoc = sanitizeLocation(cols[0] || '');
      const rToLoc = sanitizeLocation(cols[1] || '');
      const rSkuId = (cols[2] || '').trim().toUpperCase();
      const rQty = parseInt((cols[3] || '0').replace(/[^0-9]/g, ''), 10) || 0;
      
      // Validation
      let isValid = true;
      let error = '';
      let matchedStock = stock.find(s => s.skuId === rSkuId && s.location === rFromLoc);
      
      if (!rFromLoc || !rToLoc || !rSkuId) {
        isValid = false;
        error = 'Data tidak lengkap';
      } else if (rFromLoc === rToLoc) {
        isValid = false;
        error = 'Lokasi sama';
      } else if (rQty <= 0) {
        isValid = false;
        error = 'Qty tidak valid';
      } else if (!matchedStock) {
        isValid = false;
        error = 'Stok tidak ditemukan di lokasi asal';
      } else if (matchedStock.qty < rQty) {
        isValid = false;
        error = `Stok kurang (Tersedia: ${matchedStock.qty})`;
      }

      return {
        fromLocation: rFromLoc,
        toLocation: rToLoc,
        skuId: rSkuId,
        qty: rQty,
        isValid,
        error,
        originalIndex: index,
        matchedStock
      };
    }).filter(Boolean) as any[];
  }, [inputText, stock]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json<any>(ws, { header: 1 });
        
        let text = '';
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          if (row && row.length >= 3) {
            text += `${row[0]}\t${row[1]}\t${row[2]}\t${row[3] || 1}\n`;
          }
        }
        setInputText(text);
      } catch (err) {
        alert('Gagal membaca file Excel.');
      }
    };
    reader.readAsBinaryString(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const processBulkTransfer = () => {
    if (!onBulkInternalTransfer) return;
    const validRows = parsedBulkRows.filter(r => r.isValid);
    if (validRows.length === 0) {
      alert('Tidak ada baris yang valid untuk diproses!');
      return;
    }

    const payload = validRows.map(r => ({
      skuId: r.skuId,
      qty: r.qty,
      expiredDate: r.matchedStock.expiredDate,
      fromLocation: r.fromLocation,
      toLocation: r.toLocation,
      warehouseId: r.matchedStock.warehouseId,
      operator: currentUser?.fullName || 'Operator'
    }));

    const success = onBulkInternalTransfer(payload);
    if (success) {
      alert(`Berhasil memproses ${validRows.length} transfer massal!`);
      setInputText('');
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-[#11141B] rounded-2xl border border-slate-800/60 p-4 sm:p-5 shadow-lg relative overflow-hidden">
        <div className="absolute top-0 right-0 p-32 bg-emerald-500/5 blur-[100px] rounded-full pointer-events-none"></div>
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between relative z-10">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-3">
              <ArrowLeftRight className="w-6 h-6 text-emerald-400" />
              Transfer Antar Lokasi
            </h1>
            <p className="text-slate-400 text-xs sm:text-sm mt-1">
              Pindahkan stok antar rak atau gudang secara cepat dan real-time.
            </p>
          </div>
          
          <div className="flex bg-[#161B25] p-1 rounded-xl border border-slate-800/60">
            <button 
              onClick={() => setActiveTab('manual')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'manual' ? 'bg-emerald-500/10 text-emerald-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Transfer Cepat
            </button>
            <button 
              onClick={() => setActiveTab('bulk')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'bulk' ? 'bg-emerald-500/10 text-emerald-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Import Massal
            </button>
            <button 
              onClick={() => setActiveTab('history')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'history' ? 'bg-emerald-500/10 text-emerald-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Riwayat
            </button>
          </div>
        </div>
      </div>

      {/* Tip Transfer Antar Lokasi */}
      <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-between gap-3 text-xs text-indigo-300">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-indigo-400 shrink-0" />
          <span><strong>Transfer Antar Lokasi:</strong> Pindahkan stok antar rak atau sub-lokasi internal (termasuk Rak aktif, ZONE 1, URBAN, Display) secara fleksibel dan real-time.</span>
        </div>
      </div>

      {activeTab === 'manual' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          
          {/* Kiri: Pilih Sumber & Cari Stok */}
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-[#11141B] rounded-2xl border border-slate-800/60 p-4 sm:p-5 shadow-lg">
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                <div className="flex-1">
                  <label className="text-[11px] font-bold text-emerald-400 uppercase block mb-1">
                    Lokasi Asal
                  </label>
                  <select
                    value={fromLoc}
                    onChange={(e) => setFromLoc(e.target.value)}
                    className="w-full bg-[#161B25] border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">-- Pilih Lokasi --</option>
                    {allLocations.map(loc => (
                      <option key={loc} value={loc}>{loc}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 relative">
                  <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">
                    Cari SKU / Nama
                  </label>
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-[32px]" />
                  <input
                    type="text"
                    placeholder="Masukkan kata kunci..."
                    value={searchManual}
                    onChange={(e) => setSearchManual(e.target.value)}
                    className="w-full bg-[#161B25] border border-slate-700 text-white text-sm rounded-xl pl-9 pr-3 py-2.5 outline-none focus:ring-1 focus:ring-emerald-500"
                    disabled={!fromLoc}
                  />
                </div>
              </div>

              <div className="border border-slate-800/60 rounded-xl overflow-hidden bg-[#161B25] min-h-[300px] flex flex-col">
                <div className="bg-slate-900/50 px-3 py-2 border-b border-slate-800/60 flex items-center justify-between text-xs font-bold text-slate-400">
                  <span>Stok Tersedia ({sourceStock.length})</span>
                </div>
                <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[400px]">
                  {!fromLoc ? (
                    <div className="text-center text-slate-500 py-10 text-sm">
                      <MapPin className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      Pilih Lokasi Asal terlebih dahulu
                    </div>
                  ) : sourceStock.length === 0 ? (
                    <div className="text-center text-slate-500 py-10 text-sm">
                      Tidak ada stok di lokasi ini
                    </div>
                  ) : (
                    sourceStock.map(s => (
                      <div key={s.id} className="bg-[#11141B] border border-slate-800 p-3 rounded-lg flex items-center justify-between group hover:border-emerald-500/30 transition-colors">
                        <div>
                          <div className="font-mono font-bold text-emerald-400 text-xs">{s.skuId}</div>
                          <div className="text-white text-sm font-semibold truncate max-w-[200px] sm:max-w-[300px]">{s.skuName}</div>
                          <div className="text-slate-400 text-xs mt-0.5">Tersedia: <strong className="text-white">{s.qty}</strong> pcs</div>
                        </div>
                        <button
                          onClick={() => addToCart(s)}
                          className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-emerald-500 text-slate-300 hover:text-slate-950 flex items-center justify-center transition-all shadow-sm"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Kanan: Keranjang Transfer & Destinasi */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-[#11141B] rounded-2xl border border-slate-800/60 p-4 sm:p-5 shadow-lg flex flex-col h-full">
              
              <div className="mb-4">
                <label className="text-[11px] font-bold text-emerald-400 uppercase block mb-1">
                  Ke Lokasi Tujuan
                </label>
                <input
                  type="text"
                  placeholder="Scan atau ketik lokasi (ex: RAK-B02)"
                  value={toLoc}
                  onChange={(e) => setToLoc(sanitizeLocation(e.target.value))}
                  className="w-full bg-[#161B25] border border-emerald-500/50 text-white font-mono text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
                />
              </div>

              <div className="flex-1 flex flex-col border border-slate-800/60 rounded-xl overflow-hidden bg-[#161B25] mb-4">
                <div className="bg-slate-900/50 px-3 py-2 border-b border-slate-800/60 flex items-center justify-between text-xs font-bold text-slate-400">
                  <span>Item Dipilih ({cart.length})</span>
                </div>
                <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[300px]">
                  {cart.length === 0 ? (
                    <div className="text-center text-slate-500 py-10 text-sm">
                      <Layers className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      Belum ada item ditambahkan
                    </div>
                  ) : (
                    cart.map((c, idx) => (
                      <div key={idx} className="bg-[#11141B] border border-slate-800 p-3 rounded-lg flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-mono font-bold text-slate-300 text-[10px]">{c.skuId}</div>
                          <div className="text-white text-xs font-semibold truncate">{c.skuName}</div>
                          <div className="text-[10px] text-slate-500">Max: {c.maxQty}</div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <input 
                            type="number"
                            min={1}
                            max={c.maxQty}
                            value={c.qty}
                            onChange={(e) => updateCartQty(idx, parseInt(e.target.value) || 1)}
                            className="w-14 bg-slate-950 border border-slate-700 text-white font-bold text-center text-xs py-1 rounded"
                          />
                          <button onClick={() => removeCartItem(idx)} className="p-1 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 rounded">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <button
                onClick={processManualTransfer}
                disabled={cart.length === 0 || !toLoc}
                className={`w-full py-3.5 rounded-xl text-sm font-extrabold flex items-center justify-center gap-2 transition-all shadow-md ${
                  cart.length > 0 && toLoc 
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 cursor-pointer'
                    : 'bg-slate-800/50 text-slate-500 cursor-not-allowed'
                }`}
              >
                <MoveRight className="w-5 h-5" />
                PINDAHKAN STOK
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'bulk' && (
        <div className="bg-[#11141B] rounded-2xl border border-slate-800/60 p-4 sm:p-5 shadow-lg space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-white font-bold text-sm">Import Massal</h2>
              <p className="text-xs text-slate-400">Copy paste dari Excel atau upload file.</p>
            </div>
            <div className="flex gap-2">
              <input 
                type="file" 
                accept=".xlsx,.xls,.csv" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                className="hidden" 
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                Upload Excel
              </button>
              <button
                onClick={handleDownloadTemplate}
                className="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                <DownloadCloud className="w-3.5 h-3.5" />
                Template
              </button>
            </div>
          </div>

          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={`LokasiAsal\tLokasiTujuan\tSKU\tQty\nRAK-A\tRAK-B\tSKU01\t50`}
            className="w-full h-40 bg-[#161B25] border border-slate-800 text-slate-300 text-sm font-mono p-4 rounded-xl outline-none focus:ring-1 focus:ring-emerald-500 resize-none whitespace-pre"
          />

          {parsedBulkRows.length > 0 && (
            <div className="space-y-3">
              <div className="flex justify-between items-center px-1">
                <span className="text-xs font-bold text-slate-400">Pratinjau Data ({parsedBulkRows.length} baris)</span>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1.5 pr-2">
                {parsedBulkRows.map((r, i) => (
                  <div key={i} className={`p-2 rounded-lg border text-xs flex justify-between items-center ${r.isValid ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-rose-500/5 border-rose-500/20'}`}>
                    <div className="flex gap-4">
                      <span className="font-mono text-slate-300"><span className="text-amber-400">{r.fromLocation}</span> → <span className="text-emerald-400">{r.toLocation}</span></span>
                      <span className="font-mono font-bold text-white">{r.skuId}</span>
                      <span className="text-slate-400">Qty: {r.qty}</span>
                    </div>
                    {r.isValid ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <div className="flex items-center gap-1 text-rose-400">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="text-[10px]">{r.error}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <button
                onClick={processBulkTransfer}
                disabled={!parsedBulkRows.some(r => r.isValid)}
                className={`w-full py-3 rounded-xl text-sm font-extrabold flex items-center justify-center gap-2 transition-all shadow-md ${
                  parsedBulkRows.some(r => r.isValid)
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 cursor-pointer'
                    : 'bg-slate-800/50 text-slate-500 cursor-not-allowed'
                }`}
              >
                PROSES SEMUA ({parsedBulkRows.filter(r => r.isValid).length} Valid)
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <HistoryTransfer 
          logs={logs}
          currentUser={currentUser}
          onEditTransferLog={onEditTransferLog}
          onDeleteTransferLog={onDeleteTransferLog}
          onClearAllTransferLogs={onClearAllTransferLogs}
        />
      )}

    </div>
  );
}
