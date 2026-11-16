import React, { useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Copy, Eye, EyeOff, KeyRound, Package, Send, Webhook } from 'lucide-react';
import type { BranchOperationType, UserAccount } from '../types';
import { getActiveBranch, supabase } from '../supabase';

interface MarketplaceWebhookProps {
  currentUser: UserAccount | null;
  branchOperationType?: BranchOperationType;
  onNavigateTab: (tabId: string) => void;
}

const MARKETPLACE_CHANNEL_MAP: Record<string, { orderSource: string; expectedType: 'ONLINE' | 'UNASSIGNED' }> = {
  Shopee: { orderSource: 'SHOPEE', expectedType: 'ONLINE' },
  'TikTok Shop': { orderSource: 'TIKTOK_SHOP', expectedType: 'ONLINE' },
  Tokopedia: { orderSource: 'TOKOPEDIA', expectedType: 'ONLINE' },
  Lazada: { orderSource: 'LAZADA', expectedType: 'ONLINE' },
  Blibli: { orderSource: 'BLIBLI', expectedType: 'ONLINE' },
  'Mabang ERP': { orderSource: 'MABANG', expectedType: 'ONLINE' },
  Jubelio: { orderSource: 'JUBELIO', expectedType: 'ONLINE' },
  'Manual / Custom': { orderSource: 'WEBHOOK_CUSTOM', expectedType: 'UNASSIGNED' },
};

