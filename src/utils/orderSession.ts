import type { OutboundItem } from '../types';

export type OrderIssueReportInput =
  | {
      reportedBy: string;
      stage: 'Picking' | 'Sortir' | 'Packing';
      type: 'Stok Kurang' | 'Barang Rusak' | 'Barcode Bermasalah' | 'Lainnya';
      notes: string;
    }
  | {
      resolveBy: string;
    };

export type OrderSessionData = {
  pickingBy?: string | null; pickingStartedAt?: string | null;
  packingBy?: string | null; packingStartedAt?: string | null;
  basketNumber?: string | null;
  masterBasketNumber?: string | null;
  issueReport?: OrderIssueReportInput | null;
};
export type OrderSessionResult = { orders: OutboundItem[] };

export function isOrderClaimedByAnotherPicker(
  order: {
    pickingBy?: string;
    basketNumber?: string;
    masterBasketNumber?: string;
  },
  currentActorName?: string
): boolean {
  const actor = (currentActorName || '').trim().toLowerCase();
  const claimedBy = (order.pickingBy || '').trim().toLowerCase();
  const boundBasket = (order.masterBasketNumber || order.basketNumber || '').trim();
  if (claimedBy) {
    return !actor || claimedBy !== actor;
  }
  return Boolean(boundBasket);
}

export function prepareOrderSessionUpdates(orders: OutboundItem[], references: string | string[], data: OrderSessionData, now = new Date().toISOString()) {
  const refs = new Set((Array.isArray(references) ? references : [references]).map(r => r.trim()).filter(Boolean));
  if (!refs.size) throw new Error('Order untuk keranjang belum dipilih.');
  const targetRows = orders.filter(o => refs.has(o.referenceNumber) && o.status === 'Pending');
  for (const ref of refs) {
    if (!targetRows.some(o => o.referenceNumber === ref)) throw new Error('Order sudah berubah atau selesai. Muat data terbaru.');
  }
  const incomingPickingBy = typeof data.pickingBy === 'string' ? data.pickingBy.trim() : undefined;
  const incomingPackingBy = typeof data.packingBy === 'string' ? data.packingBy.trim() : undefined;
  const incomingBasket = typeof data.masterBasketNumber === 'string'
    ? data.masterBasketNumber.trim().toUpperCase()
    : typeof data.basketNumber === 'string'
      ? data.basketNumber.trim().toUpperCase()
      : undefined;

  return targetRows.map(o => {
    if (incomingPickingBy) {
      if (o.picked) {
        throw new Error(`Order ${o.referenceNumber} sudah selesai dipick. Ambil ulang tugas baru.`);
      }
      const existingPickingBy = (o.pickingBy || '').trim();
      if (existingPickingBy && existingPickingBy.toLowerCase() !== incomingPickingBy.toLowerCase()) {
        const basketNote = (o.masterBasketNumber || o.basketNumber || '').trim();
        throw new Error(
          `Order ${o.referenceNumber} sedang diambil oleh "${existingPickingBy}"${basketNote ? ` (keranjang ${basketNote})` : ''}. Ambil ulang tugas baru.`
        );
      }
      const existingBasket = (o.masterBasketNumber || o.basketNumber || '').trim().toUpperCase();
      if (existingBasket && incomingBasket && existingBasket !== incomingBasket) {
        throw new Error(
          `Order ${o.referenceNumber} sudah terikat ke keranjang ${existingBasket}. Gunakan Monitor Keranjang Induk untuk memindahkannya.`
        );
      }
    }
    if (incomingPackingBy) {
      const existingPackingBy = (o.packingBy || '').trim();
      if (existingPackingBy && existingPackingBy.toLowerCase() !== incomingPackingBy.toLowerCase()) {
        throw new Error(`Order ${o.referenceNumber} sedang diproses packing oleh "${existingPackingBy}" di perangkat lain.`);
      }
    }

    const next = { ...o };
    for (const [person, started] of [['pickingBy','pickingStartedAt'],['packingBy','packingStartedAt']] as const) {
      if (data[person] === null) { delete next[person]; delete next[started]; }
      else if (data[person] !== undefined) { next[person] = data[person]!; next[started] = data[started] || now; }
    }
    for (const field of ['basketNumber', 'masterBasketNumber'] as const) {
      if (data[field] === null) delete next[field];
      else if (data[field] !== undefined) {
        const basket = data[field]!.trim().toUpperCase();
        if (!basket || basket.length > 128) throw new Error('Kode keranjang harus berisi 1–128 karakter.');
        next[field] = basket;
      }
    }
    if (data.issueReport !== undefined) {
      if (data.issueReport === null) {
        next.issueResolvedAt = now;
        next.issueResolvedBy = next.issueResolvedBy || 'Admin';
      } else if ('resolveBy' in data.issueReport) {
        next.issueResolvedAt = now;
        next.issueResolvedBy = data.issueReport.resolveBy.trim() || 'Admin';
      } else {
        const cleanNotes = data.issueReport.notes.trim();
        if (cleanNotes.length < 5) {
          throw new Error('Tuliskan keterangan kendala minimal 5 karakter.');
        }
        next.issueReportedAt = now;
        next.issueReportedBy = data.issueReport.reportedBy.trim() || 'Operator';
        next.issueStage = data.issueReport.stage;
        next.issueType = data.issueReport.type;
        next.issueNotes = cleanNotes.slice(0, 500);
        delete next.issueResolvedAt;
        delete next.issueResolvedBy;
      }
    }
    return next;
  });
}
