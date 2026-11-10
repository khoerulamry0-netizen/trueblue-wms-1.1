import {getStockStatus} from '../utils/calculations';
import { supabase, getActiveBranch } from '../supabase';
import React, { useMemo, useEffect, useState } from 'react';
import { StockItem, DccLog } from '../types';
import { formatNumber } from '../utils/calculations';
import { 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Users, 
  Layers, 
  PieChart as PieChartIcon, 
  ArrowUpRight, 
  ArrowDownRight,
  Sparkles
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
  Cell,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Legend
} from 'recharts';

interface AnalyticsDashboardProps {
  stock: StockItem[];
  logs: DccLog[];
}

export default function AnalyticsDashboard({ stock, logs }: AnalyticsDashboardProps) {
  const [movements,setMovements]=useState<{created_at:string;delta:number}[]>([]);
  const [movementError,setMovementError]=useState('');
  useEffect(()=>{
    let alive=true;
    const load=async()=>{
      try{
        if(!supabase)throw Error('Database belum terhubung.');
        const branch=getActiveBranch(),since=new Date(Date.now()-8*86400000).toISOString();
        const rows:{created_at:string;delta:number}[]=[];
        for(let page=0;;page++){
          const {data,error}=await supabase.from('stock_movements').select('id,created_at,delta').eq('branch_id',branch).gte('created_at',since).order('id',{ascending:true}).range(page*1000,page*1000+999);
          if(error)throw error;if(!alive)return;
          rows.push(...(data||[]));if((data||[]).length<1000)break;
        }
        if(alive){setMovements(rows);setMovementError('');}
      }catch(e:any){if(alive){setMovements([]);setMovementError(e.message||'Mutasi belum dapat dimuat.');}}
    };void load();return()=>{alive=false;};
  },[stock,logs]);
  // 1. Summarize stock volume by product category
  const assetMetrics = useMemo(() => {
    let totalValue = 0;
    let totalItems = 0;
    const categoryValues: Record<string, { qty: number; value: number }> = {};

    stock.forEach(item => {
      if (item.qty > 0) {
        const cat = getStockStatus(item);
        const itemVal = item.qty;

        totalValue += itemVal;
        totalItems += item.qty;

        if (categoryValues[cat]) {
          categoryValues[cat].qty += item.qty;
          categoryValues[cat].value += itemVal;
        } else {
          categoryValues[cat] = { qty: item.qty, value: itemVal };
        }
      }
    });

    const chartData = Object.entries(categoryValues).map(([name, data]) => ({
      name,
      qty: data.qty,
      value: data.value,
      percentage: totalValue > 0 ? Math.round((data.value / totalValue) * 100) : 0
    }));

    const riskQty = stock
      .filter((item) => ['Expired', 'Damage', 'Karantina', 'Near ED', 'Under 3 Month'].includes(getStockStatus(item)))
      .reduce((sum, item) => sum + item.qty, 0);
    const safeQty = stock
      .filter((item) => getStockStatus(item) === 'AMAN')
      .reduce((sum, item) => sum + item.qty, 0);

    return {
      totalValue,
      totalItems,
      totalSkus: new Set(stock.map((item) => item.skuId)).size,
      riskQty,
      safePercentage: totalItems > 0 ? Math.round((safeQty / totalItems) * 100) : 0,
      categoryValues,
      chartData
    };
  }, [stock]);

  // 2. Process Logs for In & Out Trends over time (Last 7 Days)
  const trendData = useMemo(() => {
    const dates: string[] = [];
    // Use the current date so the trend stays relevant over time.
    const baseDate = new Date(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta'}).format(new Date())+'T12:00:00');
    
    for (let i = 6; i >= 0; i--) {
      const d = new Date(baseDate);
      d.setDate(baseDate.getDate() - i);
      const dateStr = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
      dates.push(dateStr);
    }

    const dateMap: Record<string, { date: string; displayDate: string; stockIn: number; stockOut: number }> = {};
    dates.forEach(dateStr => {
      const d = new Date(dateStr);
      const day = d.getDate();
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      const displayDate = `${day} ${monthNames[d.getMonth()]}`;
      dateMap[dateStr] = {
        date: dateStr,
        displayDate,
        stockIn: 0,
        stockOut: 0
      };
    });

    movements.forEach(row=>{
      const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta'}).format(new Date(row.created_at));
      const bucket=dateMap[date];if(!bucket)return;
      const delta=Number(row.delta);if(delta>0)bucket.stockIn+=delta;else if(delta<0)bucket.stockOut-=delta;
    });

    return Object.values(dateMap);
  }, [movements]);

  // 3. Process Operator Activity counts from Logs
  const operatorData = useMemo(() => {
    const operatorCounts: Record<string, { name: string; totalActions: number; types: Record<string, number> }> = {};
    
    logs.forEach(log => {
      const user = log.user || 'Unknown';
      if (!operatorCounts[user]) {
        operatorCounts[user] = {
          name: user,
          totalActions: 0,
          types: {}
        };
      }
      operatorCounts[user].totalActions += 1;
      operatorCounts[user].types[log.type] = (operatorCounts[user].types[log.type] || 0) + 1;
    });

    return Object.values(operatorCounts)
      .sort((a, b) => b.totalActions - a.totalActions)
      .slice(0, 5) // Top 5 Operators
      .map(op => ({
        ...op,
        actions: op.totalActions
      }));
  }, [logs]);

  const COLORS = ['#10b981', '#3b82f6', '#6366f1', '#f43f5e'];

  // Custom tooltips
  const TrendTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-slate-950/95 border border-slate-800 p-3 rounded-xl shadow-2xl font-sans text-xs">
          <p className="font-bold text-slate-300 mb-1.5">{payload[0].payload.displayDate}</p>
          <div className="space-y-1">
            <p className="text-emerald-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              Masuk: <span className="font-extrabold">{formatNumber(payload[0].value)}</span> pcs
            </p>
            <p className="text-rose-450 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
              Keluar: <span className="font-extrabold">{formatNumber(payload[1].value)}</span> pcs
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  const AssetPieTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-slate-950/95 border border-slate-800 p-3 rounded-xl shadow-2xl font-sans text-xs">
          <p className="font-bold text-white uppercase mb-1">{data.name}</p>
          <div className="space-y-1">
            <p className="text-slate-300">
              Volume: <span className="text-white font-bold">{formatNumber(data.qty)} pcs</span>
            </p>
            <p className="text-emerald-400 font-bold">
              Jumlah Stok: {formatNumber(data.value)} pcs
            </p>
            <p className="text-indigo-400 font-semibold">
              Proporsi: {data.percentage}%
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  const OperatorTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-slate-950/95 border border-slate-800 p-3 rounded-xl shadow-2xl font-sans text-xs">
          <p className="font-bold text-white mb-1.5">{data.name}</p>
          <p className="text-emerald-400 font-bold mb-1">Total Aktivitas: {data.actions} transaksi</p>
          <div className="mt-1 border-t border-slate-800 pt-1 space-y-0.5 text-slate-400">
            {Object.entries(data.types).map(([type, count]: any) => (
              <p key={type} className="flex justify-between gap-4 font-mono text-[10px]">
                <span>{type}:</span>
                <span className="font-bold text-white">{count}</span>
              </p>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6" id="analytics-tab">
      {/* Title Header with Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between bg-gradient-to-r from-[#11141B] via-[#151922] to-[#121c25] rounded-2xl p-6 text-white shadow-xl border border-indigo-500/10">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
            <span className="text-xs font-black uppercase tracking-widest text-indigo-400">Visual Insights</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white mt-1">
            Analitik Stok dan Aktivitas Gudang
          </h1>
          <p className="text-slate-350 mt-1 text-sm md:text-base">
            Ringkasan stok, pergerakan barang, dan aktivitas operator berdasarkan data WMS.
          </p>
        </div>
      </div>

      {movementError && <p role="alert" className="text-rose-500">Grafik mutasi gagal dimuat: {movementError}</p>}
      {/* Visual Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Total Stock Volume */}
        <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md flex items-start gap-4">
          <div className="p-3 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
            <Layers className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Stok</p>
            <h3 className="text-2xl font-black text-white mt-1">
              {formatNumber(assetMetrics.totalValue)} pcs
            </h3>
            <p className="text-xs text-slate-450 mt-1">Jumlah unit stok yang tercatat di database</p>
          </div>
        </div>

        {/* Total Volume Stok */}
        <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md flex items-start gap-4">
          <div className="p-3 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/15">
            <Layers className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">SKU Unik</p>
            <h3 className="text-2xl font-black text-white mt-1">
              {formatNumber(assetMetrics.totalSkus)} <span className="text-xs font-normal text-slate-500">SKU</span>
            </h3>
            <p className="text-xs text-emerald-450 font-semibold mt-1 flex items-center gap-1">
              Terdistribusi di berbagai rak penyimpanan
            </p>
          </div>
        </div>

        {/* Total Operator Aktif */}
        <div className="bg-[#11141B] rounded-xl p-5 border border-slate-800/60 shadow-md flex items-start gap-4">
          <div className="p-3 rounded-lg bg-rose-500/10 text-rose-450 border border-rose-500/15">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Operator Tercatat</p>
            <h3 className="text-2xl font-black text-white mt-1">
              {operatorData.length} <span className="text-xs font-normal text-slate-500">orang</span>
            </h3>
            <p className="text-xs text-rose-450 font-semibold mt-1">
              Nama operator pada log aktivitas
            </p>
          </div>
        </div>
      </div>

      {/* Analytics Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        <p className="text-sm text-slate-600">Grafik mencakup seluruh mutasi, termasuk transfer internal dan penyesuaian stok; bukan hanya penerimaan supplier dan pengiriman pelanggan.</p>
        {/* Chart 1: Tren Keluar Masuk Barang (Area Chart) */}
        <div className="lg:col-span-8 bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
              <Activity className="w-5 h-5 text-indigo-400" />
              Seluruh Mutasi Stok Masuk vs Keluar (7 Hari Terakhir)
            </h3>
            <p className="text-xs text-slate-400 mb-6">
              Volume seluruh mutasi stok, termasuk transfer internal dan penyesuaian, untuk melihat beban aktivitas gudang.
            </p>
          </div>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={movementError ? [] : trendData}
                margin={{ top: 10, right: 10, left: -10, bottom: 5 }}
              >
                <defs>
                  <linearGradient id="colorIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorOut" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis 
                  dataKey="displayDate" 
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
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: '#475569', strokeWidth: 1 }} />
                <Legend 
                  verticalAlign="top" 
                  height={36} 
                  iconType="circle"
                  formatter={(value) => {
                    return <span className="text-xs text-slate-400 font-bold ml-1">{value === 'stockIn' ? 'Seluruh Mutasi Masuk' : 'Seluruh Mutasi Keluar'}</span>;
                  }}
                />
                <Area type="monotone" dataKey="stockIn" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorIn)" />
                <Area type="monotone" dataKey="stockOut" stroke="#f43f5e" strokeWidth={2} fillOpacity={1} fill="url(#colorOut)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Persentase Volume Stok per Kategori (Pie Donut Chart) */}
        <div className="lg:col-span-4 bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
              <PieChartIcon className="w-5 h-5 text-emerald-400" />
              Proporsi Volume Stok per Status
            </h3>
            <p className="text-xs text-slate-400 mb-6">
              Persentase jumlah unit stok berdasarkan status.
            </p>
          </div>
          <div className="h-64 w-full flex items-center justify-center relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={assetMetrics.chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={85}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {assetMetrics.chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<AssetPieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            
            {/* Center label inside Donut */}
            <div className="absolute text-center flex flex-col justify-center">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Stok</span>
              <span className="text-base font-black text-white">{formatNumber(assetMetrics.totalValue)}</span>
              <span className="text-[9px] text-emerald-400 font-semibold">pcs</span>
            </div>
          </div>
          
          {/* Legends list */}
          <div className="space-y-1.5 mt-4">
            {assetMetrics.chartData.map((entry, index) => (
              <div key={entry.name} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }}></div>
                  <span className="text-slate-400 font-medium">{entry.name}</span>
                </div>
                <div className="text-right">
                  <span className="font-bold text-white">{formatNumber(entry.value)} pcs</span>
                  <span className="text-[10px] text-slate-500 font-mono ml-2">({entry.percentage}%)</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2: Statistik Aktivitas Operator & Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Chart 3: Statistik Aktivitas Operator (Horizontal Bar Chart) */}
        <div className="lg:col-span-7 bg-[#11141B] rounded-xl p-6 border border-slate-800/60 shadow-md flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
              <Users className="w-5 h-5 text-rose-400" />
              Statistik Aktivitas Operator Teraktif (Kinerja Staf)
            </h3>
            <p className="text-xs text-slate-400 mb-6">
              Peringkat staf operator berdasarkan jumlah pencatatan transaksi masuk, keluar, transfer rak, atau audit cek fisik.
            </p>
          </div>
          <div className="h-64 w-full">
            {operatorData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 text-xs italic">
                Belum ada data riwayat mutasi operator
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={operatorData}
                  layout="vertical"
                  margin={{ top: 10, right: 10, left: 15, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                  <XAxis 
                    type="number"
                    stroke="#94a3b8" 
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis 
                    type="category"
                    dataKey="name" 
                    stroke="#94a3b8" 
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={80}
                  />
                  <Tooltip content={<OperatorTooltip />} cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }} />
                  <Bar dataKey="actions" radius={[0, 6, 6, 0]} barSize={16}>
                    {operatorData.map((entry, index) => {
                      const colors = ['#f43f5e', '#ec4899', '#3b82f6', '#10b981', '#f59e0b'];
                      return <Cell key={`cell-op-${index}`} fill={colors[index % colors.length]} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Sidebar: Business Decision Insight Panel */}
        <div className="lg:col-span-5 bg-gradient-to-br from-[#11141B] to-[#161a25] rounded-xl p-6 border border-slate-800/60 shadow-md flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-indigo-400 mb-2">
              <Sparkles className="w-4 h-4 animate-spin-slow" />
              <h4 className="text-xs font-extrabold uppercase tracking-widest">Keputusan Strategis (Data-Driven)</h4>
            </div>
            <h3 className="text-base font-bold text-white mb-4">
              Rekomendasi Optimalisasi Stok Gudang
            </h3>
            
            <div className="space-y-4 text-xs">
              {/* Insight 1: Deadstock management */}
              <div className="flex gap-3 items-start bg-rose-500/5 border border-rose-500/10 p-3 rounded-lg">
                <ArrowDownRight className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-300">Kurangi Pesanan Baru untuk Deadstock</p>
                  <p className="text-slate-400 mt-1 leading-relaxed">
                    Stok berisiko sebanyak <span className="font-bold text-white">{formatNumber(assetMetrics.riskQty)} pcs</span> berstatus kedaluwarsa, rusak, atau mendekati kedaluwarsa. Periksa lokasi dan jadwalkan tindak lanjut.
                  </p>
                </div>
              </div>

              {/* Insight 2: Fast moving stock optimization */}
              <div className="flex gap-3 items-start bg-emerald-500/5 border border-emerald-500/10 p-3 rounded-lg">
                <ArrowUpRight className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-emerald-300">Amankan Buffer Stock Fast Moving</p>
                  <p className="text-slate-400 mt-1 leading-relaxed">
                    Stok berstatus aman berjumlah <span className="font-bold text-white">{assetMetrics.safePercentage}%</span> dari total volume. Tetap pantau stok minimum untuk mencegah kehabisan barang.
                  </p>
                </div>
              </div>
              
              {/* Insight 3: Operator accountability */}
              <div className="flex gap-3 items-start bg-indigo-500/5 border border-indigo-500/10 p-3 rounded-lg">
                <Users className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-indigo-300">Akuntabilitas Operator & Shift Gudang</p>
                  <p className="text-slate-400 mt-1 leading-relaxed">
                    Operator <span className="font-bold text-white">{operatorData[0]?.name || 'Belum ada aktivitas'}</span> mencatat aktivitas transaksi tertinggi. Gunakan statistik aktivitas ini untuk menilai beban kerja dan pembagian shift yang adil.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
