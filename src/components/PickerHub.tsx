import React from 'react';
import { ClipboardList, Boxes, ArrowRight, ShieldCheck, ShoppingCart, Sparkles } from 'lucide-react';
import type { BranchOperationType, UserAccount } from '../types';

interface PickerHubProps {
  currentUser: UserAccount | null;
  branchOperationType?: BranchOperationType;
  onSelectMenu: (menuId: 'b2b-picking' | 'online-picking') => void;
}

export default function PickerHub({
  currentUser,
  branchOperationType = 'HYBRID',
  onSelectMenu,
}: PickerHubProps) {
  const showB2b = branchOperationType !== 'ONLINE';
  const showOnline = branchOperationType !== 'B2B';
  return (
    <div className="min-h-[80vh] flex flex-col justify-center items-center px-4 py-8 max-w-5xl mx-auto animate-fadeIn">
      {/* Welcome Banner */}
      <div className="text-center mb-8 max-w-2xl">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold mb-4">
          <Sparkles className="w-3.5 h-3.5 text-blue-400 animate-pulse" />
          <span>Portal Operasional Pengambilan Barang</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
          Selamat Bertugas, <span className="text-blue-400">{currentUser?.fullName || 'Picker'}</span>! 👋
        </h1>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed">
          Cabang aktif bertipe <span className="text-blue-300 font-bold">{branchOperationType}</span>. Pilih jalur operasional picking yang sesuai agar pesanan <span className="text-amber-400 font-bold">B2B / Offline</span> dan <span className="text-emerald-400 font-bold">Online Marketplace</span> tidak tertukar.
        </p>
      </div>

      {/* Choice Cards */}
      <div className={`grid grid-cols-1 ${showB2b && showOnline ? 'md:grid-cols-2' : 'max-w-xl'} gap-6 w-full`}>
        {showB2b && (
        <div
          onClick={() => onSelectMenu('b2b-picking')}
          className="group relative bg-[#11141B] hover:bg-[#161B26] border-2 border-slate-800 hover:border-amber-500/70 rounded-2xl p-6 sm:p-8 cursor-pointer transition-all duration-200 shadow-lg hover:shadow-amber-500/10 hover:-translate-y-1 flex flex-col justify-between"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectMenu('b2b-picking'); }}
        >
          <div>
            <div className="flex items-center justify-between mb-5">
              <div className="w-14 h-14 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 group-hover:scale-110 transition-transform">
                <ClipboardList className="w-7 h-7" />
              </div>
              <span className="px-3 py-1 text-xs font-black uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full">
                B2B & Offline
              </span>
            </div>

            <h2 className="text-xl font-black text-white group-hover:text-amber-300 transition-colors">
              Outbound B2B / Offline
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Pengambilan barang untuk pesanan partai besar, distributor, order cabang fisik, atau pesanan manual non-marketplace.
            </p>

            <div className="mt-5 space-y-2 border-t border-slate-800/80 pt-4 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Rute lokasi rak teroptimasi otomatis</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Picking batch & cetak label surat jalan</span>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between text-amber-400 font-bold text-sm group-hover:translate-x-1 transition-transform">
            <span>Buka Picking B2B</span>
            <ArrowRight className="w-5 h-5" />
          </div>
        </div>
        )}

        {showOnline && (
        <div
          onClick={() => onSelectMenu('online-picking')}
          className="group relative bg-[#11141B] hover:bg-[#161B26] border-2 border-slate-800 hover:border-emerald-500/70 rounded-2xl p-6 sm:p-8 cursor-pointer transition-all duration-200 shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-1 flex flex-col justify-between"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectMenu('online-picking'); }}
        >
          <div>
            <div className="flex items-center justify-between mb-5">
              <div className="w-14 h-14 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 group-hover:scale-110 transition-transform">
                <Boxes className="w-7 h-7" />
              </div>
              <span className="px-3 py-1 text-xs font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full">
                Online Marketplace
              </span>
            </div>

            <h2 className="text-xl font-black text-white group-hover:text-emerald-300 transition-colors">
              Outbound Online
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Pengambilan barang pesanan e-commerce (Shopee, Tokopedia, TikTok Shop, Lazada) dengan sistem keranjang induk & wave picking.
            </p>

            <div className="mt-5 space-y-2 border-t border-slate-800/80 pt-4 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Scan keranjang induk & pemindaian SKU produk</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Otomatis terhubung ke meja sortir & packing online</span>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between text-emerald-400 font-bold text-sm group-hover:translate-x-1 transition-transform">
            <span>Buka Picking Online</span>
            <ArrowRight className="w-5 h-5" />
          </div>
        </div>
        )}
      </div>

      {/* Helpful Hint */}
      <div className="mt-8 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
        <span>💡 Anda juga dapat berpindah menu kapan saja melalui bilah navigasi di sisi kiri layar.</span>
      </div>
    </div>
  );
}
