import type {OutboundItem} from '../types';
import {getCanonicalStockId} from './calculations';
export type SortingTask={referenceNumber:string;masterBasket:string;basketCode:string;items:OutboundItem[];counts:Record<string,number>};
export type BasketConflict={basketCode:string;referenceNumber:string;customerName?:string;stage:'Packing'|'Picking / Sortir'};
export type SortLoadCandidate={
  referenceNumber:string;
  orderNumber?:string;
  orderId?:string;
  basketNumber?:string;
  masterBasketNumber?:string;
  isPicked:boolean;
  isSorted:boolean;
};
export type SortLoadSelection<T extends SortLoadCandidate>={
  readyOrders:T[];
  fellBackToSingleOrder:boolean;
  alreadySortedCount:number;
  unpickedCount:number;
};

/** Select only picked, unsorted orders for sorting and report why non-ready matches were excluded. */
export function selectSortLoadCandidates<T extends SortLoadCandidate>(
  orders:T[],
  rawQuery:string
):SortLoadSelection<T>{
  const query=rawQuery.trim().toUpperCase();
  if(!query){
    return{readyOrders:[],fellBackToSingleOrder:false,alreadySortedCount:0,unpickedCount:0};
  }

  const basketMatches=orders.filter(ord=>
    ord.basketNumber?.trim().toUpperCase()===query||
    ord.masterBasketNumber?.trim().toUpperCase()===query
  );
  if(basketMatches.length>0){
    return{
      readyOrders:basketMatches.filter(ord=>ord.isPicked&&!ord.isSorted),
      fellBackToSingleOrder:false,
      alreadySortedCount:basketMatches.filter(ord=>ord.isSorted).length,
      unpickedCount:basketMatches.filter(ord=>!ord.isPicked&&!ord.isSorted).length,
    };
  }

  const singleMatches=orders.filter(ord=>
    ord.referenceNumber.trim().toUpperCase()===query||
    ord.orderNumber?.trim().toUpperCase()===query||
    ord.orderId?.trim().toUpperCase()===query
  );
  const readySingle=singleMatches.find(ord=>ord.isPicked&&!ord.isSorted);
  if(readySingle){
    return{
      readyOrders:[readySingle],
      fellBackToSingleOrder:true,
      alreadySortedCount:0,
      unpickedCount:0,
    };
  }

  return{
    readyOrders:[],
    fellBackToSingleOrder:false,
    alreadySortedCount:singleMatches.filter(ord=>ord.isSorted).length,
    unpickedCount:singleMatches.filter(ord=>!ord.isPicked&&!ord.isSorted).length,
  };
}

/** Find active Pending/unshipped orders outside `excludeReferenceNumbers` still occupying any candidate basket code. */
export function findActiveBasketConflicts(
  history: OutboundItem[],
  candidateBaskets: string[],
  excludeReferenceNumbers: Iterable<string> = []
): BasketConflict[] {
  const candidates = new Set(candidateBaskets.map(b => b.trim().toUpperCase()).filter(Boolean));
  if (candidates.size === 0) return [];

  const excluded = new Set(excludeReferenceNumbers);
  const seen = new Set<string>();
  const conflicts: BasketConflict[] = [];

  for (const item of history) {
    if (item.status !== 'Pending' || item.shipped) continue;
    if (excluded.has(item.referenceNumber)) continue;
    const basket = (item.basketNumber || '').trim().toUpperCase();
    if (!basket || !candidates.has(basket)) continue;

    const dedupeKey = `${basket}::${item.referenceNumber}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const stage: BasketConflict['stage'] =
      item.sortedAt?.trim() && item.sortedBy?.trim() ? 'Packing' : 'Picking / Sortir';
    conflicts.push({
      basketCode: basket,
      referenceNumber: item.referenceNumber,
      customerName: item.customerName,
      stage
    });
  }

  return conflicts;
}

/** Build a compact human-readable conflict summary (up to 3 conflicting baskets). */
export function formatBasketConflictSummary(conflicts: BasketConflict[]): string {
  const preview = conflicts.slice(0, 3).map(c => `${c.basketCode} (${c.referenceNumber} - ${c.stage})`).join(', ');
  return conflicts.length > 3 ? `${preview}, +${conflicts.length - 3} lainnya` : preview;
}

export function prepareSortingUpdates(history:OutboundItem[],tasks:SortingTask[],actor:string,now=new Date().toISOString()){
 if(!tasks.length||tasks.length>20||new Set(tasks.map(t=>t.referenceNumber)).size!==tasks.length)throw Error('Tugas sortir kosong atau berulang.');
 const baskets=tasks.map(t=>t.basketCode.trim().toUpperCase());if(baskets.some(b=>!b||b.length>128)||new Set(baskets).size!==baskets.length)throw Error('Kode keranjang harus terisi dan berbeda untuk setiap order.');
 const batchRefs=tasks.map(t=>t.referenceNumber);
 const conflicts=findActiveBasketConflicts(history,baskets,batchRefs);
 if(conflicts.length>0)throw Error(`Kode keranjang masih aktif digunakan order lain yang belum selesai: ${formatBasketConflictSummary(conflicts)}. Selesaikan pengemasan atau gunakan kode keranjang lain.`);
 return tasks.flatMap((task,i)=>{
  const current=history.filter(o=>o.referenceNumber===task.referenceNumber);
  if(!current.length||current.some(o=>o.status!=='Pending'||o.shipped||!o.picked||o.stockDeducted!==true))throw Error('Order berubah, belum selesai dipick, atau sudah diproses. Periksa data terbaru.');
  if(current.length!==task.items.length||new Set(task.items.map(o=>o.id)).size!==current.length)throw Error('Baris alokasi order berubah. Periksa ulang isi keranjang.');
  for(const old of task.items){const fresh=current.find(o=>o.id===old.id);
   const key=(o:OutboundItem)=>getCanonicalStockId(o.skuId,o.expiredDate,o.location,o.warehouseId);
   if(!fresh||old.referenceNumber!==task.referenceNumber||key(fresh)!==key(old)||fresh.qty!==old.qty)throw Error('SKU, lokasi, atau jumlah order berubah. Periksa ulang isi keranjang.');
   if(!Number.isSafeInteger(fresh.qty)||fresh.qty<=0||task.counts[old.id]!==fresh.qty)throw Error('Selesaikan pemindaian seluruh barang sebelum menyimpan sortir.');
   const freshBasket=(fresh.basketNumber||'').trim().toUpperCase();
   const masterBasket=task.masterBasket.trim().toUpperCase();
   if(freshBasket&&![masterBasket,baskets[i]].includes(freshBasket))throw Error(`Keranjang order ${task.referenceNumber} berubah di perangkat lain menjadi "${fresh.basketNumber}" (sebelumnya "${task.masterBasket||'-'}"). Periksa data terbaru.`);
  }
  if(Object.keys(task.counts).some(id=>task.counts[id]>0&&!current.some(o=>o.id===id)))throw Error('Hasil scan tidak sesuai baris order terbaru.');
  return current.filter(o=>!(o.sortedAt&&o.sortedBy&&(o.basketNumber||'').trim().toUpperCase()===baskets[i])).map(o=>{
   const masterBasket=(o.masterBasketNumber||(!o.sortedAt?o.basketNumber:'')||task.masterBasket||'').trim().toUpperCase();
   return {...o,basketNumber:baskets[i],...(masterBasket?{masterBasketNumber:masterBasket}:{}),sortedBy:actor,sortedAt:now};
  });
 });
}
