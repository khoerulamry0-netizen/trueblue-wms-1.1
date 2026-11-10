import React, { useState, useEffect, useRef } from 'react';
import { StockItem, CatalogItem } from '../types';
import { formatNumber } from '../utils/calculations';
import { getBarcodeForSku } from '../data/barcodeMap';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { 
  Printer, 
  X, 
  QrCode, 
  Barcode, 
  MapPin, 
  Layers, 
  Check, 
  Sliders, 
  Copy, 
  Sparkles,
  FileText,
  Eye,
  RefreshCw,
  Search,
  CheckSquare,
  Square
} from 'lucide-react';

export type ThermalPaperSize = '50x30' | '100x50' | '70x40' | 'a4_grid';

export interface LabelItemData {
  id: string;
  type: 'product' | 'location';
  title: string;
  subtitle?: string;
  code: string;
  barcodeValue: string;
  location?: string;
  expDate?: string;
  category?: string;
  qtyPackInfo?: string;
  notes?: string;
}

interface ThermalLabelPrinterProps {
  isOpen: boolean;
  onClose: () => void;
  initialItems?: LabelItemData[];
  allStock?: StockItem[];
  allLocations?: string[];
  initialMode?: 'product' | 'location';
}

export default function ThermalLabelPrinter({
  isOpen,
  onClose,
  initialItems = [],
  allStock = [],
  allLocations = [],
  initialMode = 'product'
}: ThermalLabelPrinterProps) {
  const [labelType, setLabelType] = useState<'product' | 'location'>(initialMode);
  const [paperSize, setPaperSize] = useState<ThermalPaperSize>('50x30');
  const [copiesPerItem, setCopiesPerItem] = useState(1);
  const [showQrCode, setShowQrCode] = useState(true);
  const [showBarcode, setShowBarcode] = useState(true);
  const [showLocation, setShowLocation] = useState(true);
  const [showExpDate, setShowExpDate] = useState(true);
  const [showCategory, setShowCategory] = useState(true);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<{ [id: string]: boolean }>({});
  
  // Custom manual label creator
  const [manualTitle, setManualTitle] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualLoc, setManualLoc] = useState('');
  const [manualExp, setManualExp] = useState('');
  const [customItems, setCustomItems] = useState<LabelItemData[]>([]);

  // QR Code data URLs map
  const [qrCodeUrls, setQrCodeUrls] = useState<{ [key: string]: string }>({});

  // Initialize selected items from props
  useEffect(() => {
    if (initialItems.length > 0) {
      const initialMap: { [id: string]: boolean } = {};
      initialItems.forEach(item => {
        initialMap[item.id] = true;
      });
      setSelectedItemIds(initialMap);
      if (initialItems[0]?.type) {
        setLabelType(initialItems[0].type);
      }
    } else if (labelType === 'location' && allLocations.length > 0) {
      // Default select first 5 locations
      const initialMap: { [id: string]: boolean } = {};
      allLocations.slice(0, 8).forEach(loc => {
        initialMap[`loc-${loc}`] = true;
      });
      setSelectedItemIds(initialMap);
    }
  }, [isOpen, initialItems, allLocations]);

  // Derived available items based on labelType
  const availableItems: LabelItemData[] = React.useMemo(() => {
    if (customItems.length > 0) {
      return customItems;
    }

    if (labelType === 'product') {
      // Unique SKUs from stock
      const skuMap = new Map<string, LabelItemData>();
      allStock.forEach(stockItem => {
        const key = stockItem.skuId.toUpperCase();
        if (!skuMap.has(key)) {
          skuMap.set(key, {
            id: `prod-${stockItem.skuId}`,
            type: 'product',
            title: stockItem.skuName,
            subtitle: stockItem.skuId,
            code: stockItem.skuId,
            barcodeValue: getBarcodeForSku(stockItem.skuId) || stockItem.skuId,
            location: stockItem.location,
            expDate: stockItem.expiredDate,
            qtyPackInfo: `1 Ctn = ${stockItem.qtyCtnSize || 24} Pcs`,
            category: 'Produk Gudang'
          });
        }
      });
      return Array.from(skuMap.values());
    } else {
      // Location rack labels
      return allLocations.map(loc => ({
        id: `loc-${loc}`,
        type: 'location',
        title: `LOKASI RAK ${loc.toUpperCase()}`,
        subtitle: `Gudang Utama - Rak Penyimpanan`,
        code: loc.toUpperCase(),
        barcodeValue: loc.toUpperCase(),
        location: loc.toUpperCase(),
        notes: `Scan untuk Inbound / Putaway / Picking`
      }));
    }
  }, [labelType, allStock, allLocations, customItems]);

  const filteredItems = React.useMemo(() => {
    if (!searchTerm.trim()) return availableItems;
    const q = searchTerm.toLowerCase();
    return availableItems.filter(i => 
      i.title.toLowerCase().includes(q) || 
      i.code.toLowerCase().includes(q) || 
      (i.location && i.location.toLowerCase().includes(q))
    );
  }, [availableItems, searchTerm]);

  // Active items to print
  const itemsToPrint = React.useMemo(() => {
    return availableItems.filter(i => selectedItemIds[i.id]);
  }, [availableItems, selectedItemIds]);

  // Generate QR codes for all items to print
  useEffect(() => {
    let isMounted = true;
    const generateQRs = async () => {
      const urls: { [key: string]: string } = {};
      for (const item of itemsToPrint) {
        try {
          const qrData = item.type === 'location' 
            ? `LOC:${item.code}` 
            : `SKU:${item.code}|BAR:${item.barcodeValue}|EXP:${item.expDate || ''}`;
          const url = await QRCode.toDataURL(qrData, { 
            width: 160, 
            margin: 1, 
            color: { dark: '#000000', light: '#ffffff' } 
          });
          urls[item.id] = url;
        } catch (e) {
          console.error("QR Code gen error", e);
        }
      }
      if (isMounted) {
        setQrCodeUrls(urls);
      }
    };

    if (itemsToPrint.length > 0) {
      generateQRs();
    }

    return () => {
      isMounted = false;
    };
  }, [itemsToPrint]);

  // Render Barcodes via JsBarcode into canvas/svg
  useEffect(() => {
    itemsToPrint.forEach(item => {
      const el = document.getElementById(`barcode-svg-${item.id}`);
      if (el) {
        try {
          JsBarcode(el, item.barcodeValue || item.code, {
            format: "CODE128",
            width: paperSize === '50x30' ? 1.4 : 2,
            height: paperSize === '50x30' ? 35 : 55,
            displayValue: true,
            fontSize: paperSize === '50x30' ? 10 : 13,
            textMargin: 2,
            margin: 2,
            font: "monospace"
          });
        } catch (e) {
          console.error("Barcode gen error for", item.code, e);
        }
      }
    });
  }, [itemsToPrint, paperSize, showBarcode]);

  const handleToggleSelectAll = () => {
    const allSelected = filteredItems.every(i => selectedItemIds[i.id]);
    const updated = { ...selectedItemIds };
    filteredItems.forEach(i => {
      if (allSelected) {
        delete updated[i.id];
      } else {
        updated[i.id] = true;
      }
    });
    setSelectedItemIds(updated);
  };

  const handleAddManualLabel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim() || !manualTitle.trim()) return;

    const newItem: LabelItemData = {
      id: `manual-${Date.now()}`,
      type: labelType,
      title: manualTitle.trim().toUpperCase(),
      code: manualCode.trim().toUpperCase(),
      barcodeValue: manualCode.trim().toUpperCase(),
      location: manualLoc.trim().toUpperCase() || undefined,
      expDate: manualExp.trim() || undefined,
      category: 'Label Khusus'
    };

    setCustomItems(prev => [newItem, ...prev]);
    setSelectedItemIds(prev => ({ ...prev, [newItem.id]: true }));
    setManualTitle('');
    setManualCode('');
    setManualLoc('');
    setManualExp('');
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
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-white text-lg flex items-center gap-2">
                Cetak Label Barcode & Rak Gudang
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  Thermal Ready
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Generator label format thermal printer (50x30mm, 100x50mm, 70x40mm) & kertas stiker A4
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body: Left Control Panel + Right Live Print Preview */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 flex-1 overflow-hidden">
          
          {/* Left Panel: Settings & Item Selector */}
          <div className="lg:col-span-5 border-r border-slate-800 p-4 space-y-4 overflow-y-auto max-h-[calc(92vh-140px)] bg-[#121620]">
            
            {/* Mode Tab */}
            <div className="flex bg-[#18202F] p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => { setLabelType('product'); setSelectedItemIds({}); }}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  labelType === 'product'
                    ? 'bg-emerald-500 text-slate-950 font-extrabold shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Barcode className="w-3.5 h-3.5" />
                Label Produk / SKU
              </button>
              <button
                type="button"
                onClick={() => { setLabelType('location'); setSelectedItemIds({}); }}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  labelType === 'location'
                    ? 'bg-emerald-500 text-slate-950 font-extrabold shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <MapPin className="w-3.5 h-3.5" />
                Label Rak / Lokasi
              </button>
            </div>

            {/* Paper Size & Layout Options */}
            <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800 space-y-3">
              <div className="flex justify-between items-center text-xs font-bold text-slate-300">
                <span className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                  Format Kertas Label:
                </span>
                <span className="text-emerald-400 font-mono text-[11px]">{paperSize}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {[
                  { id: '50x30', name: '50 x 30 mm', sub: 'Standar SKU' },
                  { id: '100x50', name: '100 x 50 mm', sub: 'Rak / Karton' },
                  { id: '70x40', name: '70 x 40 mm', sub: 'Medium' },
                  { id: 'a4_grid', name: 'A4 Grid', sub: '24 Stiker' }
                ].map(size => (
                  <button
                    key={size.id}
                    type="button"
                    onClick={() => setPaperSize(size.id as ThermalPaperSize)}
                    className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                      paperSize === size.id
                        ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300 font-bold'
                        : 'bg-[#18202F] border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    <div className="text-xs font-bold">{size.name}</div>
                    <div className="text-[9px] text-slate-500">{size.sub}</div>
                  </button>
                ))}
              </div>

              {/* Elements Visibility Toggle */}
              <div className="pt-2 border-t border-slate-800/80 flex flex-wrap gap-2 text-xs">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                  <input
                    type="checkbox"
                    checked={showBarcode}
                    onChange={(e) => setShowBarcode(e.target.checked)}
                    className="rounded text-emerald-500 focus:ring-0"
                  />
                  <span>1D Barcode</span>
                </label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                  <input
                    type="checkbox"
                    checked={showQrCode}
                    onChange={(e) => setShowQrCode(e.target.checked)}
                    className="rounded text-emerald-500 focus:ring-0"
                  />
                  <span>QR Code</span>
                </label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                  <input
                    type="checkbox"
                    checked={showLocation}
                    onChange={(e) => setShowLocation(e.target.checked)}
                    className="rounded text-emerald-500 focus:ring-0"
                  />
                  <span>Lokasi Rak</span>
                </label>
                {labelType === 'product' && (
                  <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer bg-slate-900/60 px-2 py-1 rounded-md border border-slate-800">
                    <input
                      type="checkbox"
                      checked={showExpDate}
                      onChange={(e) => setShowExpDate(e.target.checked)}
                      className="rounded text-emerald-500 focus:ring-0"
                    />
                    <span>Exp Date</span>
                  </label>
                )}
              </div>
            </div>

            {/* Item Selection Header & Search */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleToggleSelectAll}
                    className="flex items-center gap-1.5 text-xs text-emerald-400 font-bold hover:underline cursor-pointer"
                  >
                    {filteredItems.every(i => selectedItemIds[i.id]) && filteredItems.length > 0 ? (
                      <CheckSquare className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-500" />
                    )}
                    Pilih Semua ({filteredItems.length})
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
                    max="50"
                    value={copiesPerItem}
                    onChange={(e) => setCopiesPerItem(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-12 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-center text-white font-bold"
                  />
                </div>
              </div>

              {/* Search Box */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder={labelType === 'product' ? 'Cari SKU / Nama Produk...' : 'Cari Nama Rak (Contoh: E3, TRANSIT)...'}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 bg-[#161B25] border border-slate-800 rounded-lg text-xs text-white placeholder:text-slate-500 outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              {/* Item List with Checkboxes */}
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {filteredItems.length === 0 ? (
                  <div className="text-center py-6 text-xs text-slate-500">
                    Tidak ada item yang sesuai pencarian.
                  </div>
                ) : (
                  filteredItems.map(item => {
                    const isChecked = !!selectedItemIds[item.id];
                    return (
                      <div
                        key={item.id}
                        onClick={() => setSelectedItemIds(prev => ({ ...prev, [item.id]: !isChecked }))}
                        className={`flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer transition-all ${
                          isChecked
                            ? 'bg-emerald-500/10 border-emerald-500/40 text-white'
                            : 'bg-[#161B25] border-slate-800/80 text-slate-400 hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {}} // handled by parent onClick
                            className="rounded text-emerald-500 focus:ring-0 shrink-0"
                          />
                          <div className="truncate">
                            <div className="font-bold truncate text-white flex items-center gap-1.5">
                              <span className="font-mono text-emerald-400">{item.code}</span>
                              <span className="truncate">{item.title}</span>
                            </div>
                            <div className="text-[10px] text-slate-500 flex items-center gap-2">
                              {item.location && <span>Rak: {item.location}</span>}
                              {item.expDate && <span>Exp: {item.expDate}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Quick Manual Label Input Accordion */}
            <details className="bg-[#161B25] rounded-xl border border-slate-800 p-3 text-xs group">
              <summary className="font-bold text-slate-300 cursor-pointer flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  + Buat Label Bebas / Custom
                </span>
                <span className="text-[10px] text-slate-500 group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <form onSubmit={handleAddManualLabel} className="mt-3 space-y-2 pt-2 border-t border-slate-800">
                <div>
                  <input
                    type="text"
                    required
                    placeholder="Judul / Nama Barang / Nama Rak..."
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-md text-xs text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    required
                    placeholder="Kode Barcode / SKU..."
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-md text-xs font-mono text-emerald-300"
                  />
                  <input
                    type="text"
                    placeholder="Lokasi Rak (Opsional)..."
                    value={manualLoc}
                    onChange={(e) => setManualLoc(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-md text-xs text-amber-300 font-mono"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded-md font-bold text-xs cursor-pointer"
                >
                  + Tambahkan ke Daftar Cetak
                </button>
              </form>
            </details>

          </div>

          {/* Right Panel: Live Print Preview Canvas */}
          <div className="lg:col-span-7 p-4 bg-slate-950/90 flex flex-col justify-between overflow-y-auto max-h-[calc(92vh-140px)]">
            
            <div>
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-bold text-slate-400 flex items-center gap-1.5">
                  <Eye className="w-4 h-4 text-emerald-400" />
                  Pratinjau Hasil Cetak Thermal ({itemsToPrint.length * copiesPerItem} Lembar Label)
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  Ukuran: {paperSize === '50x30' ? '50mm x 30mm' : paperSize === '100x50' ? '100mm x 50mm' : paperSize === '70x40' ? '70mm x 40mm' : 'A4 Multi-Sticker'}
                </span>
              </div>

              {itemsToPrint.length === 0 ? (
                <div className="bg-[#161B25] rounded-xl border border-dashed border-slate-800 p-12 text-center text-slate-500 space-y-2">
                  <Printer className="w-8 h-8 mx-auto text-slate-600" />
                  <p className="text-sm font-semibold">Belum ada label yang dipilih</p>
                  <p className="text-xs">Centang satu atau beberapa item di panel sebelah kiri untuk melihat pratinjau cetak.</p>
                </div>
              ) : (
                <div className="space-y-4 max-h-[480px] overflow-y-auto p-2 bg-slate-900/50 rounded-xl border border-slate-800/80">
                  
                  {/* Grid or List of Labels */}
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
                            ? 'min-h-[160px] max-w-[280px]' 
                            : paperSize === '100x50' 
                            ? 'min-h-[200px] w-full' 
                            : 'min-h-[180px]'
                        }`}
                      >
                        {/* Top Header of Label */}
                        <div className="border-b border-black/80 pb-1 flex justify-between items-start gap-1">
                          <div className="truncate">
                            <h4 className="font-extrabold text-xs tracking-tight uppercase leading-tight truncate text-black">
                              {item.title}
                            </h4>
                            <span className="text-[10px] font-mono font-bold text-black block">
                              {item.code}
                            </span>
                          </div>
                          {showLocation && item.location && (
                            <div className="bg-black text-white px-1.5 py-0.5 rounded text-[9px] font-mono font-extrabold shrink-0">
                              {item.location}
                            </div>
                          )}
                        </div>

                        {/* Middle Barcode & QR Body */}
                        <div className="my-1.5 flex items-center justify-between gap-2">
                          {showBarcode && (
                            <div className="flex-1 text-center overflow-hidden">
                              <svg id={`barcode-svg-${item.id}`} className="mx-auto max-w-full"></svg>
                            </div>
                          )}
                          {showQrCode && qrCodeUrls[item.id] && (
                            <div className="shrink-0 text-center border-l border-slate-200 pl-1.5">
                              <img
                                src={qrCodeUrls[item.id]}
                                alt="QR"
                                className={paperSize === '50x30' ? 'w-12 h-12' : 'w-16 h-16'}
                              />
                              <span className="text-[8px] font-mono text-slate-600 block">SCAN</span>
                            </div>
                          )}
                        </div>

                        {/* Bottom Footer Info */}
                        <div className="border-t border-black/60 pt-1 flex justify-between items-center text-[9px] font-mono font-bold text-black">
                          {showExpDate && item.expDate ? (
                            <span>EXP: {item.expDate}</span>
                          ) : (
                            <span>{item.qtyPackInfo || 'WMS STOK'}</span>
                          )}
                          <span className="text-[8px] text-slate-700 font-sans">
                            {item.type === 'location' ? 'RACK SHELF' : 'PROD ITEM'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                </div>
              )}
            </div>

            {/* Bottom Print Action Bar */}
            <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap justify-between items-center gap-3">
              <div className="text-xs text-slate-400">
                Total halaman cetak: <strong className="text-white font-mono">{itemsToPrint.length * copiesPerItem} label</strong>
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
                  className="px-6 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-extrabold text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition-all flex items-center gap-2 cursor-pointer"
                >
                  <Printer className="w-4 h-4" />
                  CETAK LABEL SEKARANG (PRINT)
                </button>
              </div>
            </div>

          </div>

        </div>

      </div>

      {/* Hidden Thermal Print Sheet (Rendered only on window.print()) */}
      <div className="hidden print:block fixed inset-0 bg-white text-black p-0 m-0 z-[99999]">
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            body * { visibility: hidden; }
            .thermal-print-container, .thermal-print-container * { visibility: visible; }
            .thermal-print-container { 
              position: absolute; 
              left: 0; 
              top: 0; 
              width: 100%; 
              padding: 0; 
              margin: 0; 
            }
            .thermal-label-page {
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
        <div className="thermal-print-container">
          {itemsToPrint.map((item) => {
            return Array.from({ length: copiesPerItem }).map((_, cIdx) => (
              <div key={`print-${item.id}-${cIdx}`} className="thermal-label-page text-black font-sans">
                {/* Header */}
                <div style={{ borderBottom: '1.5px solid black', paddingBottom: '1mm', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: paperSize === '50x30' ? '9pt' : '12pt', fontWeight: 'bold', textTransform: 'uppercase', lineHeight: 1.1 }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: paperSize === '50x30' ? '7pt' : '9pt', fontFamily: 'monospace', fontWeight: 'bold' }}>
                      {item.code}
                    </div>
                  </div>
                  {showLocation && item.location && (
                    <div style={{ backgroundColor: 'black', color: 'white', padding: '1px 4px', borderRadius: '2px', fontSize: '8pt', fontFamily: 'monospace', fontWeight: 'bold' }}>
                      {item.location}
                    </div>
                  )}
                </div>

                {/* Barcode / QR */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '1mm 0' }}>
                  {showBarcode && (
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <svg id={`barcode-print-svg-${item.id}-${cIdx}`}></svg>
                    </div>
                  )}
                  {showQrCode && qrCodeUrls[item.id] && (
                    <div style={{ marginLeft: '2mm' }}>
                      <img
                        src={qrCodeUrls[item.id]}
                        alt="QR"
                        style={{ width: paperSize === '50x30' ? '12mm' : '18mm', height: paperSize === '50x30' ? '12mm' : '18mm' }}
                      />
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div style={{ borderTop: '1px solid black', paddingTop: '1mm', display: 'flex', justifyContent: 'space-between', fontSize: paperSize === '50x30' ? '6.5pt' : '8pt', fontFamily: 'monospace', fontWeight: 'bold' }}>
                  <span>{showExpDate && item.expDate ? `EXP: ${item.expDate}` : (item.qtyPackInfo || 'WMS STOK')}</span>
                  <span>{item.type === 'location' ? 'RACK SHELF' : 'PROD ITEM'}</span>
                </div>
              </div>
            ));
          })}
        </div>
      </div>

    </div>
  );
}
