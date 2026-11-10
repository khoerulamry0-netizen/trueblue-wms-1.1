
import type { StockItem, OutboundItem } from '../types';
import { getAvailableStockPool, getExpiredStatus, isZoneOrUrbanLocation, normalizeDateToDmy, isNoExpiryDate } from './calculations';
export type ImportLine = { row:number; orderNumber:string; skuId:string; qty:number; customerName:string; customerAddress:string; customerPhone:string; noPo:string; batchNumber:string; errors:string[] };
const aliases:Record<string,string> = { noorder:'orderNumber', nomororder:'orderNumber', ordernumber:'orderNumber', orderid:'orderNumber', sku:'skuId', skuid:'skuId', kodebarang:'skuId', qty:'qty', jumlah:'qty', qtypcs:'qty', customer:'customerName', pelanggan:'customerName', namapelanggan:'customerName', customername:'customerName', alamat:'customerAddress', alamatpelanggan:'customerAddress', alamatpenerima:'customerAddress', customeraddress:'customerAddress', address:'customerAddress', teleponpelanggan:'customerPhone', telepon:'customerPhone', nomortelepon:'customerPhone', nohp:'customerPhone', hp:'customerPhone', customerphone:'customerPhone', phone:'customerPhone', nopo:'noPo', nomorpo:'noPo', po:'noPo', batch:'batchNumber', nomorbatch:'batchNumber', batchnumber:'batchNumber' };
export function parseOrderTable(table:unknown[][]):ImportLine[] {
 if(table.length<2) throw new Error('File harus memiliki header dan minimal satu baris order.');
 const headers=table[0].map(v=>aliases[String(v??'').toLowerCase().replace(/[^a-z0-9]/g,'')]||'');
 for(const h of ['orderNumber','skuId','qty']) if(!headers.includes(h)) throw new Error('Kolom wajib: No Order, SKU, Qty (pcs).');
 if(headers.filter(Boolean).length!==new Set(headers.filter(Boolean)).size) throw new Error('Ada kolom header yang berulang.');
 const lines:ImportLine[]=[];
 table.slice(1).forEach((cells,i)=>{
  if(cells.every(c=>String(c??'').trim()===''))return;
  const data:Record<string,string>={};headers.forEach((h,j)=>{if(h)data[h]=String(cells[j]??'').trim();});
  const errors:string[]=[];
  if(!data.orderNumber||data.orderNumber.length>128)errors.push('No Order wajib diisi, maksimal 128 karakter.');
  if(!data.skuId||data.skuId.length>128)errors.push('SKU wajib diisi, maksimal 128 karakter.');
  if(!/^[1-9][0-9]*$/.test(data.qty||'')||!Number.isSafeInteger(Number(data.qty)))errors.push('Qty harus bilangan bulat positif dalam pcs, tanpa pemisah ribuan.');
  if((data.customerName||'').length>200||(data.noPo||'').length>128||(data.batchNumber||'').length>128)errors.push('Pelanggan maksimal 200 karakter; PO dan batch maksimal 128.');
  if((data.customerAddress||'').length>1000)errors.push('Alamat pelanggan maksimal 1.000 karakter.');
  if((data.customerPhone||'').length>40)errors.push('Telepon pelanggan maksimal 40 karakter.');
  lines.push({row:i+2,orderNumber:data.orderNumber||'',skuId:(data.skuId||'').toUpperCase(),qty:Number(data.qty)||0,customerName:data.customerName||'',customerAddress:data.customerAddress||'',customerPhone:data.customerPhone||'',noPo:data.noPo||'',batchNumber:data.batchNumber||'',errors});
 });
 if(!lines.length||lines.length>2000)throw new Error('File harus berisi 1–2.000 baris order.');
 const seen=new Set<string>(),groups=new Map<string,string>();
 return lines.map(line=>{
  const errors=[...line.errors],orderKey=line.orderNumber.toUpperCase(),key=JSON.stringify([orderKey,line.skuId]);
  if(seen.has(key))errors.push('SKU berulang pada nomor order yang sama. Gabungkan Qty menjadi satu baris.');
  seen.add(key);
  const meta=JSON.stringify([line.orderNumber,line.customerName,line.noPo,line.batchNumber,line.customerAddress,line.customerPhone]);
  if(groups.has(orderKey)&&groups.get(orderKey)!==meta)errors.push('Data pelanggan/alamat/telepon/PO/batch atau penulisan nomor order tidak konsisten dalam satu order.');
  groups.set(orderKey,meta);
  return {...line,errors};
 });
}
export function planOrderImport(lines:ImportLine[],stock:StockItem[],history:OutboundItem[],warehouseId:string){
 const validEd=(v:string | undefined | null)=>{if(isNoExpiryDate(v))return true;const norm=normalizeDateToDmy(v);if(norm==='No Expired'||norm==='--')return true;if(!/^\d{2}\/\d{2}\/\d{4}$/.test(norm))return false;const [d,m,y]=norm.split('/').map(Number),dt=new Date(y,m-1,d);return dt.getFullYear()===y&&dt.getMonth()===m-1&&dt.getDate()===d;};
 const pool=getAvailableStockPool(stock,history).filter(s=>(s.warehouseId||'WH-CENTRAL')===warehouseId&&validEd(s.expiredDate)&&!['Expired','Damage'].includes(getExpiredStatus(s.expiredDate))&&!['Expired','Damage'].includes(s.status)).map(s=>({...s})).sort((a,b)=>{
  const date=(v:string)=>{v=normalizeDateToDmy(v);return /^\d{2}\/\d{2}\/\d{4}$/.test(v)?v.slice(6)+v.slice(3,5)+v.slice(0,2):'99999999'};
  return date(a.expiredDate).localeCompare(date(b.expiredDate))||a.location.localeCompare(b.location,undefined,{numeric:true})||a.id.localeCompare(b.id);
 });
 const existing=new Set(history.filter(o=>o.status!=='Cancelled').flatMap(o=>[o.orderNumber,o.referenceNumber]).filter(Boolean).map(n=>n!.trim().toUpperCase()));
 return lines.map(line=>{
  const errors=[...line.errors],allocations:{stock:StockItem;qty:number}[]=[];
  if(existing.has(line.orderNumber.toUpperCase()))errors.push('Nomor order sudah terdaftar (aktif/selesai) di cabang ini.');
  const matches=pool.filter(s=>s.skuId.toUpperCase()===line.skuId&&s.qty>0);
  const available=matches.reduce((a,s)=>a+s.qty,0);
  if(!errors.length&&available<line.qty)errors.push('Stok bebas rak aktif kurang: tersedia '+available+' pcs, diminta '+line.qty+' pcs.');
  if(!errors.length){let left=line.qty;for(const s of matches){if(!left)break;const take=Math.min(left,s.qty);allocations.push({stock:{...s},qty:take});s.qty-=take;left-=take;}}
  const reuseCancelled=history.some(o=>o.status==='Cancelled'&&[o.orderNumber,o.referenceNumber].some(n=>n?.trim().toUpperCase()===line.orderNumber.toUpperCase()));
  return {...line,errors,allocations,reuseCancelled};
 });
}

export function createImportReferences(lines:ImportLine[],history:OutboundItem[],requestId:string):Map<string,string>{
 const refs=new Map<string,string>();
 for(const line of lines){const key=line.orderNumber.trim().toUpperCase();if(refs.has(key))continue;
 const cancelled=history.some(o=>o.status==='Cancelled'&&[o.orderNumber,o.referenceNumber].some(n=>n?.trim().toUpperCase()===key));
 refs.set(key,cancelled?'REIMP_'+requestId.replace(/-/g,'')+'_'+refs.size:line.orderNumber);
 }return refs;
}
