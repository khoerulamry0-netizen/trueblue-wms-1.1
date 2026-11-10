import React, { useState, useEffect, useMemo, useRef } from 'react';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { 
  X, 
  Printer, 
  QrCode, 
  Barcode, 
  Copy, 
  Check, 
  Sparkles, 
  Sliders, 
  Download, 
  Boxes, 
  Search, 
  CheckSquare, 
  Square, 
  RefreshCw, 
  Eye, 
  Plus, 
  Trash2, 
  Camera, 
  CheckCircle2, 
  AlertCircle
} from 'lucide-react';

export type BasketPaperSize = '50x30' | '70x40' | '100x50' | 'a4_grid';

export interface BasketItem {
  id: string;
  code: string;
  name: string;
  zone?: string;
  notes?: string;
}

interface BasketQrGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  initialPrefix?: string;
  suggestedCount?: number;
}

export default function BasketQrGenerator({
  isOpen,
  onClose,
  initialPrefix = 'BSK-',
  suggestedCount = 20
}: BasketQrGeneratorProps) {
  // Config state
  const [prefix, setPrefix] = useState(initialPrefix);
  const [startNum, setStartNum] = useState(1);
  const [count, setCount] = useState(suggestedCount);
  const [zoneTag, setZoneTag] = useState('GUDANG UTAMA');
  const [paperSize, setPaperSize] = useState<BasketPaperSize>('50x30');
  const [copiesPerItem, setCopiesPerItem] = useState(1);

  // Display toggles
  const [showBarcode, setShowBarcode] = useState(true);
  const [showQrCode, setShowQrCode] = useState(true);
  const [showZone, setShowZone] = useState(true);

  // Active items list
  const [baskets, setBaskets] = useState<BasketItem[]>(() => {
    const initialList: BasketItem[] = [];
    for (let i = 1; i <= suggestedCount; i++) {
      const code = `${initialPrefix}${String(i).padStart(2, '0')}`;
      initialList.push({
        id: `bsk-${code}`,
        code,
        name: `KERANJANG ${code}`,
        zone: 'GUDANG UTAMA',
        notes: 'Picking & Packing'
      });
    }
    return initialList;
  });

  const [selectedIds, setSelectedIds] = useState<{ [id: string]: boolean }>(() => {
    const map: { [id: string]: boolean } = {};
    for (let i = 1; i <= Math.min(10, suggestedCount); i++) {
      const code = `${initialPrefix}${String(i).padStart(2, '0')}`;
      map[`bsk-${code}`] = true;
    }
    return map;
  });

  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'generator' | 'tester'>('generator');

  // Single add manual form
  const [manualCode, setManualCode] = useState('');
  const [manualName, setManualName] = useState('');

  // Generated QR Data URLs
  const [qrUrls, setQrUrls] = useState<{ [id: string]: string }>({});

  // Scanner test state
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<{ match: boolean; item?: BasketItem; text: string } | null>(null);

  // Generate batch baskets helper
  const handleGenerateBatch = (pfx: string, start: number, total: number, zone: string) => {
    const newList: BasketItem[] = [];
    const newSelected: { [id: string]: boolean } = {};

    for (let i = 0; i < total; i++) {
      const num = start + i;
      const formattedNum = String(num).padStart(2, '0');
      const code = `${pfx}${formattedNum}`;
      const item: BasketItem = {
        id: `bsk-${code}-${Date.now() + i}`,
        code,
        name: `KERANJANG ${code}`,
        zone: zone || 'GUDANG UTAMA',
        notes: 'Picking & Packing Tote'
      };
      newList.push(item);
      newSelected[item.id] = true;
    }

    setBaskets(newList);
    setSelectedIds(newSelected);
  };

  // Add custom single basket
  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    const cleanCode = manualCode.trim().toUpperCase();
    const item: BasketItem = {
      id: `bsk-${cleanCode}-${Date.now()}`,
      code: cleanCode,
      name: manualName.trim().toUpperCase() || `KERANJANG ${cleanCode}`,
      zone: zoneTag || 'GUDANG UTAMA',
      notes: 'Custom Basket'
    };
    setBaskets(prev => [item, ...prev]);
    setSelectedIds(prev => ({ ...prev, [item.id]: true }));
    setManualCode('');
    setManualName('');
  };

  // Filtered baskets
  const filteredBaskets = useMemo(() => {
    if (!searchTerm.trim()) return baskets;
    const q = searchTerm.toLowerCase();
    return baskets.filter(b => b.code.toLowerCase().includes(q) || b.name.toLowerCase().includes(q));
  }, [baskets, searchTerm]);

  // Selected baskets for printing
  const itemsToPrint = useMemo(() => {
    return baskets.filter(b => selectedIds[b.id]);
  }, [baskets, selectedIds]);

  // Generate QR codes for selected items
  useEffect(() => {
    let isMounted = true;
    const generateQRs = async () => {
      const urls: { [id: string]: string } = {};
      for (const item of itemsToPrint) {
        try {
          // Standard payload: BASKET:BSK-01
          const payload = `BASKET:${item.code}`;
          const url = await QRCode.toDataURL(payload, {
            width: 180,
            margin: 1,
            color: { dark: '#000000', light: '#ffffff' }
          });
          urls[item.id] = url;
        } catch (e) {
          console.error("QR Code generation error", e);
        }
      }
      if (isMounted) {
        setQrUrls(urls);
      }
    };

    if (itemsToPrint.length > 0) {
      generateQRs();
    }

    return () => {
      isMounted = false;
    };
  }, [itemsToPrint]);

  // Render JsBarcode for preview cards
  useEffect(() => {
    itemsToPrint.forEach(item => {
      const el = document.getElementById(`basket-barcode-${item.id}`);
      if (el) {
        try {
          JsBarcode(el, item.code, {
            format: "CODE128",
            width: paperSize === '50x30' ? 1.4 : 2,
            height: paperSize === '50x30' ? 32 : 48,
            displayValue: true,
            fontSize: paperSize === '50x30' ? 10 : 12,
            textMargin: 1,
            margin: 1,
            font: "monospace"
          });
        } catch (e) {
          console.error("JsBarcode error for", item.code, e);
        }
      }
    });
  }, [itemsToPrint, paperSize, showBarcode]);

  // Render JsBarcode for print sheet
  useEffect(() => {
    itemsToPrint.forEach(item => {
      for (let c = 0; c < copiesPerItem; c++) {
        const el = document.getElementById(`basket-print-barcode-${item.id}-${c}`);
        if (el) {
          try {
            JsBarcode(el, item.code, {
              format: "CODE128",
              width: paperSize === '50x30' ? 1.2 : 1.8,
              height: paperSize === '50x30' ? 28 : 42,
              displayValue: true,
              fontSize: paperSize === '50x30' ? 9 : 11,
              textMargin: 1,
              margin: 1,
              font: "monospace"
            });
          } catch (e) {}
        }
      }
    });
  }, [itemsToPrint, copiesPerItem, paperSize, showBarcode]);

  // Toggle select all
  const handleToggleSelectAll = () => {
    const allSelected = filteredBaskets.every(b => selectedIds[b.id]);
    const updated = { ...selectedIds };
    filteredBaskets.forEach(b => {
      if (allSelected) {
        delete updated[b.id];
      } else {
        updated[b.id] = true;
      }
    });
    setSelectedIds(updated);
  };

  // Download single QR as PNG
  const handleDownloadQr = (item: BasketItem) => {
    const url = qrUrls[item.id];
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `QR-BASKET-${item.code}.png`;
    a.click();
  };

  // Test scan verification
  const handleTestScan = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = testInput.trim().toUpperCase();
    if (!raw) return;

    // Check payload: could be "BASKET:BSK-01" or "BSK-01"
    const cleaned = raw.replace(/^BASKET:/i, '').trim();
    const matched = baskets.find(b => b.code.toUpperCase() === cleaned || b.code.toUpperCase() === raw);

    if (matched) {
      setTestResult({
        match: true,
        item: matched,
        text: `✓ VALID: Keranjang terdeteksi! Kode "${matched.code}" (${matched.name}) terdaftar dalam sistem.`
      });
    } else {
      setTestResult({
        match: false,
        text: `⚠️ TIDAK DITEMUKAN: Kode "${raw}" belum terdaftar di daftar keranjang saat ini.`
      });
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-[#11141B] border border-slate-800 rounded-2xl w-full max-w-6xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden text-slate-200">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#161B25]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Boxes className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-white text-lg flex items-center gap-2">
                QR & Barcode Generator Keranjang (Basket / Tote)
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  Batch & Thermal Ready
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Buat dan cetak stiker QR code keranjang picking / tote gudang untuk batch order & pemilahan barang
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex bg-slate-900 border border-slate-800 rounded-xl p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('generator')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'generator' ? 'bg-amber-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Printer className="w-3.5 h-3.5" />
                Cetak & Buat
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('tester')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'tester' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Camera className="w-3.5 h-3.5" />
                Uji Scan QR
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors ml-2 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab 1: Tester View */}
        {activeTab === 'tester' && (
          <div className="p-6 overflow-y-auto max-h-[calc(92vh-120px)] bg-[#121620] space-y-6">
            <div className="max-w-xl mx-auto bg-[#161B25] border border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="text-center space-y-1">
                <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center mx-auto">
                  <Camera className="w-6 h-6" />
                </div>
                <h4 className="font-extrabold text-white text-base">Uji Validasi Scan QR Keranjang</h4>
                <p className="text-xs text-slate-400">
                  Arahkan scanner barcode fisik Anda atau ketik/paste payload QR untuk memverifikasi kecocokan data
                </p>
              </div>

              <form onSubmit={handleTestScan} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-300">Hasil Scan / Input Barcode:</label>
                  <input
                    type="text"
                    autoFocus
                    placeholder="Contoh: BASKET:BSK-01 atau BSK-01..."
                    value={testInput}
                    onChange={(e) => setTestInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm font-mono text-amber-300 outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl transition-all cursor-pointer shadow flex items-center justify-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  Verifikasi Kode Keranjang
                </button>
              </form>

              {testResult && (
                <div className={`p-4 rounded-xl border flex items-start gap-3 ${
                  testResult.match 
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' 
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}>
                  {testResult.match ? (
                    <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-5 h-5 shrink-0 text-rose-400 mt-0.5" />
                  )}
                  <div className="text-xs leading-relaxed space-y-1">
                    <p className="font-bold">{testResult.text}</p>
                    {testResult.item && (
                      <div className="text-[11px] text-slate-400 bg-black/30 p-2 rounded-lg font-mono">
                        <div>Kode: <strong>{testResult.item.code}</strong></div>
                        <div>Nama: <strong>{testResult.item.name}</strong></div>
                        <div>Area: <strong>{testResult.item.zone}</strong></div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Generator & Print View */}
        {activeTab === 'generator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 flex-1 overflow-hidden">
            
            {/* Left Column: Settings, Generator & Selector */}
            <div className="lg:col-span-5 border-r border-slate-800 p-4 space-y-4 overflow-y-auto max-h-[calc(92vh-120px)] bg-[#121620]">
              
              {/* Batch Presets */}
              <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800 space-y-2.5">
                <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Preset Cepat Penomoran Keranjang:
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleGenerateBatch('BSK-', 1, 10, zoneTag)}
                    className="p-2 rounded-lg bg-[#18202F] hover:bg-slate-800 border border-slate-800 text-left cursor-pointer transition-all"
                  >
                    <div className="text-xs font-bold text-white">BSK-01 s/d BSK-10</div>
                    <div className="text-[10px] text-slate-400">10 Keranjang Standar</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerateBatch('BSK-', 1, 20, zoneTag)}
                    className="p-2 rounded-lg bg-[#18202F] hover:bg-slate-800 border border-slate-800 text-left cursor-pointer transition-all"
                  >
                    <div className="text-xs font-bold text-white">BSK-01 s/d BSK-20</div>
                    <div className="text-[10px] text-slate-400">20 Keranjang Picking</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerateBatch('TOTE-', 1, 15, 'PACKING ZONE')}
                    className="p-2 rounded-lg bg-[#18202F] hover:bg-slate-800 border border-slate-800 text-left cursor-pointer transition-all"
                  >
                    <div className="text-xs font-bold text-white">TOTE-01 s/d TOTE-15</div>
                    <div className="text-[10px] text-slate-400">Tote Meja Packing</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerateBatch('BSK-', 1, 50, zoneTag)}
                    className="p-2 rounded-lg bg-[#18202F] hover:bg-slate-800 border border-slate-800 text-left cursor-pointer transition-all"
                  >
                    <div className="text-xs font-bold text-white">BSK-01 s/d BSK-50</div>
                    <div className="text-[10px] text-slate-400">50 Keranjang Gudang</div>
                  </button>
                </div>
              </div>

              {/* Custom Batch Range Configuration */}
              <div className="bg-[#161B25] p-3 rounded-xl border border-amber-500/30 space-y-2.5">
                <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-amber-400" />
                  Kustomisasi Batch Keranjang:
                </span>
                
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-400 block mb-1">Prefix / Awalan:</label>
                    <input
                      type="text"
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                      placeholder="BSK-"
                      className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded font-mono text-xs text-amber-300"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400 block mb-1">Nomor Mulai:</label>
                    <input
                      type="number"
                      min="1"
                      value={startNum}
                      onChange={(e) => setStartNum(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded font-mono text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400 block mb-1">Jumlah:</label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={count}
                      onChange={(e) => setCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                      className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded font-mono text-xs text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-slate-400 block mb-1">Label Lokasi / Zona (Opsional):</label>
                  <input
                    type="text"
                    value={zoneTag}
                    onChange={(e) => setZoneTag(e.target.value.toUpperCase())}
                    placeholder="Contoh: GUDANG UTAMA, MEJA PACKING, AREA TRANSIT"
                    className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-slate-200"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => handleGenerateBatch(prefix, startNum, count, zoneTag)}
                  className="w-full py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold text-xs rounded-lg transition-all cursor-pointer shadow flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Buat {count} Label Keranjang ({prefix}{String(startNum).padStart(2, '0')} - {prefix}{String(startNum + count - 1).padStart(2, '0')})
                </button>
              </div>

              {/* Format Kertas Label */}
              <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800 space-y-2">
                <div className="flex justify-between items-center text-xs font-bold text-slate-300">
                  <span className="flex items-center gap-1.5">
                    <Printer className="w-3.5 h-3.5 text-amber-400" />
                    Ukuran Kertas Thermal:
                  </span>
                  <span className="text-amber-400 font-mono text-[11px]">{paperSize}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {[
                    { id: '50x30', name: '50 x 30 mm', sub: 'Standar' },
                    { id: '70x40', name: '70 x 40 mm', sub: 'Medium' },
                    { id: '100x50', name: '100 x 50 mm', sub: 'Besar' },
                    { id: 'a4_grid', name: 'A4 Grid', sub: '24 Stiker' }
                  ].map(size => (
                    <button
                      key={size.id}
                      type="button"
                      onClick={() => setPaperSize(size.id as BasketPaperSize)}
                      className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                        paperSize === size.id
                          ? 'bg-amber-500/15 border-amber-500 text-amber-300 font-bold'
                          : 'bg-[#18202F] border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <div className="text-xs font-bold">{size.name}</div>
                      <div className="text-[9px] text-slate-500">{size.sub}</div>
                    </button>
                  ))}
                </div>

                <div className="pt-2 border-t border-slate-800/80 flex flex-wrap gap-2 text-xs">
                  <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                    <input
                      type="checkbox"
                      checked={showBarcode}
                      onChange={(e) => setShowBarcode(e.target.checked)}
                      className="rounded text-amber-500 focus:ring-0"
                    />
                    <span>1D Barcode</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                    <input
                      type="checkbox"
                      checked={showQrCode}
                      onChange={(e) => setShowQrCode(e.target.checked)}
                      className="rounded text-amber-500 focus:ring-0"
                    />
                    <span>QR Code</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                    <input
                      type="checkbox"
                      checked={showZone}
                      onChange={(e) => setShowZone(e.target.checked)}
                      className="rounded text-amber-500 focus:ring-0"
                    />
                    <span>Label Zona</span>
                  </label>
                </div>
              </div>

              {/* Selector & Search */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleToggleSelectAll}
                      className="flex items-center gap-1.5 text-xs text-amber-400 font-bold hover:underline cursor-pointer"
                    >
                      {filteredBaskets.every(b => selectedIds[b.id]) && filteredBaskets.length > 0 ? (
                        <CheckSquare className="w-4 h-4 text-amber-400" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-500" />
                      )}
                      Pilih Semua ({filteredBaskets.length})
                    </button>
                    <span className="text-[11px] text-slate-500">|</span>
                    <span className="text-xs font-extrabold text-amber-400 font-mono">
                      {itemsToPrint.length} Dipilih
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    <span>Rangkap:</span>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={copiesPerItem}
                      onChange={(e) => setCopiesPerItem(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-12 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-center text-white font-bold"
                    />
                  </div>
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Cari nomor keranjang (BSK-01)..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 bg-[#161B25] border border-slate-800 rounded-lg text-xs text-white placeholder:text-slate-500 outline-none focus:ring-1 focus:ring-amber-500"
                  />
                </div>

                {/* Basket List Checkboxes */}
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {filteredBaskets.map((b) => (
                    <div
                      key={b.id}
                      onClick={() => setSelectedIds(prev => ({ ...prev, [b.id]: !prev[b.id] }))}
                      className={`flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer transition-all ${
                        selectedIds[b.id]
                          ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                          : 'bg-[#161B25] border-slate-800/80 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <input
                          type="checkbox"
                          checked={!!selectedIds[b.id]}
                          onChange={() => {}}
                          className="rounded text-amber-500 focus:ring-0 pointer-events-none"
                        />
                        <span className="font-mono font-bold text-white">{b.code}</span>
                        <span className="text-slate-400 truncate text-[11px]">- {b.name}</span>
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono shrink-0 ml-2">{b.zone}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tambah Keranjang Khusus Manual */}
              <details className="bg-[#161B25] p-2.5 rounded-xl border border-slate-800/80 text-xs">
                <summary className="font-bold text-slate-300 cursor-pointer flex items-center justify-between">
                  <span>+ Tambah Keranjang Khusus (Single)</span>
                  <span className="text-[10px] text-amber-400">Buka Form</span>
                </summary>
                <form onSubmit={handleAddManual} className="mt-2.5 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      required
                      placeholder="Kode: BSK-VIP..."
                      value={manualCode}
                      onChange={(e) => setManualCode(e.target.value)}
                      className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded font-mono text-xs text-amber-300"
                    />
                    <input
                      type="text"
                      placeholder="Nama: Keranjang VIP..."
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                      className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-md font-bold text-xs cursor-pointer"
                  >
                    + Masukkan ke Daftar
                  </button>
                </form>
              </details>

            </div>

            {/* Right Column: Live Print Preview Canvas */}
            <div className="lg:col-span-7 p-4 bg-slate-950/90 flex flex-col justify-between overflow-y-auto max-h-[calc(92vh-120px)]">
              <div>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs font-bold text-slate-400 flex items-center gap-1.5">
                    <Eye className="w-4 h-4 text-amber-400" />
                    Pratinjau Cetak Thermal Keranjang ({itemsToPrint.length * copiesPerItem} Lembar Label)
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">
                    Ukuran: {paperSize === '50x30' ? '50x30 mm' : paperSize === '100x50' ? '100x50 mm' : paperSize === '70x40' ? '70x40 mm' : 'A4 Grid'}
                  </span>
                </div>

                {itemsToPrint.length === 0 ? (
                  <div className="bg-[#161B25] rounded-xl border border-dashed border-slate-800 p-12 text-center text-slate-500 space-y-2">
                    <Boxes className="w-8 h-8 mx-auto text-slate-600" />
                    <p className="text-sm font-semibold">Belum ada keranjang yang dipilih</p>
                    <p className="text-xs">Centang satu atau beberapa keranjang di panel kiri untuk melihat pratinjau cetak.</p>
                  </div>
                ) : (
                  <div className="space-y-4 max-h-[500px] overflow-y-auto p-2 bg-slate-900/50 rounded-xl border border-slate-800/80">
                    <div className={`grid gap-4 ${
                      paperSize === '50x30' 
                        ? 'grid-cols-1 sm:grid-cols-2' 
                        : paperSize === 'a4_grid' 
                        ? 'grid-cols-1 sm:grid-cols-3' 
                        : 'grid-cols-1'
                    }`}>
                      {itemsToPrint.map((item, idx) => (
                        <div
                          key={`${item.id}-${idx}`}
                          className={`bg-white text-black p-3 rounded-lg shadow-lg border border-slate-300 flex flex-col justify-between select-none relative transition-all ${
                            paperSize === '50x30' 
                              ? 'min-h-[170px] max-w-[280px]' 
                              : paperSize === '100x50' 
                              ? 'min-h-[210px] w-full' 
                              : 'min-h-[190px]'
                          }`}
                        >
                          {/* Label Header */}
                          <div className="border-b-2 border-black pb-1 flex justify-between items-start gap-1">
                            <div className="truncate">
                              <h4 className="font-extrabold text-sm tracking-tight uppercase leading-tight truncate text-black flex items-center gap-1.5">
                                {item.code}
                              </h4>
                              <span className="text-[10px] font-mono font-bold text-slate-700 block">
                                {item.name}
                              </span>
                            </div>
                            {showZone && item.zone && (
                              <div className="bg-black text-white px-1.5 py-0.5 rounded text-[8px] font-mono font-extrabold shrink-0">
                                {item.zone}
                              </div>
                            )}
                          </div>

                          {/* Barcode & QR Body */}
                          <div className="my-1.5 flex items-center justify-between gap-2">
                            {showBarcode && (
                              <div className="flex-1 text-center overflow-hidden">
                                <svg id={`basket-barcode-${item.id}`} className="mx-auto max-w-full"></svg>
                              </div>
                            )}
                            {showQrCode && qrUrls[item.id] && (
                              <div className="shrink-0 text-center border-l border-slate-300 pl-1.5">
                                <img
                                  src={qrUrls[item.id]}
                                  alt="QR"
                                  className={paperSize === '50x30' ? 'w-14 h-14' : 'w-18 h-18'}
                                />
                                <span className="text-[7.5px] font-mono text-slate-800 font-bold block">
                                  BASKET QR
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Label Footer */}
                          <div className="border-t border-black/80 pt-1 flex justify-between items-center text-[8.5px] font-mono font-bold text-black">
                            <span className="bg-amber-100 text-amber-900 px-1 rounded">TOTE PICKING</span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDownloadQr(item)}
                                className="text-[8px] text-blue-700 underline cursor-pointer hover:text-blue-900"
                                title="Download QR PNG"
                              >
                                PNG
                              </button>
                              <span className="text-slate-400">|</span>
                              <span className="text-[8px] text-slate-600 font-sans">WMS TRUEBLUE WMS</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Action Bar */}
              <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap justify-between items-center gap-3">
                <div className="text-xs text-slate-400">
                  Total label yang akan dicetak: <strong className="text-amber-400 font-mono">{itemsToPrint.length * copiesPerItem} label</strong>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-colors cursor-pointer"
                  >
                    Tutup
                  </button>
                  <button
                    type="button"
                    disabled={itemsToPrint.length === 0}
                    onClick={handlePrint}
                    className="px-6 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-extrabold text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all flex items-center gap-2 cursor-pointer"
                  >
                    <Printer className="w-4 h-4" />
                    Cetak {itemsToPrint.length * copiesPerItem} Label Thermal
                  </button>
                </div>
              </div>

            </div>

          </div>
        )}

      </div>

      {/* Hidden Print Container for Browser Print (Native CSS @media print) */}
      <div className="hidden print:block fixed inset-0 bg-white text-black z-[99999]">
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            body * { visibility: hidden !important; }
            .basket-print-container, .basket-print-container * { visibility: visible !important; }
            .basket-print-container { 
              position: absolute; 
              left: 0; 
              top: 0; 
              width: 100%; 
              padding: 0; 
              margin: 0; 
            }
            .basket-label-page {
              page-break-after: always;
              break-after: page;
              display: flex;
              flex-direction: column;
              justify-content: space-between;
              box-sizing: border-box;
              margin: 0 auto;
              padding: 2mm 3mm;
              ${paperSize === '50x30' ? 'width: 50mm; height: 30mm;' : paperSize === '100x50' ? 'width: 100mm; height: 50mm;' : paperSize === '70x40' ? 'width: 70mm; height: 40mm;' : 'width: 100%;'}
            }
          }
        `}} />
        <div className="basket-print-container">
          {itemsToPrint.map((item) => {
            return Array.from({ length: copiesPerItem }).map((_, cIdx) => (
              <div key={`print-${item.id}-${cIdx}`} className="basket-label-page text-black font-sans">
                {/* Print Header */}
                <div style={{ borderBottom: '1.5px solid black', paddingBottom: '1mm', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: paperSize === '50x30' ? '10pt' : '14pt', fontWeight: 'bold', textTransform: 'uppercase', lineHeight: 1.1 }}>
                      {item.code}
                    </div>
                    <div style={{ fontSize: paperSize === '50x30' ? '7pt' : '9pt', fontFamily: 'monospace', fontWeight: 'bold', color: '#333' }}>
                      {item.name}
                    </div>
                  </div>
                  {showZone && item.zone && (
                    <div style={{ backgroundColor: 'black', color: 'white', padding: '1px 4px', borderRadius: '2px', fontSize: '7.5pt', fontFamily: 'monospace', fontWeight: 'bold' }}>
                      {item.zone}
                    </div>
                  )}
                </div>

                {/* Print Barcode / QR */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '1mm 0' }}>
                  {showBarcode && (
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <svg id={`basket-print-barcode-${item.id}-${cIdx}`}></svg>
                    </div>
                  )}
                  {showQrCode && qrUrls[item.id] && (
                    <div style={{ marginLeft: '2mm', textAlign: 'center' }}>
                      <img
                        src={qrUrls[item.id]}
                        alt="QR"
                        style={{ width: paperSize === '50x30' ? '13mm' : '20mm', height: paperSize === '50x30' ? '13mm' : '20mm' }}
                      />
                    </div>
                  )}
                </div>

                {/* Print Footer */}
                <div style={{ borderTop: '1px solid black', paddingTop: '1mm', display: 'flex', justifyContent: 'space-between', fontSize: paperSize === '50x30' ? '6.5pt' : '8pt', fontFamily: 'monospace', fontWeight: 'bold' }}>
                  <span>TOTE / BASKET PICKING</span>
                  <span>WMS SYSTEM</span>
                </div>
              </div>
            ));
          })}
        </div>
      </div>

    </div>
  );
}
