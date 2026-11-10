import type {OutboundItem} from '../types';
import {getCanonicalStockId} from './calculations';
export type SortingTask={referenceNumber:string;masterBasket:string;basketCode:string;items:OutboundItem[];counts:Record<string,number>};
export function prepareSortingUpdates(history:OutboundItem[],tasks:SortingTask[],actor:string,now=new Date().toISOString()){
 if(!tasks.length||tasks.length>20||new Set(tasks.map(t=>t.referenceNumber)).size!==tasks.length)throw Error('Tugas sortir kosong atau berulang.');
 const baskets=tasks.map(t=>t.basketCode.trim().toUpperCase());if(baskets.some(b=>!b||b.length>128)||new Set(baskets).size!==baskets.length)throw Error('Kode keranjang harus terisi dan berbeda untuk setiap order.');
 return tasks.flatMap((task,i)=>{
  const current=history.filter(o=>o.referenceNumber===task.referenceNumber);
  if(!current.length||current.some(o=>o.status!=='Pending'||o.shipped||!o.picked||o.stockDeducted!==true))throw Error('Order berubah, belum selesai dipick, atau sudah diproses. Periksa data terbaru.');
  if(current.length!==task.items.length||new Set(task.items.map(o=>o.id)).size!==current.length)throw Error('Baris alokasi order berubah. Periksa ulang isi keranjang.');
  for(const old of task.items){const fresh=current.find(o=>o.id===old.id);
   const key=(o:OutboundItem)=>getCanonicalStockId(o.skuId,o.expiredDate,o.location,o.warehouseId);
   if(!fresh||old.referenceNumber!==task.referenceNumber||key(fresh)!==key(old)||fresh.qty!==old.qty)throw Error('SKU, lokasi, atau jumlah order berubah. Periksa ulang isi keranjang.');
   if(!Number.isSafeInteger(fresh.qty)||fresh.qty<=0||task.counts[old.id]!==fresh.qty)throw Error('Selesaikan pemindaian seluruh barang sebelum menyimpan sortir.');
   if(![task.masterBasket.trim().toUpperCase(),baskets[i]].includes((fresh.basketNumber||'').trim().toUpperCase()))throw Error('Keranjang order berubah di perangkat lain. Periksa data terbaru.');
  }
  if(Object.keys(task.counts).some(id=>task.counts[id]>0&&!current.some(o=>o.id===id)))throw Error('Hasil scan tidak sesuai baris order terbaru.');
  return current.filter(o=>!(o.sortedAt&&o.sortedBy&&(o.basketNumber||'').trim().toUpperCase()===baskets[i])).map(o=>({...o,basketNumber:baskets[i],sortedBy:actor,sortedAt:now}));
 });
}
