import React, { useState, useMemo } from 'react';
import { StockItem } from '../types';
import { formatNumber, getExpiredStatus, isNearExpiryStatus } from '../utils/calculations';
import { 
  MapPin, 
  Search, 
  Filter, 
  Layers, 
  Boxes, 
  AlertTriangle, 
  Calendar, 
  Printer, 
  ArrowRight, 
  Sparkles, 
  Eye, 
  CheckCircle2, 
  RefreshCw, 
  X,
  Info,
  Maximize2,
  Minimize2
} from 'lucide-react';
import ThermalLabelPrinter from './ThermalLabelPrinter';

interface WarehouseMapProps {
  stock: StockItem[];
  onRelocateFromRack?: (rackLocation: string) => void;
  onAuditRack?: (rackLocation: string) => void;
  onNavigateToTransfer?: (rackLocation: string) => void;
}

export interface RackCellData {
  location: string;
  zone: string;
  aisle: string;
  bay: number;
  level: number;
  items: StockItem[];
  totalQty: number;
  uniqueSkuCount: number;
  hasNearExpiry: boolean;
  hasExpired: boolean;
  utilization: 'empty' | 'low' | 'medium' | 'high';
}

export default function WarehouseMap({
  stock,
  onRelocateFromRack,
  onAuditRack
}: WarehouseMapProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedZone, setSelectedZone] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'EMPTY' | 'OCCUPIED' | 'NEAR_EXPIRY'>('ALL');
  const [selectedRack, setSelectedRack] = useState<RackCellData | null>(null);
  const [showLabelModal, setShowLabelModal] = useState(false);
  const [labelModalRack, setLabelModalRack] = useState<string | null>(null);

  // 1. Parse and extract all racks from stock & standard warehouse layout
  const racksData = useMemo(() => {
    const rackMap = new Map<string, RackCellData>();

    // Seed standard warehouse racks (Aisles A, B, C, D, E, F)
    const standardAisles = ['A', 'B', 'C', 'D', 'E', 'F'];
    standardAisles.forEach(aisle => {
      for (let bay = 1; bay <= 4; bay++) {
        for (let lvl = 1; lvl <= 3; lvl++) {
          const locName = `${aisle}${bay}-0${lvl}-01`;
          rackMap.set(locName, {
            location: locName,
            zone: `Zona ${aisle}`,
            aisle: aisle,
            bay: bay,
            level: lvl,
            items: [],
            totalQty: 0,
            uniqueSkuCount: 0,
            hasNearExpiry: false,
            hasExpired: false,
            utilization: 'empty'
          });
        }
      }
    });

    // Special staging & transit locations
    const specialLocations = ['TRANSIT', 'ZONE 1 - RETUR', 'STAGING-IN', 'DISPLAY-A1'];
    specialLocations.forEach(loc => {
      rackMap.set(loc, {
        location: loc,
        zone: loc.includes('ZONE 1') ? 'Zone 1' : loc.includes('TRANSIT') ? 'Transit' : 'Staging',
        aisle: 'SPECIAL',
        bay: 1,
        level: 1,
        items: [],
        totalQty: 0,
        uniqueSkuCount: 0,
        hasNearExpiry: false,
        hasExpired: false,
        utilization: 'empty'
      });
    });

    // Populate with real stock items
    stock.forEach(item => {
      if (item.qty <= 0) return;
      const cleanLoc = item.location.trim().toUpperCase();
      if (!cleanLoc || cleanLoc.startsWith('SYSTEM_')) return;

      if (!rackMap.has(cleanLoc)) {
        // Dynamic custom rack
        const match = cleanLoc.match(/^([A-Z]+)(\d+)?(?:-(\d+))?(?:-(\d+))?/);
        const aisleName = match ? match[1] : 'LAINNYA';
        const bayNum = match && match[2] ? parseInt(match[2], 10) : 1;
        const lvlNum = match && match[3] ? parseInt(match[3], 10) : 1;

        rackMap.set(cleanLoc, {
          location: cleanLoc,
          zone: `Zona ${aisleName}`,
          aisle: aisleName,
          bay: bayNum,
          level: lvlNum,
          items: [],
          totalQty: 0,
          uniqueSkuCount: 0,
          hasNearExpiry: false,
          hasExpired: false,
          utilization: 'empty'
        });
      }

      const cell = rackMap.get(cleanLoc)!;
      cell.items.push(item);
      cell.totalQty += item.qty;

      // Expiry checks
      const expStatus = getExpiredStatus(item.expiredDate);
      if (expStatus === 'Expired') {
        cell.hasExpired = true;
      } else if (isNearExpiryStatus(expStatus)) {
        cell.hasNearExpiry = true;
      }
    });

    // Calculate unique SKUs & utilization level
    rackMap.forEach(cell => {
      const uniqueSkus = new Set(cell.items.map(i => i.skuId));
      cell.uniqueSkuCount = uniqueSkus.size;

      // Rough capacity heuristic (Max ~1000 pcs per rack shelf)
      if (cell.totalQty === 0) {
        cell.utilization = 'empty';
      } else if (cell.totalQty < 300) {
        cell.utilization = 'low';
      } else if (cell.totalQty < 800) {
        cell.utilization = 'medium';
      } else {
        cell.utilization = 'high';
      }
    });

    return Array.from(rackMap.values());
  }, [stock]);

  // Unique Zones list
  const availableZones = useMemo(() => {
    const zones = new Set(racksData.map(r => r.zone));
    return ['ALL', ...Array.from(zones)];
  }, [racksData]);

  // Search matching locations (for animated map glowing pinpoints)
  const searchMatchingLocations = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    const q = searchQuery.toLowerCase().trim();
    const matching = new Set<string>();

    racksData.forEach(rack => {
      if (rack.location.toLowerCase().includes(q)) {
        matching.add(rack.location);
      }
      const hasSkuMatch = rack.items.some(
        item => item.skuId.toLowerCase().includes(q) || item.skuName.toLowerCase().includes(q)
      );
      if (hasSkuMatch) {
        matching.add(rack.location);
      }
    });

    return matching;
  }, [racksData, searchQuery]);

  // Filtered racks according to Zone and Status
  const filteredRacks = useMemo(() => {
    return racksData.filter(rack => {
      if (selectedZone !== 'ALL' && rack.zone !== selectedZone) return false;
      if (statusFilter === 'EMPTY' && rack.totalQty > 0) return false;
      if (statusFilter === 'OCCUPIED' && rack.totalQty === 0) return false;
      if (statusFilter === 'NEAR_EXPIRY' && !rack.hasNearExpiry && !rack.hasExpired) return false;
      return true;
    });
  }, [racksData, selectedZone, statusFilter]);

  // Group racks by Zone for visual bento rendering
  const groupedByZone = useMemo(() => {
    const map = new Map<string, RackCellData[]>();
    filteredRacks.forEach(rack => {
      if (!map.has(rack.zone)) {
        map.set(rack.zone, []);
      }
      map.get(rack.zone)!.push(rack);
    });

    // Sort racks inside zone by Bay and Level
    map.forEach(racks => {
      racks.sort((a, b) => {
        if (a.bay !== b.bay) return a.bay - b.bay;
        return a.level - b.level;
      });
    });

    return Array.from(map.entries());
  }, [filteredRacks]);

  // Aggregate Stats
  const totalRacks = racksData.length;
  const occupiedRacks = racksData.filter(r => r.totalQty > 0).length;
  const emptyRacks = totalRacks - occupiedRacks;
  const nearExpiryRacks = racksData.filter(r => r.hasNearExpiry || r.hasExpired).length;
  const warehouseOccupancyRate = totalRacks > 0 ? Math.round((occupiedRacks / totalRacks) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Top Header & Search Control Bar */}
      <div className="bg-[#11141B] p-4 rounded-2xl border border-slate-800 shadow-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-extrabold text-white text-base sm:text-lg flex items-center gap-2">
                Peta Visual Utilisasi Denah Rak Gudang
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  Interactive 2D Grid
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Visualisasi kapasitas penyimpanan per lorong, densitas stok, & status masa kedaluwarsa real-time
              </p>
            </div>
          </div>

          {/* Quick Metrics Bar */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <div className="bg-[#161B25] px-3 py-1.5 rounded-xl border border-slate-800 flex items-center gap-2">
              <span className="text-slate-400">Utilisasi:</span>
              <strong className="text-emerald-400 font-extrabold">{warehouseOccupancyRate}%</strong>
            </div>
            <div className="bg-[#161B25] px-3 py-1.5 rounded-xl border border-slate-800 flex items-center gap-2">
              <span className="text-slate-400">Terisi:</span>
              <strong className="text-white font-extrabold">{occupiedRacks} / {totalRacks} Rak</strong>
            </div>
            {nearExpiryRacks > 0 && (
              <div className="bg-purple-950/30 px-3 py-1.5 rounded-xl border border-purple-500/30 flex items-center gap-2 text-purple-300">
                <AlertTriangle className="w-3.5 h-3.5 text-purple-400" />
                <span>{nearExpiryRacks} Rak Near-Expiry</span>
              </div>
            )}
          </div>
        </div>

        {/* Filter Controls & Search */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 pt-2 border-t border-slate-800/80">
          {/* Search SKU or Location */}
          <div className="md:col-span-6 relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Cari SKU / Nama Produk / Kode Rak (akan bersinar di denah)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-2 bg-[#161B25] border border-emerald-500/30 rounded-xl text-xs text-white placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-2.5 text-slate-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Zone Selector */}
          <div className="md:col-span-3">
            <select
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              className="w-full py-2 px-3 bg-[#161B25] border border-slate-800 rounded-xl text-xs text-white outline-none cursor-pointer"
            >
              {availableZones.map(zone => (
                <option key={zone} value={zone}>
                  {zone === 'ALL' ? '🌐 Semua Zona Gudang' : `📍 ${zone}`}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="md:col-span-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="w-full py-2 px-3 bg-[#161B25] border border-slate-800 rounded-xl text-xs text-white outline-none cursor-pointer"
            >
              <option value="ALL">Semua Status Rak</option>
              <option value="OCCUPIED">🟢 Hanya Rak Terisi</option>
              <option value="EMPTY">⚪ Hanya Rak Kosong</option>
              <option value="NEAR_EXPIRY">🟣 Hanya Rak Near-Expiry</option>
            </select>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400 pt-1">
          <span className="font-bold text-slate-500 uppercase text-[9px]">Indikator Warna:</span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-slate-800 border border-slate-700"></span> Kosong (0 pcs)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/20 border border-emerald-500"></span> Rendah (&lt;300 pcs)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-500/30 border border-amber-500"></span> Sedang (300-800 pcs)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-rose-500/30 border border-rose-500"></span> Penuh (&gt;800 pcs)
          </span>
          <span className="flex items-center gap-1 text-purple-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-purple-500/40 border border-purple-400 animate-pulse"></span> Near-Expiry
          </span>
          {searchQuery && (
            <span className="flex items-center gap-1 text-emerald-300 font-bold ml-auto animate-pulse">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              {searchMatchingLocations.size} Rak Sesuai Pencarian
            </span>
          )}
        </div>
      </div>

      {/* Warehouse Map Grid Layout by Zone */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {groupedByZone.map(([zoneName, racks]) => (
          <div
            key={zoneName}
            className="bg-[#11141B] rounded-2xl border border-slate-800/80 p-4 space-y-3 shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <h3 className="font-extrabold text-white text-sm uppercase tracking-wide">
                  {zoneName}
                </h3>
                <span className="text-[10px] text-slate-500 font-mono">
                  ({racks.length} Rak)
                </span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Total: <strong className="text-emerald-400">{formatNumber(racks.reduce((s, r) => s + r.totalQty, 0))}</strong> pcs
              </span>
            </div>

            {/* Racks Grid inside Zone */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
              {racks.map(rack => {
                const isSearchMatch = searchMatchingLocations.has(rack.location);
                const isSelected = selectedRack?.location === rack.location;

                // Determine border and bg color
                let bgStyle = 'bg-slate-900/60 border-slate-800 text-slate-400';
                if (rack.hasNearExpiry || rack.hasExpired) {
                  bgStyle = 'bg-purple-950/20 border-purple-500/50 text-purple-300 shadow-purple-500/5';
                } else if (rack.utilization === 'high') {
                  bgStyle = 'bg-rose-950/20 border-rose-500/40 text-rose-300';
                } else if (rack.utilization === 'medium') {
                  bgStyle = 'bg-amber-950/20 border-amber-500/40 text-amber-300';
                } else if (rack.utilization === 'low') {
                  bgStyle = 'bg-emerald-950/20 border-emerald-500/40 text-emerald-300';
                }

                if (isSearchMatch) {
                  bgStyle = 'bg-emerald-500/25 border-emerald-400 text-white ring-2 ring-emerald-400/80 shadow-lg shadow-emerald-500/20 animate-pulse';
                }

                if (isSelected) {
                  bgStyle += ' ring-2 ring-white border-white';
                }

                return (
                  <div
                    key={rack.location}
                    onClick={() => setSelectedRack(rack)}
                    className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all duration-150 hover:scale-[1.02] flex flex-col justify-between min-h-[90px] ${bgStyle}`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="font-mono font-black text-xs tracking-tight truncate text-white">
                        {rack.location}
                      </span>
                      {rack.hasNearExpiry && (
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" title="Ada Near-Expiry" />
                      )}
                    </div>

                    <div className="my-1 text-center">
                      <div className="text-sm font-black font-mono">
                        {formatNumber(rack.totalQty)} <span className="text-[9px] font-normal text-slate-400">pcs</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center text-[9px] font-mono border-t border-slate-800/60 pt-1 text-slate-400">
                      <span>{rack.uniqueSkuCount} SKU</span>
                      <span className="uppercase text-[8px] font-bold">
                        {rack.utilization}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Interactive Detail Drawer for Selected Rack */}
      {selectedRack && (
        <div className="fixed inset-0 z-[9999] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
          <div className="bg-[#11141B] border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden text-slate-200 animate-in fade-in duration-150">
            
            {/* Drawer Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#161B25]">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-black text-sm">
                  {selectedRack.location}
                </div>
                <div>
                  <h3 className="font-extrabold text-white text-base">
                    Rincian Stok Rak {selectedRack.location}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {selectedRack.zone} • {selectedRack.uniqueSkuCount} Jenis Produk • Total {formatNumber(selectedRack.totalQty)} Pcs
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedRack(null)}
                className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* List of SKUs inside Rack */}
            <div className="p-4 max-h-[60vh] overflow-y-auto space-y-2">
              {selectedRack.items.length === 0 ? (
                <div className="text-center py-10 text-slate-500 text-xs space-y-2">
                  <Boxes className="w-8 h-8 mx-auto text-slate-600" />
                  <p className="font-bold">Rak ini saat ini kosong</p>
                  <p>Anda dapat mengalokasikan barang baru ke rak ini melalui menu Inbound atau Transfer Antar Lokasi.</p>
                </div>
              ) : (
                selectedRack.items.map((item, idx) => {
                  const expStatus = getExpiredStatus(item.expiredDate);
                  return (
                    <div
                      key={`${item.skuId}-${idx}`}
                      className="p-3 bg-[#161B25] rounded-xl border border-slate-800/80 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-emerald-400">{item.skuId}</span>
                          <span className="font-semibold text-white truncate max-w-[280px]">{item.skuName}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-2 font-mono">
                          <span>EXP: {item.expiredDate || 'Non-Exp'}</span>
                          {expStatus !== 'AMAN' && (
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                              expStatus === 'Expired' 
                                ? 'bg-rose-500/20 text-rose-300' 
                                : 'bg-purple-500/20 text-purple-300'
                            }`}>
                              {expStatus}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-right font-mono">
                        <div className="text-sm font-extrabold text-white">
                          {formatNumber(item.qty)} <span className="text-xs text-slate-400">pcs</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Actions for this Rack */}
            <div className="p-4 border-t border-slate-800 bg-[#161B25] flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setLabelModalRack(selectedRack.location);
                  setShowLabelModal(true);
                }}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                Cetak Label Rak
              </button>

              <div className="flex items-center gap-2">
                {onRelocateFromRack && selectedRack.totalQty > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      onRelocateFromRack(selectedRack.location);
                      setSelectedRack(null);
                    }}
                    className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-bold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                    Pindahkan Stok
                  </button>
                )}

                {onAuditRack && (
                  <button
                    type="button"
                    onClick={() => {
                      onAuditRack(selectedRack.location);
                      setSelectedRack(null);
                    }}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-500/20"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Opname Fisik Rak Ini
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Label Modal for Rack */}
      {showLabelModal && labelModalRack && (
        <ThermalLabelPrinter
          isOpen={showLabelModal}
          onClose={() => setShowLabelModal(false)}
          allStock={stock}
          allLocations={[labelModalRack]}
          initialMode="location"
          initialItems={[{
            id: `loc-${labelModalRack}`,
            type: 'location',
            title: `LOKASI RAK ${labelModalRack}`,
            code: labelModalRack,
            barcodeValue: labelModalRack,
            location: labelModalRack
          }]}
        />
      )}
    </div>
  );
}
