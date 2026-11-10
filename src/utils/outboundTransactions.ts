import {isStockPickable} from './calculations';

import type {StockItem,OutboundItem} from '../types';
import {isZoneOrUrbanLocation,getCanonicalStockId,getAvailableStockPool,getExpiredStatus,normalizeDateToDmy} from './calculations';
import {prepareOrderCompletion} from './orderCompletion';
type NewOrder=Omit<OutboundItem,'id'|'timestamp'>;
export function prepareOutboundCreation(stock:StockItem[],history:OutboundItem[],items:NewOrder[]){
 if(!items.length)throw new Error('Daftar outbound kosong.');
 const refs=new Set(items.map(i=>i.referenceNumber));
 if(items.some(i=>!i.referenceNumber?.trim()||!['Pending','Completed'].includes(i.status)))throw new Error('Nomor dokumen dan status outbound tidak valid.');
 if(history.some(o=>refs.has(o.referenceNumber)))throw new Error('Nomor dokumen sudah digunakan. Muat ulang data sebelum membuat order baru.');
 const draft=items[0].status==='Pending';
 if(items.some(i=>(i.status==='Pending')!==draft))throw new Error('Pisahkan draft dan outbound langsung.');
 const timestamp=new Date().toISOString();
 const originals:OutboundItem[]=items.map(i=>({...i,id:'ord_'+crypto.randomUUID(),timestamp,warehouseId:i.warehouseId||'WH-CENTRAL',expiredDate:normalizeDateToDmy(i.expiredDate),picked:false,stockDeducted:false,status:'Pending'}));
 const planned=prepareOrderCompletion(stock,[...history,...originals],Array.from(refs).map(refNum=>({refNum,updatedItems:originals.filter(o=>o.referenceNumber===refNum),isPicking:true})));
 return {draft,orders:planned.orders.map(o=>({...o,completedAt:draft?undefined:new Date().toISOString(),pickedAt:draft?undefined:o.pickedAt,status:draft?'Pending':'Completed',picked:!draft,isPicked:!draft,stockDeducted:!draft,scanned:!draft} as OutboundItem)),
  stock:planned.changedStock.map(s=>draft?{...stock.find(old=>old.id===s.id)!}:s)};
}
const allocationKey=(o:OutboundItem)=>getCanonicalStockId(o.skuId,o.expiredDate,o.location,o.warehouseId);
const deducted=(o:OutboundItem)=>o.stockDeducted===true||(o.stockDeducted===undefined&&(o.status==='Completed'||!!o.picked||!!o.isPicked));
export function prepareOrderEdits(stock:StockItem[],history:OutboundItem[],edits:{updated:OutboundItem;original:OutboundItem}[]){
 if(!edits.length||new Set(edits.map(e=>e.original.id)).size!==edits.length)throw new Error('Daftar edit kosong atau berulang.');
 const ids=new Set(edits.map(e=>e.original.id));
 const pool=getAvailableStockPool(stock,history.filter(o=>!ids.has(o.id))).map(s=>({...s}));
 return edits.map(({updated,original})=>{
  const live=history.find(o=>o.id===original.id);
  if(!live||(live as any).__wms_revision!==(original as any).__wms_revision)throw new Error('Order berubah di perangkat lain. Buka ulang order.');
  if(live.status==='Cancelled'||live.shipped)throw new Error('Order dibatalkan atau sudah dikirim tidak dapat diedit.');
  if(updated.id!==live.id||updated.status!==live.status||updated.skuId!==live.skuId||(updated.warehouseId||'WH-CENTRAL')!==(live.warehouseId||'WH-CENTRAL'))throw new Error('Identitas, gudang, SKU, dan status order tidak dapat diganti lewat edit.');
  const next={...live,...updated,expiredDate:normalizeDateToDmy(updated.expiredDate),warehouseId:live.warehouseId||'WH-CENTRAL',pickedAt:live.pickedAt,stockDeducted:live.stockDeducted,picked:live.picked,isPicked:live.isPicked};
  if(!Number.isSafeInteger(next.qty)||next.qty<=0)throw new Error('Qty harus bilangan bulat positif.');
  const moved=allocationKey(next)!==allocationKey(live)||next.qty!==live.qty;
  if(deducted(live)&&moved)throw new Error('Stok order sudah dipotong. Qty, lokasi, dan kedaluwarsa dikunci. Gunakan pembatalan beralasan dan buat order baru setelah koreksi stok.');
  if(!deducted(live)){
   const matches=pool.filter(s=>getCanonicalStockId(s.skuId,s.expiredDate,s.location,s.warehouseId)===allocationKey(next));
   if(matches.length!==1||matches[0].qty<next.qty)throw new Error('Stok bebas untuk alokasi order yang diedit tidak cukup atau tidak valid.');
   matches[0].qty-=next.qty;
  }
  return next;
 });
}
