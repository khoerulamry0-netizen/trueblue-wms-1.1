import type {OutboundItem} from '../types';
import type {ShippingOrderData} from '../components/ShippingReceiptModal';
export function buildOrderReceipt(history:OutboundItem[],reference:string,branchId:string):ShippingOrderData {
 const rows=history.filter(o=>o.referenceNumber===reference&&o.status!=='Cancelled');
 if(!rows.length)throw Error('Order tidak tersedia atau sudah dibatalkan.');
 if(rows.some(o=>!Number.isSafeInteger(o.qty)||o.qty<=0))throw Error('Jumlah barang order tidak valid.');
 const value=(key:keyof OutboundItem)=>rows.map(o=>o[key]).find(v=>typeof v==='string'&&v.trim()) as string|undefined;
 const people=(key:keyof OutboundItem)=>Array.from(new Set(rows.map(o=>o[key]).filter(v=>typeof v==='string'&&v.trim()))).join(', ')||'-';
 const orderNumber=value('orderNumber');
 return {branchId,referenceNumber:reference,orderNumber,orderId:orderNumber||reference,noPo:value('noPo'),batchNumber:value('batchNumber'),customerName:value('customerName'),customerAddress:value('customerAddress'),customerPhone:value('customerPhone'),timestamp:value('completedAt')||value('timestamp'),inputByName:people('createdBy'),pickerName:people('pickedBy'),packerName:people('packedBy'),items:rows.map(o=>({id:o.id,skuId:o.skuId,skuName:o.skuName,location:o.location,expiredDate:o.expiredDate,qty:o.qty})),totalQty:rows.reduce((n,o)=>n+o.qty,0)};
}
