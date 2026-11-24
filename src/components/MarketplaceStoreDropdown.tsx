import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, List, Plus, RefreshCw, Store } from 'lucide-react';
import { supabase } from '../supabase';
import type { UserAccount } from '../types';

export type HeaderMarketplaceStore = {
  id: string;
  marketplace: 'SHOPEE' | 'TIKTOK';
  store_key: string;
  store_name: string;
  mode: 'DEMO' | 'LIVE';
  connection_status: 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED' | 'PENDING';
};

interface Props {
  currentUser: UserAccount | null;
  onOpenMarketplace: () => void;
}

const COMPANY_ID = 'DEFAULT';
const isAdminRole = (role?: string) => role === 'Administrator' || role === 'Admin';

export default function MarketplaceStoreDropdown({ currentUser, onOpenMarketplace }: Props) {
  const [open, setOpen] = useState(false);
  const [stores, setStores] = useState<HeaderMarketplaceStore[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const canManage = isAdminRole(currentUser?.role);

  const fetchStores = async () => {
    if (!supabase || !canManage) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('marketplace_stores')
        .select('id,marketplace,store_key,store_name,mode,connection_status')
        .eq('company_id', COMPANY_ID)
        .order('created_at');
      setStores((data || []) as HeaderMarketplaceStore[]);
    } catch {
      // Non-fatal if migration hasn't been applied yet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!canManage) return;
    void fetchStores();
    const handler = () => void fetchStores();
    window.addEventListener('wms-marketplace-stores-updated', handler);
    return () => window.removeEventListener('wms-marketplace-stores-updated', handler);
  }, [canManage]);

  useEffect(() => {
    if (!open) return;
    void fetchStores();
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!canManage) return null;

  const connectedStoresCount = stores.filter(s => s.connection_status === 'CONNECTED').length;
  // +1 for built-in Manual Order channel (always connected)
  const totalConnected = connectedStoresCount + 1;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        id="header-daftar-toko-btn"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Daftar Toko Marketplace (Shopee, TikTok Shop, Manual Order)"
        className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-[#161B25] hover:bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-200 transition-colors cursor-pointer"
      >
        <Store size={15} className="text-indigo-400 shrink-0" />
        <span className="hidden sm:inline">Daftar Toko</span>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-black text-emerald-300">
          {totalConnected}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Daftar Toko"
          className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border border-slate-700/80 bg-[#11141B] shadow-2xl z-50 overflow-hidden"
        >
          {/* Header (Upfos-style) */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/80 bg-slate-950/50">
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold text-white">Daftar Toko</span>
              {loading && <RefreshCw size={12} className="animate-spin text-slate-400" />}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenMarketplace();
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 px-3 py-1 text-xs font-bold text-indigo-300 transition-colors cursor-pointer"
            >
              <List size={13} />
              <span>Lihat</span>
            </button>
          </div>

          {/* Store list */}
          <div className="divide-y divide-slate-800/70 max-h-80 overflow-y-auto">
            {/* Built-in Manual Order row */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-900/50 transition-colors">
              <div className="min-w-0">
                <div className="text-xs font-black text-slate-100">Others</div>
                <div className="text-[11px] font-semibold text-slate-400 truncate mt-0.5">
                  MANUAL ORDER (B2B &amp; ONLINE)
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-[11px] font-bold text-emerald-300">Terhubung</span>
                <CheckCircle2 size={15} className="text-emerald-400" />
              </div>
            </div>

            {/* Dynamic Shopee & TikTok Shop rows */}
            {stores.map(store => {
              const isConnected = store.connection_status === 'CONNECTED';
              const isPending = store.connection_status === 'PENDING';
              const isTikTok = store.marketplace === 'TIKTOK';
              return (
                <button
                  key={store.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenMarketplace();
                  }}
                  className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-900/50 transition-colors cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-black tracking-tight ${
                          isTikTok
                            ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                            : 'bg-orange-500/15 text-orange-300 border border-orange-500/30'
                        }`}
                      >
                        {isTikTok ? 'TikTok Shop' : 'Shopee'}
                      </span>
                      <span
                        className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${
                          store.mode === 'LIVE'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-amber-500/15 text-amber-300'
                        }`}
                      >
                        {store.mode}
                      </span>
                    </div>
                    <div className="text-xs font-bold text-slate-200 truncate mt-1">
                      {store.store_name}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isConnected ? 'bg-emerald-400' : isPending ? 'bg-amber-400' : 'bg-slate-500'
                      }`}
                    />
                    <span
                      className={`text-[11px] font-bold ${
                        isConnected ? 'text-emerald-300' : isPending ? 'text-amber-300' : 'text-slate-400'
                      }`}
                    >
                      {isConnected ? 'Terhubung' : isPending ? 'Menunggu' : 'Terputus'}
                    </span>
                    {isConnected && <CheckCircle2 size={15} className="text-emerald-400" />}
                  </div>
                </button>
              );
            })}

            {stores.length === 0 && (
              <div className="px-4 py-4 text-center text-xs text-slate-400">
                Belum ada toko Shopee / TikTok Shop yang dihubungkan.
              </div>
            )}
          </div>

          {/* Footer CTA */}
          <div className="p-3 border-t border-slate-800/80 bg-slate-950/60">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenMarketplace();
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 px-3 py-2 text-xs font-extrabold text-white transition-colors cursor-pointer"
            >
              <Plus size={14} />
              <span>Hubungkan Toko Shopee / TikTok Shop</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
