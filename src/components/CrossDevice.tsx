import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Database, Info, Monitor, RefreshCw, Smartphone } from 'lucide-react';
import { StockItem, DccLog, ActiveDevice } from '../types';

interface CrossDeviceProps {
  stock: StockItem[];
  logs: DccLog[];
  currentUser: { username: string; role: string; fullName: string } | null;
  dbStatus?: 'connected' | 'offline';
  activeDevices?: ActiveDevice[];
  currentDeviceId?: string;
  onRefreshHeartbeat?: () => void;
  onRemoveDevice?: (deviceId: string) => void;
  onSimulateInbound: (item: { skuId: string; skuName: string; expiredDate: string; location: string; qty: number }) => void;
  onSimulateTransfer: (transfer: { skuId: string; skuName: string; expiredDate: string; fromLocation: string; toLocation: string; qty: number }) => boolean;
  onForcePushStockToCloud?: () => void;
}

export default function CrossDevice({ currentUser, dbStatus = 'offline' }: CrossDeviceProps) {
  const [appUrl, setAppUrl] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const url = window.location.origin + window.location.pathname;
    setAppUrl(url);
    void QRCode.toDataURL(url, { width: 240, margin: 1 }).then(setQrCode).catch(() => setQrCode(''));
  }, []);

  const copyUrl = async () => {
    if (!appUrl) return;
    try { await navigator.clipboard.writeText(appUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { window.prompt('Salin tautan aplikasi ini:', appUrl); }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-800 bg-[#11141B] p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-emerald-400"><Database className="w-5 h-5" /></div>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-white">Gunakan WMS di perangkat lain</h2>
            <p className="mt-1 text-xs text-slate-400">Buka tautan aplikasi yang sama di PC, tablet, atau ponsel. Setelah login, perubahan persediaan dan transaksi dibaca langsung dari database Supabase bersama.</p>
          </div>
          <span className={dbStatus === 'connected' ? 'rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-[10px] font-bold text-emerald-300' : 'rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-[10px] font-bold text-amber-300'}>
            {dbStatus === 'connected' ? 'SUPABASE TERHUBUNG' : 'BELUM TERHUBUNG'}
          </span>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <div className="rounded-2xl border border-slate-800 bg-[#11141B] p-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-900 text-emerald-400"><Smartphone className="w-6 h-6" /></div>
          <h3 className="text-sm font-bold text-white">Pindai untuk membuka</h3>
          {qrCode ? <img src={qrCode} alt="QR tautan TRUEBLUE WMS" className="my-4 h-48 w-48 rounded-xl bg-white p-2" /> : <div className="my-4 flex h-48 w-48 items-center justify-center rounded-xl border border-slate-800 text-xs text-slate-500">QR belum tersedia</div>}
          <button onClick={() => void copyUrl()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}{copied ? 'Tautan tersalin' : 'Salin tautan'}
          </button>
          <p className="mt-3 break-all text-[10px] text-slate-500">{appUrl}</p>
        </div>

        <div className="space-y-4 rounded-2xl border border-slate-800 bg-[#11141B] p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-white"><Monitor className="w-4 h-4 text-indigo-400" />Langkah pemakaian</h3>
          <ol className="space-y-3 text-xs text-slate-300">
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-emerald-400">1</span><span>Pastikan aplikasi sudah dipasang pada alamat HTTPS yang dapat diakses tim.</span></li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-emerald-400">2</span><span>Buka tautan atau pindai QR dari perangkat lain yang terhubung ke internet.</span></li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-emerald-400">3</span><span>Masuk dengan ID akun dan password yang dibuat admin.</span></li>
          </ol>
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3 text-[11px] text-slate-300 flex gap-2"><Info className="w-4 h-4 shrink-0 text-indigo-400" /><span>{dbStatus === 'connected' ? 'Perangkat ini sudah terhubung. Pembaruan tabel disebarkan lewat Supabase Realtime.' : 'Hubungkan VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY, lalu periksa koneksi internet.'}</span></div>
          <div className="flex items-center gap-2 border-t border-slate-800 pt-4 text-xs text-slate-400"><span>Pengguna saat ini:</span><strong className="text-slate-200">{currentUser?.fullName || '—'}</strong><span className="text-emerald-400">{currentUser?.role || ''}</span></div>
        </div>
      </section>
    </div>
  );
}
