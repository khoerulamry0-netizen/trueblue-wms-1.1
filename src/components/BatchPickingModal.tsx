import React, { useState, useMemo } from 'react';
import { OutboundItem, StockItem, Warehouse, WarehousePickingRouteConfig, PickingRoutePattern } from '../types';
import { formatNumber, getProductPackSizes, isZoneOrUrbanLocation } from '../utils/calculations';
import { findSkuId, getBarcodeForSku } from '../data/barcodeMap';
import { getWarehouseRouteScore, describeRouteConfig, DEFAULT_TRUEBLUE_ROUTE_CONFIG } from '../utils/warehouseRouting';
import BasketQrGenerator from './BasketQrGenerator';
export { getWarehouseRouteScore } from '../utils/warehouseRouting';
import { 
  Package, 
  MapPin, 
  CheckCircle, 
  Printer, 
  X, 
  Layers, 
  Navigation, 
  CheckSquare, 
  Square, 
  Barcode, 
  Calendar, 
  Boxes, 
  ArrowRight,
  TrendingUp,
  Search,
  Sparkles,
  RotateCcw,
  Check,
  Building2
} from 'lucide-react';

export interface BatchPickingOrderGroup {
  referenceNumber: string;
  customerName?: string;
  items: OutboundItem[];
  isPicked?: boolean;
  totalQty: number;
}

export interface ConsolidatedPickItem {
  id: string;
  skuId: string;
  skuName: string;
  location: string;
  expiredDate: string;
  totalQty: number;
  qtyCtnSize: number;
  qtyPackSize: number;
  barcode: string;
  orderBreakdowns: {
    referenceNumber: string;
    customerName?: string;
    qty: number;
  }[];
}

interface BatchPickingModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderHistory: OutboundItem[];
  allStock: StockItem[];
  warehouses?: Warehouse[];
  selectedWarehouseId?: string;
  onCompleteBatchPicking?: (referenceNumbers: string[]) => Promise<boolean>;
}

