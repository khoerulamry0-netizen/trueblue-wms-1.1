import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, getActiveBranch, db, collection, getDocs, doc, writeBatch } from '../supabase';
import { readAllRows } from '../utils/readAllRows';
import { prepareOrderSessionUpdates } from '../utils/orderSession';
import {
  buildBranchExceptionReport,
  formatExceptionCsv,
  type ExceptionCategory,
  type ExceptionReportItem
} from '../utils/exceptionReport';
import {
  Search,
  CheckSquare,
  Square,
  MinusSquare,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  X,
  Filter,
  Check,
  Ban,
  Boxes,
  ShieldAlert,
  Download
} from 'lucide-react';

const titles: Record<string, string> = {
  INSERT: 'Dibuat',
  UPDATE: 'Diubah',
  DELETE: 'Dihapus',
  BACKUP_CREATE: 'Backup dibuat',
  BACKUP_IMPORT: 'Backup diimpor',
  BACKUP_RESTORE: 'Data dipulihkan',
  ACCOUNT_CREATE: 'Akun dibuat',
  ACCOUNT_UPDATE: 'Akun diubah',
  ACCOUNT_DELETE: 'Akses akun dihapus'
};

const REASON_PRESETS = [
  'Permintaan pembatalan dari customer',
  'Salah input kuantitas / SKU order',
  'Order ganda / duplikat transaksi',
  'Stok fisik di gudang tidak mencukupi',
  'Alamat tujuan tidak dapat dijangkau ekspedisi'
];

