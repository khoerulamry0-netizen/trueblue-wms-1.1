import DashboardOverview from './DashboardOverview';
import {getStockStatus,getCompletedOutbound,getAvailableStockPool,isStockPickable} from '../utils/calculations';
import React from 'react';
import { StockItem, DccLog, OutboundItem, BatchRecord } from '../types';
import EnterpriseWmsBanner from './EnterpriseWmsBanner';
import { formatNumber, formatToWibTimeOnly, getProductCategory, isToday, isNearExpiryStatus, getExpiredStatus } from '../utils/calculations';
import { 
  TrendingUp, 
  AlertTriangle, 
  ShieldCheck, 
  Package, 
  MapPin, 
  Clock, 
  ArrowUpRight, 
  ArrowDownRight,
  MoveRight,
  RotateCcw,
  BarChart4,
  Boxes,
  ClipboardCheck,
  PackageCheck,
  Hourglass,
  ShieldAlert,
  Calendar,
  ClipboardList,
  ArrowRight,
  Truck,
  Building2,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import { motion } from 'motion/react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';

// Custom Tooltip for Lowest Stock SKU Chart
const SkuTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-slate-950 border border-slate-850 p-3 rounded-xl shadow-2xl font-sans max-w-xs">
        <p className="text-xs font-black text-rose-400 mb-1 leading-normal uppercase">{data.fullName}</p>
        <p className="text-[10px] text-slate-500 font-mono mb-1.5">SKU: {data.skuId}</p>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
          <p className="text-xs font-bold text-white">
            Sisa Stok: <span className="text-rose-400 text-sm font-black">{formatNumber(payload[0].value)}</span> pcs
          </p>
        </div>
      </div>
    );
  }
  return null;
};

// Custom Tooltip for Top Sold SKU Chart
const SoldSkuTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-slate-950 border border-slate-850 p-3 rounded-xl shadow-2xl font-sans max-w-xs">
        <p className="text-xs font-black text-emerald-400 mb-1 leading-normal uppercase">{data.fullName}</p>
        <p className="text-[10px] text-slate-500 font-mono mb-1.5">SKU: {data.skuId}</p>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <p className="text-xs font-bold text-white">
            Outbound selesai (30 hari): <span className="text-emerald-400 text-sm font-black">{formatNumber(payload[0].value)}</span> pcs
          </p>
        </div>
      </div>
    );
  }
  return null;
};

// Custom Tooltip for Location Distribution Chart
const LocationTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-slate-950 border border-slate-850 p-3 rounded-xl shadow-2xl font-sans">
        <p className="text-xs font-extrabold text-indigo-400 mb-1 uppercase tracking-wide">Lokasi: {data.location}</p>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
          <p className="text-xs font-bold text-white">
            Total Volume: <span className="text-indigo-300 text-sm font-black">{formatNumber(payload[0].value)}</span> pcs
          </p>
        </div>
      </div>
    );
  }
  return null;
};

interface DashboardProps {
  stock: StockItem[];
  logs: DccLog[];
  orderHistory: OutboundItem[];
  batches?: BatchRecord[];
  onNavigate: (tab: string) => void;
  userRole?: string;
  currentTheme?: string;
  onOpenInventory?: (focus: string) => void;
  onOpenWork?: (stage: 'pick' | 'validate') => void;
}

