import type { OutboundItem } from '../types';

export type OrderSessionData = {
  pickingBy?: string | null; pickingStartedAt?: string | null;
  packingBy?: string | null; packingStartedAt?: string | null;
  basketNumber?: string | null;
};
export type OrderSessionResult = { orders: OutboundItem[] };

export function prepareOrderSessionUpdates(orders: OutboundItem[], references: string | string[], data: OrderSessionData, now = new Date().toISOString()) {
  const refs = new Set((Array.isArray(references) ? references : [references]).map(r => r.trim()).filter(Boolean));
  if (!refs.size) throw new Error('Order untuk keranjang belum dipilih.');
  for (const ref of refs) {
    if (!orders.some(o => o.referenceNumber === ref && o.status === 'Pending')) throw new Error('Order sudah berubah atau selesai. Muat data terbaru.');
  }
  return orders.filter(o => refs.has(o.referenceNumber) && o.status === 'Pending').map(o => {
    const next = { ...o };
    for (const [person, started] of [['pickingBy','pickingStartedAt'],['packingBy','packingStartedAt']] as const) {
      if (data[person] === null) { delete next[person]; delete next[started]; }
      else if (data[person] !== undefined) { next[person] = data[person]!; next[started] = data[started] || now; }
    }
    if (data.basketNumber === null) delete next.basketNumber;
    else if (data.basketNumber !== undefined) {
      const basket = data.basketNumber.trim().toUpperCase();
      if (!basket || basket.length > 128) throw new Error('Kode keranjang harus berisi 1–128 karakter.');
      next.basketNumber = basket;
    }
    return next;
  });
}
