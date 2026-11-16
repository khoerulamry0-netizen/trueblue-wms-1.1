import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X, CheckCircle2 } from 'lucide-react';
import type { OrderIssueReportInput } from '../utils/orderSession';

const ISSUE_TYPES: Array<'Stok Kurang' | 'Barang Rusak' | 'Barcode Bermasalah' | 'Lainnya'> = [
  'Stok Kurang',
  'Barang Rusak',
  'Barcode Bermasalah',
  'Lainnya'
];

const QUICK_NOTES: string[] = [
  'Stok fisik di rak kosong / kurang dari jumlah order',
  'Barang ditemukan rusak, penyok, atau bocor',
  'Barcode tidak terbaca atau berbeda dengan SKU order',
  'Item tidak ditemukan / tertinggal saat sortir & packing'
];

interface OrderIssueModalProps {
  open: boolean;
  references: string[];
  stage: 'Picking' | 'Sortir' | 'Packing';
  reporterName: string;
  onClose: () => void;
  onSubmit: (reference: string, report: Exclude<OrderIssueReportInput, { resolveBy: string }>) => Promise<void>;
}

export default function OrderIssueModal({
  open,
  references,
  stage,
  reporterName,
  onClose,
  onSubmit
}: OrderIssueModalProps) {
  const [selectedRef, setSelectedRef] = useState(references[0] || '');
  const [issueType, setIssueType] = useState<'Stok Kurang' | 'Barang Rusak' | 'Barcode Bermasalah' | 'Lainnya'>('Stok Kurang');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setSelectedRef(references[0] || '');
      setIssueType('Stok Kurang');
      setNotes('');
      setError('');
    }
  }, [open, references]);

  if (!open || references.length === 0) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRef.trim()) {
      setError('Pilih nomor order yang bermasalah.');
      return;
    }
    if (notes.trim().length < 5) {
      setError('Tuliskan detail kendala minimal 5 karakter.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(selectedRef, {
        reportedBy: reporterName || 'Operator',
        stage,
        type: issueType,
        notes: notes.trim()
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Gagal menyimpan laporan kendala.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[130] bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Lapor Kendala Stok atau Barang Rusak"
        className="w-full max-w-lg rounded-2xl bg-[#0F141E] border border-amber-500/40 text-slate-100 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-amber-500/10">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <div>
              <h3 className="font-extrabold text-base text-white">Lapor Kendala Lapangan ({stage})</h3>
              <p className="text-[11px] text-amber-200/80">
                Laporan langsung masuk ke tab Laporan Exception Supervisor tanpa mengubah stok secara paksa.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div role="alert" className="p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 font-semibold">
              {error}
            </div>
          )}

          <div>
            <label className="block font-bold text-slate-300 mb-1.5">Nomor Order Bermasalah:</label>
            {references.length === 1 ? (
              <div className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 font-mono font-bold text-amber-300">
                {references[0]}
              </div>
            ) : (
              <select
                value={selectedRef}
                onChange={e => setSelectedRef(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white font-mono font-bold outline-none focus:border-amber-500"
              >
                {references.map(ref => (
                  <option key={ref} value={ref}>
                    {ref}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block font-bold text-slate-300 mb-1.5">Jenis Kendala:</label>
            <div className="grid grid-cols-2 gap-2">
              {ISSUE_TYPES.map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setIssueType(type)}
                  className={`px-3 py-2 rounded-lg border font-bold text-left transition-all cursor-pointer ${
                    issueType === type
                      ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-sm'
                      : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block font-bold text-slate-300">Keterangan / SKU Bermasalah (min. 5 karakter):</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Contoh: SKU 1019 di rak A1 sisa 2 pcs (order butuh 3 pcs), 1 pcs kemasan bocor."
              className="w-full px-3 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-white placeholder-slate-500 outline-none focus:border-amber-500 resize-none"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {QUICK_NOTES.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setNotes(preset)}
                  className="px-2 py-1 rounded border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-[10px] text-slate-300 cursor-pointer text-left"
                >
                  + {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-black flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{busy ? 'Mengirim...' : 'Kirim Laporan Kendala'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
