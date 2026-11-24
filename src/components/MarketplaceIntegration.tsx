import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  Link2,
  Play,
  RefreshCw,
  Store,
  Unplug,
  X
} from 'lucide-react';
import { supabase } from '../supabase';
import type { CatalogItem, UserAccount } from '../types';

type MarketplacePlatform = 'SHOPEE' | 'TIKTOK';

type MarketplaceStore = {
  id: string;
  company_id: string;
  marketplace: MarketplacePlatform;
  store_key: string;
  store_name: string;
  mode: 'DEMO' | 'LIVE';
  connection_status: 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED' | 'PENDING';
  last_synced_at: string | null;
  external_shop_id?: number | null;
  external_shop_code?: string | null;
  last_error?: string | null;
};
type MarketplaceMapping = { id: string; store_id: string; external_sku: string; external_variant: string; internal_sku: string };
type MarketplaceOrder = {
  id: string;
  store_id: string;
  marketplace: MarketplacePlatform;
  external_order_id: string;
  status: 'PERLU_MAPPING' | 'SIAP_DITINJAU' | 'GAGAL';
  order_payload: { items?: DemoOrderItem[]; demo_label?: string; source?: string };
  failure_reason: string | null;
  created_at: string;
};
type DemoOrderItem = { external_sku: string; variant: string; qty: number };
type SyncRun = {
  id: string;
  store_id: string;
  started_at: string;
  finished_at: string | null;
  new_order_count: number;
  existing_order_count: number;
  failure_reason: string | null;
};

const COMPANY_ID = 'DEFAULT';
const isAdmin = (role?: string) => role === 'Administrator' || role === 'Admin';
const labelStatus = (status: MarketplaceOrder['status']) =>
  status === 'PERLU_MAPPING' ? 'Perlu Mapping' : status === 'SIAP_DITINJAU' ? 'Siap Ditinjau' : 'Gagal';
const platformLabel = (mp: MarketplacePlatform) => (mp === 'TIKTOK' ? 'TikTok Shop' : 'Shopee');
const normalize = (value: string) => value.trim().toUpperCase();

function demoItems(storeKey: string, catalog: CatalogItem[]): DemoOrderItem[] {
  const firstSku = catalog.find(item => item.skuId || item.sku)?.skuId || catalog.find(item => item.skuId || item.sku)?.sku || '';
  return storeKey.endsWith('-01')
    ? [{ external_sku: firstSku || 'DEMO-SKU-MAPPED', variant: 'Default', qty: 2 }]
    : [{ external_sku: 'DEMO-SKU-UNMAPPED', variant: 'Merah / L', qty: 1 }];
}

function notifyHeaderDropdown() {
  try {
    window.dispatchEvent(new CustomEvent('wms-marketplace-stores-updated'));
  } catch {
    // ignore in non-browser environments
  }
}