export default function ActivityConsole({
  onClose,
  initialIds = [],
  initialTab,
  currentUserName
}: {
  onClose: () => void;
  initialIds?: string[];
  initialTab?: 'audit' | 'exception' | 'cancel';
  currentUserName?: string;
}) {
  const [tab, setTab] = useState<'audit' | 'exception' | 'cancel'>(
    initialTab || (initialIds.length ? 'cancel' : 'audit')
  );
  const [events, setEvents] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [exceptionOrders, setExceptionOrders] = useState<any[]>([]);
  const [stocks, setStocks] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [exceptionCategory, setExceptionCategory] = useState<'ALL' | ExceptionCategory>('ALL');
  const [exceptionQuery, setExceptionQuery] = useState('');
  const [ids, setIds] = useState<string[]>(initialIds);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [entity, setEntity] = useState('');
  const [orderPage, setOrderPage] = useState(0);
  const [orderLimit, setOrderLimit] = useState(200);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'cancellable' | 'cancelled' | 'shipped'>('all');

  const lock = useRef(false);
  const branch = getActiveBranch();
  const loadSeq = useRef(0);

  const load = async () => {
    if (!supabase) return;
    const request = ++loadSeq.current;
    const isCurrent = () => request === loadSeq.current && branch === getActiveBranch();
    
    let q = supabase
      .from('activity_events')
      .select('*')
      .eq('branch_id', branch)
      .order('id', { ascending: false })
      .range(page * 100, page * 100 + 99);
    if (entity) q = q.eq('entity_type', entity);

    const [a, b, c, stockRowsRes, orderAllRes] = await Promise.all([
      q,
      supabase
        .from('wms_documents')
        .select('document_id,payload,revision')
        .eq('branch_id', branch)
        .eq('collection_name', 'orders')
        .order('updated_at', { ascending: false })
        .range(orderPage * orderLimit, orderPage * orderLimit + (orderLimit - 1)),
      supabase
        .from('branch_transfers')
        .select('id,source_branch,destination_branch,status,created_at,notes,receipt_notes,items,receipt')
        .or(`source_branch.eq.${branch},destination_branch.eq.${branch}`)
        .order('created_at', { ascending: false })
        .limit(200),
      readAllRows<{ document_id: string; payload: any }>(
        () => supabase!.from('wms_documents').select('document_id,payload').eq('branch_id', branch).eq('collection_name', 'stock'),
        'document_id',
        isCurrent
      ).catch(() => []),
      readAllRows<{ document_id: string; payload: any }>(
        () => supabase!.from('wms_documents').select('document_id,payload').eq('branch_id', branch).eq('collection_name', 'orders'),
        'document_id',
        isCurrent
      ).catch(() => [])
    ]);

    if (request !== loadSeq.current) return;
    if (a.error || b.error) {
      setError((a.error || b.error)!.message);
    } else {
      setEvents(a.data || []);
      let all = b.data || [];
      const missing = ids.filter(id => !all.some(o => o.document_id === id));
      if (missing.length) {
        const extra = await supabase
          .from('wms_documents')
          .select('document_id,payload,revision')
          .eq('branch_id', branch)
          .eq('collection_name', 'orders')
          .in('document_id', missing);
        if (request !== loadSeq.current) return;
        if (extra.error) {
          setError(extra.error.message);
          return;
        }
        all = [...all, ...(extra.data || [])];
      }
      setOrders(all);
      setTransfers(c.data || []);
      setStocks(stockRowsRes);
      setExceptionOrders(orderAllRes.length ? orderAllRes : all);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      loadSeq.current++;
    };
  }, [page, entity, orderPage, orderLimit]);

  const exceptionReport = useMemo(
    () =>
      buildBranchExceptionReport({
        orders: exceptionOrders,
        stocks,
        transfers,
        events
      }),
    [exceptionOrders, stocks, transfers, events]
  );

  const filteredExceptions = useMemo(() => {
    const q = exceptionQuery.trim().toLowerCase();
    return exceptionReport.items.filter(item => {
      if (exceptionCategory !== 'ALL' && item.category !== exceptionCategory) return false;
      if (!q) return true;
      return (
        item.reference.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.detail.toLowerCase().includes(q) ||
        item.actor.toLowerCase().includes(q)
      );
    });
  }, [exceptionReport.items, exceptionCategory, exceptionQuery]);

  const handleJumpToCancel = (item: ExceptionReportItem) => {
    if (item.actionableOrderIds?.length) {
      setIds(prev => Array.from(new Set([...prev, ...item.actionableOrderIds!])));
    }
    if (item.actionableOrderRef) {
      setSearchQuery(item.actionableOrderRef);
    }
    if (item.category === 'ISSUE_REPORTED' && !reason.trim()) {
      setReason(`${item.title}: ${item.detail}`.slice(0, 500));
    }
    setTab('cancel');
  };

  const handleResolveException = async (item: ExceptionReportItem) => {
    if (!item.actionableOrderRef || busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const snapshot = await getDocs(collection(db, 'orders'));
      const freshOrders = snapshot.docs.map(d => d.data() as any);
      const updates = prepareOrderSessionUpdates(freshOrders, item.actionableOrderRef, {
        issueReport: { resolveBy: currentUserName || 'Supervisor' }
      });
      const batch = writeBatch(db);
      for (const ord of updates) {
        batch.set({ ...doc(db, 'orders', ord.id), expectedRevision: (ord as any).__wms_revision ?? null }, ord);
      }
      await batch.commit();
      setNotice(`Kendala order ${item.actionableOrderRef} ditandai selesai ditinjau.`);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Gagal memperbarui status peninjauan kendala.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const handleExportExceptionsCsv = () => {
    if (!filteredExceptions.length) return;
    const csv = formatExceptionCsv(filteredExceptions);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TRUEBLUE_Exception_${branch}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filtered orders based on search and status
  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      const p = o.payload || {};
      const isCancelled = p.status === 'Cancelled';
      const isShipped = !!p.shipped || !!p.shippedAt;
      const isCancellable = !isCancelled && !isShipped;

      if (statusFilter === 'cancellable' && !isCancellable) return false;
      if (statusFilter === 'cancelled' && !isCancelled) return false;
      if (statusFilter === 'shipped' && !isShipped) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const orderNum = (p.orderNumber || o.document_id || '').toLowerCase();
        const refNum = (p.referenceNumber || '').toLowerCase();
        const po = (p.noPo || '').toLowerCase();
        const sku = (p.skuId || '').toLowerCase();
        const skuName = (p.skuName || '').toLowerCase();
        const cust = (p.customerName || '').toLowerCase();
        return (
          orderNum.includes(q) ||
          refNum.includes(q) ||
          po.includes(q) ||
          sku.includes(q) ||
          skuName.includes(q) ||
          cust.includes(q)
        );
      }
      return true;
    });
  }, [orders, searchQuery, statusFilter]);

  // Cancellable orders currently displayed
  const cancellableDisplayed = useMemo(() => {
    return filteredOrders.filter(
      o => o.payload?.status !== 'Cancelled' && !o.payload?.shipped && !o.payload?.shippedAt
    );
  }, [filteredOrders]);

  const allDisplayedSelected =
    cancellableDisplayed.length > 0 &&
    cancellableDisplayed.every(o => ids.includes(o.document_id));

  const someDisplayedSelected =
    !allDisplayedSelected &&
    cancellableDisplayed.some(o => ids.includes(o.document_id));

  const toggleSelectAllDisplayed = () => {
    if (allDisplayedSelected) {
      setIds(prev => prev.filter(id => !cancellableDisplayed.some(o => o.document_id === id)));
    } else {
      const displayedIds = cancellableDisplayed.map(o => o.document_id);
      setIds(prev => Array.from(new Set([...prev, ...displayedIds])));
    }
  };

  // Select all SKUs of a specific order
  const handleSelectOrderFamily = (orderNumberOrDocId: string) => {
    const family = orders.filter(o => {
      const p = o.payload || {};
      const match = (p.orderNumber || o.document_id) === orderNumberOrDocId || p.referenceNumber === orderNumberOrDocId;
      const isCancellable = p.status !== 'Cancelled' && !p.shipped && !p.shippedAt;
      return match && isCancellable;
    });
    const familyIds = family.map(o => o.document_id);
    const allInIds = familyIds.every(id => ids.includes(id));

    if (allInIds) {
      setIds(prev => prev.filter(id => !familyIds.includes(id)));
    } else {
      setIds(prev => Array.from(new Set([...prev, ...familyIds])));
    }
  };

  // Robust cancel handler with chunking (unlimited orders)
  const cancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lock.current || !supabase) return;

    if (!ids.length) {
      setError('Pilih minimal 1 order untuk dibatalkan.');
      return;
    }

    if (reason.trim().length < 5) {
      setError('Isi alasan pembatalan minimal 5 karakter (contoh: "Permintaan customer").');
      return;
    }

    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('Memverifikasi data order sebelum pembatalan...');

    try {
      // 1. Gather all selected documents and resolve latest revisions
      let allSelected = orders.filter(o => ids.includes(o.document_id));
      const missingIds = ids.filter(id => !allSelected.some(o => o.document_id === id));

      if (missingIds.length > 0) {
        setNotice(`Memuat ${missingIds.length} order yang belum tersinkron...`);
        for (let i = 0; i < missingIds.length; i += 100) {
          const chunk = missingIds.slice(i, i + 100);
          const { data, error: fetchErr } = await supabase
            .from('wms_documents')
            .select('document_id,payload,revision')
            .eq('branch_id', branch)
            .eq('collection_name', 'orders')
            .in('document_id', chunk);
          if (fetchErr) throw fetchErr;
          if (data) allSelected = [...allSelected, ...data];
        }
      }

      // Filter out any already cancelled or shipped
      const cancellableDocs = allSelected.filter(o => {
        const p = o.payload || {};
        return p.status !== 'Cancelled' && !p.shipped && !p.shippedAt;
      });

      if (cancellableDocs.length === 0) {
        setError('Semua order yang dipilih sudah pernah dibatalkan atau sudah dikirim.');
        return;
      }

      // 2. Chunk calls into batches of up to 100 (PostgreSQL RPC cancel_wms_orders accepts up to 100)
      const BATCH_SIZE = 100;
      const totalBatches = Math.ceil(cancellableDocs.length / BATCH_SIZE);
      let successCount = 0;

      for (let i = 0; i < cancellableDocs.length; i += BATCH_SIZE) {
        const chunk = cancellableDocs.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        if (totalBatches > 1) {
          setNotice(`Membatalkan batch ${batchNum} dari ${totalBatches} (${chunk.length} order)...`);
        } else {
          setNotice(`Memproses pembatalan ${chunk.length} order...`);
        }

        const { error: rpcErr } = await supabase.rpc('cancel_wms_orders', {
          p_branch_id: branch,
          p_items: chunk.map(o => ({
            id: o.document_id,
            expected_revision: o.revision
          })),
          p_reason: reason.trim()
        });

        if (rpcErr) throw rpcErr;
        successCount += chunk.length;
      }

      setIds([]);
      setReason('');
      setNotice(`✅ Berhasil membatalkan ${successCount} order! Riwayat asli tersimpan aman dan stok telah dikembalikan ke inventory.`);
      await load();
    } catch (e: any) {
      setError(e.message || 'Pembatalan gagal. Muat data terbaru sebelum mencoba lagi.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const button = 'border border-slate-700 hover:border-slate-600 bg-slate-800 hover:bg-slate-750 text-slate-200 rounded-lg px-3 py-2 text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed';

  return createPortal(
    <div className="fixed inset-0 z-[130] bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-3 animate-in fade-in duration-150">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Aktivitas dan Pembatalan"
        className="w-full max-w-6xl max-h-[94vh] flex flex-col rounded-2xl bg-[#0f172a] border border-slate-800 shadow-2xl text-slate-100 overflow-hidden"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 border-b border-slate-800/80 bg-slate-900/60">
          <div>
            <h2 className="font-extrabold text-xl text-white flex items-center gap-2">
              <Boxes className="w-5 h-5 text-amber-400" />
              Aktivitas & Pembatalan Outbound
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Cabang <span className="font-bold text-amber-300 font-mono">{branch}</span> · Riwayat audit asli tetap tersimpan secara permanen.
            </p>
          </div>
          <button disabled={busy} onClick={onClose} className={button}>
            Tutup aktivitas
          </button>
        </div>

        {/* Navigation & Status alerts */}
        <div className="px-5 pt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                disabled={busy}
                onClick={() => setTab('audit')}
                className={`${button} ${tab === 'audit' ? 'bg-emerald-600 text-white border-emerald-500 shadow-md' : ''}`}
              >
                Riwayat Aktivitas
              </button>
              <button
                disabled={busy}
                onClick={() => setTab('exception')}
                className={`${button} flex items-center gap-1.5 ${tab === 'exception' ? 'bg-amber-600 text-white border-amber-500 shadow-md' : ''}`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Laporan Exception</span>
                {exceptionReport.summary.total > 0 && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black leading-none ${
                    exceptionReport.summary.high > 0 ? 'bg-rose-500 text-white' : 'bg-slate-700 text-amber-300'
                  }`}>
                    {exceptionReport.summary.total}
                  </span>
                )}
              </button>
              <button
                disabled={busy}
                onClick={() => setTab('cancel')}
                className={`${button} ${tab === 'cancel' ? 'bg-emerald-600 text-white border-emerald-500 shadow-md' : ''}`}
              >
                Pembatalan Outbound (Bisa Banyak Order)
              </button>
            </div>
            <button
              disabled={busy}
              onClick={() => {
                setError('');
                void load();
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-750 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              Muat ulang
            </button>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2.5 p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{error}</div>
              <button onClick={() => setError('')} className="text-rose-400 hover:text-rose-200">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {notice && (
            <div role="status" className="flex items-start gap-2.5 p-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{notice}</div>
              <button onClick={() => setNotice('')} className="text-emerald-400 hover:text-emerald-200">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'audit' ? (
            <div className="space-y-4">
              <p className="rounded-xl bg-slate-800/60 border border-slate-750 p-3 text-xs text-slate-300 leading-relaxed">
                Perubahan stok, order, katalog, akun, master cabang, dan transfer dicatat otomatis sejak fitur diaktifkan. Catatan audit tidak bisa diubah atau dihapus dari aplikasi.
              </p>

              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-slate-300 flex items-center gap-2">
                  <span>Jenis data:</span>
                  <select
                    aria-label="Jenis aktivitas"
                    value={entity}
                    onChange={e => {
                      setEntity(e.target.value);
                      setPage(0);
                    }}
                    className="border border-slate-700 rounded-lg p-2 bg-slate-800 text-white text-xs outline-none focus:border-emerald-500"
                  >
                    <option value="">Semua Data</option>
                    {[
                      'stock',
                      'orders',
                      'logs',
                      'catalog',
                      'audits',
                      'profiles',
                      'branches',
                      'branch_transfers',
                      'accounts',
                      'warehouses',
                      'warehouse_transfers',
                      'inbound',
                      'returns',
                      'batches',
                      'backups'
                    ].map(v => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900/40">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-800/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      {['Waktu WIB', 'Petugas', 'Aktivitas', 'Data', 'Alasan / Rincian'].map(h => (
                        <th className="p-3 font-semibold uppercase tracking-wider text-[11px]" key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {events.map(row => (
                      <tr key={row.id} className="hover:bg-slate-850/50 transition-colors">
                        <td className="p-3 whitespace-nowrap font-mono text-slate-400">
                          {new Date(row.created_at).toLocaleString('id-ID', {
                            timeZone: 'Asia/Jakarta'
                          })}
                        </td>
                        <td className="p-3 font-medium text-slate-200">{row.actor_name || 'Layanan sistem'}</td>
                        <td className="p-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 border border-slate-700 text-slate-300">
                            {titles[row.action] || row.action}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="font-semibold text-slate-300">{row.entity_type}</div>
                          <div className="text-[10px] text-slate-500 font-mono break-all">{row.entity_id}</div>
                        </td>
                        <td className="p-3">
                          <p className="text-slate-300">{row.reason || '—'}</p>
                          <details className="mt-1">
                            <summary className="cursor-pointer font-bold text-amber-400 hover:text-amber-300 text-[11px]">
                              Lihat perubahan
                            </summary>
                            <div className="overflow-x-auto max-w-xl mt-2 p-2 bg-slate-950 border border-slate-800 rounded-lg">
                              <table className="text-[11px] w-full">
                                <thead>
                                  <tr className="border-b border-slate-800 text-slate-400">
                                    <th className="p-1">Kolom</th>
                                    <th className="p-1">Sebelum</th>
                                    <th className="p-1">Sesudah</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Array.from(
                                    new Set([
                                      ...Object.keys(row.before_data || {}),
                                      ...Object.keys(row.after_data || {})
                                    ])
                                  )
                                    .filter(
                                      k =>
                                        JSON.stringify(row.before_data?.[k]) !==
                                        JSON.stringify(row.after_data?.[k])
                                    )
                                    .map(k => (
                                      <tr key={k} className="border-b border-slate-900">
                                        <td className="p-1 font-mono text-amber-400">{k}</td>
                                        <td className="p-1 break-all whitespace-pre-wrap text-rose-300 font-mono">
                                          {JSON.stringify(row.before_data?.[k]) ?? '—'}
                                        </td>
                                        <td className="p-1 break-all whitespace-pre-wrap text-emerald-300 font-mono">
                                          {JSON.stringify(row.after_data?.[k]) ?? '—'}
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!events.length && (
                  <p className="p-8 text-center text-slate-400 text-xs">Belum ada aktivitas yang sesuai filter.</p>
                )}
              </div>

              <div className="flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <button disabled={!page} className={button} onClick={() => setPage(page - 1)}>
                    Sebelumnya
                  </button>
                  <span className="font-semibold text-slate-300">Halaman {page + 1}</span>
                  <button disabled={events.length < 100} className={button} onClick={() => setPage(page + 1)}>
                    Berikutnya
                  </button>
                </div>
              </div>
            </div>
          ) : tab === 'exception' ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3.5 text-xs text-amber-200 leading-relaxed flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-amber-300 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4" />
                    Ringkasan Exception & Anomali Cabang {branch} (Read-Only)
                  </p>
                  <p className="text-slate-300 mt-0.5">
                    Mengumpulkan laporan kendala operator, stok rusak/ED/QC Hold, transfer berselisih, order tertahan &gt; 24 jam, dan pembatalan agar mudah ditindaklanjuti Supervisor.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!filteredExceptions.length}
                  onClick={handleExportExceptionsCsv}
                  className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-200 font-bold text-xs flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  Export CSV ({filteredExceptions.length})
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
                {[
                  { key: 'ALL', label: 'Semua Temuan', count: exceptionReport.summary.total, tone: 'border-slate-700 bg-slate-900/70 text-white' },
                  { key: 'ISSUE_REPORTED', label: 'Kendala Operator', count: exceptionReport.summary.openIssues, tone: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
                  { key: 'STOCK_ANOMALY', label: 'Stok Rusak / Hold / ED', count: exceptionReport.summary.stockAnomalies, tone: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
                  { key: 'TRANSFER_ANOMALY', label: 'Transfer Bermasalah', count: exceptionReport.summary.transferAnomalies, tone: 'border-orange-500/40 bg-orange-500/10 text-orange-300' },
                  { key: 'ORDER_STALE', label: 'Order Tertahan >24j', count: exceptionReport.summary.staleOrders, tone: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
                  { key: 'ORDER_CANCELLED', label: 'Order Dibatalkan', count: exceptionReport.summary.cancelledOrders, tone: 'border-slate-600 bg-slate-800/70 text-slate-300' }
                ].map(card => (
                  <button
                    key={card.key}
                    type="button"
                    onClick={() => setExceptionCategory(card.key as any)}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${card.tone} ${
                      exceptionCategory === card.key ? 'ring-2 ring-amber-400 shadow-md' : 'opacity-85 hover:opacity-100'
                    }`}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wide opacity-80">{card.label}</div>
                    <div className="text-xl font-black font-mono mt-1">{card.count}</div>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={exceptionQuery}
                    onChange={e => setExceptionQuery(e.target.value)}
                    placeholder="Cari nomor order, SKU, rak, pelapor, atau detail exception..."
                    className="w-full bg-slate-900 border border-slate-750 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <select
                  aria-label="Filter kategori exception"
                  value={exceptionCategory}
                  onChange={e => setExceptionCategory(e.target.value as any)}
                  className="bg-slate-900 border border-slate-750 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-amber-500"
                >
                  <option value="ALL">Semua Kategori ({exceptionReport.summary.total})</option>
                  <option value="ISSUE_REPORTED">Kendala Operator ({exceptionReport.summary.openIssues})</option>
                  <option value="STOCK_ANOMALY">Stok Rusak / Hold / ED ({exceptionReport.summary.stockAnomalies})</option>
                  <option value="TRANSFER_ANOMALY">Transfer Selisih / Tertunda ({exceptionReport.summary.transferAnomalies})</option>
                  <option value="ORDER_STALE">Order Tertahan &gt; 24 Jam ({exceptionReport.summary.staleOrders})</option>
                  <option value="ORDER_CANCELLED">Order Dibatalkan ({exceptionReport.summary.cancelledOrders})</option>
                  <option value="AUDIT_CRITICAL">Audit Sensitif ({exceptionReport.summary.criticalAudits})</option>
                </select>
              </div>

              <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900/40">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-800/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="p-3 font-semibold uppercase text-[11px]">Prioritas</th>
                      <th className="p-3 font-semibold uppercase text-[11px]">Referensi</th>
                      <th className="p-3 font-semibold uppercase text-[11px]">Temuan &amp; Rincian</th>
                      <th className="p-3 font-semibold uppercase text-[11px]">Petugas / Lokasi</th>
                      <th className="p-3 font-semibold uppercase text-[11px] text-right">Qty</th>
                      <th className="p-3 font-semibold uppercase text-[11px] text-right">Tindakan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredExceptions.slice(0, 200).map(item => (
                      <tr key={item.id} className="hover:bg-slate-850/50 transition-colors">
                        <td className="p-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-black uppercase border ${
                              item.severity === 'high'
                                ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                                : item.severity === 'medium'
                                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                                  : 'bg-slate-800 text-slate-300 border-slate-700'
                            }`}
                          >
                            {item.severity === 'high' ? 'TINGGI' : item.severity === 'medium' ? 'SEDANG' : 'INFO'}
                          </span>
                        </td>
                        <td className="p-3 font-mono font-bold text-slate-200 whitespace-nowrap">
                          <div>{item.reference}</div>
                          {item.timestamp && (
                            <div className="text-[10px] font-normal text-slate-500 mt-0.5">
                              {new Date(item.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="font-bold text-slate-100">{item.title}</div>
                          <div className="text-[11px] text-slate-400 mt-0.5">{item.detail}</div>
                        </td>
                        <td className="p-3 text-slate-300">{item.actor}</td>
                        <td className="p-3 text-right font-mono font-bold text-slate-200">
                          {item.qty > 0 ? `${item.qty.toLocaleString('id-ID')} pcs` : '—'}
                        </td>
                        <td className="p-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {item.actionableOrderIds && item.actionableOrderIds.length > 0 && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleJumpToCancel(item)}
                                className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-[11px] font-bold cursor-pointer"
                              >
                                Batalkan Order
                              </button>
                            )}
                            {item.category === 'ISSUE_REPORTED' && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleResolveException(item)}
                                className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold cursor-pointer"
                              >
                                Tandai Ditinjau
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filteredExceptions.length && (
                  <p className="p-8 text-center text-slate-400 text-xs">
                    Tidak ada exception atau anomali yang sesuai filter pada cabang ini.
                  </p>
                )}
              </div>
            </div>
          ) : (
            /* Cancel Tab */
            <form onSubmit={cancel} className="space-y-4">
              <div className="rounded-xl bg-slate-800/60 border border-slate-750 p-3.5 text-xs text-slate-300 leading-relaxed space-y-1">
                <p className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  Aturan Pembatalan Outbound:
                </p>
                <p className="text-slate-400">
                  Pembatalan hanya untuk barang yang <strong>belum dikirim</strong>. Jika stok fisik sudah terpotong (status Completed / Picked), sistem secara otomatis mengembalikannya ke inventory. Order tetap dicatat dengan status <strong>Dibatalkan</strong>.
                </p>
              </div>

              {/* Filters and Selection toolbar */}
              <div className="bg-[#111827] border border-slate-800 rounded-xl p-3.5 space-y-3">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  {/* Search */}
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Cari nomor order (contoh: KOL-ID-2368), PO, SKU, atau nama customer..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-750 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Status Filter */}
                  <div className="flex items-center gap-2">
                    <Filter className="w-3.5 h-3.5 text-slate-400" />
                    <select
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value as any)}
                      className="bg-slate-900 border border-slate-750 rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-emerald-500"
                    >
                      <option value="all">Semua Status</option>
                      <option value="cancellable">Bisa Dibatalkan (Aktif / Belum Kirim)</option>
                      <option value="cancelled">Sudah Dibatalkan</option>
                      <option value="shipped">Sudah Dikirim</option>
                    </select>

                    {/* Page Size */}
                    <select
                      value={orderLimit}
                      onChange={e => {
                        setOrderLimit(Number(e.target.value));
                        setOrderPage(0);
                      }}
                      className="bg-slate-900 border border-slate-750 rounded-lg px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-500"
                    >
                      <option value={100}>100 baris / hal</option>
                      <option value={200}>200 baris / hal</option>
                      <option value={500}>500 baris / hal</option>
                    </select>
                  </div>
                </div>

                {/* Bulk Action Buttons & Selected Count */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy || cancellableDisplayed.length === 0}
                      onClick={toggleSelectAllDisplayed}
                      className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
                    >
                      {allDisplayedSelected ? (
                        <>
                          <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
                          Batal Pilih Halaman Ini
                        </>
                      ) : (
                        <>
                          <Square className="w-3.5 h-3.5 text-slate-400" />
                          Pilih Semua di Halaman Ini ({cancellableDisplayed.length})
                        </>
                      )}
                    </button>

                    {ids.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setIds([])}
                        className="px-3 py-1.5 rounded-lg border border-rose-800/40 bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        Reset Pilihan
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">
                      Total baris order: <strong className="text-white">{filteredOrders.length}</strong>
                    </span>
                    <span className={`px-2.5 py-1 rounded-md text-xs font-bold font-mono ${
                      ids.length > 0
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}>
                      Terpilih: {ids.length} order
                    </span>
                  </div>
                </div>
              </div>

              {/* Table of Orders */}
              <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900/40 max-h-[46vh]">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-800/90 text-slate-400 border-b border-slate-800 sticky top-0 z-10 backdrop-blur-sm">
                    <tr>
                      <th className="p-3 w-10 text-center">
                        <button
                          type="button"
                          onClick={toggleSelectAllDisplayed}
                          disabled={busy || cancellableDisplayed.length === 0}
                          className="text-slate-400 hover:text-white disabled:opacity-30 inline-flex items-center justify-center"
                          title="Pilih / Batal Pilih Semua yang Tampil"
                        >
                          {allDisplayedSelected ? (
                            <CheckSquare className="w-4 h-4 text-emerald-400" />
                          ) : someDisplayedSelected ? (
                            <MinusSquare className="w-4 h-4 text-amber-400" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </th>
                      <th className="p-3 font-semibold uppercase tracking-wider text-[11px]">Nomor Order / SKU</th>
                      <th className="p-3 font-semibold uppercase tracking-wider text-[11px]">Tujuan / Customer</th>
                      <th className="p-3 font-semibold uppercase tracking-wider text-[11px]">Jumlah</th>
                      <th className="p-3 font-semibold uppercase tracking-wider text-[11px]">Status</th>
                      <th className="p-3 font-semibold uppercase tracking-wider text-[11px] text-right">Aksi Cepat</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredOrders.map(o => {
                      const p = o.payload || {};
                      const isCancelled = p.status === 'Cancelled';
                      const isShipped = !!p.shipped || !!p.shippedAt;
                      const isCancellable = !isCancelled && !isShipped;
                      const isChecked = ids.includes(o.document_id);
                      const orderNum = p.orderNumber || p.referenceNumber || o.document_id;

                      return (
                        <tr
                          key={o.document_id}
                          className={`transition-colors ${
                            isChecked
                              ? 'bg-amber-500/10 hover:bg-amber-500/15'
                              : isCancelled
                              ? 'opacity-60 bg-slate-950/40'
                              : 'hover:bg-slate-850/50'
                          }`}
                        >
                          <td className="p-3 text-center">
                            <input
                              aria-label={'Pilih order ' + o.document_id}
                              type="checkbox"
                              disabled={busy || !isCancellable}
                              checked={isChecked}
                              onChange={e => {
                                if (e.target.checked) {
                                  setIds(prev => [...prev, o.document_id]);
                                } else {
                                  setIds(prev => prev.filter(id => id !== o.document_id));
                                }
                              }}
                              className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500 w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-slate-100">{orderNum}</span>
                              {p.noPo && (
                                <span className="text-[10px] bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-slate-300">
                                  PO: {p.noPo}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              <strong className="text-amber-400 font-mono">{p.skuId}</strong> · {p.skuName}
                            </div>
                            {p.location && (
                              <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                                Lok: {p.location} {p.expiredDate ? `· ED: ${p.expiredDate}` : ''}
                              </div>
                            )}
                          </td>
                          <td className="p-3 font-medium text-slate-300">
                            {p.customerName || '—'}
                          </td>
                          <td className="p-3 whitespace-nowrap font-mono font-bold text-slate-200">
                            {p.qty} pcs
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {isCancelled ? (
                              <div>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1 w-fit">
                                  <Ban className="w-3 h-3 text-rose-400" />
                                  Dibatalkan
                                </span>
                                {p.cancellationReason && (
                                  <div className="text-[10px] text-slate-400 mt-1 max-w-[200px] truncate" title={p.cancellationReason}>
                                    {p.cancellationReason}
                                  </div>
                                )}
                              </div>
                            ) : isShipped ? (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-300 border border-blue-500/30 flex items-center gap-1 w-fit">
                                <Check className="w-3 h-3 text-blue-400" />
                                Sudah dikirim
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 w-fit">
                                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                {p.status || 'Aktif'}
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-right whitespace-nowrap">
                            {isCancellable && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleSelectOrderFamily(p.orderNumber || p.referenceNumber || o.document_id)}
                                className="px-2.5 py-1 text-[10px] font-bold rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                                title="Pilih semua baris SKU pada order ini"
                              >
                                Pilih 1 Order Penuh
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!filteredOrders.length && (
                  <div className="p-8 text-center text-slate-400 text-xs">
                    {searchQuery ? 'Tidak ada order yang cocok dengan pencarian Anda.' : 'Belum ada order pada cabang ini.'}
                  </div>
                )}
              </div>

              {/* Pagination controls */}
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400 pt-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={busy || !orderPage}
                    onClick={() => setOrderPage(orderPage - 1)}
                  >
                    Halaman Sebelumnya
                  </button>
                  <span className="font-semibold text-slate-300">
                    Halaman {orderPage + 1}
                  </span>
                  <button
                    type="button"
                    className={button}
                    disabled={busy || orders.length < orderLimit}
                    onClick={() => setOrderPage(orderPage + 1)}
                  >
                    Halaman Berikutnya
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">
                  Tip: Anda bisa memilih banyak order melintasi halaman, lalu membatalkannya sekaligus.
                </p>
              </div>

              {/* Reason input & submit */}
              <div className="bg-[#111827] border border-slate-800 rounded-xl p-4 space-y-3">
                <label className="text-xs font-semibold text-slate-200 block space-y-1">
                  <span>Alasan Pembatalan (Wajib minimal 5 karakter):</span>
                  <textarea
                    aria-label="Alasan pembatalan order"
                    required
                    minLength={5}
                    maxLength={1000}
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="Tuliskan alasan pembatalan (contoh: Permintaan customer sebelum pengiriman / salah input jumlah SKU)..."
                    className="block w-full border border-slate-750 bg-slate-900 rounded-lg p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors resize-none h-20"
                  />
                </label>

                {/* Preset reason pills */}
                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium text-slate-400">Pilih cepat alasan umum:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {REASON_PRESETS.map((preset, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setReason(preset)}
                        className="px-2.5 py-1 text-[10px] rounded-lg border border-slate-750 bg-slate-850 hover:bg-slate-750 hover:border-slate-650 text-slate-300 hover:text-white transition-all text-left"
                      >
                        + {preset}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t border-slate-800">
                  <div className="text-xs text-slate-400">
                    {ids.length > 0 ? (
                      <span>
                        Siap membatalkan <strong className="text-amber-400 font-mono">{ids.length}</strong> baris order. Stok fisik akan dikembalikan otomatis.
                      </span>
                    ) : (
                      <span className="text-slate-500">Centang order yang ingin dibatalkan di atas.</span>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={busy || !ids.length}
                    className="px-5 py-2.5 rounded-xl font-extrabold text-xs text-white bg-rose-600 hover:bg-rose-500 border border-rose-500/50 shadow-lg shadow-rose-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                  >
                    {busy ? (
                      <>
                        <RotateCcw className="w-4 h-4 animate-spin" />
                        <span>Memproses Pembatalan...</span>
                      </>
                    ) : (
                      <>
                        <Ban className="w-4 h-4" />
                        <span>Batalkan {ids.length > 0 ? `${ids.length} Order Terpilih` : 'Order'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
