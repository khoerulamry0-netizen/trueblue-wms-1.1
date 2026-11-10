import BranchSenderSettings from './BranchSenderSettings';
import { Building2, ShieldCheck, Archive, History, BookOpen, ArrowLeftRight, Network, Trash2, Pencil, X } from 'lucide-react';
import HqDashboard from './HqDashboard';
import BackupRecovery from './BackupRecovery';
import ActivityConsole from './ActivityConsole';
import StockLedger from './StockLedger';
import { createPortal } from 'react-dom';
import BranchTransfers from './BranchTransfers';
import React, { useEffect, useState } from 'react';
import { supabase, getActiveBranch, setActiveBranch } from '../supabase';
import type { UserAccount } from '../types';
type Branch = {id:string;name:string};
export default function BranchPanel({currentUser,navigationTarget,onAction}:{currentUser:UserAccount|null;navigationTarget?:HTMLElement|null;onAction?:()=>void}) {
 const [branches,setBranches]=useState<Branch[]>([]),[open,setOpen]=useState(false),[code,setCode]=useState(''),[name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
 const [senderOpen,setSenderOpen]=useState(false);
 const [transferOpen,setTransferOpen]=useState(false);
 const [ledgerOpen,setLedgerOpen]=useState(false);
 const [activityOpen,setActivityOpen]=useState(false),[cancelIds,setCancelIds]=useState<string[]>([]);
 useEffect(()=>{const listener=(event:Event)=>{setCancelIds((event as CustomEvent).detail?.orderIds||[]);setActivityOpen(true)};window.addEventListener('wms-open-audit',listener);return()=>window.removeEventListener('wms-open-audit',listener)},[]);
 const [backupOpen,setBackupOpen]=useState(false);
 const [hqOpen,setHqOpen]=useState(false);
 const hq=currentUser?.role==='Administrator';
 const load=async()=>{if(!supabase)return;const {data,error}=await supabase.from('branches').select('id,name').order('id');if(error)setError(error.message);else setBranches(data||[])};
 useEffect(()=>{void load()},[currentUser?.id]);
 const startEdit=(b:Branch)=>{setEditingBranch(b);setCode(b.id);setName(b.name);setError('');};
 const cancelEdit=()=>{setEditingBranch(null);setCode('');setName('');setError('');};
 const saveBranch=async(e:React.FormEvent)=>{
   e.preventDefault();
   if(!supabase||busy)return;
   setBusy(true);setError('');
   const cleanCode=(editingBranch?editingBranch.id:code).trim().toUpperCase();
   const cleanName=name.trim();
   const {error:rpcError}=await supabase.rpc('save_branch',{p_id:cleanCode,p_name:cleanName});
   if(!rpcError){
     setBusy(false);setCode('');setName('');setEditingBranch(null);await load();return;
   }
   const payload={id:cleanCode,name:cleanName};
   const {error:upsertError}=editingBranch
     ? await supabase.from('branches').update({name:cleanName}).eq('id',cleanCode)
     : await supabase.from('branches').upsert(payload);
   setBusy(false);
   if(upsertError){
     setError(upsertError.message||rpcError.message);
   }else{
     setCode('');setName('');setEditingBranch(null);await load();
   }
 };
 const removeBranch=async(branchToDelete:Branch)=>{
   if(!supabase||busy)return;
   if(branches.length<=1){alert('Tidak dapat menghapus cabang. Minimal harus ada 1 cabang aktif di sistem.');return;}
   const confirmed=window.confirm(`Yakin ingin menghapus cabang "${branchToDelete.id} — ${branchToDelete.name}"?\nSemua dokumen, stok, dan data operasional pada cabang ini akan dibersihkan.`);
   if(!confirmed)return;
   setBusy(true);setError('');
   const {error:rpcError}=await supabase.rpc('delete_branch',{p_branch_id:branchToDelete.id});
   if(rpcError){
     const {error:delError}=await supabase.from('branches').delete().eq('id',branchToDelete.id);
     if(delError){setError(delError.message||rpcError.message);setBusy(false);return;}
   }
   setBusy(false);
   if(branchToDelete.id===getActiveBranch()){
     const remaining=branches.filter(b=>b.id!==branchToDelete.id);
     if(remaining.length>0){setActiveBranch(remaining[0].id);window.location.reload();return;}
   }
   await load();
 };
 const change=(id:string)=>{if(id===getActiveBranch())return;if(!window.confirm('Pindah cabang? Form yang belum disimpan akan ditutup.'))return;setActiveBranch(id);window.location.reload()};
 return <><div className="blues-branch-picker"><label><Building2 size={16}/><span>Cabang aktif</span><select title={currentUser?.role==='Viewer'?'Semua cabang · hanya lihat':'Pilih cabang'} aria-label="Cabang aktif" value={getActiveBranch()} onChange={e=>change(e.target.value)}>{branches.map(b=><option key={b.id} value={b.id}>{b.id} — {b.name}</option>)}</select></label></div>
 {navigationTarget&&createPortal(<nav aria-label="Administrasi cabang" onClick={onAction}><p className="blues-nav-caption">Administrasi</p>{hq&&<button className="blues-nav-link" onClick={()=>setHqOpen(true)}><Network size={18}/><span>Dashboard Pusat</span></button>}{['Admin','Administrator'].includes(currentUser?.role||'')&&<><button className="blues-nav-link" onClick={()=>setBackupOpen(true)}><Archive size={18}/><span>Backup & Pemulihan</span></button><button className="blues-nav-link" onClick={()=>{setCancelIds([]);setActivityOpen(true)}}><History size={18}/><span>Aktivitas & Pembatalan</span></button></>}<button className="blues-nav-link" onClick={()=>setLedgerOpen(true)}><BookOpen size={18}/><span>Buku Mutasi</span></button><button className="blues-nav-link" onClick={()=>setTransferOpen(true)}><ArrowLeftRight size={18}/><span>Transfer Cabang</span></button>{hq&&<button className="blues-nav-link" onClick={()=>setSenderOpen(true)}><Building2 size={18}/><span>Pengaturan Pengirim</span></button>}{hq&&<button className="blues-nav-link" onClick={()=>setOpen(true)}><Building2 size={18}/><span>Master Cabang</span></button>}</nav>,navigationTarget)}
 {senderOpen&&<BranchSenderSettings onClose={()=>setSenderOpen(false)}/>}
 {hqOpen&&<HqDashboard onClose={()=>setHqOpen(false)}/>}
 {backupOpen&&<BackupRecovery onClose={()=>setBackupOpen(false)}/>}
 {activityOpen&&<ActivityConsole initialIds={cancelIds} onClose={()=>setActivityOpen(false)}/>}
 {ledgerOpen&&<StockLedger onClose={()=>setLedgerOpen(false)}/>}
 {transferOpen&&<BranchTransfers currentUser={currentUser} onClose={()=>setTransferOpen(false)}/>}
 {open&&createPortal(<div className="fixed inset-0 z-[100] bg-slate-950/60 flex items-center justify-center p-4"><section role="dialog" aria-modal="true" aria-label="Master Cabang" className="w-full max-w-xl max-h-[85vh] overflow-auto rounded-2xl bg-slate-900 border p-5 text-slate-100"><div className="flex justify-between"><h2 className="font-bold text-lg">Master Cabang</h2><button aria-label="Tutup master cabang" onClick={()=>setOpen(false)}>Tutup</button></div><p className="text-sm text-slate-400 my-3">Stok, gudang, transaksi, dan katalog disimpan terpisah untuk setiap cabang.</p><table className="w-full text-left text-sm mb-4"><thead><tr className="border-b border-slate-800 text-slate-400"><th className="p-2">Kode</th><th className="p-2">Nama</th>{hq&&<th className="p-2 text-right">Aksi</th>}</tr></thead><tbody>{branches.map(b=><tr key={b.id} className="border-b border-slate-800/60 hover:bg-slate-800/30"><td className="p-2 font-bold">{b.id}</td><td className="p-2">{b.name}</td>{hq&&<td className="p-2 text-right"><div className="inline-flex items-center gap-1.5 justify-end"><button type="button" disabled={busy} onClick={()=>startEdit(b)} className="inline-flex items-center gap-1 rounded-lg border border-indigo-800/60 bg-indigo-950/40 px-2 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/60 hover:text-white" title={`Ubah nama cabang ${b.id}`}><Pencil className="w-3.5 h-3.5"/><span>Ubah</span></button><button type="button" disabled={busy||branches.length<=1} onClick={()=>void removeBranch(b)} className="inline-flex items-center gap-1 rounded-lg border border-rose-900/50 bg-rose-950/30 px-2 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-900/50 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed" title={branches.length<=1?"Cabang terakhir tidak dapat dihapus":`Hapus cabang ${b.id}`}><Trash2 className="w-3.5 h-3.5"/><span>Hapus</span></button></div></td>}</tr>)}</tbody></table><form onSubmit={saveBranch} className="space-y-3"><div className="flex justify-between items-center"><h3 className="font-bold text-white">{editingBranch?`Ubah Nama Cabang (${editingBranch.id})`:'Tambah Cabang Baru'}</h3>{editingBranch&&<button type="button" onClick={cancelEdit} className="text-xs text-slate-400 hover:text-white flex items-center gap-1"><X className="w-3.5 h-3.5"/>Batal Ubah</button>}</div><input aria-label="Kode cabang" placeholder="Kode, contoh: JKT01" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,31}" maxLength={32} value={editingBranch?editingBranch.id:code} readOnly={Boolean(editingBranch)} onChange={e=>setCode(e.target.value.toUpperCase())} className={`w-full rounded-lg border p-2 text-sm ${editingBranch?'bg-slate-800 text-slate-400 cursor-not-allowed':'bg-slate-900 text-white'}`}/><input aria-label="Nama cabang" placeholder="Nama cabang baru" required maxLength={100} value={name} onChange={e=>setName(e.target.value)} className="w-full rounded-lg border p-2 text-sm bg-slate-900 text-white"/>{error&&<p role="alert" className="text-xs text-rose-400">{error}</p>}<div className="flex gap-2"><button disabled={busy} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg px-4 py-2 font-bold text-xs disabled:opacity-50">{busy?'Menyimpan…':editingBranch?'Perbarui Nama Cabang':'Simpan Cabang Baru'}</button>{editingBranch&&<button type="button" onClick={cancelEdit} className="border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-lg px-3 py-2 text-xs font-semibold">Batal</button>}</div></form></section></div>,document.body)}</>;
}
