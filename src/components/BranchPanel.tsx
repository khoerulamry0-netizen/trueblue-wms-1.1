import BranchSenderSettings from './BranchSenderSettings';
import { Building2, ShieldCheck, Archive, History, BookOpen, ArrowLeftRight, Network } from 'lucide-react';
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
 const add=async(e:React.FormEvent)=>{e.preventDefault();if(!supabase||busy)return;setBusy(true);setError('');const {error}=await supabase.from('branches').insert({id:code.trim().toUpperCase(),name:name.trim()});setBusy(false);if(error)setError(error.message);else{setCode('');setName('');await load()}};
 const change=(id:string)=>{if(id===getActiveBranch())return;if(!window.confirm('Pindah cabang? Form yang belum disimpan akan ditutup.'))return;setActiveBranch(id);window.location.reload()};
 return <><div className="blues-branch-picker"><label><Building2 size={16}/><span>Cabang aktif</span><select title={currentUser?.role==='Viewer'?'Semua cabang · hanya lihat':'Pilih cabang'} aria-label="Cabang aktif" value={getActiveBranch()} onChange={e=>change(e.target.value)}>{branches.map(b=><option key={b.id} value={b.id}>{b.id} — {b.name}</option>)}</select></label></div>
 {navigationTarget&&createPortal(<nav aria-label="Administrasi cabang" onClick={onAction}><p className="blues-nav-caption">Administrasi</p>{hq&&<button className="blues-nav-link" onClick={()=>setHqOpen(true)}><Network size={18}/><span>Dashboard Pusat</span></button>}{['Admin','Administrator'].includes(currentUser?.role||'')&&<><button className="blues-nav-link" onClick={()=>setBackupOpen(true)}><Archive size={18}/><span>Backup & Pemulihan</span></button><button className="blues-nav-link" onClick={()=>{setCancelIds([]);setActivityOpen(true)}}><History size={18}/><span>Aktivitas & Pembatalan</span></button></>}<button className="blues-nav-link" onClick={()=>setLedgerOpen(true)}><BookOpen size={18}/><span>Buku Mutasi</span></button><button className="blues-nav-link" onClick={()=>setTransferOpen(true)}><ArrowLeftRight size={18}/><span>Transfer Cabang</span></button>{hq&&<button className="blues-nav-link" onClick={()=>setSenderOpen(true)}><Building2 size={18}/><span>Pengaturan Pengirim</span></button>}{hq&&<button className="blues-nav-link" onClick={()=>setOpen(true)}><Building2 size={18}/><span>Master Cabang</span></button>}</nav>,navigationTarget)}
 {senderOpen&&<BranchSenderSettings onClose={()=>setSenderOpen(false)}/>}
 {hqOpen&&<HqDashboard onClose={()=>setHqOpen(false)}/>}
 {backupOpen&&<BackupRecovery onClose={()=>setBackupOpen(false)}/>}
 {activityOpen&&<ActivityConsole initialIds={cancelIds} onClose={()=>setActivityOpen(false)}/>}
 {ledgerOpen&&<StockLedger onClose={()=>setLedgerOpen(false)}/>}
 {transferOpen&&<BranchTransfers currentUser={currentUser} onClose={()=>setTransferOpen(false)}/>}
 {open&&createPortal(<div className="fixed inset-0 z-[100] bg-slate-950/60 flex items-center justify-center p-4"><section role="dialog" aria-modal="true" aria-label="Master Cabang" className="w-full max-w-xl max-h-[85vh] overflow-auto rounded-2xl bg-slate-900 border p-5 text-slate-100"><div className="flex justify-between"><h2 className="font-bold text-lg">Master Cabang</h2><button aria-label="Tutup master cabang" onClick={()=>setOpen(false)}>Tutup</button></div><p className="text-sm text-slate-400 my-3">Stok, gudang, transaksi, dan katalog disimpan terpisah untuk setiap cabang.</p><table className="w-full text-left text-sm mb-4"><thead><tr><th className="p-2">Kode</th><th className="p-2">Nama</th></tr></thead><tbody>{branches.map(b=><tr key={b.id}><td className="p-2 font-bold">{b.id}</td><td className="p-2">{b.name}</td></tr>)}</tbody></table><form onSubmit={add} className="space-y-3"><h3 className="font-bold">Tambah cabang</h3><input aria-label="Kode cabang" placeholder="Kode, contoh: JKT01" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,31}" maxLength={32} value={code} onChange={e=>setCode(e.target.value.toUpperCase())} className="w-full rounded-lg border p-2"/><input aria-label="Nama cabang" placeholder="Nama cabang" required maxLength={100} value={name} onChange={e=>setName(e.target.value)} className="w-full rounded-lg border p-2"/>{error&&<p role="alert" className="text-rose-400">{error}</p>}<button disabled={busy} className="bg-emerald-500 rounded-lg px-4 py-2 font-bold disabled:opacity-50">{busy?'Menyimpan…':'Simpan cabang'}</button></form></section></div>,document.body)}</>;
}
