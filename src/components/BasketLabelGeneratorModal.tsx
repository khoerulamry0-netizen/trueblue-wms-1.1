import React, { useState, useEffect, useRef, useMemo } from 'react';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { 
  Printer, 
  X, 
  QrCode, 
  Barcode, 
  ShoppingBag, 
  Layers, 
  Sparkles, 
  Download, 
  Copy, 
  Check, 
  RefreshCw, 
  Plus, 
  Trash2, 
  CheckSquare, 
  Square,
  Eye,
  Sliders,
  FileText,
  Boxes,
  ArrowRight,
  Info,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

export type BasketPaperSize = '4x6_inch' | '4x6_cm';

export interface BasketItemData {
  id: string;
  basketNumber: string;
  warehouseName?: string;
  zoneInfo?: string;
  qrPayload?: string;
}

interface BasketLabelGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialBasketNumber?: string;
  activeBasketsFromOrders?: string[];
}

export default function BasketLabelGeneratorModal({
  isOpen,
  onClose,
  initialBasketNumber,
  activeBasketsFromOrders = []
}: BasketLabelGeneratorModalProps) {
  // Generation Mode: 'range' | 'manual' | 'orders'
  const [genMode, setGenMode] = useState<'range' | 'manual' | 'orders'>('range');

  // Range options
  const [prefix, setPrefix] = useState('B-');
  const [startNum, setStartNum] = useState(1);
  const [endNum, setEndNum] = useState(10);
  const [padDigits, setPadDigits] = useState<'2' | '3' | 'none'>('2');

  // Manual list
  const [manualText, setManualText] = useState('B-01\nB-02\nB-03\nB-04\nB-05');

  // Paper & layout options
  const [paperSize, setPaperSize] = useState<BasketPaperSize>('4x6_inch');
  const [showQrCode, setShowQrCode] = useState(true);
  const [showBarcode, setShowBarcode] = useState(true);
  const [showInstructions, setShowInstructions] = useState(true);
  const [showDate, setShowDate] = useState(true);
  const [copiesPerBasket, setCopiesPerBasket] = useState(1);
  
  // Warehouse & branding header
  const [warehouseTitle, setWarehouseTitle] = useState('GUDANG UTAMA');
  const [subtitle, setSubtitle] = useState('KERANJANG OPERASIONAL PICKING & PACKING');
  const [zoneNote, setZoneNote] = useState('SEMUA ZONA (ZONE A/B/C/D/E/F)');

  // Selected items to print
  const [selectedBaskets, setSelectedBaskets] = useState<string[]>([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);

  // Generated QR Data URLs: { basketNumber: dataUrl }
  const [qrUrls, setQrUrls] = useState<{ [key: string]: string }>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  // Printable container ref
  const printSheetRef = useRef<HTMLDivElement>(null);

  // Initialize from initialBasketNumber if provided
  useEffect(() => {
    if (initialBasketNumber && initialBasketNumber.trim() !== '') {
      const clean = initialBasketNumber.trim().toUpperCase();
      setManualText(clean);
      setGenMode('manual');
      setSelectedBaskets([clean]);
    }
  }, [initialBasketNumber, isOpen]);

  // Generate basket list based on mode
  const generatedBasketList: string[] = useMemo(() => {
    if (genMode === 'manual') {
      const lines = manualText
        .split(/[\n,;]+/)
        .map(s => s.trim().toUpperCase())
        .filter(s => s.length > 0);
      return Array.from(new Set(lines));
    }

    if (genMode === 'orders') {
      const valid = activeBasketsFromOrders
        .map(s => s.trim().toUpperCase())
        .filter(s => s.length > 0);
      return Array.from(new Set(valid));
    }

    // Range mode
    const start = Math.max(1, Math.min(startNum, endNum));
    const end = Math.max(start, Math.min(999, endNum));
    const list: string[] = [];

    for (let i = start; i <= end; i++) {
      let numStr = i.toString();
      if (padDigits === '2') {
        numStr = i.toString().padStart(2, '0');
      } else if (padDigits === '3') {
        numStr = i.toString().padStart(3, '0');
      }
      list.push(`${prefix.trim().toUpperCase()}${numStr}`);
    }

    return list;
  }, [genMode, prefix, startNum, endNum, padDigits, manualText, activeBasketsFromOrders]);

  // Sync selected baskets when generated list changes
  useEffect(() => {
    setSelectedBaskets(generatedBasketList);
    setActivePreviewIndex(0);
  }, [generatedBasketList]);

  // Generate QR Codes whenever generated list changes
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const generateAllQrs = async () => {
      const urls: { [key: string]: string } = {};
      for (const basket of generatedBasketList) {
        try {
          // Standard clean payload = basket number so standard barcode guns type it directly into packer input
          const url = await QRCode.toDataURL(basket, {
            width: 380,
            margin: 1,
            errorCorrectionLevel: 'M',
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          });
          urls[basket] = url;
        } catch (err) {
          console.error(`Error generating QR for ${basket}`, err);
        }
      }
      if (isMounted) {
        setQrUrls(urls);
      }
    };

    generateAllQrs();
    return () => {
      isMounted = false;
    };
  }, [isOpen, generatedBasketList]);

  // Render JsBarcode for preview SVGs
  useEffect(() => {
    if (!isOpen || !showBarcode) return;

    // Small delay to ensure DOM SVG elements are mounted
    const timer = setTimeout(() => {
      generatedBasketList.forEach((basket) => {
        const svgEl = document.getElementById(`preview-barcode-${basket}`);
        if (svgEl) {
          try {
            JsBarcode(svgEl, basket, {
              format: 'CODE128',
              width: 2.2,
              height: 48,
              displayValue: true,
              fontSize: 14,
              fontOptions: 'bold',
              font: 'monospace',
              margin: 4,
              background: '#ffffff',
              lineColor: '#000000'
            });
          } catch (e) {
            console.error('Barcode generation error for', basket, e);
          }
        }
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [isOpen, showBarcode, generatedBasketList, activePreviewIndex]);

  // Render Barcodes in Hidden Print Sheet before printing
  const preparePrintBarcodes = () => {
    const listToPrint = generatedBasketList.filter(b => selectedBaskets.includes(b));
    listToPrint.forEach((basket) => {
      for (let c = 0; c < copiesPerBasket; c++) {
        const svgEl = document.getElementById(`print-barcode-${basket}-${c}`);
        if (svgEl) {
          try {
            JsBarcode(svgEl, basket, {
              format: 'CODE128',
              width: paperSize === '4x6_inch' ? 2.6 : 1.6,
              height: paperSize === '4x6_inch' ? 55 : 30,
              displayValue: true,
              fontSize: paperSize === '4x6_inch' ? 16 : 10,
              fontOptions: 'bold',
              font: 'monospace',
              margin: 4,
              background: '#ffffff',
              lineColor: '#000000'
            });
          } catch (e) {
            console.error('Print barcode error for', basket, e);
          }
        }
      }
    });
  };

  const handlePrintAll = () => {
    preparePrintBarcodes();
    // Allow SVG render tick then trigger print
    setTimeout(() => {
      window.print();
    }, 250);
  };

  const handlePrintSingle = (basket: string) => {
    setSelectedBaskets([basket]);
    preparePrintBarcodes();
    setTimeout(() => {
      window.print();
    }, 250);
  };

  const handleCopyQrImage = async (basket: string, idx: number) => {
    const dataUrl = qrUrls[basket];
    if (!dataUrl) return;

    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      setCopiedIndex(idx);
      setTimeout(() => setCopiedIndex(null), 2500);
    } catch (e) {
      console.warn('Clipboard write failed, fallback to copy text', e);
      navigator.clipboard.writeText(basket);
      setCopiedIndex(idx);
      setTimeout(() => setCopiedIndex(null), 2500);
    }
  };

  const handleDownloadQr = (basket: string) => {
    const dataUrl = qrUrls[basket];
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `QR_LABEL_BASKET_${basket}.png`;
    a.click();
  };

  const toggleSelectBasket = (basket: string) => {
    setSelectedBaskets(prev => 
      prev.includes(basket) ? prev.filter(b => b !== basket) : [...prev, basket]
    );
  };

  const selectAllBaskets = () => {
    setSelectedBaskets([...generatedBasketList]);
  };

  const deselectAllBaskets = () => {
    setSelectedBaskets([]);
  };

  // Quick Preset Helper
  const applyPreset = (pPrefix: string, start: number, end: number, digits: '2' | '3' | 'none') => {
    setGenMode('range');
    setPrefix(pPrefix);
    setStartNum(start);
    setEndNum(end);
    setPadDigits(digits);
  };

  if (!isOpen) return null;

  const currentPreviewBasket = generatedBasketList[activePreviewIndex] || generatedBasketList[0] || 'B-01';
  const totalToPrintCount = selectedBaskets.length * copiesPerBasket;
  const todayDateStr = new Date().toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-[#0D1117] border border-slate-800 rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-150 flex flex-col my-4 max-h-[95vh]">
        
        {/* Modal Top Header */}
        <div className="bg-[#151922] px-5 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-md">
              <QrCode className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-extrabold text-white text-base tracking-wide flex items-center gap-2">
                  QR Generator & Cetak Label Keranjang / Basket
                </h3>
                <span className="text-[11px] bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-full font-black tracking-wider uppercase font-mono">
                  Ukuran Kertas 4x6
                </span>
                <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md font-bold">
                  {paperSize === '4x6_inch' ? 'Standard Thermal 4x6 Inci (100x150 mm)' : 'Mini Tag 4x6 CM (40x60 mm)'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Cetak label stiker barcode & QR Code keranjang picking untuk memudahkan staf picker & packer melacak order.
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-2 rounded-xl hover:bg-slate-800 cursor-pointer"
            title="Tutup Modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body: Left Controls & Right Visual Preview */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* LEFT COLUMN: Configuration Controls (5 Cols) */}
          <div className="lg:col-span-5 space-y-5">
            
            {/* 1. Generator Mode Selector */}
            <div className="bg-[#11141B] border border-slate-800 rounded-xl p-4 space-y-3 shadow-md">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Metode Pembuatan Nomor Basket
                </label>
                <span className="text-[11px] text-amber-400 font-mono font-bold">
                  {generatedBasketList.length} Label
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1.5 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setGenMode('range')}
                  className={`py-2 px-2 text-[11px] font-bold rounded-lg transition-all cursor-pointer text-center ${
                    genMode === 'range'
                      ? 'bg-amber-500 text-slate-950 shadow-md font-black'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  🔢 Urutan (Range)
                </button>
                <button
                  type="button"
                  onClick={() => setGenMode('manual')}
                  className={`py-2 px-2 text-[11px] font-bold rounded-lg transition-all cursor-pointer text-center ${
                    genMode === 'manual'
                      ? 'bg-amber-500 text-slate-950 shadow-md font-black'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  ✍️ Input Bebas
                </button>
                <button
                  type="button"
                  onClick={() => setGenMode('orders')}
                  className={`py-2 px-2 text-[11px] font-bold rounded-lg transition-all cursor-pointer text-center relative ${
                    genMode === 'orders'
                      ? 'bg-amber-500 text-slate-950 shadow-md font-black'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  📦 Dari Order
                  {activeBasketsFromOrders.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.2 bg-amber-400 text-slate-950 rounded-full text-[9px] font-mono">
                      {activeBasketsFromOrders.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Mode Specific Inputs */}
              {genMode === 'range' && (
                <div className="space-y-3 pt-2">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Prefix</label>
                      <input
                        type="text"
                        value={prefix}
                        onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                        placeholder="Contoh: B-"
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-750 focus:border-amber-500 rounded-lg text-white font-mono font-bold text-xs outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">No. Awal</label>
                      <input
                        type="number"
                        min="1"
                        max="999"
                        value={startNum}
                        onChange={(e) => setStartNum(parseInt(e.target.value) || 1)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-750 focus:border-amber-500 rounded-lg text-white font-mono font-bold text-xs outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">No. Akhir</label>
                      <input
                        type="number"
                        min="1"
                        max="999"
                        value={endNum}
                        onChange={(e) => setEndNum(parseInt(e.target.value) || 1)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-750 focus:border-amber-500 rounded-lg text-white font-mono font-bold text-xs outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Format Digit Angka</label>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => setPadDigits('2')}
                        className={`py-1.5 px-2 text-xs font-mono font-bold rounded-lg border cursor-pointer ${
                          padDigits === '2' ? 'bg-amber-500/20 text-amber-300 border-amber-500/50' : 'bg-slate-900 text-slate-400 border-slate-800'
                        }`}
                      >
                        01, 02.. (2 Digit)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPadDigits('3')}
                        className={`py-1.5 px-2 text-xs font-mono font-bold rounded-lg border cursor-pointer ${
                          padDigits === '3' ? 'bg-amber-500/20 text-amber-300 border-amber-500/50' : 'bg-slate-900 text-slate-400 border-slate-800'
                        }`}
                      >
                        001, 002.. (3 Digit)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPadDigits('none')}
                        className={`py-1.5 px-2 text-xs font-mono font-bold rounded-lg border cursor-pointer ${
                          padDigits === 'none' ? 'bg-amber-500/20 text-amber-300 border-amber-500/50' : 'bg-slate-900 text-slate-400 border-slate-800'
                        }`}
                      >
                        1, 2, 3.. (Polos)
                      </button>
                    </div>
                  </div>

                  {/* Preset Shortcut Buttons */}
                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1.5">Preset Cepat:</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => applyPreset('B-', 1, 10, '2')}
                        className="px-2.5 py-1 text-[10px] font-mono font-bold bg-slate-900 hover:bg-slate-800 text-amber-400 border border-slate-800 rounded-md cursor-pointer transition-colors"
                      >
                        B-01 s/d B-10
                      </button>
                      <button
                        type="button"
                        onClick={() => applyPreset('B-', 1, 20, '2')}
                        className="px-2.5 py-1 text-[10px] font-mono font-bold bg-slate-900 hover:bg-slate-800 text-amber-400 border border-slate-800 rounded-md cursor-pointer transition-colors"
                      >
                        B-01 s/d B-20
                      </button>
                      <button
                        type="button"
                        onClick={() => applyPreset('BSK-', 1, 30, '2')}
                        className="px-2.5 py-1 text-[10px] font-mono font-bold bg-slate-900 hover:bg-slate-800 text-amber-400 border border-slate-800 rounded-md cursor-pointer transition-colors"
                      >
                        BSK-01 s/d BSK-30
                      </button>
                      <button
                        type="button"
                        onClick={() => applyPreset('BASKET-', 1, 50, '2')}
                        className="px-2.5 py-1 text-[10px] font-mono font-bold bg-slate-900 hover:bg-slate-800 text-amber-400 border border-slate-800 rounded-md cursor-pointer transition-colors"
                      >
                        BASKET-01 s/d 50
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {genMode === 'manual' && (
                <div className="space-y-2 pt-2">
                  <label className="text-[10px] font-bold text-slate-400 uppercase block">
                    Daftar Nomor Basket (Pisahkan dengan baris baru atau koma)
                  </label>
                  <textarea
                    rows={4}
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    placeholder="Contoh:&#10;B-01&#10;B-02&#10;BSK-03&#10;TOTE-04"
                    className="w-full p-2.5 bg-slate-900 border border-slate-750 focus:border-amber-500 rounded-xl text-white font-mono text-xs outline-none"
                  />
                  <p className="text-[10px] text-slate-500">
                    Ketik nomor keranjang custom gudang Anda satu per baris.
                  </p>
                </div>
              )}

              {genMode === 'orders' && (
                <div className="space-y-2 pt-2">
                  <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs space-y-2">
                    <p className="text-slate-300">
                      Mengambil nomor basket fisik yang saat ini sedang aktif digunakan pada antrean pesanan outbound:
                    </p>
                    {activeBasketsFromOrders.length === 0 ? (
                      <p className="text-amber-400/90 font-mono text-[11px] italic">
                        Belum ada order pending yang menggunakan nomor basket. Silakan gunakan tab "Urutan (Range)" untuk mencetak nomor keranjang baru.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {activeBasketsFromOrders.map(b => (
                          <span key={b} className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 text-amber-300 rounded font-mono text-xs font-bold">
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 2. Paper & Layout Settings */}
            <div className="bg-[#11141B] border border-slate-800 rounded-xl p-4 space-y-4 shadow-md">
              <label className="text-xs font-black text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-amber-400" />
                Format Ukuran Kertas & Desain Label
              </label>

              {/* Paper size selector */}
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1.5">
                  Ukuran Kertas Thermal Printer
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPaperSize('4x6_inch')}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                      paperSize === '4x6_inch'
                        ? 'bg-amber-500/15 border-amber-500 text-amber-300 ring-1 ring-amber-500/30'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    <div className="font-extrabold text-xs flex items-center gap-1.5">
                      <span>4 x 6 Inci (Thermal Roll)</span>
                      {paperSize === '4x6_inch' && <Check className="w-3.5 h-3.5 text-amber-400" />}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                      100 x 150 mm / 102 x 152 mm (Standard Zebra/Xprinter)
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaperSize('4x6_cm')}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                      paperSize === '4x6_cm'
                        ? 'bg-amber-500/15 border-amber-500 text-amber-300 ring-1 ring-amber-500/30'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    <div className="font-extrabold text-xs flex items-center gap-1.5">
                      <span>4 x 6 CM (Label Mini)</span>
                      {paperSize === '4x6_cm' && <Check className="w-3.5 h-3.5 text-amber-400" />}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                      40 x 60 mm (Tag Kecil Keranjang)
                    </div>
                  </button>
                </div>
              </div>

              {/* Elements to include */}
              <div className="space-y-2 pt-1 border-t border-slate-800/80">
                <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
                  Komponen Kode & Identitas Label:
                </span>
                
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-2 p-2 bg-slate-900 border border-slate-800 rounded-lg cursor-pointer hover:border-slate-700">
                    <input
                      type="checkbox"
                      checked={showQrCode}
                      onChange={(e) => setShowQrCode(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700"
                    />
                    <div className="text-xs font-bold text-slate-200 flex items-center gap-1">
                      <QrCode className="w-3.5 h-3.5 text-amber-400" />
                      <span>QR Code (2D)</span>
                    </div>
                  </label>

                  <label className="flex items-center gap-2 p-2 bg-slate-900 border border-slate-800 rounded-lg cursor-pointer hover:border-slate-700">
                    <input
                      type="checkbox"
                      checked={showBarcode}
                      onChange={(e) => setShowBarcode(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700"
                    />
                    <div className="text-xs font-bold text-slate-200 flex items-center gap-1">
                      <Barcode className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Barcode 1D (Code128)</span>
                    </div>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <label className="flex items-center gap-2 p-2 bg-slate-900 border border-slate-800 rounded-lg cursor-pointer hover:border-slate-700">
                    <input
                      type="checkbox"
                      checked={showInstructions}
                      onChange={(e) => setShowInstructions(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700"
                    />
                    <span className="text-xs font-medium text-slate-300">
                      Petunjuk Operasional
                    </span>
                  </label>

                  <label className="flex items-center gap-2 p-2 bg-slate-900 border border-slate-800 rounded-lg cursor-pointer hover:border-slate-700">
                    <input
                      type="checkbox"
                      checked={showDate}
                      onChange={(e) => setShowDate(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700"
                    />
                    <span className="text-xs font-medium text-slate-300">
                      Tanggal Cetak
                    </span>
                  </label>
                </div>
              </div>

              {/* Text customizations */}
              <div className="space-y-2 pt-1 border-t border-slate-800/80">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Header Label</label>
                    <input
                      type="text"
                      value={warehouseTitle}
                      onChange={(e) => setWarehouseTitle(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-750 focus:border-amber-500 rounded-lg text-white font-bold text-xs outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Keterangan Zona</label>
                    <input
                      type="text"
                      value={zoneNote}
                      onChange={(e) => setZoneNote(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-750 focus:border-amber-500 rounded-lg text-white font-bold text-xs outline-none"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label className="text-[11px] font-bold text-slate-300">Jumlah Rangkap per Label:</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCopiesPerBasket(Math.max(1, copiesPerBasket - 1))}
                      className="w-7 h-7 bg-slate-800 hover:bg-slate-700 rounded-lg text-white font-bold flex items-center justify-center cursor-pointer"
                    >
                      -
                    </button>
                    <span className="font-mono font-black text-amber-400 text-sm w-6 text-center">
                      {copiesPerBasket}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCopiesPerBasket(copiesPerBasket + 1)}
                      className="w-7 h-7 bg-slate-800 hover:bg-slate-700 rounded-lg text-white font-bold flex items-center justify-center cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

            </div>

            {/* 3. Basket Selection Checklist (Accordion / Scroll) */}
            <div className="bg-[#11141B] border border-slate-800 rounded-xl p-4 space-y-3 shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-200 uppercase tracking-wider">
                  Daftar Keranjang ({selectedBaskets.length} / {generatedBasketList.length} Dipilih)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAllBaskets}
                    className="text-[10px] font-bold text-amber-400 hover:underline cursor-pointer"
                  >
                    Pilih Semua
                  </button>
                  <span className="text-slate-600">|</span>
                  <button
                    type="button"
                    onClick={deselectAllBaskets}
                    className="text-[10px] font-bold text-slate-400 hover:text-white cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              </div>

              <div className="max-h-40 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                {generatedBasketList.map((b, idx) => {
                  const isChecked = selectedBaskets.includes(b);
                  const isCurrentPreview = idx === activePreviewIndex;

                  return (
                    <div
                      key={b}
                      className={`flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                        isCurrentPreview 
                          ? 'border-amber-500/50 bg-amber-500/10 text-white' 
                          : 'border-slate-800/80 bg-slate-900/60 text-slate-300'
                      }`}
                    >
                      <label className="flex items-center gap-2 cursor-pointer flex-1">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectBasket(b)}
                          className="w-3.5 h-3.5 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700"
                        />
                        <span className="font-mono font-bold">{b}</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setActivePreviewIndex(idx)}
                        className={`text-[10px] px-2 py-0.5 rounded font-medium cursor-pointer ${
                          isCurrentPreview ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Pratinjau
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>

          {/* RIGHT COLUMN: Interactive 4x6 Label Visual Preview (7 Cols) */}
          <div className="lg:col-span-7 flex flex-col space-y-4">
            
            {/* Preview Toolbar */}
            <div className="bg-[#11141B] border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-md">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                  <Eye className="w-4 h-4 text-amber-400" />
                  Pratinjau Label 4x6:
                </span>
                <span className="font-mono font-black text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/25 text-xs">
                  {currentPreviewBasket}
                </span>
                <span className="text-[11px] text-slate-400">
                  ({activePreviewIndex + 1} dari {generatedBasketList.length})
                </span>
              </div>

              {/* Slider / Next / Prev */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={activePreviewIndex <= 0}
                  onClick={() => setActivePreviewIndex(prev => Math.max(0, prev - 1))}
                  className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  disabled={activePreviewIndex >= generatedBasketList.length - 1}
                  onClick={() => setActivePreviewIndex(prev => Math.min(generatedBasketList.length - 1, prev + 1))}
                  className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <div className="h-4 w-px bg-slate-800"></div>
                <button
                  type="button"
                  onClick={() => handleCopyQrImage(currentPreviewBasket, activePreviewIndex)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  title="Salin Gambar QR"
                >
                  {copiedIndex === activePreviewIndex ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Tersalin!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Salin QR</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadQr(currentPreviewBasket)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  title="Unduh Gambar QR PNG"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh PNG</span>
                </button>
              </div>
            </div>

            {/* The Real-Time 4x6 Label Sheet Render */}
            <div className="flex-1 bg-slate-950/60 rounded-2xl border border-slate-800/80 p-4 sm:p-6 flex items-center justify-center overflow-auto min-h-[460px]">
              
              {/* Simulated Thermal 4x6 Paper Canvas */}
              <div 
                className={`bg-white text-black rounded-lg shadow-2xl border-4 border-slate-200 p-5 flex flex-col justify-between transition-all select-none ${
                  paperSize === '4x6_inch'
                    ? 'w-[360px] h-[540px]' // Realistic 4x6 aspect ratio (2:3)
                    : 'w-[300px] h-[450px]'
                }`}
                style={{ fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
              >
                {/* 1. Header Warehouse Branding */}
                <div className="border-b-2 border-black pb-2.5 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-5 bg-black text-white rounded flex items-center justify-center font-black text-[10px]">
                        W
                      </div>
                      <h4 className="font-black text-xs uppercase tracking-wider text-black">
                        {warehouseTitle}
                      </h4>
                    </div>
                    <p className="text-[9px] font-bold tracking-tight text-neutral-800 mt-0.5">
                      {subtitle}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="inline-block bg-black text-white font-mono font-black text-[9px] px-2 py-0.5 rounded">
                      4x6 THERMAL
                    </span>
                    <p className="text-[8px] font-mono text-neutral-600 mt-0.5">
                      WMS TOTE
                    </p>
                  </div>
                </div>

                {/* 2. Main Giant Basket Identifier */}
                <div className="my-2 text-center bg-neutral-100 border-2 border-dashed border-neutral-400 rounded-xl p-2.5">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-neutral-600 block">
                    NOMOR KERANJANG / BASKET
                  </span>
                  <div className="text-3xl sm:text-4xl font-black font-mono tracking-tight text-black py-0.5">
                    {currentPreviewBasket}
                  </div>
                  <span className="inline-block bg-black text-white text-[9px] font-bold px-2 py-0.5 rounded-full font-mono uppercase">
                    {zoneNote}
                  </span>
                </div>

                {/* 3. High-Density QR Code & Barcode Section */}
                <div className="flex flex-col items-center justify-center my-1 space-y-2">
                  {showQrCode && qrUrls[currentPreviewBasket] ? (
                    <div className="flex flex-col items-center bg-white p-1 rounded-lg border border-neutral-300">
                      <img
                        src={qrUrls[currentPreviewBasket]}
                        alt={`QR Code for ${currentPreviewBasket}`}
                        className="w-36 h-36 object-contain"
                      />
                      <span className="text-[8px] font-bold tracking-wider text-neutral-700 uppercase mt-0.5">
                        SCAN UNTUK PICKER & PACKER
                      </span>
                    </div>
                  ) : showQrCode ? (
                    <div className="w-36 h-36 flex items-center justify-center bg-neutral-100 rounded-lg text-neutral-400 text-xs">
                      Membuat QR...
                    </div>
                  ) : null}

                  {showBarcode && (
                    <div className="w-full flex flex-col items-center pt-1">
                      <svg id={`preview-barcode-${currentPreviewBasket}`} className="max-w-full"></svg>
                    </div>
                  )}
                </div>

                {/* 4. Warehouse Operational Instructions */}
                {showInstructions && (
                  <div className="border border-neutral-300 bg-neutral-50 rounded-lg p-2 text-[9px] leading-tight text-neutral-800 space-y-0.5">
                    <div className="font-extrabold text-[9px] uppercase tracking-wider text-black flex items-center gap-1">
                      <span>📌 PETUNJUK KERJA STAF:</span>
                    </div>
                    <div>• <strong>Picker:</strong> Masukkan barang hasil ambil ke keranjang ini.</div>
                    <div>• <strong>Packer:</strong> Tembak barcode/QR keranjang untuk buka order.</div>
                    <div>• Kembalikan keranjang kosong ke area stasiun setelah selesai.</div>
                  </div>
                )}

                {/* 5. Footer Details */}
                <div className="border-t border-black/80 pt-1.5 flex items-center justify-between text-[8px] font-mono text-neutral-600">
                  <span>REF: {currentPreviewBasket}-WMS</span>
                  {showDate && <span>CETAK: {todayDateStr}</span>}
                  <span>STATUS: AKTIF</span>
                </div>

              </div>

            </div>

            {/* Bottom Actions Bar */}
            <div className="bg-[#11141B] border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xl">
              <div className="text-xs text-slate-300">
                <span>Siap Cetak: </span>
                <strong className="text-amber-400 font-mono text-sm">{selectedBaskets.length} Keranjang</strong>
                <span className="text-slate-500"> ({totalToPrintCount} Lembar 4x6)</span>
              </div>

              <div className="flex items-center gap-2.5 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => handlePrintSingle(currentPreviewBasket)}
                  className="flex-1 sm:flex-none px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer border border-slate-700 active:scale-95"
                  title="Cetak khusus 1 lembar label yang sedang dilihat saat ini"
                >
                  <Printer className="w-3.5 h-3.5 text-amber-400" />
                  <span>Cetak Ini Saja</span>
                </button>

                <button
                  type="button"
                  disabled={selectedBaskets.length === 0}
                  onClick={handlePrintAll}
                  className={`flex-1 sm:flex-none px-6 py-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer ${
                    selectedBaskets.length === 0
                      ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                      : 'bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 shadow-amber-500/20 active:scale-95'
                  }`}
                >
                  <Printer className="w-4 h-4 fill-current" />
                  <span>Cetak Semua Label 4x6 ({selectedBaskets.length})</span>
                </button>
              </div>
            </div>

          </div>

        </div>

      </div>

      {/* HIDDEN PRINT SHEET (Rendered only on window.print() via CSS media query) */}
      <div 
        ref={printSheetRef}
        id="basket-print-sheet"
        className="hidden print:block fixed inset-0 bg-white text-black p-0 m-0 z-[999999]"
      >
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            @page {
              size: ${paperSize === '4x6_inch' ? '4in 6in' : '40mm 60mm'};
              margin: 0;
            }
            html, body {
              width: ${paperSize === '4x6_inch' ? '4in' : '40mm'} !important;
              height: ${paperSize === '4x6_inch' ? '6in' : '60mm'} !important;
              margin: 0 !important;
              padding: 0 !important;
              background: white !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              overflow: hidden !important;
            }
            body * {
              visibility: hidden !important;
            }
            #basket-print-sheet,
            #basket-print-sheet * {
              visibility: visible !important;
            }
            #basket-print-sheet {
              position: absolute !important;
              left: 0 !important;
              top: 0 !important;
              width: 100% !important;
              margin: 0 !important;
              padding: 0 !important;
            }
            .basket-print-page {
              page-break-after: always !important;
              break-after: page !important;
              display: flex !important;
              flex-direction: column !important;
              justify-content: space-between !important;
              box-sizing: border-box !important;
              margin: 0 !important;
              padding: ${paperSize === '4x6_inch' ? '0.35in 0.3in' : '2mm 3mm'} !important;
              width: ${paperSize === '4x6_inch' ? '4in' : '40mm'} !important;
              height: ${paperSize === '4x6_inch' ? '6in' : '60mm'} !important;
              max-width: ${paperSize === '4x6_inch' ? '4in' : '40mm'} !important;
              max-height: ${paperSize === '4x6_inch' ? '6in' : '60mm'} !important;
              background: white !important;
              color: black !important;
            }
          }
        `}} />

        <div className="basket-print-container">
          {generatedBasketList
            .filter(b => selectedBaskets.includes(b))
            .map((basket) => {
              return Array.from({ length: copiesPerBasket }).map((_, cIdx) => (
                <div 
                  key={`print-page-${basket}-${cIdx}`} 
                  className="basket-print-page font-sans text-black"
                >
                  {/* Top Header */}
                  <div style={{ borderBottom: '2px solid black', paddingBottom: paperSize === '4x6_inch' ? '6px' : '2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: paperSize === '4x6_inch' ? '14pt' : '8pt', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {warehouseTitle}
                      </div>
                      <div style={{ fontSize: paperSize === '4x6_inch' ? '8pt' : '5pt', fontWeight: 'bold', color: '#333' }}>
                        {subtitle}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ backgroundColor: 'black', color: 'white', padding: '1px 5px', borderRadius: '3px', fontSize: paperSize === '4x6_inch' ? '9pt' : '6pt', fontFamily: 'monospace', fontWeight: 'bold' }}>
                        4x6
                      </span>
                    </div>
                  </div>

                  {/* Giant Basket Identifier */}
                  <div style={{ textAlign: 'center', margin: paperSize === '4x6_inch' ? '10px 0' : '3px 0', border: '2px dashed #444', borderRadius: '8px', padding: paperSize === '4x6_inch' ? '8px' : '3px', backgroundColor: '#f7f7f7' }}>
                    <div style={{ fontSize: paperSize === '4x6_inch' ? '9pt' : '6pt', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px', color: '#555' }}>
                      NOMOR KERANJANG / BASKET
                    </div>
                    <div style={{ fontSize: paperSize === '4x6_inch' ? '32pt' : '15pt', fontWeight: '900', fontFamily: 'monospace', lineHeight: 1.1 }}>
                      {basket}
                    </div>
                    <div style={{ fontSize: paperSize === '4x6_inch' ? '8pt' : '5pt', fontWeight: 'bold', textTransform: 'uppercase', color: '#222' }}>
                      {zoneNote}
                    </div>
                  </div>

                  {/* QR & Barcode Section */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', margin: '4px 0' }}>
                    {showQrCode && qrUrls[basket] && (
                      <div style={{ textAlign: 'center', marginBottom: paperSize === '4x6_inch' ? '6px' : '2px' }}>
                        <img
                          src={qrUrls[basket]}
                          alt="QR"
                          style={{
                            width: paperSize === '4x6_inch' ? '1.85in' : '20mm',
                            height: paperSize === '4x6_inch' ? '1.85in' : '20mm',
                            display: 'block',
                            margin: '0 auto'
                          }}
                        />
                        <div style={{ fontSize: paperSize === '4x6_inch' ? '7pt' : '4.5pt', fontWeight: 'bold', textTransform: 'uppercase', marginTop: '2px' }}>
                          SCAN UNTUK PICKER & PACKER
                        </div>
                      </div>
                    )}

                    {showBarcode && (
                      <div style={{ textAlign: 'center', width: '100%' }}>
                        <svg id={`print-barcode-${basket}-${cIdx}`} style={{ margin: '0 auto', maxWidth: '100%' }}></svg>
                      </div>
                    )}
                  </div>

                  {/* Instructions */}
                  {showInstructions && (
                    <div style={{ border: '1px solid #777', borderRadius: '4px', padding: paperSize === '4x6_inch' ? '6px' : '2px', fontSize: paperSize === '4x6_inch' ? '7.5pt' : '5pt', lineHeight: 1.25, backgroundColor: '#fcfcfc', color: '#111' }}>
                      <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>📌 PETUNJUK KERJA:</div>
                      <div>• Picker: Masukkan barang pesanan ke keranjang ini.</div>
                      <div>• Packer: Tembak QR / barcode keranjang untuk proses packing.</div>
                      <div>• Kembalikan keranjang kosong ke area stasiun setelah selesai.</div>
                    </div>
                  )}

                  {/* Footer */}
                  <div style={{ borderTop: '1.5px solid black', paddingTop: paperSize === '4x6_inch' ? '4px' : '2px', display: 'flex', justifyContent: 'space-between', fontSize: paperSize === '4x6_inch' ? '7pt' : '5pt', fontFamily: 'monospace', fontWeight: 'bold', color: '#333' }}>
                    <span>REF: {basket}</span>
                    {showDate && <span>CETAK: {todayDateStr}</span>}
                    <span>WMS BASKET</span>
                  </div>

                </div>
              ));
            })}
        </div>
      </div>

    </div>
  );
}
