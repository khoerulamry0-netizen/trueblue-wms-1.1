import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Layers } from 'lucide-react';
import type { ChannelOperationType, OutboundItem } from '../types';
import { resolveOrderType } from '../utils/orderType';

interface UnassignedOrdersBannerProps {
  orderHistory: OutboundItem[];
  currentUser: { role?: string; username?: string; fullName?: string } | null;
  onAssignOrderType?: (
    assignments: Array<{ id?: string; referenceNumber?: string; orderType: ChannelOperationType }>
  ) => Promise<boolean>;
  title?: string;
  compact?: boolean;
}

export function UnassignedOrdersBanner({
  orderHistory,
  currentUser,
  onAssignOrderType,
  title = 'Order Lama / Belum Terklasifikasi (UNASSIGNED)',
  compact = false,
}: UnassignedOrdersBannerProps) {
  const isAdmin = currentUser?.role === 'Administrator' || currentUser?.role === 'Admin';
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [expanded, setExpanded] = useState(!compact);

  const groupedUnassigned = useMemo(() => {
    const groups = new Map<
      string,
      {
        referenceNumber: string;
        orderNumber: string;
        noPo: string;
        customerName: string;
        status: string;
        totalQty: number;
        rowCount: number;
        orderSource?: string;
        timestamp: string;
      }
    >();

    for (const item of orderHistory) {
      if (item.status === 'Cancelled') continue;
      if (resolveOrderType(item) !== 'UNASSIGNED') continue;
      const ref = (item.referenceNumber || item.orderNumber || item.id).trim();
      const existing = groups.get(ref);
      if (existing) {
        existing.totalQty += Number(item.qty || 0);
        existing.rowCount += 1;
      } else {
        groups.set(ref, {
          referenceNumber: ref,
          orderNumber: item.orderNumber || ref,
          noPo: item.noPo || '-',
          customerName: item.customerName || 'Customer',
          status: item.status || 'Pending',
          totalQty: Number(item.qty || 0),
          rowCount: 1,
          orderSource: item.orderSource,
          timestamp: item.timestamp,
        });
      }
    }

    return Array.from(groups.values()).sort((a, b) =>
      String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
    );
  }, [orderHistory]);

  if (!isAdmin || groupedUnassigned.length === 0) {
    return null;
  }

  const assignSingle = async (referenceNumber: string, orderType: ChannelOperationType) => {
    if (!onAssignOrderType || busyKey) return;
    setBusyKey(`${referenceNumber}:${orderType}`);
    setFeedback(null);
    try {
      const ok = await onAssignOrderType([{ referenceNumber, orderType }]);
      if (ok) {
        setFeedback({
          type: 'success',
          message: `Order ${referenceNumber} berhasil ditetapkan sebagai ${orderType}.`,
        });
      } else {
        setFeedback({
          type: 'error',
          message: `Gagal menyimpan klasifikasi order ${referenceNumber}.`,
        });
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err?.message || `Gagal menyimpan klasifikasi order ${referenceNumber}.`,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const assignAll = async (orderType: ChannelOperationType) => {
    if (!onAssignOrderType || busyKey || groupedUnassigned.length === 0) return;
    const confirmed = window.confirm(
      `Tetapkan seluruh ${groupedUnassigned.length} order UNASSIGNED sebagai ${orderType}?\n\nStok dan status order tidak diubah.`
    );
    if (!confirmed) return;

    setBusyKey(`ALL:${orderType}`);
    setFeedback(null);
    try {
      const ok = await onAssignOrderType(
        groupedUnassigned.map((g) => ({
          referenceNumber: g.referenceNumber,
          orderType,
        }))
      );
      if (ok) {
        setFeedback({
          type: 'success',
          message: `${groupedUnassigned.length} order berhasil ditetapkan sebagai ${orderType}.`,
        });
      } else {
        setFeedback({
          type: 'error',
          message: 'Gagal menyimpan klasifikasi massal.',
        });
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err?.message || 'Gagal menyimpan klasifikasi massal.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-black text-amber-200 flex items-center gap-2">
              <span>{title}</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                {groupedUnassigned.length} Order
              </span>
            </h3>
            <p className="text-xs text-amber-100/80 mt-0.5">
              Order tanpa <code className="px-1 py-0.5 rounded bg-slate-900/80 text-amber-200">orderType</code> yang pasti tidak ditebak otomatis dari No PO/customer dan ditahan dari antrean Picking B2B, Picking Online, maupun Manifest. Pilih jenis order secara eksplisit di sini.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onAssignOrderType && (
            <>
              <button
                type="button"
                disabled={Boolean(busyKey)}
                onClick={() => assignAll('B2B')}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold disabled:opacity-50"
              >
                Tetapkan Semua B2B
              </button>
              <button
                type="button"
                disabled={Boolean(busyKey)}
                onClick={() => assignAll('ONLINE')}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50"
              >
                Tetapkan Semua ONLINE
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-200 text-xs font-bold hover:bg-amber-500/20"
          >
            {expanded ? 'Sembunyikan Daftar' : `Lihat ${groupedUnassigned.length} Order`}
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-xl px-3 py-2 text-xs font-semibold flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-200'
              : 'bg-rose-500/15 border border-rose-500/30 text-rose-200'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{feedback.message}</span>
        </div>
      )}

      {expanded && (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/70">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 uppercase text-[10px]">
                <th className="py-2.5 px-3">No. Order / Ref</th>
                <th className="py-2.5 px-3">Customer / PO</th>
                <th className="py-2.5 px-3">Sumber / Status</th>
                <th className="py-2.5 px-3 text-right">Qty</th>
                <th className="py-2.5 px-3 text-right">Klasifikasi Manual Admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {groupedUnassigned.slice(0, 50).map((ord) => (
                <tr key={ord.referenceNumber} className="hover:bg-slate-900/50">
                  <td className="py-2.5 px-3 font-mono font-bold text-white">
                    {ord.orderNumber}
                    {ord.referenceNumber !== ord.orderNumber && (
                      <div className="text-[10px] text-slate-400">Ref: {ord.referenceNumber}</div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-slate-200">
                    <div className="font-semibold">{ord.customerName}</div>
                    {ord.noPo !== '-' && (
                      <div className="text-[10px] text-slate-400 font-mono">PO: {ord.noPo}</div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-slate-300">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-[10px] font-bold">
                      <Layers className="w-3 h-3 text-amber-400" />
                      {ord.orderSource || 'LEGACY'}
                    </span>
                    <span className="ml-1.5 text-[10px] text-slate-400">({ord.status})</span>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-white">
                    {ord.totalQty} pcs
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {onAssignOrderType ? (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={Boolean(busyKey)}
                          onClick={() => assignSingle(ord.referenceNumber, 'B2B')}
                          className="px-2.5 py-1 rounded-lg bg-blue-600/90 hover:bg-blue-500 text-white font-bold text-[11px] disabled:opacity-50"
                        >
                          Tetapkan sebagai B2B
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busyKey)}
                          onClick={() => assignSingle(ord.referenceNumber, 'ONLINE')}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white font-bold text-[11px] disabled:opacity-50"
                        >
                          Tetapkan sebagai ONLINE
                        </button>
                      </div>
                    ) : (
                      <span className="text-slate-500 text-[11px]">Hanya Admin</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {groupedUnassigned.length > 50 && (
            <div className="px-3 py-2 text-[11px] text-slate-400 bg-slate-900/50 border-t border-slate-800">
              Menampilkan 50 dari {groupedUnassigned.length} order UNASSIGNED teratas.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default UnassignedOrdersBanner;