export default function Dashboard({ stock = [], logs = [], orderHistory = [], batches = [], onNavigate, userRole, currentTheme, onOpenInventory, onOpenWork }: DashboardProps) {
  const completedOutbound=getCompletedOutbound(orderHistory);
  // Calculations
  const totalStockQty = stock.reduce((acc, curr) => acc + curr.qty, 0);
  
  const uniqueSkus = Array.from(new Set(stock.map(item => item.skuId))).length;
  
  const occupiedLocations = Array.from(new Set(stock.filter(item => item.qty > 0).map(item => JSON.stringify([(item.warehouseId || 'WH-CENTRAL').trim().toUpperCase(), item.location.trim().toUpperCase()])))).length;

  // Category splits
  const categoryGroups: Record<string, number> = {};
  stock.forEach(item => {
    const cat = getProductCategory(item.skuId, item.skuName);
    categoryGroups[cat] = (categoryGroups[cat] || 0) + item.qty;
  });

  // Top locations by stock volume
  const locationGroups: Record<string, number> = {};
  stock.forEach(item => {
    locationGroups[item.location] = (locationGroups[item.location] || 0) + item.qty;
  });
  const topLocations = Object.entries(locationGroups)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  const maxLocationQty = topLocations[0]?.qty || 1;

  const handleSafeNavigate = (targetTab: string) => {
    if (userRole === 'Packer' || userRole === 'Picker') {
      if (targetTab !== 'dashboard') {
        onNavigate('bulk');
        return;
      }
    }
    if (userRole === 'Viewer') {
      if (targetTab !== 'dashboard') {
        onNavigate('inventory');
        return;
      }
    }
    onNavigate(targetTab);
  };

  return (
    <div className="space-y-6" id="dashboard-tab">
      {/* Enterprise WMS Header Banner */}
      <EnterpriseWmsBanner 
        userRole={userRole}
        onNavigate={handleSafeNavigate}
        totalSkuCount={uniqueSkus}
        totalUnitsCount={totalStockQty}
      />

      <DashboardOverview stock={stock} orders={orderHistory} logs={logs} role={userRole} onInventory={onOpenInventory} onWork={onOpenWork}/>

      {/* Visual Analytics Row using Recharts Bar Charts */}
      {(() => {
        // Compute 10 SKU Outbound Selesai (30 hari) from orderHistory
        const soldSkuMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};
        completedOutbound.forEach(item => {
          if (item.skuId && item.status === 'Completed') {
            if (!soldSkuMap[item.skuId]) {
              soldSkuMap[item.skuId] = {
                skuId: item.skuId,
                skuName: item.skuName,
                qty: 0
              };
            }
            soldSkuMap[item.skuId].qty += item.qty;
          }
        });

        const topSoldSkus = Object.values(soldSkuMap)
          .sort((a, b) => b.qty - a.qty) // Highest sales first (descending)
          .slice(0, 10)
          .map(item => ({
            name: item.skuName.length > 15 ? `${item.skuName.slice(0, 13)}...` : item.skuName,
            fullName: item.skuName,
            skuId: item.skuId,
            qty: item.qty
          }));

        // Compute Stock Distribution per Location
        const locStockMap: Record<string, number> = {};
        stock.forEach(item => {
          if (item.qty > 0) {
            locStockMap[item.location] = (locStockMap[item.location] || 0) + item.qty;
          }
        });

        const locationDistribution = Object.entries(locStockMap)
          .map(([location, qty]) => ({
            location,
            qty
          }))
          .sort((a, b) => b.qty - a.qty) // Sort descending so densest locations are first
          .slice(0, 8); // Top 8 locations

        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Card 1: 10 SKU Outbound Selesai (30 hari) */}
            <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md flex flex-col justify-between">
              <div>
                <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-emerald-400" />
                  10 SKU Outbound Selesai (30 hari)
                </h3>
                <p className="text-xs text-slate-400 mb-6">Hanya order selesai, tidak termasuk draft, picking, dan pembatalan.</p>
              </div>
              <div className="h-64 w-full">
                {topSoldSkus.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-500 text-xs italic">
                    Belum ada data transaksi Outbound (Penjualan)
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topSoldSkus}
                      margin={{ top: 10, right: 10, left: -25, bottom: 5 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                      <XAxis 
                        dataKey="name" 
                        stroke="#94a3b8" 
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis 
                        stroke="#94a3b8" 
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<SoldSkuTooltip />} cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }} />
                      <Bar dataKey="qty" radius={[6, 6, 0, 0]} barSize={24}>
                        {topSoldSkus.map((entry, index) => {
                          const colors = ['#10b981', '#059669', '#34d399', '#059669', '#6ee7b7', '#a7f3d0', '#047857', '#06b6d4', '#22d3ee', '#0891b2'];
                          return <Cell key={`cell-sku-${index}`} fill={colors[index % colors.length]} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Card 2: Distribusi Stok per Lokasi */}
            <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md flex flex-col justify-between">
              <div>
                <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                  <BarChart4 className="w-5 h-5 text-indigo-400" />
                  Distribusi Stok per Lokasi
                </h3>
                <p className="text-xs text-slate-400 mb-6">Rincian kepadatan barang aktif di setiap lorong rak penyimpanan utama dan zona transit.</p>
              </div>
              <div className="h-64 w-full">
                {locationDistribution.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-500 text-xs italic">
                    Tidak ada data lokasi yang terisi barang
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={locationDistribution}
                      margin={{ top: 10, right: 10, left: -25, bottom: 5 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                      <XAxis 
                        dataKey="location" 
                        stroke="#94a3b8" 
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis 
                        stroke="#94a3b8" 
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<LocationTooltip />} cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }} />
                      <Bar dataKey="qty" radius={[6, 6, 0, 0]} barSize={32}>
                        {locationDistribution.map((entry, index) => {
                          const colors = ['#6366f1', '#4f46e5', '#818cf8', '#a5b4fc', '#4338ca', '#3b82f6', '#06b6d4', '#10b981'];
                          return <Cell key={`cell-loc-${index}`} fill={colors[index % colors.length]} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        );
      })()}


      <p className="text-xs text-slate-500">Kategori pergerakan dari outbound selesai 30 hari: cepat ≥100 pcs, sedang 10–99, lambat 1–9; nol = belum ada outbound. Angka fisik mencakup stok karantina, yang tidak tersedia untuk picking.</p>
      {/* 20 SKU Deadstock (Stok Mengendap) */}
      {(() => {
        const skuDetailsMap: Record<string, { 
          skuId: string; 
          skuName: string; 
          totalStock: number; 
          totalSold: number;
          category: string;
          hasNearExp: boolean;
          hasDamage: boolean;
          damagedQty: number;
        }> = {};

        stock.forEach(item => {
          if (item.skuId && item.skuId !== 'SYSTEM_EMPTY') {
            if (!skuDetailsMap[item.skuId]) {
              skuDetailsMap[item.skuId] = {
                skuId: item.skuId,
                skuName: item.skuName,
                totalStock: 0,
                totalSold: 0,
                category: getProductCategory(item.skuId, item.skuName),
                hasNearExp: false,
                damagedQty: 0,
                hasDamage: false
              };
            }
            skuDetailsMap[item.skuId].totalStock += item.qty;
            if (item.qty>0 && isNearExpiryStatus(getStockStatus(item))) {
              skuDetailsMap[item.skuId].hasNearExp = true;
            }
            if (item.qty>0 && ['Damage','Expired','Karantina'].includes(getStockStatus(item))) {
              skuDetailsMap[item.skuId].hasDamage = true;
              skuDetailsMap[item.skuId].damagedQty += item.qty;
            }
          }
        });

        completedOutbound.forEach(order=>{if(skuDetailsMap[order.skuId])skuDetailsMap[order.skuId].totalSold+=order.qty;});

        const deadstockSkus = Object.values(skuDetailsMap)
          .filter(item => item.totalStock > 0)
          .sort((a, b) => {
            if (a.totalSold !== b.totalSold) {
              return a.totalSold - b.totalSold; // lower sales first (dead stock)
            }
            return b.totalStock - a.totalStock; // higher stock first (more critical sitting stock)
          })
          .slice(0, 20);

        return (
          <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3 mb-6">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-450 border border-rose-500/15">
                    <AlertTriangle className="w-4 h-4 text-rose-400" />
                  </span>
                  20 SKU Minim Outbound (30 hari)
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Unit outbound selesai selama 30 hari terakhir. Tanpa riwayat outbound belum membuktikan barang tidak laku.
                </p>
              </div>
              <span className="text-[10px] font-black uppercase text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1 rounded-full self-start">
                Perhatian Khusus
              </span>
            </div>

            {deadstockSkus.length === 0 ? (
              <div className="text-center py-12 text-slate-500 text-xs italic">
                Tidak ada sisa stok aktif yang terdeteksi sebagai deadstock.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800/80 text-slate-400 uppercase tracking-wider font-extrabold text-[10px]">
                      <th className="py-3 px-4 w-12 text-center">No</th>
                      <th className="py-3 px-4">SKU ID & Nama Produk</th>
                      <th className="py-3 px-4">Kategori</th>
                      <th className="py-3 px-4 text-right">Total Sisa Stok</th>
                      <th className="py-3 px-4 text-right">Outbound selesai (30 hari)</th>
                      <th className="py-3 px-4 text-center">Kondisi Risiko</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {deadstockSkus.map((sku, index) => {
                      let statusBadge = (
                        <span className="text-[9px] font-black uppercase text-emerald-400 bg-emerald-500/10 border border-emerald-500/15 px-2 py-0.5 rounded-md">
                          Stok Normal
                        </span>
                      );
                      if (sku.hasDamage) {
                        statusBadge = (
                          <span className="text-[9px] font-black uppercase text-rose-400 bg-rose-500/10 border border-rose-500/15 px-2 py-0.5 rounded-md">
                            Karantina: {formatNumber(sku.damagedQty)} pcs
                          </span>
                        );
                      } else if (sku.hasNearExp) {
                        statusBadge = (
                          <span className="text-[9px] font-black uppercase text-amber-450 bg-amber-500/10 border border-amber-500/15 px-2 py-0.5 rounded-md">
                            Ada batch dekat ED
                          </span>
                        );
                      } else if (sku.totalSold === 0) {
                        statusBadge = (
                          <span className="text-[9px] font-black uppercase text-rose-300 bg-rose-500/5 border border-rose-500/10 px-2 py-0.5 rounded-md">
                            Belum ada outbound (30 hari)
                          </span>
                        );
                      }

                      return (
                        <tr key={sku.skuId} className="hover:bg-slate-900/40 transition-colors">
                          <td className="py-3 px-4 text-center font-mono font-bold text-slate-500">
                            {index + 1}
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-200">{sku.skuId}</div>
                            <div className="text-slate-450 text-[11px] truncate max-w-sm mt-0.5">{sku.skuName}</div>
                          </td>
                          <td className="py-3 px-4 text-slate-400 font-medium">
                            {sku.category}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-extrabold text-white">
                            {formatNumber(sku.totalStock)} <span className="text-[10px] text-slate-500 font-normal">pcs</span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-extrabold text-emerald-400">
                            {formatNumber(sku.totalSold)} <span className="text-[10px] text-slate-500 font-normal">pcs</span>
                          </td>
                          <td className="py-3 px-4 text-center">
                            {statusBadge}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Charts & Map Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column - Stock Status Ratio & Top Locations */}
        <div className="lg:col-span-7 space-y-6">
          {/* Top Locations by volume */}
          <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <MapPin className="w-5 h-5 text-emerald-400" />
              Lokasi dengan Stok Terbanyak
            </h3>

            <div className="space-y-4">
              {topLocations.map((loc, idx) => {
                const widthPct = Math.max(8, Math.round((loc.qty / maxLocationQty) * 100));
                let colorClass = 'bg-emerald-500';
                if (loc.name === 'ZONE 1') colorClass = 'bg-rose-500';
                else if (loc.name === 'URBAN STOCK') colorClass = 'bg-indigo-500';
                else if (loc.name === 'RACK DISPLAY') colorClass = 'bg-amber-500';

                return (
                  <div key={idx} className="space-y-1">
                    <div className="flex justify-between text-sm font-medium">
                      <span className="text-slate-300 font-mono flex items-center gap-1.5">
                        <span className="text-xs bg-slate-800/60 border border-slate-700/60 text-slate-400 px-1.5 py-0.5 rounded font-sans font-bold">
                          #{idx + 1}
                        </span>
                        {loc.name}
                      </span>
                      <span className="text-white font-extrabold">{formatNumber(loc.qty)} pcs</span>
                    </div>
                    <div className="h-3 w-full bg-slate-900/60 rounded-full overflow-hidden">
                      <div 
                        style={{ width: `${widthPct}%` }}
                        className={`h-full ${colorClass} rounded-full transition-all duration-500`}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Kategori Pergerakan (30 hari) */}
          <div className="bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Package className="w-5 h-5 text-emerald-400" />
              Kategori Pergerakan (30 hari)
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(categoryGroups)
                .sort((a, b) => b[1] - a[1])
                .map(([name, qty], idx) => {
                  let colorClass = 'bg-slate-500';
                  let bgClass = 'bg-slate-500/10 border-slate-500/20';
                  let textColor = 'text-slate-400';
                  
                  if (name === 'FAST MOVING') {
                    colorClass = 'bg-emerald-500';
                    bgClass = 'bg-emerald-500/5 border-emerald-500/10';
                    textColor = 'text-emerald-400';
                  } else if (name === 'MEDIUM') {
                    colorClass = 'bg-amber-500';
                    bgClass = 'bg-amber-500/5 border-amber-500/10';
                    textColor = 'text-amber-400';
                  } else if (name === 'SLOW MOVING') {
                    colorClass = 'bg-indigo-500';
                    bgClass = 'bg-indigo-500/5 border-indigo-500/10';
                    textColor = 'text-indigo-400';
                  } else if (name === 'DEAD STOCK') {
                    colorClass = 'bg-rose-500';
                    bgClass = 'bg-rose-500/5 border-rose-500/10';
                    textColor = 'text-rose-400';
                  }

                  const totalPct = totalStockQty > 0 ? Math.round((qty / totalStockQty) * 100) : 0;

                  return (
                    <div key={idx} className={`p-4 rounded-xl border ${bgClass} flex flex-col justify-between`}>
                      <div>
                        <span className={`text-[10px] font-extrabold uppercase tracking-wider ${textColor}`}>{name}</span>
                        <p className="text-xl font-black text-white mt-1.5">
                          {formatNumber(qty)} <span className="text-xs text-slate-500 font-normal">pcs</span>
                        </p>
                      </div>
                      <div className="mt-4 space-y-1">
                        <div className="flex justify-between text-[10px] text-slate-500 font-semibold">
                          <span>Proporsi</span>
                          <span>{totalPct}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-900/60 rounded-full overflow-hidden">
                          <div 
                            style={{ width: `${totalPct}%` }}
                            className={`h-full ${colorClass} rounded-full transition-all duration-500`}
                          ></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>

        {/* Right Column - Real-time DCC Logs */}
        <div className="lg:col-span-5">
          <div className="bg-[#11141B] rounded-xl border border-slate-800/60 shadow-md h-full flex flex-col min-h-[420px]">
            <div className="p-5 border-b border-slate-800/60 flex justify-between items-center bg-slate-900/40 rounded-t-xl">
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                </span>
                <h3 className="font-bold text-white">Aktivitas Real-time Cycle Count</h3>
              </div>
              <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full uppercase tracking-wider">
                Live Feed
              </span>
            </div>

            {/* Logs List */}
            <div className="p-4 flex-1 overflow-y-auto max-h-[360px] divide-y divide-slate-800/60">
              {logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-12 text-slate-500 h-full">
                  <Clock className="w-10 h-10 stroke-1 mb-2 animate-pulse" />
                  <p className="text-sm font-medium">Belum ada aktivitas hari ini</p>
                  <p className="text-xs text-slate-500 mt-1">Gunakan fitur outbound atau Cycle Count untuk memulai</p>
                </div>
              ) : (
                logs.slice(0, 15).map((log, idx) => {
                  let badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/15';
                  if (log.type === 'OUTBOUND') badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/15';
                  if (log.type === 'TRANSFER') badgeColor = 'bg-indigo-500/10 text-indigo-400 border-indigo-500/15';
                  if (log.type === 'ADJUSTMENT') badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/15';

                  return (
                    <div key={log.id} className="py-3 flex gap-3 text-xs items-start">
                      <div className={`shrink-0 px-2 py-0.5 rounded border text-[9px] font-extrabold uppercase ${badgeColor}`}>
                        {log.type}
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex justify-between">
                          <span className="font-semibold text-slate-200 font-mono text-[11px]">{log.skuId}</span>
                          <span className="text-slate-500 text-[10px]">{formatToWibTimeOnly(log.timestamp)}</span>
                        </div>
                        <p className="text-slate-400 line-clamp-1">{log.skuName}</p>
                        <div className="flex justify-between text-slate-500 items-center">
                          <span>{log.description}</span>
                          <span className="font-bold text-slate-300 bg-slate-900/50 border border-slate-800 px-1 rounded">Qty: {formatNumber(log.qty)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="p-4 border-t border-slate-800/60 bg-slate-900/20 rounded-b-xl text-center">
              <button
                onClick={() => onNavigate('daily-cycle-count')}
                className="text-xs font-bold text-emerald-400 hover:text-emerald-300 flex items-center justify-center gap-1 mx-auto cursor-pointer"
              >
                Lihat Detail Cycle Count
                <MoveRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
