import React, {useRef, useState} from 'react';
import ModalFrame from './ModalFrame';
import {verifyArchiveFile} from './PeriodArchive';
import {supabase} from '../supabase';

type Branch = {id:string;name:string};
type PlanPart = {part:string;label:string;filename:string;sha256:string;bytes:number};
type Plan = {
 plan_id:string;
 sha256:string;
 expires_at:string;
 is_multi_part?:boolean;
 parts?:PlanPart[];
 summary:Record<string,any>;
};
type BackupFile = {format:string;version:number;backup_id:string;branch_id:string;created_at:string;sha256:string;payload_text?:string;parts?:PlanPart[];summary?:any};

const field='w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100';
const button='rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const PERMANENT_DELETION_SAFETY_HOLD=false;

async function sha256Text(value:string){
 const bytes=new TextEncoder().encode(value);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

function saveBlob(name:string, data:any){
 const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type:'application/json'}));
 const a=document.createElement('a');
 a.href=url;
 a.download=name;
 document.body.appendChild(a);
 a.click();
 document.body.removeChild(a);
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export default function BranchDeletion({branch,onClose,onDeleted}:{branch?:Branch;onClose:()=>void;onDeleted?:()=>void}){
 const planId=useRef(crypto.randomUUID());
 const lock=useRef(false);
 const [plan,setPlan]=useState<Plan|null>(null),[backup,setBackup]=useState<BackupFile|null>(null);
 const [file,setFile]=useState<BackupFile|null>(null),[ack,setAck]=useState(false),[reason,setReason]=useState(''),[confirmation,setConfirmation]=useState(''),[password,setPassword]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[done,setDone]=useState(false);
 const [downloadProgress,setDownloadProgress]=useState<string|null>(null);
 const [verifiedParts,setVerifiedParts]=useState<string[]>([]);
 const restoring=!branch;

 const run=async(fn:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{await fn()}catch(e:any){setError(e?.message||'Proses gagal. Tidak ada data yang diubah.')}finally{lock.current=false;setBusy(false)}};
 
 const rpc=async(action:string,target:string,id:string,uploaded:any=null)=>{
  if(!supabase)throw new Error('Database tidak tersedia.');
  const {data,error}=await supabase.rpc('branch_deletion_action',{p_action:action,p_branch_id:target,p_plan_id:id,p_confirmation:confirmation,p_reason:reason,p_file:uploaded});
  if(error)throw error;return data;
 };

 const prepare=()=>run(async()=>{
  if(!branch)throw new Error('Cabang tidak tersedia.');
  const value=await rpc('prepare',branch.id,planId.current) as Plan;
  setPlan(value);
  if(value.is_multi_part){
   setNotice('Pemeriksaan lulus. Sistem menyiapkan backup lossless bertahap. Unduh seluruh lima file sebelum melanjutkan.');
  }else{
   setNotice('Pemeriksaan lulus. Belum ada data yang dihapus. Unduh dan periksa kembali file backup.');
  }
 });

 const download=()=>run(async()=>{
  if(!branch||!plan)throw new Error('Siapkan backup terlebih dahulu.');
  if(plan.is_multi_part && plan.parts && plan.parts.length>0){
   for(let i=0;i<plan.parts.length;i++){
    const p=plan.parts[i];
    setDownloadProgress(`${i+1}/${plan.parts.length+1}: Mengunduh ${p.label}...`);
    const partData = await rpc(`export:${p.part}`,branch.id,plan.plan_id);
    saveBlob(`TRUEBLUE-hapus-cabang-${branch.id}-${p.filename}`,partData);
    await new Promise(r=>setTimeout(r,600));
   }
   setDownloadProgress(`${plan.parts.length+1}/${plan.parts.length+1}: Membuat manifest terverifikasi...`);
   const manifest = await rpc('export:manifest',branch.id,plan.plan_id);
   setPlan(prev=>prev?{...prev,sha256:manifest.sha256,parts:manifest.parts}:null);
   saveBlob(`TRUEBLUE-hapus-cabang-${branch.id}-manifest.json`,manifest);
   setDownloadProgress(null);
   setBackup(manifest as BackupFile);
   setNotice(`Berhasil mengunduh ${plan.parts.length+1} file backup cabang ${branch.id}. Simpan semua file di lokasi aman, lalu pilih kembali seluruh file untuk verifikasi.`);
  }else{
   const value=await rpc('export',branch.id,plan.plan_id) as BackupFile;
   setBackup(value);
   saveBlob(`TRUEBLUE-hapus-cabang-${branch.id}-${plan.plan_id}.json`,value);
   setNotice('File diunduh. Simpan salinan kedua, lalu pilih kembali file yang sama.');
  }
 });

 const selectFiles=(fileList:FileList|null)=>run(async()=>{
  if(!fileList||fileList.length===0)return;
  const files=Array.from(fileList);
  const parsedFiles:{file:File;json:any}[]=[];
  for(const candidate of files){
   try{parsedFiles.push({file:candidate,json:JSON.parse(await candidate.text())});}
   catch{throw new Error(`File ${candidate.name} bukan JSON backup yang valid.`);}
  }
  const manifestEntry=parsedFiles.find(item=>item.json.format==='BLUES_WMS_MULTI_BACKUP');
  if(manifestEntry){
   const manifestJson=manifestEntry.json as BackupFile;
   if(manifestJson.version!==2)throw new Error('Versi backup multipart tidak didukung.');
   if(branch&&(manifestJson.branch_id!==branch.id||manifestJson.backup_id!==plan?.plan_id)){
    throw new Error('File manifest tidak cocok dengan rencana penghapusan cabang ini.');
   }
   if(plan&&plan.sha256!==manifestJson.sha256){
    throw new Error('Checksum SHA-256 pada file manifest tidak cocok dengan rencana server.');
   }

   const verified:string[]=['Manifest Utama (manifest.json)'];
   const expectedParts=manifestJson.parts||[];
   if(expectedParts.length!==4)throw new Error('Manifest tidak memuat empat bagian backup wajib.');
   for(const p of expectedParts){
     const found=parsedFiles.find(item=>item.json.format==='BLUES_WMS_PART'&&item.json.part===p.part);
     if(!found)throw new Error(`Bagian backup ${p.label} belum dipilih.`);
     if(found.json.version!==2||found.json.backup_id!==manifestJson.backup_id||found.json.branch_id!==manifestJson.branch_id)
      throw new Error(`Identitas bagian ${p.label} tidak cocok dengan manifest.`);
     const actual=await sha256Text(String(found.json.payload_text||''));
     if(actual!==p.sha256||found.json.sha256!==p.sha256)throw new Error(`Checksum bagian ${p.label} tidak cocok.`);
     verified.push(`${p.label} (${p.filename})`);
   }

   setVerifiedParts(verified);
   setFile(manifestJson);
   setAck(false);
   setConfirmation('');
   setReason('');
   setNotice(`Manifest dan seluruh ${expectedParts.length} bagian backup cabang ${manifestJson.branch_id} terverifikasi valid.`);
  }else{
   const checked=await verifyArchiveFile(files[0],plan?{backup_id:plan.plan_id,sha256:plan.sha256}:undefined);
   const value=checked.value as BackupFile;
   if(branch&&value.branch_id!==branch.id)throw new Error('File berasal dari cabang lain.');
   setFile(value);
   setAck(false);
   setConfirmation('');
   setReason('');
   setNotice(`File backup cabang ${value.branch_id} valid dan checksum cocok.`);
  }
 });

 const reauthenticate=async()=>{
  if(!supabase)throw new Error('Database tidak tersedia.');
  const user=await supabase.auth.getUser();
  if(user.error||!user.data.user?.email)throw new Error('Sesi akun tidak tersedia. Masuk kembali.');
  const auth=await supabase.auth.signInWithPassword({email:user.data.user.email,password});
  setPassword('');
  if(auth.error)throw new Error('Password tidak cocok. Tidak ada data yang diubah.');
 };

 const finish=()=>run(async()=>{
  if(!branch||!plan||!file||!ack)throw new Error('Backup dan salinan kedua harus diverifikasi.');
  await reauthenticate();
  await rpc('finish',branch.id,plan.plan_id,file);
  setDone(true);
  setNotice('Cabang dan datanya telah dihapus. Simpan file backup untuk pemulihan darurat.');
  await onDeleted?.();
 });

 const restore=()=>run(async()=>{
  if(!file||!ack||!supabase)throw new Error('Pilih dan verifikasi file backup terlebih dahulu.');
  await reauthenticate();
  const {error:restoreError}=await supabase.rpc('restore_deleted_branch',{p_branch_id:file.branch_id,p_plan_id:file.backup_id,p_confirmation:confirmation,p_reason:reason,p_file:file});
  if(restoreError)throw restoreError;
  setDone(true);
  setNotice(`Cabang ${file.branch_id} berhasil dipulihkan dari backup terverifikasi.`);
  await onDeleted?.();
 });

 const cancel=async()=>{
  if(busy)return;
  if(plan&&!done&&branch&&supabase){
   await supabase.rpc('branch_deletion_action',{p_action:'cancel',p_branch_id:branch.id,p_plan_id:plan.plan_id,p_confirmation:'',p_reason:'',p_file:null});
  }
  onClose();
 };

 const summary=plan?.summary||{};
 const target=branch?.id||file?.branch_id||'';
 const phrase=(restoring?'PULIHKAN ':'HAPUS ')+target;

 return <ModalFrame titleId="branch-deletion-title" className="w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-[#0E121A] p-6 text-slate-100" onClose={()=>void cancel()}>
  <header className="mb-5 flex items-start justify-between gap-4">
   <div>
    <h2 id="branch-deletion-title" className="text-lg font-bold">{restoring?'Pulihkan cabang dari backup':`Hapus permanen cabang ${branch?.id}`}</h2>
    <p className="mt-1 text-xs text-slate-400">Khusus Administrator kantor pusat · proses tervalidasi dan tercatat</p>
   </div>
   <button data-modal-close className={button} disabled={busy} onClick={()=>void cancel()}>Tutup</button>
  </header>
  {error&&<p role="alert" className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
  {notice&&<p role="status" className="mb-4 rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-100">{notice}</p>}
  {done?<div className="space-y-3 text-sm"><p>Proses selesai. Muat ulang aplikasi sebelum melanjutkan operasional.</p><button className={button+' bg-emerald-600 text-white'} onClick={onClose}>Selesai</button></div>:restoring?<div className="space-y-4">
   <p className="text-sm leading-6 text-slate-300">Pilih file hasil penghapusan cabang. Server memeriksa checksum dan bukti penghapusan sebelum mengembalikan data.</p>
   <label className="block text-sm">Pilih manifest dan seluruh bagian backup JSON<input type="file" accept=".json,application/json" multiple disabled={busy} className="mt-2 block" onChange={e=>{const selected=e.target.files?.[0];setFile(null);if(selected)void selectFiles(e.target.files);e.target.value='';}}/></label>
   {file&&<ConfirmationFields target={target} phrase={phrase} restoring ack={ack} setAck={setAck} reason={reason} setReason={setReason} confirmation={confirmation} setConfirmation={setConfirmation} password={password} setPassword={setPassword}/>} 
   {file&&<button className={button+' bg-emerald-700 text-white'} disabled={busy||!ack||confirmation!==phrase||reason.trim().length<10||!password} onClick={()=>void restore()}>Pulihkan cabang {target}</button>}
  </div>:<div className="space-y-4">
   <p className="text-sm leading-6 text-slate-300">Cabang hanya dapat dihapus jika tidak memiliki akun, order aktif, transfer lintas cabang, atau backup lokal yang belum diverifikasi. Cabang aktif dan cabang terakhir juga ditolak.</p>
   {PERMANENT_DELETION_SAFETY_HOLD&&<div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
    <strong className="block">Penghapusan permanen sedang dinonaktifkan</strong>
    <span className="mt-1 block text-amber-200/80">Operasional cabang tetap aman. Fitur ini dibuka kembali setelah backup berukuran besar terbukti dapat dipulihkan utuh melalui pengujian otomatis.</span>
   </div>}
   {!PERMANENT_DELETION_SAFETY_HOLD&&!plan&&<button className={button+' bg-sky-700 text-white'} disabled={busy} onClick={()=>void prepare()}>1. Periksa cabang & siapkan backup</button>}
   {plan&&<div className="space-y-4 rounded-xl border border-slate-700 p-4">
    <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
     <Stat label="Dokumen" value={summary.documents}/>
     <Stat label="Order" value={summary.orders}/>
     <Stat label="Stok" value={`${Number(summary.stock_qty||0).toLocaleString('id-ID')} pcs`}/>
     <Stat label="Audit" value={summary.audit_events}/>
    </div>
    {plan.is_multi_part && (
     <div className="rounded-lg bg-sky-950/40 border border-sky-800/60 p-3 text-xs text-sky-200 space-y-1">
      <strong className="block text-sky-100">Ekspor Multi-Part Diaktifkan ({plan.parts?.length||4} bagian terpisah)</strong>
      <p>Data cabang berukuran besar (±{Math.round((summary.total_bytes||57000000)/1024/1024)} MB). Sistem membagi ekspor menjadi manifest, data operasional, audit, dan backup lama agar proses unduh stabil.</p>
     </div>
    )}
    <p className="text-xs text-slate-400">Rencana berlaku sampai {new Date(plan.expires_at).toLocaleString('id-ID')}. Perubahan data akan membatalkan proses.</p>
    
    <div>
     <button className={button+' bg-sky-700 text-white flex items-center gap-2'} disabled={busy} onClick={()=>void download()}>
      <span>2. Unduh {plan.is_multi_part ? `seluruh backup (${(plan.parts?.length||4)+1} file)` : 'backup lengkap'}</span>
     </button>
     {downloadProgress && <p className="text-xs text-sky-400 mt-2 font-mono animate-pulse">{downloadProgress}</p>}
    </div>

    {backup&&<div className="space-y-2">
     <label className="block text-sm">
      3. Pilih kembali manifest dan seluruh file bagian backup
      <input type="file" accept=".json,application/json" multiple disabled={busy} className="mt-2 block" onChange={e=>{selectFiles(e.target.files);e.target.value='';}}/>
     </label>
     {verifiedParts.length>0 && (
      <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-800/50 text-emerald-300 text-xs space-y-1">
       <strong>File terverifikasi:</strong>
       <ul className="list-disc pl-4 space-y-0.5">
        {verifiedParts.map(p=><li key={p}>{p}</li>)}
       </ul>
      </div>
     )}
    </div>}

    {file&&<ConfirmationFields target={target} phrase={phrase} ack={ack} setAck={setAck} reason={reason} setReason={setReason} confirmation={confirmation} setConfirmation={setConfirmation} password={password} setPassword={setPassword}/>} 
    {file&&<button className={button+' bg-rose-700 text-white'} disabled={busy||!ack||confirmation!==phrase||reason.trim().length<10||!password} onClick={()=>void finish()}>4. Hapus permanen cabang {target}</button>}
   </div>}
  </div>}
 </ModalFrame>;
}

function Stat({label,value}:{label:string;value:React.ReactNode}){return <div className="rounded-lg bg-slate-900 p-2"><span className="block text-[10px] uppercase text-slate-500">{label}</span><strong>{value??0}</strong></div>}
function ConfirmationFields({target,phrase,restoring=false,ack,setAck,reason,setReason,confirmation,setConfirmation,password,setPassword}:{target:string;phrase:string;restoring?:boolean;ack:boolean;setAck:(v:boolean)=>void;reason:string;setReason:(v:string)=>void;confirmation:string;setConfirmation:(v:string)=>void;password:string;setPassword:(v:string)=>void}){return <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
 <label className="flex gap-2 text-sm"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/><span>{restoring?'Saya memahami pemulihan memakai bukti penghapusan yang tersimpan di server.':'Saya sudah menyimpan salinan kedua di lokasi lain dan memahami data cloud cabang akan dihapus permanen.'}</span></label>
 <label className="block text-sm">Alasan (minimal 10 karakter)<textarea className={field+' mt-1'} minLength={10} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
 <label className="block text-sm">Ketik {phrase}<input className={field+' mt-1'} autoComplete="off" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
 <label className="block text-sm">Password akun saat ini<input className={field+' mt-1'} type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
 <p className="text-xs text-slate-500">Target: {target}</p>
 </div>}
