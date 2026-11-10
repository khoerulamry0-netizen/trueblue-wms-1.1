import React,{useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
export default function WriteStatus(){
 const [pending,setPending]=useState(0),[error,setError]=useState('');
 useEffect(()=>{const listener=(event:Event)=>{const d=(event as CustomEvent).detail;setPending(d.pending);if(d.error)setError(d.error)};window.addEventListener('wms-write-status',listener);return()=>window.removeEventListener('wms-write-status',listener)},[]);
 if(!pending&&!error)return null;
 return createPortal(<div className="fixed inset-0 z-[300] bg-slate-950/50 flex items-center justify-center p-4"><section role={error?'alertdialog':'status'} aria-label={error?'Perubahan belum tersimpan':'Menyimpan transaksi'} className="rounded-2xl bg-slate-900 border p-6 max-w-lg text-slate-100 space-y-4"><h2 className="font-bold text-lg">{error?'Perubahan belum tersimpan':'Menyimpan transaksi…'}</h2><p className="text-sm">{error||'Tunggu sampai server mengonfirmasi. Jangan tutup halaman.'}</p>{error&&<><p className="text-sm text-slate-400">Periksa stok terbaru sebelum mengulang. Jika koneksi terputus, periksa riwayat untuk memastikan transaksi sebelumnya sudah masuk.</p><button className="rounded-lg bg-emerald-500 px-4 py-2 font-bold" onClick={()=>window.location.reload()}>Muat data terbaru</button></>}</section></div>,document.body);
}
