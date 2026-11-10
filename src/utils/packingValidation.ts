import type { OutboundItem } from '../types';

type PackingLine = Pick<OutboundItem, 'id' | 'skuId' | 'qty'>;
type SortedLine = Pick<OutboundItem, 'status' | 'picked' | 'stockDeducted' | 'sortedAt' | 'sortedBy' | 'basketNumber'>;

export function hasSavedSorting(items: SortedLine[]): boolean {
  if (!items.length) return false;
  const basket = items[0].basketNumber?.trim().toUpperCase();
  return Boolean(basket) && items.every(item =>
    item.status === 'Pending' && item.picked === true && item.stockDeducted === true &&
    Boolean(item.sortedAt?.trim()) && Boolean(item.sortedBy?.trim()) &&
    item.basketNumber?.trim().toUpperCase() === basket
  );
}

export function hasExactPackingCounts(items: PackingLine[], counts: Record<string, number>): boolean {
  if (!items.length || new Set(items.map(item => item.id)).size !== items.length) return false;
  const ids = new Set(items.map(item => item.id));
  if (Object.keys(counts).some(id => !ids.has(id))) return false;
  return items.every(item =>
    Boolean(item.id && item.skuId?.trim()) && Number.isSafeInteger(item.qty) && item.qty > 0 &&
    Number.isSafeInteger(counts[item.id]) && counts[item.id] === item.qty
  );
}

export const scanServerUnavailable = 'Penyelesaian dinonaktifkan: pencatatan dan validasi scan di server belum tersedia.';
export function serverScanValidationAvailable(): boolean {
  return true;
}