export function MarketplaceWebhook({
  currentUser,
  branchOperationType = 'HYBRID',
  onNavigateTab,
}: MarketplaceWebhookProps) {
  const activeBranch = getActiveBranch();
  const [secretKey, setSecretKey] = useState('TRUEBLUE_WEBHOOK_2026');
  const [showSecret, setShowSecret] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const [testOrderNumber, setTestOrderNumber] = useState(() => `WHK-${Date.now().toString().slice(-6)}`);
  const [testMarketplace, setTestMarketplace] = useState('Shopee');
  const [testOrderTypeOverride, setTestOrderTypeOverride] = useState<'AUTO' | 'B2B' | 'ONLINE'>('AUTO');
  const [testSku, setTestSku] = useState('');
  const [testQty, setTestQty] = useState(1);
  const [testCustomer, setTestCustomer] = useState('Buyer Marketplace');
  const [testPhone, setTestPhone] = useState('081200000000');
  const [testAddress, setTestAddress] = useState('Alamat Pengiriman Marketplace');
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, any> | null>(null);

  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const webhookEndpoint = useMemo(
    () => (supabaseUrl ? `${supabaseUrl}/rest/v1/rpc/marketplace_order_webhook` : '/rest/v1/rpc/marketplace_order_webhook'),
    [supabaseUrl]
  );

  const canRun = currentUser?.role === 'Administrator' || currentUser?.role === 'Admin';
  if (!canRun) {
    return (
      <div className="p-6 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-rose-200 text-sm">
        Hanya Admin atau Administrator cabang yang dapat mengakses konfigurasi & simulasi Webhook Marketplace.
      </div>
    );
  }

  const handleCopyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(webhookEndpoint);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Clipboard blocked in non-HTTPS contexts
    }
  };

  const handleSimulateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      setTestError('Koneksi Supabase tidak tersedia pada sesi ini.');
      return;
    }

    setTesting(true);
    setTestError(null);
    setTestResult(null);

    try {
      const channelMeta = MARKETPLACE_CHANNEL_MAP[testMarketplace] || {
        orderSource: testMarketplace.toUpperCase().replace(/\s+/g, '_'),
        expectedType: 'UNASSIGNED',
      };

      const payload: Record<string, any> = {
        branchId: activeBranch,
        warehouseId: 'WH-CENTRAL',
        orderNumber: testOrderNumber.trim(),
        marketplace: testMarketplace,
        orderSource: channelMeta.orderSource,
        customerName: testCustomer.trim(),
        phone: testPhone.trim(),
        address: testAddress.trim(),
        items: [{ skuId: testSku.trim().toUpperCase(), qty: Number(testQty) }],
      };

      if (testOrderTypeOverride !== 'AUTO') {
        payload.orderType = testOrderTypeOverride;
      }

      const { data, error } = await supabase.rpc('marketplace_order_webhook', {
        payload,
        p_secret: secretKey.trim(),
      });

      if (error) {
        setTestError(error.message || 'Gagal memproses payload webhook.');
        return;
      }

      setTestResult((data as Record<string, any>) || { success: true });
      setTestOrderNumber(`WHK-${Date.now().toString().slice(-6)}`);
    } catch (err: any) {
      setTestError(err?.message || 'Terjadi kesalahan saat mengirim webhook.');
    } finally {
      setTesting(false);
    }
  };

  const resultOrderType = String(testResult?.orderType || 'UNASSIGNED').toUpperCase();
  const nextTabId =
    resultOrderType === 'B2B'
      ? 'b2b-picking'
      : resultOrderType === 'ONLINE'
        ? 'online-picking'
        : 'dashboard';

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-black text-white flex items-center gap-2.5">
            <Webhook className="w-6 h-6 text-indigo-400" /> Integrasi Webhook Marketplace & Order
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Cabang aktif <strong className="text-white">{activeBranch}</strong> bertipe operasional{' '}
            <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-bold">{branchOperationType}</span>.
            Order dari sumber tervalidasi (<span className="text-emerald-300">Shopee, TikTok Shop, Tokopedia, Lazada, Blibli, Mabang, Jubelio</span>) diklasifikasikan otomatis sebagai <strong className="text-emerald-300">ONLINE</strong>; sumber tidak dikenal masuk sebagai <strong className="text-amber-300">UNASSIGNED</strong> tanpa tebakan PO/customer.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-slate-800 bg-[#11141B] p-5 space-y-4">
          <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-amber-400" /> Endpoint RPC & Secret Key Cabang {activeBranch}
          </h2>
          <div>
            <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Endpoint RPC Webhook</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={webhookEndpoint}
                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono"
              />
              <button
                type="button"
                onClick={handleCopyEndpoint}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-white font-bold inline-flex items-center gap-1"
              >
                {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedUrl ? 'Tersalin' : 'Salin'}</span>
              </button>
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Webhook Secret Key</label>
            <div className="flex items-center gap-2">
              <input
                type={showSecret ? 'text' : 'password'}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
                aria-label="Tampilkan secret webhook"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#11141B] p-5 space-y-4">
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <Package className="w-4 h-4 text-indigo-400" /> Alur Kerja Otomatis & Keamanan Klasifikasi
          </h3>
          <div className="space-y-3 text-xs text-slate-300">
            <div className="flex gap-2.5 items-start">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">1</span>
              <div>
                <strong className="text-white">Validasi Sumber Order:</strong>
                <p className="text-slate-400 text-[11px] mt-0.5">Whitelist marketplace terpercaya ditetapkan ke ONLINE; payload tanpa sumber valid atau explicit orderType masuk sebagai UNASSIGNED.</p>
              </div>
            </div>
            <div className="flex gap-2.5 items-start">
              <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">2</span>
              <div>
                <strong className="text-white">Alokasi FEFO Pickable Otomatis:</strong>
                <p className="text-slate-400 text-[11px] mt-0.5">Hanya mengambil rak pickable (non-Damage, non-Expired, non-buffer) dengan memperhitungkan stok reserved order pending.</p>
              </div>
            </div>
            <div className="flex gap-2.5 items-start">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">3</span>
              <div>
                <strong className="text-white">Masuk Antrean Channel yang Tepat:</strong>
                <p className="text-slate-400 text-[11px] mt-0.5">Order ONLINE langsung masuk Picking Online, B2B masuk Picking B2B, dan UNASSIGNED ditahan di panel klasifikasi Admin.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-[#11141B] p-6 space-y-4">
        <div>
          <h2 className="text-base font-extrabold text-white flex items-center gap-2">
            <Send className="w-4 h-4 text-emerald-400" /> Uji Coba / Simulasi Pesanan Masuk
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Uji coba penerimaan order webhook dan klasifikasi channel secara aman di cabang <strong>{activeBranch}</strong>.
          </p>
        </div>

        <form onSubmit={handleSimulateWebhook} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Nomor Order</label>
              <input
                type="text"
                required
                value={testOrderNumber}
                onChange={(e) => setTestOrderNumber(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Marketplace / Channel</label>
              <select
                value={testMarketplace}
                onChange={(e) => setTestMarketplace(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              >
                {Object.keys(MARKETPLACE_CHANNEL_MAP).map((label) => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Override orderType</label>
              <select
                value={testOrderTypeOverride}
                onChange={(e) => setTestOrderTypeOverride(e.target.value as 'AUTO' | 'B2B' | 'ONLINE')}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              >
                <option value="AUTO">AUTO (Ikuti Whitelist Sumber)</option>
                <option value="ONLINE">Eksplisit ONLINE</option>
                <option value="B2B">Eksplisit B2B</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">SKU Barang</label>
              <input
                type="text"
                required
                placeholder="Contoh: PR001-01"
                value={testSku}
                onChange={(e) => setTestSku(e.target.value.toUpperCase())}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Qty (pcs)</label>
              <input
                type="number"
                min={1}
                max={9999}
                required
                value={testQty}
                onChange={(e) => setTestQty(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Nama Pembeli</label>
              <input
                type="text"
                value={testCustomer}
                onChange={(e) => setTestCustomer(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">No. Telepon</label>
              <input
                type="text"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Alamat Pengiriman</label>
              <input
                type="text"
                value={testAddress}
                onChange={(e) => setTestAddress(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={testing}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            {testing ? 'Mengirim Webhook...' : 'Kirim Test Pesanan Webhook'}
          </button>
        </form>

        {testError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <strong className="block text-rose-200">Gagal Memproses Webhook:</strong>
              <span>{testError}</span>
            </div>
          </div>
        )}

        {testResult && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold text-emerald-300 flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400" />
                Order diterima ({resultOrderType})!
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab(nextTabId)}
                className="inline-flex items-center gap-1 text-xs font-bold text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                <span>
                  {resultOrderType === 'B2B'
                    ? 'Buka Picking B2B'
                    : resultOrderType === 'ONLINE'
                      ? 'Buka Picking Online'
                      : 'Klasifikasikan di Dashboard'}
                </span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <pre className="p-3 bg-slate-950/70 border border-emerald-500/20 rounded-lg text-[11px] font-mono text-emerald-300 overflow-x-auto max-h-48">
              {JSON.stringify(testResult, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default MarketplaceWebhook;
