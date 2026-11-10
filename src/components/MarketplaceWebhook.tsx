import React, { useState } from 'react';
import { Webhook, Copy, Check, Send, ShieldCheck, Zap, ArrowRight, Package, AlertCircle } from 'lucide-react';
import { supabase, getActiveBranch } from '../supabase';
import type { StockItem } from '../types';

interface MarketplaceWebhookProps {
  stock: StockItem[];
  onNavigateTab: (tab: string) => void;
}

export default function MarketplaceWebhook({ stock, onNavigateTab }: MarketplaceWebhookProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [testOrderNumber, setTestOrderNumber] = useState(`ORDER-MKT-${Math.floor(1000 + Math.random() * 9000)}`);
  const [testCustomer, setTestCustomer] = useState('Budi Santoso (Customer TikTok)');
  const [testPhone, setTestPhone] = useState('081234567890');
  const [testAddress, setTestAddress] = useState('Jl. Sudirman No. 45, Jakarta Pusat');
  const [testMarketplace, setTestMarketplace] = useState('TikTok Shop');
  const [testSku, setTestSku] = useState(stock[0]?.skuId || 'PR001-01');
  const [testQty, setTestQty] = useState(1);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const endpointUrl = `${import.meta.env.VITE_SUPABASE_URL || 'https://suwaodhkmrvpzyuhzujf.supabase.co'}/rest/v1/rpc/marketplace_order_webhook`;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_LFZoNWOfwZ7mIHFCavK-Kg_qc0HRG6W';
  const secretKey = 'TRUEBLUE_WEBHOOK_2026';

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const sampleJson = {
    payload: {
      order_number: "SHOPEE-20261110-0982",
      customer_name: "Siti Rahma",
      customer_phone: "081298765432",
      customer_address: "Jl. Melati No. 12, Bandung, Jawa Barat",
      marketplace: "Shopee",
      branch_id: getActiveBranch(),
      warehouse_id: "WH-CENTRAL",
      items: [
        {
          sku: testSku || "SKU-PRODUK-01",
          qty: 2
        }
      ]
    },
    p_secret: secretKey
  };

  const curlCommand = `curl -X POST '${endpointUrl}' \\
  -H 'apikey: ${anonKey}' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(sampleJson, null, 2)}'`;

  const handleSimulateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setTestError(null);
    setTestResult(null);

    try {
      if (!supabase) throw new Error('Koneksi Supabase belum aktif.');

      const payload = {
        order_number: testOrderNumber.trim(),
        customer_name: testCustomer.trim(),
        customer_phone: testPhone.trim(),
        customer_address: testAddress.trim(),
        marketplace: testMarketplace,
        branch_id: getActiveBranch(),
        warehouse_id: 'WH-CENTRAL',
        items: [
          {
            sku: testSku.trim(),
            qty: Number(testQty)
          }
        ]
      };

      const { data, error } = await supabase.rpc('marketplace_order_webhook', {
        payload,
        p_secret: secretKey
      });

      if (error) throw error;
      setTestResult(data);
      // Generate new test order ID for next run
      setTestOrderNumber(`ORDER-MKT-${Math.floor(1000 + Math.random() * 9000)}`);
    } catch (err: any) {
      setTestError(err.message || 'Gagal mengirim order simulasi webhook.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12 font-sans">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-indigo-500/30 p-6 rounded-2xl shadow-xl">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold mb-2">
            <Zap className="w-3.5 h-3.5" /> Direct REST API & Webhook
          </div>
          <h1 className="text-2xl font-black text-white flex items-center gap-3">
            <Webhook className="w-7 h-7 text-emerald-400" /> Webhook Marketplace API
          </h1>
          <p className="text-xs text-slate-400 mt-1.5 max-w-2xl">
            Koneksikan WMS Anda langsung ke marketplace (Shopee, TikTok Shop, Tokopedia, Lazada) atau sistem Omnichannel (Mabang, Jubelio, Ginee). Pesanan baru otomatis masuk ke alur picking & packing dengan alokasi rak FEFO instan.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-4 py-2.5 rounded-xl w-fit">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <span>Status API: Siap Menerima Pesanan</span>
        </div>
      </div>

      {/* Grid: Credentials & Endpoint */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Endpoint URL Card */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-[#11141B] p-5 space-y-4">
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-400" /> URL Webhook (Endpoint POST)
          </h3>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                Webhook POST URL:
              </label>
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-emerald-300 font-mono break-all">
                <span className="flex-1 truncate">{endpointUrl}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(endpointUrl, 'url')}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg shrink-0 flex items-center gap-1 font-sans text-xs"
                >
                  {copiedField === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedField === 'url' ? 'Tersalin' : 'Salin'}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  API Key Header (<code className="text-slate-300">apikey</code>):
                </label>
                <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-300 font-mono">
                  <span className="flex-1 truncate">{anonKey.slice(0, 18)}...</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(anonKey, 'key')}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg shrink-0 text-xs"
                  >
                    {copiedField === 'key' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Webhook Secret Token:
                </label>
                <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-300 font-mono">
                  <span className="flex-1 font-bold text-indigo-400">{secretKey}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(secretKey, 'secret')}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg shrink-0 text-xs"
                  >
                    {copiedField === 'secret' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                Contoh cURL / Integrasi API:
              </span>
              <button
                type="button"
                onClick={() => copyToClipboard(curlCommand, 'curl')}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-semibold"
              >
                {copiedField === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                Salin Perintah cURL
              </button>
            </div>
            <pre className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-[11px] font-mono text-slate-300 overflow-x-auto max-h-44">
              {curlCommand}
            </pre>
          </div>
        </div>

        {/* Info & Alur Marketplace */}
        <div className="rounded-2xl border border-slate-800 bg-[#11141B] p-5 space-y-4">
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <Package className="w-4 h-4 text-indigo-400" /> Alur Kerja Otomatis WMS
          </h3>
          <div className="space-y-3 text-xs text-slate-300">
            <div className="flex gap-2.5 items-start">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">1</span>
              <div>
                <strong className="text-white">Pesanan Masuk dari Toko:</strong>
                <p className="text-slate-400 text-[11px] mt-0.5">Saat pembeli checkout di Shopee/TikTok/Tokopedia, webhook mengirim order ke URL ini.</p>
              </div>
            </div>

            <div className="flex gap-2.5 items-start">
              <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">2</span>
              <div>
                <strong className="text-white">Alokasi FEFO Otomatis:</strong>
                <p className="text-slate-400 text-[11px] mt-0.5">WMS mencari nomor rak dengan tanggal kedaluwarsa terdekat yang masih aman dan memiliki stok bebas.</p>
              </div>
            </div>

            <div className="flex gap-2.5 items-start">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">3</span>
              <div>
                <strong className="text-white">Siap Picking & Packing:</strong>
                <p className="text-slate-400 text-[11px] mt-0.5">Pesanan langsung muncul secara live (Realtime 0 detik) di menu Picking/Packing operator gudang.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Simulator / Test Webhook */}
      <div className="rounded-2xl border border-slate-800 bg-[#11141B] p-6 space-y-4">
        <div>
          <h2 className="text-base font-extrabold text-white flex items-center gap-2">
            <Send className="w-4 h-4 text-emerald-400" /> Uji Coba / Simulasi Pesanan Masuk
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Uji coba apakah pesanan berhasil diterima oleh WMS dan dialokasikan ke rak fisik. Pesanan yang berhasil akan langsung muncul di tab <strong>Picking/Packing</strong>.
          </p>
        </div>

        <form onSubmit={handleSimulateWebhook} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Nomor Order</label>
              <input
                type="text"
                required
                value={testOrderNumber}
                onChange={e => setTestOrderNumber(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Marketplace / Channel</label>
              <select
                value={testMarketplace}
                onChange={e => setTestMarketplace(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              >
                <option value="Shopee">Shopee</option>
                <option value="TikTok Shop">TikTok Shop</option>
                <option value="Tokopedia">Tokopedia</option>
                <option value="Lazada">Lazada</option>
                <option value="Mabang ERP">Mabang ERP</option>
                <option value="Manual / Custom">Manual / Custom</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">SKU Barang</label>
              <input
                type="text"
                required
                placeholder="Contoh: PR001-01"
                value={testSku}
                onChange={e => setTestSku(e.target.value.toUpperCase())}
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
                onChange={e => setTestQty(Number(e.target.value))}
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
                onChange={e => setTestCustomer(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">No. Telepon</label>
              <input
                type="text"
                value={testPhone}
                onChange={e => setTestPhone(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase block mb-1">Alamat Pengiriman</label>
              <input
                type="text"
                value={testAddress}
                onChange={e => setTestAddress(e.target.value)}
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
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-300 flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400" /> Pesanan Berhasil Diterima & Masuk ke WMS!
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab('mabang')}
                className="inline-flex items-center gap-1 text-xs font-bold text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                <span>Buka Picking/Packing</span>
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