export default function MarketplaceIntegration({ currentUser, catalog }: { currentUser: UserAccount | null; catalog: CatalogItem[] }) {
  const [stores, setStores] = useState<MarketplaceStore[]>([]);
  const [mappings, setMappings] = useState<MarketplaceMapping[]>([]);
  const [orders, setOrders] = useState<MarketplaceOrder[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<MarketplaceOrder | null>(null);
  const [newStoreName, setNewStoreName] = useState('');
  const [demoPlatform, setDemoPlatform] = useState<MarketplacePlatform>('SHOPEE');
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, string>>({});
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const supabaseBaseUrl = (import.meta.env.VITE_SUPABASE_URL || 'https://<PROJECT_REF>.supabase.co').replace(/\/+$/, '');
  const shopeeCallbackUrl = `${supabaseBaseUrl}/functions/v1/shopee-live`;
  const tiktokCallbackUrl = `${supabaseBaseUrl}/functions/v1/tiktok-live`;

  const storeMap = useMemo(() => new Map(stores.map(store => [store.id, store])), [stores]);
  const catalogSkus = useMemo(() => Array.from(new Set(catalog.map(item => item.skuId || item.sku).filter(Boolean))), [catalog]);

  const copyText = (key: string, text: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const load = async () => {
    if (!supabase || !isAdmin(currentUser?.role)) return;
    setLoading(true);
    setError('');
    const [storeResult, mappingResult, orderResult, runResult] = await Promise.all([
      supabase.from('marketplace_stores').select('*').eq('company_id', COMPANY_ID).order('created_at'),
      supabase.from('marketplace_sku_mappings').select('*').eq('company_id', COMPANY_ID).order('created_at'),
      supabase.from('marketplace_orders').select('*').eq('company_id', COMPANY_ID).order('created_at', { ascending: false }),
      supabase.from('marketplace_sync_runs').select('*').eq('company_id', COMPANY_ID).order('started_at', { ascending: false }).limit(40)
    ]);
    const firstError = storeResult.error || mappingResult.error || orderResult.error || runResult.error;
    if (firstError) setError(firstError.message);
    setStores((storeResult.data || []) as MarketplaceStore[]);
    setMappings((mappingResult.data || []) as MarketplaceMapping[]);
    setOrders((orderResult.data || []) as MarketplaceOrder[]);
    setRuns((runResult.data || []) as SyncRun[]);
    setLoading(false);
    notifyHeaderDropdown();
  };

  useEffect(() => {
    void load();
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('marketplace') === 'connected') {
        const pf = params.get('platform') === 'tiktok' ? 'TikTok Shop' : 'Shopee';
        setMessage(`Toko ${pf} Live berhasil terhubung via OAuth! Klik "Sinkronkan" untuk menarik order terbaru.`);
        params.delete('marketplace');
        params.delete('platform');
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        window.history.replaceState({}, '', nextUrl);
      }
    } catch {
      // ignore URL errors
    }
  }, [currentUser?.role]);

  if (!isAdmin(currentUser?.role)) {
    return <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-200">Akses integrasi marketplace hanya tersedia untuk Administrator.</div>;
  }
  if (!supabase) return <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-200">Supabase belum dikonfigurasi. Fitur integrasi belum dapat digunakan.</div>;

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError('');
    setMessage('');
    try {
      await action();
      await load();
    } catch (e: any) {
      setError(e?.message || 'Aksi marketplace gagal.');
    } finally {
      setBusy(null);
    }
  };

  const addDemoStore = () =>
    run('add-store', async () => {
      const sameDemoCount = stores.filter(s => s.mode === 'DEMO' && s.marketplace === demoPlatform).length;
      const defaultName = `${platformLabel(demoPlatform)} Demo ${sameDemoCount + 1}`;
      const name = newStoreName.trim() || defaultName;
      const storeKey = `${demoPlatform}-DEMO-${String(sameDemoCount + 1).padStart(2, '0')}`;
      const { error: insertError } = await supabase.from('marketplace_stores').insert({
        company_id: COMPANY_ID,
        marketplace: demoPlatform,
        store_key: storeKey,
        store_name: name,
        mode: 'DEMO',
        connection_status: 'CONNECTED',
        created_by: currentUser?.id || null
      });
      if (insertError) throw insertError;
      setNewStoreName('');
      setMessage(`Toko ${platformLabel(demoPlatform)} Demo tersambung. Data tetap berlabel Demo dan tidak mengirim perubahan ke marketplace.`);
    });

  const disconnect = (store: MarketplaceStore) =>
    run(`disconnect-${store.id}`, async () => {
      const { error: updateError } = await supabase
        .from('marketplace_stores')
        .update({ connection_status: 'DISCONNECTED' })
        .eq('id', store.id)
        .eq('mode', 'DEMO');
      if (updateError) throw updateError;
    });

  const reconnect = (store: MarketplaceStore) =>
    run(`reconnect-${store.id}`, async () => {
      const { error: updateError } = await supabase
        .from('marketplace_stores')
        .update({ connection_status: 'CONNECTED' })
        .eq('id', store.id)
        .eq('mode', 'DEMO');
      if (updateError) throw updateError;
      setMessage('Toko Demo tersambung kembali. Koneksi ini tetap simulasi dan tidak memakai akses Live.');
    });

  const connectLive = (platform: MarketplacePlatform) =>
    run(`connect-live-${platform}`, async () => {
      const label = platformLabel(platform);
      const storeName = window.prompt(`Nama toko ${label} Live:`, `${label} Live`);
      if (storeName === null) return;
      const fnName = platform === 'TIKTOK' ? 'tiktok-live' : 'shopee-live';
      const { data, error: invokeError } = await supabase.functions.invoke(fnName, {
        body: { action: 'authorize', storeName }
      });
      if (invokeError) {
        setShowSetupGuide(true);
        throw new Error(
          `Edge Function "${fnName}" belum aktif atau secret API belum dipasang. Buka Panduan Setup API Live di bawah untuk memasang kunci ${label}.`
        );
      }
      if (!data?.authorizationUrl) {
        setShowSetupGuide(true);
        throw new Error(data?.error || `Link otorisasi ${label} belum tersedia. Pastikan secret API sudah dipasang.`);
      }
      window.location.assign(data.authorizationUrl);
    });

  const syncStore = (store: MarketplaceStore) =>
    run(`sync-${store.id}`, async () => {
      if (store.connection_status !== 'CONNECTED') {
        throw new Error('Toko sedang terputus. Sambungkan kembali melalui konfigurasi resmi tahap live.');
      }
      if (store.mode === 'LIVE') {
        const fnName = store.marketplace === 'TIKTOK' ? 'tiktok-live' : 'shopee-live';
        const { data, error: invokeError } = await supabase.functions.invoke(fnName, {
          body: { action: 'sync', storeId: store.id }
        });
        if (invokeError) throw invokeError;
        if (data?.error) throw new Error(data.error);
        setMessage(
          `${platformLabel(store.marketplace)} Live terbaca: ${data?.orderCount ?? 0} order (${data?.newCount ?? 0} baru). Order masuk antrean mapping terlebih dahulu dan tidak langsung mengubah stok.`
        );
        return;
      }
      const started = new Date().toISOString();
      const items = demoItems(store.store_key, catalog);
      const prefix = store.marketplace === 'TIKTOK' ? 'DEMO-TTS-ORDER' : 'DEMO-SHP-ORDER';
      const externalId = store.store_key.endsWith('-01') ? `${prefix}-001` : `${prefix}-002`;
      const { data: existing } = await supabase
        .from('marketplace_orders')
        .select('id')
        .eq('company_id', COMPANY_ID)
        .eq('marketplace', store.marketplace)
        .eq('store_id', store.id)
        .eq('external_order_id', externalId)
        .maybeSingle();
      let newCount = 0;
      let existingCount = 0;
      if (existing?.id) existingCount = 1;
      else {
        const mapped = mappings.some(
          mapping =>
            mapping.store_id === store.id &&
            normalize(mapping.external_sku) === normalize(items[0].external_sku) &&
            normalize(mapping.external_variant) === normalize(items[0].variant)
        );
        const { error: insertError } = await supabase.from('marketplace_orders').insert({
          company_id: COMPANY_ID,
          store_id: store.id,
          marketplace: store.marketplace,
          external_order_id: externalId,
          order_payload: {
            demo_label: `DEMO — data simulasi ${platformLabel(store.marketplace)}, tanpa data pembeli`,
            items
          },
          status: mapped ? 'SIAP_DITINJAU' : 'PERLU_MAPPING'
        });
        if (insertError && insertError.code !== '23505') throw insertError;
        if (insertError?.code === '23505') existingCount = 1;
        else newCount = 1;
      }
      const finished = new Date().toISOString();
      await supabase.from('marketplace_stores').update({ last_synced_at: finished }).eq('id', store.id);
      const { error: runError } = await supabase.from('marketplace_sync_runs').insert({
        company_id: COMPANY_ID,
        store_id: store.id,
        started_at: started,
        finished_at: finished,
        new_order_count: newCount,
        existing_order_count: existingCount,
        created_by: currentUser?.id || null
      });
      if (runError) throw runError;
      setMessage(`Sinkronisasi Demo selesai: ${newCount} order baru, ${existingCount} sudah ada. Tidak ada stok atau antrean fulfillment yang berubah.`);
    });

  const saveMapping = (order: MarketplaceOrder, item: DemoOrderItem) =>
    run(`map-${order.id}-${item.external_sku}`, async () => {
      const internalSku = mappingDrafts[`${order.id}|${item.external_sku}|${item.variant}`] || '';
      if (!internalSku) throw new Error('Pilih SKU internal WMS terlebih dahulu.');
      const { error: mappingError } = await supabase.from('marketplace_sku_mappings').upsert(
        {
          company_id: COMPANY_ID,
          store_id: order.store_id,
          external_sku: item.external_sku,
          external_variant: item.variant,
          internal_sku: internalSku,
          created_by: currentUser?.id || null
        },
        { onConflict: 'store_id,external_sku,external_variant' }
      );
      if (mappingError) throw mappingError;
      await load();
      const latestMappings = [
        ...mappings,
        { store_id: order.store_id, external_sku: item.external_sku, external_variant: item.variant, internal_sku: internalSku } as MarketplaceMapping
      ];
      const ready = (order.order_payload.items || []).every(line =>
        latestMappings.some(
          mapping =>
            mapping.store_id === order.store_id &&
            normalize(mapping.external_sku) === normalize(line.external_sku) &&
            normalize(mapping.external_variant) === normalize(line.variant)
        )
      );
      if (ready) {
        const { error: statusError } = await supabase
          .from('marketplace_orders')
          .update({ status: 'SIAP_DITINJAU', failure_reason: null })
          .eq('id', order.id);
        if (statusError) throw statusError;
      }
      setMessage('Pemetaan tersimpan. Order tetap di antrean marketplace dan belum masuk picking atau fulfillment.');
    });

  const mappingFor = (order: MarketplaceOrder, item: DemoOrderItem) =>
    mappings.find(
      mapping =>
        mapping.store_id === order.store_id &&
        normalize(mapping.external_sku) === normalize(item.external_sku) &&
        normalize(mapping.external_variant) === normalize(item.variant)
    );

  const exactSuggestion = (item: DemoOrderItem) => {
    const matches = catalogSkus.filter(sku => normalize(sku) === normalize(item.external_sku));
    return matches.length === 1 ? matches[0] : null;
  };

  const visibleOrders = selectedStoreId ? orders.filter(order => order.store_id === selectedStoreId) : orders;
  const activeDemoCount = stores.filter(store => store.mode === 'DEMO' && store.connection_status === 'CONNECTED').length;
  const liveShopeeStores = stores.filter(store => store.mode === 'LIVE' && store.marketplace === 'SHOPEE');
  const liveTikTokStores = stores.filter(store => store.mode === 'LIVE' && store.marketplace === 'TIKTOK');

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/70 via-[#11141B] to-emerald-950/50 p-5 shadow-lg">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-indigo-300 text-[10px] font-extrabold tracking-[0.18em] uppercase">
              <Store size={15} /> Marketplace OAuth &amp; Daftar Toko
            </div>
            <h1 className="mt-2 text-2xl font-black text-white">Integrasi Marketplace (Shopee &amp; TikTok Shop)</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Hubungkan toko Shopee dan TikTok Shop via OAuth resmi seperti Upfos. Order yang masuk ditahan di antrean mapping untuk ditinjau terlebih dahulu sebelum masuk proses fulfillment.
            </p>
          </div>
          <div className="flex flex-col items-start md:items-end gap-2">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-200">
              DEMO &amp; LIVE SAFE · Mode DEMO tidak menyentuh stok, picking, packing, resi, atau marketplace
            </div>
            <button
              type="button"
              onClick={() => setShowSetupGuide(v => !v)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 px-3 py-1.5 text-xs font-bold text-sky-200 cursor-pointer transition-colors"
            >
              <BookOpen size={14} />
              <span>Panduan Daftar API Live (Shopee &amp; TikTok)</span>
              {showSetupGuide ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Collapsible Setup Guide for Shopee & TikTok Shop Live OAuth */}
      {showSetupGuide && (
        <section className="rounded-2xl border border-sky-500/30 bg-[#11141B] p-5 space-y-4 shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-extrabold text-sky-200 flex items-center gap-2">
                <BookOpen size={16} className="text-sky-400" />
                Panduan Setup 1 Kali Agar Bisa Login Toko Shopee &amp; TikTok Shop (Seperti Upfos)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Cukup daftar aplikasi tipe <strong>In-House / Seller App</strong> (gratis) 1 kali. Setelah kunci API dipasang di Supabase Secrets, semua admin tinggal klik <strong>Hubungkan Live</strong> → login Seller Center → langsung Terhubung.
              </p>
            </div>
            <button type="button" onClick={() => setShowSetupGuide(false)} className="text-slate-400 hover:text-white cursor-pointer">
              <X size={16} />
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Shopee Guide */}
            <div className="rounded-xl border border-orange-500/30 bg-orange-950/15 p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-black text-orange-300 text-sm">1. Shopee Open Platform</span>
                <a
                  href="https://open.shopee.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-orange-300 hover:text-orange-200 font-bold underline"
                >
                  open.shopee.com <ExternalLink size={12} />
                </a>
              </div>
              <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                <li>Daftar / login akun Developer → pilih tipe <strong>In-House System</strong>.</li>
                <li>Buat App baru → isi <strong>Redirect URL</strong> dengan link callback di bawah.</li>
                <li>Setelah disetujui, ambil <code>Partner ID</code> &amp; <code>Partner Key</code>.</li>
                <li>Pasang di Supabase Secrets: <code>SHOPEE_PARTNER_ID</code>, <code>SHOPEE_PARTNER_KEY</code>, <code>SHOPEE_REDIRECT_URI</code>, <code>WMS_APP_URL</code>.</li>
              </ol>
              <div className="pt-1">
                <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Redirect / Callback URL Shopee:</div>
                <div className="flex items-center gap-2 bg-[#161B25] border border-slate-700 rounded-lg px-2.5 py-1.5">
                  <code className="text-[11px] text-orange-200 truncate flex-1">{shopeeCallbackUrl}</code>
                  <button
                    type="button"
                    onClick={() => copyText('shopee-cb', shopeeCallbackUrl)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-300 hover:text-white cursor-pointer shrink-0"
                  >
                    {copiedKey === 'shopee-cb' ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                    <span>{copiedKey === 'shopee-cb' ? 'Disalin' : 'Salin'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* TikTok Shop Guide */}
            <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/15 p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-black text-cyan-300 text-sm">2. TikTok Shop Partner Center</span>
                <a
                  href="https://partner.tiktokshop.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 font-bold underline"
                >
                  partner.tiktokshop.com <ExternalLink size={12} />
                </a>
              </div>
              <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                <li>Daftar / login Partner Center → pilih <strong>Seller In-House / Custom App</strong>.</li>
                <li>Buat App baru → isi <strong>Redirect URL</strong> dengan link callback di bawah.</li>
                <li>Aktifkan scope <code>Order Information (Read)</code> &amp; <code>Authorized Shops</code>.</li>
                <li>Pasang di Supabase Secrets: <code>TIKTOK_APP_KEY</code>, <code>TIKTOK_APP_SECRET</code>, <code>TIKTOK_REDIRECT_URI</code>, <code>WMS_APP_URL</code>.</li>
              </ol>
              <div className="pt-1">
                <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Redirect / Callback URL TikTok Shop:</div>
                <div className="flex items-center gap-2 bg-[#161B25] border border-slate-700 rounded-lg px-2.5 py-1.5">
                  <code className="text-[11px] text-cyan-200 truncate flex-1">{tiktokCallbackUrl}</code>
                  <button
                    type="button"
                    onClick={() => copyText('tiktok-cb', tiktokCallbackUrl)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-300 hover:text-white cursor-pointer shrink-0"
                  >
                    {copiedKey === 'tiktok-cb' ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                    <span>{copiedKey === 'tiktok-cb' ? 'Disalin' : 'Salin'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {(error || message) && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${error ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}>
          {error || message}
        </div>
      )}

      {/* Store List Table */}
      <section className="rounded-2xl border border-slate-800/80 bg-[#11141B] shadow-md">
        <div className="flex flex-col gap-3 border-b border-slate-800/80 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-extrabold text-white">Daftar Toko Marketplace</h2>
            <p className="mt-1 text-xs text-slate-500">
              1 Manual Order aktif · {activeDemoCount} toko Demo · {liveShopeeStores.length} Shopee Live · {liveTikTokStores.length} TikTok Shop Live
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={demoPlatform}
              onChange={e => setDemoPlatform(e.target.value as MarketplacePlatform)}
              aria-label="Pilih marketplace untuk toko Demo"
              className="rounded-xl border border-slate-700 bg-[#161B25] px-2.5 py-2 text-xs text-white outline-none focus:border-indigo-500"
            >
              <option value="SHOPEE">Shopee (Demo)</option>
              <option value="TIKTOK">TikTok Shop (Demo)</option>
            </select>
            <input
              value={newStoreName}
              onChange={e => setNewStoreName(e.target.value)}
              placeholder="Nama toko Demo"
              className="rounded-xl border border-slate-700 bg-[#161B25] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={addDemoStore}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 px-3 py-2 text-xs font-extrabold text-white disabled:opacity-50 cursor-pointer"
            >
              <Store size={14} /> Tambah Demo
            </button>
            <button
              type="button"
              id="btn-connect-shopee-live"
              onClick={() => connectLive('SHOPEE')}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-xl border border-orange-500/40 bg-orange-500/15 hover:bg-orange-500/25 px-3 py-2 text-xs font-extrabold text-orange-200 disabled:opacity-50 cursor-pointer"
            >
              <Link2 size={14} /> Hubungkan Shopee Live
            </button>
            <button
              type="button"
              id="btn-connect-tiktok-live"
              onClick={() => connectLive('TIKTOK')}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-2 text-xs font-extrabold text-cyan-200 disabled:opacity-50 cursor-pointer"
            >
              <Link2 size={14} /> Hubungkan TikTok Shop Live
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/60 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">Toko</th>
                <th className="px-5 py-3">Marketplace</th>
                <th className="px-5 py-3">Mode</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Sinkronisasi terakhir</th>
                <th className="px-5 py-3">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {/* Built-in Manual Order Channel (Upfos-style Others / MANUAL ORDER) */}
              <tr className="border-t border-slate-800/70 bg-slate-950/20">
                <td className="px-5 py-3.5">
                  <div className="font-bold text-white">MANUAL ORDER</div>
                  <div className="font-mono text-[10px] text-slate-500">B2B &amp; ONLINE · INPUT / IMPORT EXCEL</div>
                </td>
                <td className="px-5 py-3.5 text-slate-300 font-semibold">Others</td>
                <td className="px-5 py-3.5">
                  <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-300">
                    Built-in
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300">
                    <CheckCircle2 size={12} /> Terhubung
                  </span>
                </td>
                <td className="px-5 py-3.5 text-slate-400">Real-time</td>
                <td className="px-5 py-3.5 text-slate-500">Aktif otomatis</td>
              </tr>

              {stores.map(store => {
                const isTikTok = store.marketplace === 'TIKTOK';
                return (
                  <tr key={store.id} className="border-t border-slate-800/70">
                    <td className="px-5 py-4">
                      <div className="font-bold text-white">{store.store_name}</div>
                      <div className="font-mono text-[10px] text-slate-500">{store.store_key}</div>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-black ${
                          isTikTok
                            ? 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300'
                            : 'border-orange-500/30 bg-orange-500/15 text-orange-300'
                        }`}
                      >
                        {platformLabel(store.marketplace)}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`rounded-full border px-2 py-1 text-[10px] font-bold ${
                          store.mode === 'LIVE'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        }`}
                      >
                        {store.mode === 'LIVE' ? 'Live' : 'Demo'}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold ${
                          store.connection_status === 'CONNECTED'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : store.connection_status === 'PENDING'
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                              : 'border-slate-700 bg-slate-800 text-slate-400'
                        }`}
                      >
                        {store.connection_status === 'CONNECTED' && <CheckCircle2 size={12} />}
                        {store.connection_status === 'CONNECTED'
                          ? store.mode === 'LIVE'
                            ? 'Terhubung Live'
                            : 'Terhubung Demo'
                          : store.connection_status === 'PENDING'
                            ? 'Menunggu otorisasi'
                            : 'Terputus'}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-slate-400">
                      {store.last_synced_at ? new Date(store.last_synced_at).toLocaleString('id-ID') : 'Belum pernah'}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex gap-2">
                        {store.connection_status === 'CONNECTED' ? (
                          <>
                            <button
                              type="button"
                              onClick={() => syncStore(store)}
                              disabled={busy !== null}
                              className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 px-2.5 py-1.5 font-bold text-indigo-300 disabled:opacity-40 cursor-pointer"
                            >
                              <RefreshCw size={13} /> Sinkronkan
                            </button>
                            {store.mode === 'DEMO' && (
                              <button
                                type="button"
                                onClick={() => disconnect(store)}
                                disabled={busy !== null}
                                className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 px-2.5 py-1.5 font-bold text-rose-300 disabled:opacity-40 cursor-pointer"
                              >
                                <Unplug size={13} /> Putuskan
                              </button>
                            )}
                          </>
                        ) : store.mode === 'DEMO' ? (
                          <button
                            type="button"
                            onClick={() => reconnect(store)}
                            disabled={busy !== null}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 px-2.5 py-1.5 font-bold text-emerald-300 disabled:opacity-40 cursor-pointer"
                          >
                            <Play size={13} /> Sambungkan
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => connectLive(store.marketplace)}
                            disabled={busy !== null}
                            className="font-bold text-emerald-300 hover:underline cursor-pointer"
                          >
                            Otorisasi ulang
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!liveShopeeStores.length && (
                <tr className="border-t border-slate-800/70 bg-slate-950/15">
                  <td className="px-5 py-3.5 font-bold text-slate-300">Shopee Live</td>
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center rounded-md border border-orange-500/30 bg-orange-500/15 px-2 py-0.5 text-[10px] font-black text-orange-300">
                      Shopee
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">Live</td>
                  <td className="px-5 py-3.5">
                    <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-400">
                      Belum terhubung
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500">Menunggu otorisasi toko</td>
                  <td className="px-5 py-3.5">
                    <button
                      type="button"
                      onClick={() => connectLive('SHOPEE')}
                      disabled={busy !== null}
                      className="font-bold text-orange-300 hover:text-orange-200 disabled:opacity-40 cursor-pointer"
                    >
                      Hubungkan
                    </button>
                  </td>
                </tr>
              )}

              {!liveTikTokStores.length && (
                <tr className="border-t border-slate-800/70 bg-slate-950/15">
                  <td className="px-5 py-3.5 font-bold text-slate-300">TikTok Shop Live</td>
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-black text-cyan-300">
                      TikTok Shop
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">Live</td>
                  <td className="px-5 py-3.5">
                    <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-400">
                      Belum terhubung
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500">Menunggu otorisasi toko</td>
                  <td className="px-5 py-3.5">
                    <button
                      type="button"
                      onClick={() => connectLive('TIKTOK')}
                      disabled={busy !== null}
                      className="font-bold text-cyan-300 hover:text-cyan-200 disabled:opacity-40 cursor-pointer"
                    >
                      Hubungkan
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Order Queue & Sync History */}
      <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-2xl border border-slate-800/80 bg-[#11141B] shadow-md">
          <div className="flex items-center justify-between border-b border-slate-800/80 p-5">
            <div>
              <h2 className="text-base font-extrabold text-white">Antrean Order Marketplace</h2>
              <p className="mt-1 text-xs text-slate-500">Order yang ditarik dari Shopee &amp; TikTok Shop ditinjau &amp; dipetakan di sini sebelum fulfillment.</p>
            </div>
            <select
              value={selectedStoreId}
              onChange={e => setSelectedStoreId(e.target.value)}
              className="rounded-xl border border-slate-700 bg-[#161B25] px-3 py-2 text-xs text-white"
            >
              <option value="">Semua toko</option>
              {stores.map(store => (
                <option key={store.id} value={store.id}>
                  {store.store_name} ({platformLabel(store.marketplace)})
                </option>
              ))}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-3">Order eksternal</th>
                  <th className="px-5 py-3">Toko</th>
                  <th className="px-5 py-3">Item / Qty</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Preview</th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map(order => (
                  <tr key={order.id} className="border-t border-slate-800/70">
                    <td className="px-5 py-4 font-mono font-bold text-indigo-300">{order.external_order_id}</td>
                    <td className="px-5 py-4 text-slate-300">{storeMap.get(order.store_id)?.store_name || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">
                      {(order.order_payload.items || []).map(item => (
                        <div key={`${item.external_sku}-${item.variant}`}>
                          {item.external_sku} · {item.variant} × {item.qty}
                        </div>
                      ))}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`rounded-full border px-2 py-1 text-[10px] font-bold ${
                          order.status === 'SIAP_DITINJAU'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        }`}
                      >
                        {labelStatus(order.status)}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setSelectedOrder(order)}
                        className="inline-flex items-center gap-1 font-bold text-indigo-300 cursor-pointer"
                      >
                        Lihat <ChevronRight size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!visibleOrders.length && (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-slate-500">
                      Belum ada order marketplace. Hubungkan toko lalu klik Sinkronkan.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800/80 bg-[#11141B] shadow-md">
          <div className="border-b border-slate-800/80 p-5">
            <h2 className="text-base font-extrabold text-white">Riwayat Sinkronisasi</h2>
            <p className="mt-1 text-xs text-slate-500">Hanya metadata proses, tanpa token atau data pembeli.</p>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {runs.map(runItem => (
              <div key={runItem.id} className="border-b border-slate-800/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-slate-300">{storeMap.get(runItem.store_id)?.store_name || 'Toko'}</span>
                  <span className="text-[10px] text-slate-600">{new Date(runItem.started_at).toLocaleString('id-ID')}</span>
                </div>
                <div className="mt-2 text-xs text-slate-400">
                  Baru <strong className="text-emerald-300">{runItem.new_order_count}</strong> · Sudah ada{' '}
                  <strong className="text-slate-200">{runItem.existing_order_count}</strong>
                  {runItem.failure_reason && <div className="mt-1 text-rose-300">Gagal: {runItem.failure_reason}</div>}
                </div>
              </div>
            ))}
            {!runs.length && <div className="p-8 text-center text-slate-500">Belum ada riwayat.</div>}
          </div>
        </div>
      </section>

      {/* SKU Mapping Section */}
      <section className="rounded-2xl border border-slate-800/80 bg-[#11141B] shadow-md">
        <div className="border-b border-slate-800/80 p-5">
          <h2 className="text-base font-extrabold text-white">Pemetaan SKU per Toko</h2>
          <p className="mt-1 text-xs text-slate-500">
            Pasangan hanya menggunakan SKU dan varian (mendukung SKU satuan maupun SKU Master Bundling). SKU internal tidak diubah dan stok tidak disentuh.
          </p>
        </div>
        <div className="grid gap-4 p-5 md:grid-cols-2">
          {orders
            .filter(order => order.status === 'PERLU_MAPPING')
            .flatMap(order => (order.order_payload.items || []).map(item => ({ order, item })))
            .map(({ order, item }) => {
              const existing = mappingFor(order, item);
              const key = `${order.id}|${item.external_sku}|${item.variant}`;
              const suggestion = exactSuggestion(item);
              return (
                <div key={key} className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-extrabold uppercase tracking-wider text-amber-300">Perlu ditangani</div>
                      <div className="mt-1 font-mono text-xs font-bold text-white">{item.external_sku}</div>
                      <div className="text-xs text-slate-400">
                        {item.variant} · {storeMap.get(order.store_id)?.store_name}
                      </div>
                      {suggestion && (
                        <button
                          type="button"
                          onClick={() => setMappingDrafts(current => ({ ...current, [key]: suggestion }))}
                          className="mt-2 text-[10px] font-bold text-indigo-300 cursor-pointer"
                        >
                          Saran exact match: {suggestion} · pakai saran
                        </button>
                      )}
                    </div>
                    <AlertTriangle size={17} className="text-amber-300" />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <select
                      value={existing?.internal_sku || mappingDrafts[key] || ''}
                      onChange={e => setMappingDrafts(current => ({ ...current, [key]: e.target.value }))}
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#161B25] px-2.5 py-2 text-xs text-white"
                    >
                      <option value="">Pilih SKU internal WMS</option>
                      {catalogSkus.map(sku => (
                        <option key={sku} value={sku}>
                          {sku}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => saveMapping(order, item)}
                      disabled={busy !== null || !mappingDrafts[key]}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40 cursor-pointer"
                    >
                      <Check size={14} /> Simpan
                    </button>
                  </div>
                </div>
              );
            })}
          {!orders.some(order => order.status === 'PERLU_MAPPING') && (
            <div className="col-span-full rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center text-sm text-emerald-300">
              Tidak ada SKU yang tertahan. Sinkronkan toko untuk menarik order terbaru.
            </div>
          )}
        </div>
      </section>

      {/* Order Preview Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setSelectedOrder(null)}>
          <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-[#11141B] shadow-2xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-800 p-5">
              <div>
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-300">
                  Preview Order {platformLabel(selectedOrder.marketplace)}
                </div>
                <h3 className="mt-1 font-mono text-lg font-black text-white">{selectedOrder.external_order_id}</h3>
              </div>
              <button type="button" onClick={() => setSelectedOrder(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-bold text-amber-200">
                Order ini berada di antrean tinjauan marketplace. Tidak masuk antrean picking, tidak reservasi stok, tidak mengurangi stok, dan tidak mengirim update ke marketplace.
              </div>
              <div className="rounded-xl border border-slate-800 bg-[#161B25] p-4 text-sm text-slate-300">
                <div className="mb-3 text-xs font-bold text-slate-500">
                  {selectedOrder.order_payload.demo_label || selectedOrder.order_payload.source || 'Order Marketplace'}
                </div>
                {(selectedOrder.order_payload.items || []).map(item => (
                  <div key={`${item.external_sku}-${item.variant}`} className="flex items-center justify-between border-t border-slate-800 py-3">
                    <span>
                      <strong className="font-mono text-white">{item.external_sku}</strong>
                      <br />
                      <span className="text-xs text-slate-500">{item.variant}</span>
                    </span>
                    <span className="font-bold text-white">× {item.qty}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Status antrean</span>
                <span className="font-bold text-amber-300">{labelStatus(selectedOrder.status)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="fixed bottom-5 right-5 rounded-xl border border-indigo-500/30 bg-indigo-950 px-4 py-3 text-xs font-bold text-indigo-200">
          <RefreshCw size={14} className="mr-2 inline animate-spin" /> Memuat integrasi…
        </div>
      )}
    </div>
  );
}
