import BranchSenderSettings from './BranchSenderSettings';
import { 
  Building2, 
  ShieldCheck, 
  Archive, 
  History, 
  BookOpen, 
  ArrowLeftRight, 
  Network,
  Edit2,
  Trash2,
  Check,
  X,
  AlertCircle,
  Save,
  Plus,
  Webhook
} from 'lucide-react';
import HqDashboard from './HqDashboard';
import BackupRecovery from './BackupRecovery';
import ActivityConsole from './ActivityConsole';
import StockLedger from './StockLedger';
import { createPortal } from 'react-dom';
import BranchTransfers from './BranchTransfers';
import BranchDeletion from './BranchDeletion';
import React, { useEffect, useState } from 'react';
import { supabase, getActiveBranch, setActiveBranch } from '../supabase';
import { useLanguage } from '../i18n/LanguageContext';
import type { BranchOperationType, UserAccount } from '../types';
import { normalizeBranchOperationType } from '../utils/orderType';

type Branch = { id: string; name: string; operation_type?: BranchOperationType };

export default function BranchPanel({
  currentUser,
  navigationTarget,
  onAction,
  onOpenWebhook,
  onBranchOperationTypeChange,
}: {
  currentUser: UserAccount | null;
  navigationTarget?: HTMLElement | null;
  onAction?: () => void;
  onOpenWebhook?: () => void;
  onBranchOperationTypeChange?: (op: BranchOperationType) => void;
}) {
  const { language } = useLanguage();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [operationType, setOperationType] = useState<BranchOperationType>('HYBRID');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletionBranch, setDeletionBranch] = useState<Branch | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  // Edit branch state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editOperationType, setEditOperationType] = useState<BranchOperationType>('HYBRID');

  const [senderOpen, setSenderOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<'audit' | 'exception' | 'cancel'>('audit');
  const [cancelIds, setCancelIds] = useState<string[]>([]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const nextIds = detail.orderIds || [];
      setCancelIds(nextIds);
      setActivityTab(detail.tab || (nextIds.length ? 'cancel' : 'audit'));
      setActivityOpen(true);
    };
    window.addEventListener('wms-open-audit', listener);
    return () => window.removeEventListener('wms-open-audit', listener);
  }, []);

  const [backupOpen, setBackupOpen] = useState(false);
  const [hqOpen, setHqOpen] = useState(false);
  const hq = currentUser?.role === 'Administrator';

  const load = async () => {
    if (!supabase) return;
    const { data, error: fetchErr } = await supabase.from('branches').select('id,name,operation_type').order('id');
    if (fetchErr) {
      const fallback = await supabase.from('branches').select('id,name').order('id');
      if (fallback.error) {
        setError(fallback.error.message);
      } else {
        const list: Branch[] = (fallback.data || []).map((b: any) => ({
          id: b.id,
          name: b.name,
          operation_type: 'HYBRID',
        }));
        setBranches(list);
      }
      return;
    }
    const list: Branch[] = (data || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      operation_type: normalizeBranchOperationType(b.operation_type, 'HYBRID'),
    }));
    setBranches(list);
    const active = list.find((b) => b.id === getActiveBranch());
    if (active?.operation_type) {
      onBranchOperationTypeChange?.(active.operation_type);
    }
  };

  useEffect(() => {
    void load();
  }, [currentUser?.id]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setError('');
    setSuccessMsg('');
    const cleanCode = code.trim().toUpperCase();
    const cleanName = name.trim();
    const cleanOp = normalizeBranchOperationType(operationType, 'HYBRID');
    let insertErr: any = null;
    const rpcRes = await supabase.rpc('save_branch', {
      p_id: cleanCode,
      p_name: cleanName,
      p_operation_type: cleanOp,
    });
    if (rpcRes.error) {
      if (rpcRes.error.code === 'PGRST202' || /could not find the function/i.test(rpcRes.error.message || '')) {
        const directRes = await supabase
          .from('branches')
          .insert({ id: cleanCode, name: cleanName, operation_type: cleanOp });
        insertErr = directRes.error;
      } else {
        insertErr = rpcRes.error;
      }
    }
    setBusy(false);
    if (insertErr) {
      setError(insertErr.message);
    } else {
      setCode('');
      setName('');
      setOperationType('HYBRID');
      setSuccessMsg(`Cabang "${cleanCode} — ${cleanName}" (${cleanOp}) berhasil ditambahkan.`);
      window.dispatchEvent(
        new CustomEvent('wms-branch-config-updated', { detail: { branchId: cleanCode, operationType: cleanOp } })
      );
      await load();
    }
  };

  const startEdit = (b: Branch) => {
    setEditingId(b.id);
    setEditName(b.name);
    setEditOperationType(normalizeBranchOperationType(b.operation_type, 'HYBRID'));
    setError('');
    setSuccessMsg('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditOperationType('HYBRID');
  };

  const saveEdit = async (branchId: string) => {
    if (!supabase || busy) return;
    const cleanName = editName.trim();
    const cleanOp = normalizeBranchOperationType(editOperationType, 'HYBRID');

    if (!cleanName) {
      setError('Nama cabang tidak boleh kosong.');
      return;
    }

    setBusy(true);
    setError('');
    setSuccessMsg('');

    try {
      const rpcRes = await supabase.rpc('save_branch', {
        p_id: branchId,
        p_name: cleanName,
        p_operation_type: cleanOp,
      });
      if (rpcRes.error) {
        if (rpcRes.error.code === 'PGRST202' || /could not find the function/i.test(rpcRes.error.message || '')) {
          const { error: updateErr } = await supabase
            .from('branches')
            .update({ name: cleanName, operation_type: cleanOp })
            .eq('id', branchId);
          if (updateErr) throw updateErr;
        } else {
          throw rpcRes.error;
        }
      }

      if (branchId === getActiveBranch()) {
        onBranchOperationTypeChange?.(cleanOp);
      }
      window.dispatchEvent(
        new CustomEvent('wms-branch-config-updated', { detail: { branchId, operationType: cleanOp } })
      );
      setSuccessMsg(`Cabang "${branchId}" diperbarui: "${cleanName}" (${cleanOp}).`);
      setEditingId(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Gagal menyimpan perubahan cabang.');
    } finally {
      setBusy(false);
    }
  };

  const deleteBranch = (b: Branch) => {
    if (busy) return;
    if (branches.length <= 1) {
      setError('Tidak dapat menghapus cabang. Minimal harus ada 1 cabang terdaftar dalam sistem.');
      return;
    }
    if (b.id === getActiveBranch()) {
      setError(`Cabang "${b.id}" sedang aktif digunakan. Silakan pindah ke cabang lain terlebih dahulu sebelum menghapus.`);
      return;
    }
    setError('');
    setSuccessMsg('');
    setDeletionBranch(b);
  };

  const change = (id: string) => {
    if (id === getActiveBranch()) return;
    if (!window.confirm('Pindah cabang? Form yang belum disimpan akan ditutup.')) return;
    setActiveBranch(id);
    window.location.reload();
  };

  return (
    <>
      <div className="blues-branch-picker">
        <label>
          <Building2 size={16} />
          <span>{language === 'en' ? 'Active branch' : 'Cabang aktif'}</span>
          <select
            title={currentUser?.role === 'Viewer' ? (language === 'en' ? 'All branches · view only' : 'Semua cabang · hanya lihat') : (language === 'en' ? 'Select branch' : 'Pilih cabang')}
            aria-label={language === 'en' ? 'Active branch' : 'Cabang aktif'}
            value={getActiveBranch()}
            onChange={e => change(e.target.value)}
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.id} — {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {navigationTarget && ['Admin', 'Administrator'].includes(currentUser?.role || '') &&
        createPortal(
          <nav aria-label={language === 'en' ? 'Branch administration' : 'Administrasi cabang'} onClick={onAction}>
            <p className="blues-nav-caption">{language === 'en' ? 'Administration' : 'Administrasi'}</p>
            {hq && (
              <button className="blues-nav-link" onClick={() => setHqOpen(true)}>
                <Network size={18} />
                <span>{language === 'en' ? 'Central Dashboard' : 'Dashboard Pusat'}</span>
              </button>
            )}
            <button className="blues-nav-link" onClick={() => setBackupOpen(true)}>
              <Archive size={18} />
              <span>{language === 'en' ? 'Backup & Recovery' : 'Backup & Pemulihan'}</span>
            </button>
            <button
              className="blues-nav-link"
              onClick={() => {
                setCancelIds([]);
                setActivityTab('audit');
                setActivityOpen(true);
              }}
            >
              <History size={18} />
              <span>{language === 'en' ? 'Activity & Cancellations' : 'Aktivitas & Pembatalan'}</span>
            </button>
            <button
              className="blues-nav-link"
              onClick={() => {
                setCancelIds([]);
                setActivityTab('exception');
                setActivityOpen(true);
              }}
            >
              <AlertCircle size={18} />
              <span>{language === 'en' ? 'Exception Report' : 'Laporan Exception'}</span>
            </button>
            <button className="blues-nav-link" onClick={() => setLedgerOpen(true)}>
              <BookOpen size={18} />
              <span>{language === 'en' ? 'Stock Ledger' : 'Buku Mutasi'}</span>
            </button>
            <button className="blues-nav-link" onClick={() => setTransferOpen(true)}>
              <ArrowLeftRight size={18} />
              <span>{language === 'en' ? 'Branch Transfer' : 'Transfer Cabang'}</span>
            </button>
            {hq && (
              <button className="blues-nav-link" onClick={() => setSenderOpen(true)}>
                <Building2 size={18} />
                <span>{language === 'en' ? 'Sender Settings' : 'Pengaturan Pengirim'}</span>
              </button>
            )}
            {hq && (
              <button className="blues-nav-link" onClick={() => setOpen(true)}>
                <Building2 size={18} />
                <span>{language === 'en' ? 'Branch Master' : 'Master Cabang'}</span>
              </button>
            )}
            {onOpenWebhook && (
              <button className="blues-nav-link" onClick={onOpenWebhook}>
                <Webhook size={18} />
                <span>{language === 'en' ? 'Marketplace Webhook' : 'Webhook Marketplace'}</span>
              </button>
            )}
          </nav>,
          navigationTarget
        )}

      {senderOpen && <BranchSenderSettings onClose={() => setSenderOpen(false)} />}
      {hqOpen && <HqDashboard onClose={() => setHqOpen(false)} />}
      {backupOpen && <BackupRecovery onClose={() => setBackupOpen(false)} />}
      {activityOpen && (
        <ActivityConsole
          initialIds={cancelIds}
          initialTab={activityTab}
          currentUserName={currentUser?.fullName || currentUser?.username}
          onClose={() => setActivityOpen(false)}
        />
      )}
      {ledgerOpen && <StockLedger onClose={() => setLedgerOpen(false)} />}
      {transferOpen && <BranchTransfers currentUser={currentUser} onClose={() => setTransferOpen(false)} />}

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[100] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
            <section
              role="dialog"
              aria-modal="true"
              aria-label="Master Cabang"
              className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-[#0E121A] border border-slate-800/80 text-slate-100 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/80 bg-[#121722]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center text-emerald-400">
                    <Building2 size={20} />
                  </div>
                  <div>
                    <h2 className="font-bold text-base text-slate-100">Master Cabang (Warehouse DC)</h2>
                    <p className="text-xs text-slate-400">
                      Kelola daftar cabang dan hapus cabang kosong yang belum memiliki akun atau data.
                    </p>
                  </div>
                </div>
                <button
                  aria-label="Tutup master cabang"
                  onClick={() => {
                    setOpen(false);
                    cancelEdit();
                    setError('');
                    setSuccessMsg('');
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Content Body */}
              <div className="p-6 overflow-y-auto space-y-5">
                {error && (
                  <div
                    role="alert"
                    className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2"
                  >
                    <AlertCircle size={16} className="shrink-0 text-rose-400" />
                    <span>{error}</span>
                  </div>
                )}

                {successMsg && (
                  <div
                    role="status"
                    className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2"
                  >
                    <Check size={16} className="shrink-0 text-emerald-400" />
                    <span>{successMsg}</span>
                  </div>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRestoreOpen(true)}
                  className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-bold text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                >
                  Pulihkan cabang dari file backup penghapusan
                </button>

                {/* Table of Branches */}
                <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-[#121722]/60">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#161B25] text-slate-400 uppercase font-bold text-[10px] border-b border-slate-800/80">
                      <tr>
                        <th className="py-2.5 px-4 w-32">Kode Cabang</th>
                        <th className="py-2.5 px-4">Nama Cabang</th>
                        <th className="py-2.5 px-4 text-center w-28">Operasional</th>
                        <th className="py-2.5 px-4 text-center w-24">Status</th>
                        <th className="py-2.5 px-4 text-right w-32">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {branches.map(b => {
                        const isActive = b.id === getActiveBranch();
                        const isEditing = editingId === b.id;

                        return (
                          <tr
                            key={b.id}
                            className={`hover:bg-slate-800/20 transition-colors ${
                              isActive ? 'bg-emerald-500/5' : ''
                            }`}
                          >
                            <td className="py-3 px-4 font-mono font-bold">
                              <span className="inline-flex items-center gap-1 font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded text-[11px]" title="Kode cabang adalah ID permanen">
                                {b.id}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editName}
                                  onChange={e => setEditName(e.target.value)}
                                  maxLength={100}
                                  placeholder="Nama cabang..."
                                  className="w-full px-2 py-1 text-xs bg-[#161B25] border border-emerald-500/40 text-slate-100 rounded outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                                  autoFocus
                                />
                              ) : (
                                <span className="font-semibold text-slate-200">{b.name}</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-center whitespace-nowrap">
                              {isEditing ? (
                                <select
                                  aria-label={`Tipe operasional ${b.id}`}
                                  value={editOperationType}
                                  onChange={(e) =>
                                    setEditOperationType(normalizeBranchOperationType(e.target.value, 'HYBRID'))
                                  }
                                  className="px-2 py-1 text-[11px] font-bold bg-[#161B25] border border-emerald-500/40 text-slate-100 rounded outline-none focus:ring-1 focus:ring-emerald-500"
                                >
                                  <option value="HYBRID">HYBRID</option>
                                  <option value="B2B">B2B</option>
                                  <option value="ONLINE">ONLINE</option>
                                </select>
                              ) : (
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-extrabold border ${
                                    b.operation_type === 'B2B'
                                      ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                                      : b.operation_type === 'ONLINE'
                                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                                        : 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                  }`}
                                >
                                  {b.operation_type || 'HYBRID'}
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-center whitespace-nowrap">
                              {isActive ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                  Aktif
                                </span>
                              ) : (
                                <span className="text-[10px] text-slate-500 font-medium">Standby</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              {isEditing ? (
                                <div className="inline-flex items-center gap-1.5 justify-end">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => saveEdit(b.id)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs transition-colors cursor-pointer disabled:opacity-50 shadow-sm"
                                    title="Simpan Perubahan"
                                  >
                                    <Save size={13} />
                                    Simpan
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={cancelEdit}
                                    className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
                                    title="Batal"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-1.5 justify-end">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => startEdit(b)}
                                    className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-sky-500/15 text-slate-300 hover:text-sky-400 border border-slate-700/60 hover:border-sky-500/40 transition-colors cursor-pointer active:scale-95"
                                    title={`Edit Cabang ${b.id}`}
                                  >
                                    <Edit2 size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy || isActive}
                                    onClick={() => deleteBranch(b)}
                                    className={`p-1.5 rounded-lg transition-colors border ${
                                      isActive
                                        ? 'bg-slate-800/40 text-slate-600 border-slate-800 cursor-not-allowed'
                                        : 'bg-slate-800/80 hover:bg-rose-500/15 text-slate-300 hover:text-rose-400 border-slate-700/60 hover:border-rose-500/40 cursor-pointer active:scale-95'
                                    }`}
                                    title={isActive ? 'Cabang aktif tidak dapat dihapus' : `Hapus Cabang ${b.id}`}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Form Tambah Cabang Baru */}
                <form onSubmit={add} className="p-4 rounded-xl border border-slate-800 bg-[#121722]/40 space-y-3">
                  <h3 className="font-bold text-xs text-slate-300 flex items-center gap-2">
                    <Plus size={14} className="text-emerald-400" />
                    Tambah Cabang Baru
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Kode Cabang</label>
                      <input
                        aria-label="Kode cabang"
                        placeholder="Contoh: JKT01 / SUB02"
                        required
                        pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,31}"
                        maxLength={32}
                        value={code}
                        onChange={e => setCode(e.target.value.toUpperCase())}
                        className="w-full px-3 py-2 text-xs font-mono font-bold bg-[#161B25] border border-slate-700/70 text-emerald-400 rounded-lg outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Nama Cabang</label>
                      <input
                        aria-label="Nama cabang"
                        placeholder="Contoh: DC Jakarta Pusat"
                        required
                        maxLength={100}
                        value={name}
                        onChange={e => setName(e.target.value)}
                        className="w-full px-3 py-2 text-xs bg-[#161B25] border border-slate-700/70 text-slate-100 rounded-lg outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Tipe Operasional</label>
                      <select
                        aria-label="Tipe operasional cabang"
                        value={operationType}
                        onChange={e => setOperationType(normalizeBranchOperationType(e.target.value, 'HYBRID'))}
                        className="w-full px-3 py-2 text-xs font-bold bg-[#161B25] border border-slate-700/70 text-slate-100 rounded-lg outline-none focus:ring-1 focus:ring-emerald-500"
                      >
                        <option value="HYBRID">HYBRID (B2B + Online)</option>
                        <option value="B2B">Khusus B2B</option>
                        <option value="ONLINE">Khusus Online</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs transition-colors cursor-pointer disabled:opacity-50 shadow-md active:scale-95"
                    >
                      <Plus size={14} />
                      {busy ? 'Menyimpan…' : 'Simpan Cabang Baru'}
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </div>,
          document.body
        )}
      {deletionBranch && (
        <BranchDeletion
          branch={deletionBranch}
          onClose={() => setDeletionBranch(null)}
          onDeleted={async () => {
            setSuccessMsg(`Cabang "${deletionBranch.id} - ${deletionBranch.name}" berhasil dihapus.`);
            await load();
          }}
        />
      )}
      {restoreOpen && (
        <BranchDeletion
          onClose={() => setRestoreOpen(false)}
          onDeleted={async () => {
            setSuccessMsg('Cabang berhasil dipulihkan dari backup terverifikasi.');
            await load();
          }}
        />
      )}
    </>
  );
}
