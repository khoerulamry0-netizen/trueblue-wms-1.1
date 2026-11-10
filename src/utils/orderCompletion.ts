import {isStockPickable} from './calculations';

import type {StockItem,OutboundItem} from '../types';
import {getCanonicalStockId,normalizeDateToDmy,calculatePackQuantities,getExpiredStatus,isZoneOrUrbanLocation,getLockedStockSummary,isNoExpiryDate} from './calculations';
export type OrderCompletion = {refNum:string;updatedItems:OutboundItem[];isPicking?:boolean};
export function prepareOrderCompletion(stock:StockItem[],history:OutboundItem[],updates:OrderCompletion[]){
 if(!updates.length||new Set(updates.map(u=>u.refNum)).size!==updates.length)throw new Error('Daftar order kosong atau berulang.');
 const refs=new Set(updates.map(u=>u.refNum)), originals=history.filter(o=>refs.has(o.referenceNumber)&&o.status==='Pending');
 const others=history.filter(o=>!refs.has(o.referenceNumber)),reserved=getLockedStockSummary(others);
 const pool=stock.map(s=>({...s})),changed=new Set<string>(),orders:OutboundItem[]=[];
 const key=(o:StockItem|OutboundItem)=>getCanonicalStockId(o.skuId,o.expiredDate,o.location,o.warehouseId);
 const find=(o:StockItem|OutboundItem)=>{const candidates=pool.filter(s=>key(s)===key(o));if(candidates.length!==1)throw new Error('Stok SKU '+o.skuId+' di '+o.location+' / '+(o.warehouseId||'WH-CENTRAL')+' tidak ditemukan atau ambigu.');return candidates[0];};
 const totals=(items:OutboundItem[])=>{const t:Record<string,number>={};for(const o of items){const k=JSON.stringify([(o.warehouseId||'WH-CENTRAL').trim().toUpperCase(),o.skuId.trim().toUpperCase()]);t[k]=(t[k]||0)+o.qty;}return JSON.stringify(Object.entries(t).sort());};
 // Refund every previous allocation before validating the final combined allocation.
 for(const o of originals)if(o.stockDeducted===true||(o.stockDeducted===undefined&&o.picked)){const s=find(o);s.qty+=o.qty;changed.add(s.id);}
 for(const u of updates){
  const old=originals.filter(o=>o.referenceNumber===u.refNum);
  if(!old.length||old.some(o=>o.shipped))throw new Error('Order sudah berubah atau selesai. Muat data terbaru.');
  let active=u.updatedItems.filter(o=>o.qty>0).map(o=>({...o}));
  if(!active.length||active.some(o=>o.referenceNumber!==u.refNum||!Number.isSafeInteger(o.qty)||o.qty<=0)||totals(old)!==totals(active))throw new Error('Jumlah SKU dan gudang harus sesuai order asli.');
  for(const item of active){
   const prior=old.find(o=>o.id===item.id);
   if(prior&&(item as any).__wms_revision!==(prior as any).__wms_revision)throw new Error('Versi order berubah. Buka ulang picking.');
  }
  // Keep every historical order ID when the picker splits or merges locations.
  const used=new Set(active.filter(i=>old.some(o=>o.id===i.id)).map(i=>i.id));
  const sameProduct=(a:OutboundItem,b:OutboundItem)=>a.skuId.trim().toUpperCase()===b.skuId.trim().toUpperCase()&&(a.warehouseId||'WH-CENTRAL')===(b.warehouseId||'WH-CENTRAL');
  active=active.map(item=>{
   if(old.some(o=>o.id===item.id))return item;
   const prior=old.find(o=>!used.has(o.id)&&sameProduct(o,item));
   if(!prior)return item;used.add(prior.id);return {...item,id:prior.id};
  });
  for(const prior of old.filter(o=>!used.has(o.id))){
   const donor=active.find(i=>sameProduct(i,prior)&&i.qty>1);
   if(!donor)throw new Error('Alokasi tidak dapat digabung tanpa menghapus riwayat. Pertahankan baris order asli.');
   donor.qty-=1;active.push({...donor,id:prior.id,qty:1});used.add(prior.id);
  }

  for(const item of active){
   const s=find(item),locked=reserved.byCanonicalId.get(key(s))||0;
   if(!Number.isFinite(s.qty)||s.qty-item.qty<locked)throw new Error('Stok bebas SKU '+item.skuId+' di '+item.location+' / '+(item.warehouseId||'WH-CENTRAL')+' tidak cukup.');
   s.qty-=item.qty;changed.add(s.id);
   const prior=old.find(o=>o.id===item.id),id=prior?.id||'ord_pick_'+crypto.randomUUID();
   const isNoExp = isNoExpiryDate(s.expiredDate);
   const cleanEd = isNoExp ? 'No Expired' : (normalizeDateToDmy(s.expiredDate) || s.expiredDate);
   const mapped={...item,id,__wms_revision:prior?(prior as any).__wms_revision:undefined,skuName:s.skuName,warehouseId:s.warehouseId||'WH-CENTRAL',expiredDate:cleanEd,location:s.location,timestamp:prior?.timestamp||new Date().toISOString(),pickedAt:prior?.pickedAt || new Date().toISOString(),picked:true,isPicked:true,stockDeducted:true,completedAt:!u.isPicking&&item.status==='Completed'?new Date().toISOString():prior?.completedAt,status:u.isPicking?'Pending':item.status} as OutboundItem;
   delete mapped.pickingBy;delete mapped.pickingStartedAt;delete mapped.packingBy;delete mapped.packingStartedAt;
   orders.push(mapped);
  }
 }
 if(new Set(orders.map(o=>o.id)).size!==orders.length)throw new Error('Baris order duplikat.');
 const changedStock=pool.filter(s=>changed.has(s.id)).map(s=>{
  const isNoExp = isNoExpiryDate(s.expiredDate);
  const cleanEd = isNoExp ? 'No Expired' : (normalizeDateToDmy(s.expiredDate) || s.expiredDate);
  const cleanStatus = isNoExp && !/damage|rusak/i.test(s.status || '') ? 'AMAN' : s.status;
  return {
   ...s,
   expiredDate: cleanEd,
   status: cleanStatus,
   ...calculatePackQuantities(s.qty,s.qtyCtnSize,s.qtyInnerSize)
  };
 });
 return {originals,orders,changedStock};
}