export default function BatchPickingModal({
  isOpen,
  onClose,
  orderHistory,
  allStock,
  warehouses,
  selectedWarehouseId,
  onCompleteBatchPicking
}: BatchPickingModalProps) {
  // Pilihan Warehouse aktif untuk alur rute picking
  const [activeWhId, setActiveWhId] = useState<string>(() => selectedWarehouseId || warehouses?.[0]?.id || 'WH-CENTRAL');
  const activeWarehouse = useMemo(() => {
    return warehouses?.find(w => w.id === activeWhId) || warehouses?.[0];
  }, [warehouses, activeWhId]);

  const effectiveRouteConfig = useMemo(() => {
    return activeWarehouse?.pickingRouteConfig || DEFAULT_TRUEBLUE_ROUTE_CONFIG;
  }, [activeWarehouse]);
  // 1. Group ONLY unpicked / pending orders from orderHistory (completed/picked orders will not appear here)
  const orderGroups = useMemo(() => {
    const groupMap = new Map<string, BatchPickingOrderGroup>();

    orderHistory.forEach(item => {
      // Must only include orders with Pending status
      if (item.status !== 'Pending') return;

      const ref = item.referenceNumber || 'DRAFT-ORDER';
      const isItemPicked = Boolean(item.picked || item.isPicked);

      if (!groupMap.has(ref)) {
        groupMap.set(ref, {
          referenceNumber: ref,
          customerName: item.customerName,
          items: [],
          isPicked: isItemPicked,
          totalQty: 0
        });
      }
      const grp = groupMap.get(ref)!;
      grp.items.push(item);
      grp.totalQty += item.qty;
      if (!isItemPicked) {
        grp.isPicked = false;
      }
    });

    // Only return orders that have NOT yet been fully picked
    return Array.from(groupMap.values()).filter(g => !g.isPicked);
  }, [orderHistory]);

  // Selected order references to include in the batch picking wave
  const [selectedOrders, setSelectedOrders] = useState<{ [ref: string]: boolean }>({});
  const [pickedItemKeys, setPickedItemKeys] = useState<{ [key: string]: boolean }>({});
  const [scanInput, setScanInput] = useState('');
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState<'unpicked' | 'verified' | 'all'>('unpicked');
  const [showBasketQrGenerator, setShowBasketQrGenerator] = useState(false);

  // Initialize selected orders with all unpicked / pending orders
  React.useEffect(() => {
    if (isOpen) {
      const initMap: { [ref: string]: boolean } = {};
      orderGroups.forEach(g => {
        initMap[g.referenceNumber] = true;
      });
      setSelectedOrders(initMap);
      setPickedItemKeys({});
      setScanInput('');
      setFilterTab('unpicked');
    }
  }, [isOpen, orderGroups]);

  // Selected orders array
  const activeOrderGroups = useMemo(() => {
    return orderGroups.filter(g => selectedOrders[g.referenceNumber]);
  }, [orderGroups, selectedOrders]);

  // 2. Consolidate items across all selected orders & Sort by Warehouse Route (Aisle / Bay / Level)
  const consolidatedRouteList: ConsolidatedPickItem[] = useMemo(() => {
    const itemMap = new Map<string, ConsolidatedPickItem>();

    activeOrderGroups.forEach(grp => {
      grp.items.forEach(item => {
        // Unique consolidated picking key: Warehouse + SKU + Location + ExpDate
        const whKey = (item.warehouseId || 'WH-CENTRAL').toUpperCase();
        const key = `${whKey}__${item.skuId.toUpperCase()}__${item.location.toUpperCase()}__${item.expiredDate}`;
        
        if (!itemMap.has(key)) {
          const pack = getProductPackSizes(item.skuId);
          itemMap.set(key, {
            id: key,
            skuId: item.skuId.toUpperCase(),
            skuName: item.skuName,
            location: item.location.toUpperCase(),
            expiredDate: item.expiredDate,
            totalQty: 0,
            qtyCtnSize: pack.qtyCtnSize,
            qtyPackSize: pack.qtyInnerSize,
            barcode: getBarcodeForSku(item.skuId) || item.skuId,
            orderBreakdowns: []
          });
        }

        const cons = itemMap.get(key)!;
        cons.totalQty += item.qty;
        cons.orderBreakdowns.push({
          referenceNumber: grp.referenceNumber,
          customerName: grp.customerName,
          qty: item.qty
        });
      });
    });

    const list = Array.from(itemMap.values());

    // Sort strictly by warehouse picking route score
    list.sort((a, b) => {
      const scoreA = getWarehouseRouteScore(a.location, effectiveRouteConfig);
      const scoreB = getWarehouseRouteScore(b.location, effectiveRouteConfig);
      if (scoreA !== scoreB) return scoreA - scoreB;
      return a.skuId.localeCompare(b.skuId);
    });

    return list;
  }, [activeOrderGroups, effectiveRouteConfig]);

  // Total stats
  const totalPcsToPick = consolidatedRouteList.reduce((s, i) => s + i.totalQty, 0);
  const pickedCount = consolidatedRouteList.filter(i => pickedItemKeys[i.id]).length;
  const progressPercent = consolidatedRouteList.length > 0 
    ? Math.round((pickedCount / consolidatedRouteList.length) * 100) 
    : 0;

  // Filtered route lists
  const unpickedRouteList = useMemo(() => {
    return consolidatedRouteList.filter(i => !pickedItemKeys[i.id]);
  }, [consolidatedRouteList, pickedItemKeys]);

  const verifiedRouteList = useMemo(() => {
    return consolidatedRouteList.filter(i => !!pickedItemKeys[i.id]);
  }, [consolidatedRouteList, pickedItemKeys]);

  const displayedRouteList = useMemo(() => {
    if (filterTab === 'unpicked') return unpickedRouteList;
    if (filterTab === 'verified') return verifiedRouteList;
    return consolidatedRouteList;
  }, [filterTab, unpickedRouteList, verifiedRouteList, consolidatedRouteList]);

  // Toggle order in wave
  const handleToggleOrder = (ref: string) => {
    setSelectedOrders(prev => ({
      ...prev,
      [ref]: !prev[ref]
    }));
  };

  const handleSelectAllOrders = () => {
    const allSelected = orderGroups.every(g => selectedOrders[g.referenceNumber]);
    const updated: { [ref: string]: boolean } = {};
    if (!allSelected) {
      orderGroups.forEach(g => { updated[g.referenceNumber] = true; });
    }
    setSelectedOrders(updated);
  };

  // Toggle individual picked status
  const handleToggleItemPicked = (key: string) => {
    const targetItem = consolidatedRouteList.find(i => i.id === key);

    const isNowPicked = !pickedItemKeys[key];
    setPickedItemKeys(prev => ({
      ...prev,
      [key]: isNowPicked
    }));

    if (targetItem) {
      if (isNowPicked) {
        setScanFeedback(`✓ Terverifikasi: ${targetItem.skuId} (${targetItem.location}) selesai diambil dan keluar dari daftar antrean`);
      } else {
        setScanFeedback(`↺ Dikembalikan: ${targetItem.skuId} (${targetItem.location}) kembali ke antrean`);
      }
    }
  };

  // Handle barcode scanning to pick
  const handleScanToPick = (e: React.FormEvent) => {
    e.preventDefault();
    const val = scanInput.trim().toUpperCase();
    if (!val) return;

    const resolvedSku = findSkuId(val).trim().toUpperCase();

    // Find matching consolidated item by SKU, Barcode, or Location (prefer unpicked ones first)
    const unpickedMatch = unpickedRouteList.find(i => 
      i.skuId.toUpperCase() === val || 
      i.skuId.toUpperCase() === resolvedSku ||
      i.barcode.toUpperCase() === val ||
      i.location.toUpperCase() === val
    );

    const matched = unpickedMatch || consolidatedRouteList.find(i => 
      i.skuId.toUpperCase() === val || 
      i.skuId.toUpperCase() === resolvedSku ||
      i.barcode.toUpperCase() === val ||
      i.location.toUpperCase() === val
    );

    if (matched) {
      setPickedItemKeys(prev => ({ ...prev, [matched.id]: true }));
      setScanFeedback(`✓ Terverifikasi: ${matched.skuId} di ${matched.location} (${matched.totalQty} pcs) selesai diambil & keluar dari daftar!`);
      setScanInput('');
    } else {
      setScanFeedback(`⚠️ Barcode / SKU "${val}" tidak ditemukan di rute picking ini.`);
    }
  };

  // Confirm Complete Batch Picking
  const handleFinalizeBatch = async () => {
    const selectedRefs = Object.keys(selectedOrders).filter(k => selectedOrders[k]);
    if (selectedRefs.length === 0) return;

    if (onCompleteBatchPicking) {
      if(!await onCompleteBatchPicking(selectedRefs))return;
    }
    onClose();
  };

  const handlePrintWaveSheet = () => {
    window.print();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-[#11141B] border border-slate-800 rounded-2xl w-full max-w-6xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden text-slate-200">
        
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#161B25]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Navigation className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-white text-lg flex items-center gap-2">
                Batch / Wave Picking Gudang (Rute Terurut Rak)
                <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                  Optimal Route Engine
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Alur Rute Aktif: <strong className="text-amber-400">{describeRouteConfig(effectiveRouteConfig)}</strong> ({activeWarehouse?.name || 'Gudang'})
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {/* Warehouse Route Selector */}
            <div className="hidden sm:flex items-center gap-2 bg-slate-900/90 border border-slate-700/80 px-3 py-1.5 rounded-xl text-xs">
              <Building2 className="w-4 h-4 text-indigo-400 shrink-0" />
              <span className="text-slate-400 font-semibold">Gudang:</span>
              <select
                value={activeWhId}
                onChange={e => setActiveWhId(e.target.value)}
                className="bg-transparent text-white font-bold text-xs focus:outline-none cursor-pointer"
              >
                {(warehouses && warehouses.length > 0 ? warehouses : [{ id: 'WH-CENTRAL', name: 'Gudang Pusat' }]).map(w => (
                  <option key={w.id} value={w.id} className="bg-slate-900 text-white">
                    {w.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Mobile Warehouse Bar */}
        <div className="sm:hidden px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs">
          <span className="text-slate-400 font-semibold flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 text-indigo-400" />
            Rute Gudang:
          </span>
          <select
            value={activeWhId}
            onChange={e => setActiveWhId(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-white font-bold text-xs px-2 py-1 rounded"
          >
            {(warehouses && warehouses.length > 0 ? warehouses : [{ id: 'WH-CENTRAL', name: 'Gudang Pusat' }]).map(w => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>

        {/* Content Body: Left Order Selector + Right Consolidated Picking Route */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 flex-1 overflow-hidden">
          
          {/* Left Panel: Select Orders for Wave */}
          <div className="lg:col-span-4 border-r border-slate-800 p-4 space-y-4 overflow-y-auto max-h-[calc(94vh-140px)] bg-[#121620]">
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-indigo-400" />
                Pilih Order dalam Batch:
              </span>
              <button
                type="button"
                onClick={handleSelectAllOrders}
                className="text-xs text-indigo-400 hover:underline font-bold"
              >
                Pilih Semua
              </button>
            </div>

            {/* List of Orders */}
            <div className="space-y-2">
              {orderGroups.length === 0 ? (
                <div className="text-center py-10 px-4 text-xs text-slate-500 bg-[#161B25] rounded-xl border border-slate-800">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 mx-auto flex items-center justify-center mb-2 border border-emerald-500/20">
                    <Check className="w-4 h-4 stroke-[3]" />
                  </div>
                  <p className="font-bold text-slate-300">Semua Order Telah Selesai Dipick</p>
                  <p className="text-[11px] text-slate-500 mt-1">Tidak ada order yang membutuhkan pengambilan barang saat ini.</p>
                </div>
              ) : (
                orderGroups.map(grp => {
                  const isSelected = !!selectedOrders[grp.referenceNumber];
                  return (
                    <div
                      key={grp.referenceNumber}
                      onClick={() => handleToggleOrder(grp.referenceNumber)}
                      className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-indigo-500/10 border-indigo-500/40 text-white shadow-sm'
                          : 'bg-[#161B25] border-slate-800/80 text-slate-400 hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            className="rounded text-indigo-500 focus:ring-0"
                          />
                          <span className="font-mono font-bold text-white">{grp.referenceNumber}</span>
                        </div>
                        {grp.isPicked ? (
                          <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            Sudah Picked
                          </span>
                        ) : (
                          <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                            Draft Order
                          </span>
                        )}
                      </div>

                      <div className="mt-2 flex justify-between items-center text-[10px] text-slate-500 font-mono">
                        <span>{grp.customerName || 'Pelanggan Toko'}</span>
                        <span className="text-indigo-300 font-bold">{grp.items.length} SKU ({formatNumber(grp.totalQty)} pcs)</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Summary card */}
            <div className="bg-[#161B25] p-3 rounded-xl border border-slate-800 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Order Terpilih:</span>
                <span className="text-white font-bold font-mono">{activeOrderGroups.length} Dokumen</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Total Item Pick:</span>
                <span className="text-emerald-400 font-bold font-mono">{consolidatedRouteList.length} Titik Rak</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Total Fisik:</span>
                <span className="text-indigo-300 font-bold font-mono">{formatNumber(totalPcsToPick)} Pcs</span>
              </div>
            </div>
          </div>

          {/* Right Panel: Consolidated Optimized Route Picking List */}
          <div className="lg:col-span-8 p-4 bg-slate-950 flex flex-col justify-between overflow-y-auto max-h-[calc(94vh-140px)] space-y-4">
            
            {/* Top Picking Progress & Barcode Scan Verifier */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-[#161B25] p-3 rounded-xl border border-slate-800">
                <div className="flex-1 min-w-[200px]">
                  <div className="flex justify-between text-xs font-bold mb-1">
                    <span className="text-slate-300 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      Progres Pengambilan Wave:
                    </span>
                    <span className="text-emerald-400 font-mono">
                      {pickedCount} / {consolidatedRouteList.length} Titik ({progressPercent}%)
                    </span>
                  </div>
                  <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
                    <div
                      className="bg-emerald-500 bg-gradient-to-r from-indigo-500 to-emerald-400 h-full transition-all duration-300 rounded-full"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBasketQrGenerator(true)}
                    className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-bold rounded-lg border border-amber-500/40 transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
                    title="Buat & Cetak Stiker QR Code Keranjang Picking"
                  >
                    <Boxes className="w-3.5 h-3.5 text-amber-400" />
                    QR Keranjang (Basket)
                  </button>

                  <button
                    type="button"
                    onClick={handlePrintWaveSheet}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Cetak Lembar Picking
                  </button>
                </div>
              </div>

              {/* Barcode scanner quick verifier */}
              <form onSubmit={handleScanToPick} className="flex gap-2">
                <div className="relative flex-1">
                  <Barcode className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Scan Barcode Produk / SKU / Lokasi Rak untuk verifikasi instan..."
                    value={scanInput}
                    onChange={(e) => setScanInput(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 bg-[#161B25] border border-indigo-500/40 text-xs text-white font-mono rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 placeholder:text-slate-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl cursor-pointer"
                >
                  Verifikasi
                </button>
              </form>

              {scanFeedback && (
                <div className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center justify-between">
                  <span>{scanFeedback}</span>
                  <button onClick={() => setScanFeedback(null)} className="text-slate-400 hover:text-white">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* View Tabs: Belum Diambil (Auto-hides verified) / Sudah Terverifikasi / Semua */}
              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-1 bg-[#161B25] p-1 rounded-xl border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setFilterTab('unpicked')}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
                      filterTab === 'unpicked'
                        ? 'bg-amber-500 text-slate-950 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <span>Belum Diambil</span>
                    <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                      filterTab === 'unpicked' ? 'bg-amber-600 text-slate-950 font-black' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {unpickedRouteList.length}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setFilterTab('verified')}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
                      filterTab === 'verified'
                        ? 'bg-emerald-500 text-slate-950 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <span>Sudah Terverifikasi</span>
                    <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                      filterTab === 'verified' ? 'bg-emerald-600 text-slate-950 font-black' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {verifiedRouteList.length}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setFilterTab('all')}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      filterTab === 'all'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Semua ({consolidatedRouteList.length})
                  </button>
                </div>

                <div className="text-[11px] text-slate-400 hidden sm:block">
                  💡 Klik item atau scan barcode untuk verifikasi (otomatis hilang dari daftar)
                </div>
              </div>
            </div>

            {/* List of Ordered Picking Locations */}
            <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
              {consolidatedRouteList.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs bg-[#161B25] rounded-xl border border-dashed border-slate-800">
                  Pilih minimal 1 order di panel sebelah kiri untuk membuat daftar Wave Picking.
                </div>
              ) : filterTab === 'unpicked' && unpickedRouteList.length === 0 ? (
                <div className="text-center py-10 px-6 bg-emerald-950/20 border border-emerald-500/30 rounded-2xl space-y-3">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/30">
                    <CheckCircle className="w-7 h-7" />
                  </div>
                  <h4 className="text-base font-extrabold text-white">
                    Semua {consolidatedRouteList.length} Titik Rak Selesai Diambil!
                  </h4>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Seluruh barang pada batch wave ini telah terverifikasi. Silakan klik tombol hijau di bawah untuk menyelesaikan picking dan meneruskan ke tim Packer.
                  </p>
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={handleFinalizeBatch}
                      className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 inline-flex items-center gap-2 cursor-pointer transition-transform active:scale-95"
                    >
                      <CheckCircle className="w-4 h-4" />
                      SELESAIKAN WAVE PICKING SEKARANG ({activeOrderGroups.length} ORDER)
                    </button>
                  </div>
                </div>
              ) : filterTab === 'verified' && verifiedRouteList.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs bg-[#161B25] rounded-xl border border-dashed border-slate-800">
                  Belum ada item yang terverifikasi. Silakan scan barcode atau klik item di tab "Belum Diambil".
                </div>
              ) : (
                displayedRouteList.map((item, index) => {
                  const isPicked = !!pickedItemKeys[item.id];
                  const ctnCount = Math.floor(item.totalQty / item.qtyCtnSize);
                  const remPcs = item.totalQty % item.qtyCtnSize;

                  // Find original overall route index in consolidatedRouteList
                  const originalIndex = consolidatedRouteList.findIndex(x => x.id === item.id);

                  return (
                    <div
                      key={item.id}
                      onClick={() => handleToggleItemPicked(item.id)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer group ${
                        isPicked
                          ? 'bg-emerald-950/20 border-emerald-500/40 opacity-80'
                          : 'bg-[#161B25] border-slate-800/80 hover:border-amber-500/50 hover:bg-[#1a202c]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          {/* Route Sequence Badge */}
                          <div className={`flex flex-col items-center justify-center w-7 h-7 rounded-lg border font-mono font-bold text-xs ${
                            isPicked 
                              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' 
                              : 'bg-slate-900 border-slate-800 text-slate-400 group-hover:border-amber-500/40 group-hover:text-amber-300'
                          }`}>
                            {originalIndex >= 0 ? originalIndex + 1 : index + 1}
                          </div>

                          <div>
                            <div className="flex items-center gap-2">
                              {/* Location Badge */}
                              <span className="px-2.5 py-1 rounded-md font-mono font-black text-xs flex items-center gap-1 bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                <MapPin className="w-3.5 h-3.5" />
                                {item.location}
                              </span>
                              <span className="font-mono font-extrabold text-white text-xs">
                                {item.skuId}
                              </span>
                              {isPicked && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                                  <Check className="w-3 h-3" /> OK Terverifikasi
                                </span>
                              )}
                            </div>
                            <h4 className="text-xs text-slate-300 font-semibold mt-1">
                              {item.skuName}
                            </h4>
                          </div>
                        </div>

                        {/* Pick Quantity Highlight */}
                        <div className="text-right shrink-0">
                          <div className="text-base font-black text-emerald-400 font-mono">
                            {formatNumber(item.totalQty)} <span className="text-xs font-normal text-slate-400">pcs</span>
                          </div>
                          {ctnCount > 0 && (
                            <div className="text-[10px] text-slate-400 font-mono">
                              ({ctnCount} Ctn {remPcs > 0 ? `+ ${remPcs} Pcs` : ''})
                            </div>
                          )}
                          <div className="mt-1">
                            <span className="text-[10px] text-indigo-400 group-hover:underline">
                              {isPicked ? 'Klik untuk batal' : 'Klik untuk verifikasi ✓'}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Order Totes / Destinations Breakdown */}
                      <div className="mt-2 pt-2 border-t border-slate-800/60 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] text-slate-500 uppercase font-bold">Alokasi Order:</span>
                        {item.orderBreakdowns.map((ord, oIdx) => (
                          <span
                            key={oIdx}
                            className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800"
                          >
                            {ord.referenceNumber}: <strong className="text-emerald-400">{ord.qty} pcs</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Actions */}
            <div className="pt-3 border-t border-slate-800 flex flex-wrap justify-between items-center gap-3">
              <div className="text-xs text-slate-400">
                {pickedCount === consolidatedRouteList.length && consolidatedRouteList.length > 0 ? (
                  <span className="text-emerald-400 font-bold flex items-center gap-1">
                    <Check className="w-4 h-4" /> Seluruh {consolidatedRouteList.length} titik barang telah selesai diambil!
                  </span>
                ) : (
                  <span>Sisa belum diambil: <strong className="text-amber-400">{unpickedRouteList.length} titik rak</strong> ({totalPcsToPick - verifiedRouteList.reduce((s, i) => s + i.totalQty, 0)} pcs)</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl cursor-pointer"
                >
                  Tutup
                </button>
                <button
                  type="button"
                  disabled={consolidatedRouteList.length === 0}
                  onClick={handleFinalizeBatch}
                  className="px-6 py-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-955 font-extrabold text-xs rounded-xl shadow-lg shadow-emerald-500/20 flex items-center gap-2 cursor-pointer"
                >
                  <CheckCircle className="w-4 h-4" />
                  SELESAIKAN WAVE PICKING ({activeOrderGroups.length} ORDER)
                </button>
              </div>
            </div>

          </div>

        </div>

      </div>

      {/* Hidden Print Wave Sheet (A4) */}
      <div className="hidden print:block fixed inset-0 bg-white text-black p-8 z-[99999]">
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            body * { visibility: hidden; }
            .wave-picking-print, .wave-picking-print * { visibility: visible; }
            .wave-picking-print { position: absolute; left: 0; top: 0; width: 100%; padding: 20px; }
          }
        `}} />
        <div className="wave-picking-print font-sans text-black">
          <div className="border-b-2 border-black pb-3 flex justify-between items-center">
            <div>
              <h1 className="text-xl font-bold uppercase tracking-tight">LEMBAR PENGAMBILAN BARANG (WAVE PICKING)</h1>
              <p className="text-xs text-gray-600">Rute Terurut Lokasi Rak Gudang Utama</p>
            </div>
            <div className="text-right text-xs">
              <p className="font-bold">Tanggal: {new Date().toLocaleDateString('id-ID')}</p>
              <p>Total Order: {activeOrderGroups.length} Dokumen | Total Pcs: {totalPcsToPick}</p>
            </div>
          </div>

          <div className="my-3 text-xs">
            <strong>Daftar Order:</strong> {activeOrderGroups.map(g => g.referenceNumber).join(', ')}
          </div>

          <table className="w-full text-xs border-collapse mt-2">
            <thead>
              <tr className="border-b-2 border-black bg-gray-100">
                <th className="p-2 text-center w-10">No</th>
                <th className="p-2 text-left w-24">Lokasi Rak</th>
                <th className="p-2 text-left">SKU & Nama Produk</th>
                <th className="p-2 text-center w-20">Exp Date</th>
                <th className="p-2 text-right w-20">Total Ambil</th>
                <th className="p-2 text-left">Alokasi Order</th>
                <th className="p-2 text-center w-12">Check</th>
              </tr>
            </thead>
            <tbody>
              {consolidatedRouteList.map((item, idx) => (
                <tr key={idx} className="border-b border-gray-300">
                  <td className="p-2 text-center font-bold">{idx + 1}</td>
                  <td className="p-2 font-mono font-bold text-sm">{item.location}</td>
                  <td className="p-2">
                    <div className="font-mono font-bold">{item.skuId}</div>
                    <div>{item.skuName}</div>
                  </td>
                  <td className="p-2 text-center font-mono">{item.expiredDate}</td>
                  <td className="p-2 text-right font-bold text-sm">{item.totalQty} pcs</td>
                  <td className="p-2 text-[10px]">
                    {item.orderBreakdowns.map(o => `${o.referenceNumber} (${o.qty} pcs)`).join(', ')}
                  </td>
                  <td className="p-2 text-center">
                    <div className="w-4 h-4 border-2 border-black mx-auto"></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* QR Basket Generator Modal */}
      {showBasketQrGenerator && (
        <BasketQrGenerator
          isOpen={showBasketQrGenerator}
          onClose={() => setShowBasketQrGenerator(false)}
        />
      )}

    </div>
  );
}
