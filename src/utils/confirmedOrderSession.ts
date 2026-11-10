import type {OutboundItem} from '../types';
import type {OrderSessionData,OrderSessionResult} from './orderSession';
export async function startConfirmedOrderSession(reference:string,data:OrderSessionData,save?: (reference:string,data:OrderSessionData)=>Promise<OrderSessionResult|false>):Promise<OutboundItem[]> {
 if(!save)throw Error('Penyimpanan sesi belum tersedia. Muat ulang WMS.');
 const result=await save(reference,data);
 if(!result)throw Error('Sesi belum dikonfirmasi server. Muat data terbaru dan buka ulang order.');
 const rows=result.orders.filter(row=>row.referenceNumber===reference&&row.status==='Pending');
 if(!rows.length)throw Error('Order sudah berubah atau selesai. Muat data terbaru.');
 return rows;
}
