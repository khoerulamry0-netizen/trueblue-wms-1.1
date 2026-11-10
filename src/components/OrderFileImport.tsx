
import React,{useEffect,useMemo,useRef,useState} from 'react';
import * as XLSX from 'xlsx';
import { Upload, Download, CheckCircle } from 'lucide-react';
import type { StockItem,OutboundItem } from '../types';
import { collection,db,doc,getDocs,getActiveBranch,supabase,writeBatch } from '../supabase';
import { parseOrderTable,planOrderImport,createImportReferences,type ImportLine } from '../utils/orderImport';
import { normalizeStockBatch } from '../utils/stockNormalization';
import { isNoExpiryDate } from '../utils/calculations';

export default function OrderFileImport({stock,orderHistory,warehouseId}:{stock:StockItem[];orderHistory:OutboundItem[];warehouseId:string}){
 const [lines,setLines]=useState<ImportLine[]>([]),[filename,setFilename]=useState(''),[batchInput,setBatchInput]=useState(''),[error,setError]=useState(''),[success,setSuccess]=useState(''),[busy,setBusy]=useState(false);
 const [attempt,setAttempt]=useState<{p_request_id:string;p_branch_id:string;p_warehouse_id:string;p_items:OutboundItem[]}|null>(null);
 const lock=useRef(false),fileInput=useRef<HTMLInputElement>(null);
 const branch=getActiveBranch();
 const plan=useMemo(()=>planOrderImport(lines,stock,orderHistory,warehouseId),[lines,stock,orderHistory,warehouseId]);
 const invalid=plan.filter(l=>l.errors.length),orderCount=new Set(lines.map(l=>l.orderNumber.toUpperCase())).size;
 const button='inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#161B25] text-slate-200 hover:bg-slate-800 px-3 py-2 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
 const reset=()=>{setLines([]);setFilename('');setError('');setSuccess('');setAttempt(null);if(fileInput.current)fileInput.current.value='';};
 const template=()=>{
  const sheet=XLSX.utils.aoa_to_sheet([['No Order','SKU','Qty (pcs)','Pelanggan','Alamat Pelanggan','Telepon Pelanggan','Batch Number']]);
  sheet['!cols']=[{wch:25},{wch:22},{wch:14},{wch:28},{wch:60},{wch:24},{wch:22}];
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Order');
  XLSX.writeFile(book,'Template_Import_Order_BLUES.xlsx');
 };
 async function read(file?:File){
  reset();if(!file)return;
  if(file.size>10*1024*1024){setError('Ukuran file maksimal 10 MB.');return;}
  if(!/\.(xlsx|csv)$/i.test(file.name)){setError('Pilih file .xlsx atau .csv.');return;}
  lock.current=true;setBusy(true);
  try{
   const book=XLSX.read(await file.arrayBuffer(),{type:'array',raw:true,cellFormula:true,sheetRows:2003});
   if(book.SheetNames.length!==1)throw new Error('Gunakan file dengan satu sheet Order agar tidak ada data yang terlewat.');
   const sheet=book.Sheets[book.SheetNames[0]];
   if(sheet['!fullref']&&XLSX.utils.decode_range(sheet['!fullref']).e.r>2000)throw new Error('Maksimal 2.000 baris order per file.');
   if(Object.values(sheet).some((c:any)=>c&&typeof c==='object'&&c.f))throw new Error('File mengandung formula. Salin sebagai nilai terlebih dahulu.');
   const table=XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:'',raw:true});
   setLines(parseOrderTable(table));setFilename(file.name);
  }catch(e:any){setError(e.message||'File tidak dapat dibaca.');}finally{setBusy(false);lock.current=false;}
 }
 async function save(){
  if(lock.current)return;
  lock.current=true;setBusy(true);setError('');setSuccess('');
  try{
   if(!supabase)throw new Error('Koneksi database belum tersedia.');
   let payload=attempt;
   if(!payload){
    if(!lines.length||invalid.length)throw new Error('Perbaiki semua baris bermasalah sebelum menyimpan.');
    const branchAtStart=branch,whAtStart=warehouseId;
    const [s,o]=await Promise.all([getDocs(collection(db,'stock')),getDocs(collection(db,'orders'))]);
    if(branchAtStart!==getActiveBranch())throw new Error('Cabang berubah. Unggah ulang file pada cabang tujuan.');
    const freshOrders=o.docs.map(d=>d.data() as unknown as OutboundItem);
    const rawStockRecords = s.docs
      .filter(d => d.id !== 'SYSTEM_EMPTY_FLAG' && d.id !== 'SYSTEM_DEFAULTS_CONFIG')
      .map(d => d.data());
    const freshStock = normalizeStockBatch(rawStockRecords);
    const fresh=planOrderImport(lines, freshStock, freshOrders, whAtStart);
    if(fresh.some(l=>l.errors.length))throw new Error('Stok tidak cukup atau nomor order sudah terdaftar. Periksa pratinjau terbaru sebelum mencoba lagi.');
    const requiredTotal = lines.reduce((sum, l) => sum + l.qty, 0);
    const allocatedTotal = fresh.reduce((sum, l) => sum + l.allocations.reduce((s, a) => s + a.qty, 0), 0);
    if (allocatedTotal < requiredTotal) throw new Error('Stok bebas tidak mencukupi untuk memenuhi seluruh kuantitas order.');

    // Pre-heal any allocated stock documents whose expiredDate in Supabase is not 'No Expired' (e.g. '-', '--', 'Tanpa kedaluwarsa')
    // so that the SQL exact match in import_wms_orders matches 'No Expired' seamlessly without rejection!
    const allocatedStocks = fresh.flatMap(l => l.allocations.map(a => a.stock));
    const staleStockDocs = s.docs.filter(d => {
      const data = d.data() as any;
      if (!isNoExpiryDate(data?.expiredDate) || data?.expiredDate === 'No Expired') return false;
      return allocatedStocks.some(stk =>
        d.id === stk.id ||
        (String(data?.skuId || '').trim().toUpperCase() === stk.skuId.toUpperCase() &&
         String(data?.location || '').trim().toUpperCase() === stk.location.toUpperCase())
      );
    });

    if (staleStockDocs.length > 0) {
      try {
        const healBatch = writeBatch(db);
        for (const d of staleStockDocs) {
          const data = d.data() as any;
          healBatch.set(doc(db, 'stock', d.id), {
            ...data,
            expiredDate: 'No Expired'
          });
        }
        await healBatch.commit();
      } catch (healErr) {
        console.warn('Auto-heal non-expiry stock marker warning:', healErr);
      }
    }

    const requestId=crypto.randomUUID(),timestamp=new Date().toISOString();
    const references=createImportReferences(lines,freshOrders,requestId);
    let index=0;
    const items:OutboundItem[]=fresh.flatMap(l=>l.allocations.map(a=>({
     id:'IMP_'+requestId.replace(/-/g,'')+'_'+index++,timestamp,referenceNumber:references.get(l.orderNumber.toUpperCase())!,orderNumber:l.orderNumber,
     customerName:l.customerName,customerAddress:l.customerAddress,customerPhone:l.customerPhone,noPo:l.noPo,batchNumber:l.batchNumber||batchInput.trim()||(l.reuseCancelled?references.get(l.orderNumber.toUpperCase())!:l.orderNumber),
     skuId:l.skuId,skuName:a.stock.skuName,expiredDate:a.stock.expiredDate,location:a.stock.location,qty:a.qty,
     warehouseId:whAtStart,warehouseName:a.stock.warehouseName,status:'Pending' as const,scanned:false,picked:false,stockDeducted:false
    })));
    if(items.length>5000)throw new Error('Alokasi melebihi 5.000 baris. Pecah file menjadi beberapa bagian.');
    payload={p_request_id:requestId,p_branch_id:branchAtStart,p_warehouse_id:whAtStart,p_items:items};
    setAttempt(payload);
   }
   if(payload.p_branch_id!==getActiveBranch()||payload.p_warehouse_id!==warehouseId)throw new Error('Cabang/gudang berubah. Kembali ke cabang/gudang impor semula sebelum mencoba lagi.');
   const {error:saveError}=await supabase.rpc('import_wms_orders',payload);
   if(saveError)throw saveError;
   const count=new Set(payload.p_items.map(i=>i.orderNumber)).size,total=payload.p_items.reduce((a,i)=>a+i.qty,0);
   setSuccess(count+' order di cabang '+payload.p_branch_id+' ('+total.toLocaleString('id-ID')+' pcs) berhasil disimpan sebagai Pending. Lanjutkan di tab Pengambilan Barang.');
   setLines([]);setFilename('');setAttempt(null);if(fileInput.current)fileInput.current.value='';
  }catch(e:any){
   if(e?.message&&/stok bebas|tidak cukup|berubah/i.test(e.message)){setAttempt(null);}
   setError(e.message||'Penyimpanan belum terkonfirmasi. Coba lagi dengan tombol yang sama.');
  }
  finally{lock.current=false;setBusy(false);}
 }
 useEffect(()=>{reset();},[branch,warehouseId]);
 return <section aria-label="Import massal order" className="rounded-xl border border-slate-700 bg-[#11141B] p-4 space-y-4">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-lg flex gap-2 items-center"><Upload className="w-5 h-5"/>Import Massal Order</h3><p className="text-sm text-slate-400 mt-1">Banyak nomor order dalam satu file Excel/CSV. Cabang <strong>{branch}</strong> · Gudang <strong>{warehouseId||'WH-CENTRAL'}</strong>.</p></div><button type="button" onClick={template} className={button}><Download className="w-4 h-4"/>Unduh Template Order</button></div>
  <p className="text-sm text-slate-400">Kolom wajib: <strong>No Order, SKU, Qty (pcs)</strong>. Satu baris per SKU per order. Pelanggan, Alamat Pelanggan, Telepon Pelanggan, dan Batch Number opsional. Isi alamat dan telepon untuk resi pengiriman. Gunakan satu sheet, maksimal 2.000 baris / 10 MB. Simpan kode order, SKU, dan telepon sebagai teks agar angka nol di depan tidak hilang.</p>
  <div className="flex flex-wrap gap-3 items-center">
   <label className={button+' cursor-pointer'}><Upload className="w-4 h-4"/>{busy?'Memproses…':'Pilih Excel / CSV'}<input ref={fileInput} aria-label="Pilih file import order" type="file" accept=".xlsx,.csv" className="sr-only" disabled={busy||!!attempt} onChange={e=>void read(e.target.files?.[0])}/></label>
   <input type="text" value={batchInput} onChange={e=>{setBatchInput(e.target.value);setAttempt(null);}} placeholder="Nomor Batch Impor (Opsional, misal: BATCH-PAGI-01)" className="px-3 py-2 text-xs bg-[#161B25] border border-slate-700 text-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500 outline-none font-mono w-72" />
   {filename&&<span className="text-sm break-all">{filename}</span>}
   {lines.length>0&&<button type="button" disabled={busy} onClick={reset} className={button}>Batalkan pratinjau</button>}
  </div>
  {plan.some(l=>l.reuseCancelled)&&<p className="wms-info-panel rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-xs font-semibold text-blue-300">Nomor order yang dibatalkan akan dibuat sebagai transaksi baru. Riwayat pembatalan lama tetap tersimpan.</p>}
  {error&&<p role="alert" className="rounded-lg border border-rose-400 p-3 text-rose-400">{error}{attempt&&' Jika koneksi terputus, klik Coba Simpan Lagi; permintaan yang sama tidak menggandakan order.'}</p>}
  {success&&<p role="status" className="rounded-lg border border-emerald-400 p-3 text-emerald-400 flex gap-2"><CheckCircle className="w-5 h-5 shrink-0"/>{success}</p>}
  {lines.length>0&&<><div className="text-sm rounded-lg bg-slate-800 p-3">{orderCount} order · {lines.length} baris · {lines.reduce((a,l)=>a+l.qty,0).toLocaleString('id-ID')} pcs · <strong>{invalid.length} baris bermasalah</strong><p className="mt-1 text-slate-400">Semua baris harus valid. Stok dialokasikan dari rak aktif menurut kedaluwarsa terdekat; area buffer, rusak, dan kedaluwarsa dikecualikan. Stok fisik baru dipotong saat picking.</p></div>
  <div className="max-h-96 overflow-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-800"><tr>{['Baris','No Order','SKU','Qty pcs','Pelanggan','Alamat / Telepon','Hasil pemeriksaan'].map(h=><th key={h} className="p-2 whitespace-nowrap">{h}</th>)}</tr></thead><tbody>{plan.map(l=><tr key={l.row} className="border-t"><td className="p-2">{l.row}</td><td className="p-2">{l.orderNumber}</td><td className="p-2 whitespace-nowrap">{l.skuId}</td><td className="p-2">{l.qty}</td><td className="p-2">{l.customerName||'—'}</td><td className="p-2 min-w-[220px] whitespace-pre-wrap">{l.customerAddress||'—'}<div className="mt-1 font-mono">{l.customerPhone||'—'}</div></td><td className="p-2">{l.errors.length?<span className="text-rose-400">{l.errors.join(' ')}</span>:<span className="text-emerald-400">{l.allocations.map(a=>a.stock.location+' · '+a.stock.expiredDate+' · '+a.qty+' pcs').join('; ')}</span>}</td></tr>)}</tbody></table></div>
  <button type="button" disabled={busy||(!attempt&&invalid.length>0)} onClick={()=>void save()} className={button+' bg-emerald-500 text-slate-950'}>{busy?'Menyimpan…':attempt?'Coba Simpan Lagi':'Simpan '+orderCount+' Order Pending'}</button></>}
 </section>;
}
