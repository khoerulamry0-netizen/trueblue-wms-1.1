import React, { useMemo, useState } from 'react';
import { Box, Check, Copy, Edit3, Layers, Search, X } from 'lucide-react';
import type { OutboundItem } from '../types';
import type { OrderSessionData, OrderSessionResult } from '../utils/orderSession';
import {
  buildMasterBasketMonitorData,
  doesMonitorOrderMatchQuery,
  type MasterBasketMonitorGroup,
  type MasterBasketOrderEntry,
  validateMasterBasketUpdate,
} from '../utils/masterBasketTracker';

interface MasterBasketMonitorModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderHistory: OutboundItem[];
  onUpdateOrderSession?: (references: string | string[], sessionData: OrderSessionData) => Promise<OrderSessionResult | false>;
  onAfterRenameMasterBasket?: (refs: string[], newBasketCode: string) => void;
  onSelectBasketForSortir?: (basketCode: string) => void;
}

export default function MasterBasketMonitorModal({
  isOpen,
  onClose,
  orderHistory,
  onUpdateOrderSession,
  onAfterRenameMasterBasket,
  onSelectBasketForSortir,
}: MasterBasketMonitorModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingGroupKey, setEditingGroupKey] = useState<string | null>(null);
  const [editingOrderRef, setEditingOrderRef] = useState<string | null>(null);
  const [basketDraft, setBasketDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { groups, matchingUnassigned } = useMemo(
    () => buildMasterBasketMonitorData(orderHistory, searchTerm),
    [orderHistory, searchTerm]
  );

  const summary = useMemo(() => {
    let picking = 0;
    let waitingSort = 0;
    let readyPacking = 0;
    for (const g of groups) {
      picking += g.stageCounts.picking;
      waitingSort += g.stageCounts.waitingSort;
      readyPacking += g.stageCounts.readyPacking;
    }
    return { picking, waitingSort, readyPacking };
  }, [groups]);

  if (!isOpen) return null;

  const normalizedQuery = searchTerm.trim().toLowerCase();

  const handleCopy = (text: string, key: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      // Ignore clipboard failures in restricted environments
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1500);
  };

  const cancelInlineEdit = () => {
    setEditingGroupKey(null);
    setEditingOrderRef(null);
    setBasketDraft('');
  };

  const submitBasketCorrection = async (
    targetRefs: string[],
    currentBasket: string,
    mode: 'rename_group' | 'move_order'
  ) => {
    if (saving || !onUpdateOrderSession) return;
    const validation = validateMasterBasketUpdate(orderHistory, targetRefs, basketDraft, mode);
    if ('error' in validation) {
      setFeedback({ type: 'error', message: validation.error });
      return;
    }
    const { cleanBasket } = validation;
    if (cleanBasket === currentBasket.trim().toUpperCase()) {
      cancelInlineEdit();
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const result = await onUpdateOrderSession(targetRefs, {
        basketNumber: cleanBasket,
        masterBasketNumber: cleanBasket,
      });
      if (!result) {
        setFeedback({ type: 'error', message: 'Perubahan keranjang induk belum terkonfirmasi server. Coba lagi.' });
        return;
      }
      onAfterRenameMasterBasket?.(targetRefs, cleanBasket);
      cancelInlineEdit();
      setFeedback({
        type: 'success',
        message:
          mode === 'rename_group'
            ? `✓ Kode Keranjang Induk "${currentBasket}" berhasil diubah menjadi "${cleanBasket}" (${targetRefs.length} order).`
            : `✓ Order ${targetRefs[0]} dipindahkan ke Keranjang Induk "${cleanBasket}".`,
      });
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Gagal memperbarui kode keranjang induk.',
      });
    } finally {
      setSaving(false);
    }
  };

  const startGroupRename = (group: MasterBasketMonitorGroup) => {
    setFeedback(null);
    setEditingOrderRef(null);
    setEditingGroupKey(group.groupKey);
    setBasketDraft(group.basketCode);
  };

  const startOrderMove = (entry: MasterBasketOrderEntry) => {
    setFeedback(null);
    setEditingGroupKey(null);
    setEditingOrderRef(entry.referenceNumber);
    setBasketDraft(entry.masterBasket || '');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Monitor Keranjang Induk Admin"
    >
      <div className="w-full max-w-5xl max-h-[90vh] bg-white border border-slate-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-900">
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 bg-slate-900 text-white flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-sky-500/20 border border-sky-400/30 text-sky-300 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black tracking-tight">
                Monitor & Koreksi Keranjang Induk
              </h2>
              <p className="text-xs text-slate-300 mt-0.5">
                Lacak pesanan per keranjang aktif (Picking / Sortir / Packing) atau koreksi kode keranjang induk sebelum proses sortir.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup monitor keranjang"
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search & Summary Bar */}
        <div className="px-4 sm:px-6 py-3 bg-slate-50 border-b border-slate-200 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Cari No. Order, Ref, Kode Keranjang, atau Nama Picker..."
                className="w-full pl-9 pr-8 py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-medium outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  aria-label="Hapus pencarian"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
              <span className="px-2.5 py-1 rounded-md bg-white border border-slate-300 text-slate-700">
                {groups.length} Keranjang
              </span>
              <span className="px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-800">
                Picking: {summary.picking}
              </span>
              <span className="px-2.5 py-1 rounded-md bg-sky-50 border border-sky-200 text-sky-800">
                Menunggu Sortir: {summary.waitingSort}
              </span>
              <span className="px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800">
                Siap Packing: {summary.readyPacking}
              </span>
            </div>
          </div>

          {feedback && (
            <div
              role="alert"
              className={`px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-between gap-2 ${
                feedback.type === 'error'
                  ? 'bg-rose-50 text-rose-800 border border-rose-300'
                  : 'bg-emerald-50 text-emerald-800 border border-emerald-300'
              }`}
            >
              <span>{feedback.message}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="p-0.5 hover:opacity-70 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-slate-100/70">
          {matchingUnassigned.length > 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-3.5 space-y-2">
              <div className="text-xs font-black text-amber-900">
                Order cocok ditemukan ({matchingUnassigned.length} order Pending), namun BELUM diikat ke Keranjang Induk mana pun:
              </div>
              <div className="flex flex-wrap gap-2">
                {matchingUnassigned.slice(0, 10).map(ord => (
                  <span
                    key={ord.referenceNumber}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-amber-200 text-[11px] font-mono text-amber-950"
                  >
                    <strong>{ord.orderNumber || ord.referenceNumber}</strong>
                    <span className="text-slate-500">({ord.totalQty} pcs • Belum Diikat)</span>
                  </span>
                ))}
                {matchingUnassigned.length > 10 && (
                  <span className="text-[11px] font-bold text-amber-800 self-center">
                    +{matchingUnassigned.length - 10} order lainnya
                  </span>
                )}
              </div>
            </div>
          )}

          {groups.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-slate-400 space-y-2">
              <Box className="w-10 h-10 mx-auto text-slate-300" />
              <p className="text-sm font-bold text-slate-600">
                {searchTerm.trim()
                  ? 'Tidak ada keranjang aktif yang cocok dengan pencarian.'
                  : 'Belum ada order aktif yang terikat ke keranjang saat ini.'}
              </p>
            </div>
          ) : (
            groups.map(group => {
              const isRenamingThisGroup = editingGroupKey === group.groupKey;
              return (
                <div
                  key={group.groupKey}
                  className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden"
                >
                  {/* Group Header */}
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 text-white font-mono text-xs font-black">
                        <Box className="w-3.5 h-3.5 text-sky-400" />
                        <span>{group.isMasterBasket ? 'Induk:' : 'Keranjang Sortir:'} {group.basketCode}</span>
                      </span>

                      <span className="text-xs font-bold text-slate-700">
                        {group.orders.length} Order · {group.totalQty} Pcs
                      </span>

                      {group.pickerNames.length > 0 && (
                        <span className="text-xs text-slate-600">
                          Picker: <strong className="text-sky-700">{group.pickerNames.join(', ')}</strong>
                        </span>
                      )}

                      {group.stageCounts.picking > 0 && (
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-bold">
                          Sedang Dipicking ({group.stageCounts.picking})
                        </span>
                      )}
                      {group.stageCounts.waitingSort > 0 && (
                        <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-900 border border-sky-300 text-[10px] font-bold">
                          Menunggu Sortir ({group.stageCounts.waitingSort})
                        </span>
                      )}
                      {group.stageCounts.readyPacking > 0 && (
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 border border-emerald-300 text-[10px] font-bold">
                          Sudah Sortir ({group.stageCounts.readyPacking})
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {onSelectBasketForSortir && group.isMasterBasket && group.stageCounts.waitingSort > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectBasketForSortir(group.basketCode);
                            onClose();
                          }}
                          className="px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-bold cursor-pointer transition-colors"
                        >
                          Buka di Sortir
                        </button>
                      )}

                      {onUpdateOrderSession && group.canRenameGroup && !isRenamingThisGroup && (
                        <button
                          type="button"
                          onClick={() => startGroupRename(group)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-950 border border-amber-300 text-[11px] font-bold cursor-pointer transition-colors"
                        >
                          <Edit3 className="w-3 h-3" />
                          Ubah Kode Induk
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Inline Rename Group Form */}
                  {isRenamingThisGroup && (
                    <form
                      onSubmit={e => {
                        e.preventDefault();
                        submitBasketCorrection(
                          group.orders.map(o => o.referenceNumber),
                          group.basketCode,
                          'rename_group'
                        );
                      }}
                      className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span className="font-bold text-amber-950">
                        Kode Keranjang Induk Baru untuk {group.orders.length} order:
                      </span>
                      <input
                        type="text"
                        autoFocus
                        value={basketDraft}
                        onChange={e => setBasketDraft(e.target.value)}
                        placeholder="Masukkan kode baru (mis. JJ2)..."
                        className="px-2.5 py-1.5 border border-amber-400 rounded bg-white text-slate-900 font-mono font-bold text-xs uppercase outline-none focus:ring-2 focus:ring-amber-500 w-44"
                      />
                      <button
                        type="submit"
                        disabled={saving}
                        className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer disabled:opacity-50"
                      >
                        {saving ? 'Menyimpan…' : 'Simpan'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelInlineEdit}
                        disabled={saving}
                        className="px-2.5 py-1.5 rounded bg-white border border-slate-300 text-slate-700 font-bold hover:bg-slate-100 cursor-pointer"
                      >
                        Batal
                      </button>
                    </form>
                  )}

                  {/* Orders Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-100/80 text-slate-600 font-bold border-b border-slate-200 text-[11px]">
                          <th className="py-2 px-3">No. Order / Ref</th>
                          <th className="py-2 px-3">Customer</th>
                          <th className="py-2 px-3 text-center">SKU / Qty</th>
                          <th className="py-2 px-3 text-center">Tahap</th>
                          <th className="py-2 px-3 text-center">Anak Keranjang</th>
                          {onUpdateOrderSession && <th className="py-2 px-3 text-center w-36">Koreksi</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {group.orders.map(ord => {
                          const highlighted = Boolean(normalizedQuery) && doesMonitorOrderMatchQuery(ord, normalizedQuery);
                          const isMovingThisOrder = editingOrderRef === ord.referenceNumber;
                          const displayRef = ord.orderNumber || ord.referenceNumber;
                          return (
                            <React.Fragment key={ord.referenceNumber}>
                              <tr className={highlighted ? 'bg-amber-50/90' : 'hover:bg-slate-50'}>
                                <td className="py-2 px-3 font-mono">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-bold text-slate-900">{displayRef}</span>
                                    <button
                                      type="button"
                                      onClick={() => handleCopy(displayRef, ord.referenceNumber)}
                                      title={`Salin ${displayRef}`}
                                      className="p-0.5 text-slate-400 hover:text-sky-600 cursor-pointer"
                                    >
                                      {copiedKey === ord.referenceNumber ? (
                                        <Check className="w-3 h-3 text-emerald-600" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  </div>
                                  {ord.orderNumber && ord.orderNumber !== ord.referenceNumber && (
                                    <div className="text-[10px] text-slate-500">Ref: {ord.referenceNumber}</div>
                                  )}
                                  {ord.batchNumber && (
                                    <div className="text-[10px] text-slate-500">Batch: {ord.batchNumber}</div>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-slate-700 font-medium">
                                  {ord.customerName || '-'}
                                </td>
                                <td className="py-2 px-3 text-center font-mono">
                                  <span className="font-bold text-slate-800">{ord.skuCount} SKU</span>
                                  <span className="text-slate-400 mx-1">·</span>
                                  <span className="font-bold text-sky-700">{ord.totalQty} pcs</span>
                                </td>
                                <td className="py-2 px-3 text-center">
                                  <span
                                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                                      ord.stage === 'Siap Packing'
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : ord.stage === 'Menunggu Sortir'
                                        ? 'bg-sky-100 text-sky-800'
                                        : 'bg-amber-100 text-amber-800'
                                    }`}
                                  >
                                    {ord.stage}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-center font-mono font-bold">
                                  {ord.sortBasket ? (
                                    <span className="px-2 py-0.5 rounded bg-violet-100 text-violet-900 border border-violet-200">
                                      {ord.sortBasket}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400">—</span>
                                  )}
                                </td>
                                {onUpdateOrderSession && (
                                  <td className="py-2 px-3 text-center">
                                    {!ord.isSorted ? (
                                      <button
                                        type="button"
                                        onClick={() => startOrderMove(ord)}
                                        className="px-2 py-1 rounded bg-slate-100 hover:bg-amber-100 text-slate-700 hover:text-amber-900 border border-slate-300 text-[10px] font-bold cursor-pointer transition-colors"
                                      >
                                        Pindah Induk
                                      </button>
                                    ) : (
                                      <span className="text-[10px] text-slate-400">Sudah sortir</span>
                                    )}
                                  </td>
                                )}
                              </tr>
                              {isMovingThisOrder && (
                                <tr className="bg-amber-50">
                                  <td colSpan={onUpdateOrderSession ? 6 : 5} className="px-3 py-2">
                                    <form
                                      onSubmit={e => {
                                        e.preventDefault();
                                        submitBasketCorrection(
                                          [ord.referenceNumber],
                                          ord.masterBasket || group.basketCode,
                                          'move_order'
                                        );
                                      }}
                                      className="flex flex-wrap items-center gap-2 text-xs"
                                    >
                                      <span className="font-bold text-amber-950">
                                        Pindahkan {displayRef} ke Keranjang Induk:
                                      </span>
                                      <input
                                        type="text"
                                        autoFocus
                                        value={basketDraft}
                                        onChange={e => setBasketDraft(e.target.value)}
                                        placeholder="Kode keranjang tujuan..."
                                        className="px-2 py-1 border border-amber-400 rounded bg-white text-slate-900 font-mono font-bold text-xs uppercase outline-none focus:ring-2 focus:ring-amber-500 w-40"
                                      />
                                      <button
                                        type="submit"
                                        disabled={saving}
                                        className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer disabled:opacity-50"
                                      >
                                        {saving ? 'Menyimpan…' : 'Simpan'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={cancelInlineEdit}
                                        disabled={saving}
                                        className="px-2 py-1 rounded bg-white border border-slate-300 text-slate-700 font-bold hover:bg-slate-100 cursor-pointer"
                                      >
                                        Batal
                                      </button>
                                    </form>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
