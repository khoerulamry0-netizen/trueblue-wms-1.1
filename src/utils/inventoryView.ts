import type { StockItem } from '../types';
import { getItemStockBreakdown, getStockStatus, isNoExpiryDate, isStockPickable, normalizeDateToDmy, type LockedStockSummary } from './calculations';

export const inventorySkuKey = (sku: string) => sku.trim().toUpperCase();

export function groupStockBySku(stock: StockItem[]) {
  const groups = new Map<string, { key: string; items: StockItem[] }>();
  for (const item of stock) {
    const key = inventorySkuKey(item.skuId);
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()];
}

export interface InventorySkuTotal {
  physical: number;
  allocated: number;
  available: number;
  held: number;
  rows: number;
}

// Sum the same eligible, unallocated lot quantities used by the order stock pool.
// Subtracting allocations from physical SKU totals would include held/buffer stock.
export function getInventorySkuTotals(stock: StockItem[], locked: LockedStockSummary) {
  const totals = new Map<string, InventorySkuTotal>();
  for (const item of stock) {
    const key = inventorySkuKey(item.skuId);
    const total = totals.get(key) || { physical: 0, allocated: 0, available: 0, held: 0, rows: 0 };
    const lot = getItemStockBreakdown(item, locked);
    total.physical += lot.physicalQty;
    total.allocated += lot.lockedQty;
    total.available += lot.availableQty;
    total.held += isStockPickable(item) ? 0 : lot.physicalQty;
    total.rows += 1;
    totals.set(key, total);
  }
  return totals;
}

export function inventoryDateLabel(item: StockItem): string {
  const value = normalizeDateToDmy(item.expiredDate);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  if (!value || value === 'No Expired' || value === '--' || isNoExpiryDate(item.expiredDate) || isNoExpiryDate(value)) return 'Tanpa kedaluwarsa';
  if (/damage|rusak|expired|kedaluwarsa/i.test(value || item.expiredDate || '')) return '—';
  return 'Periksa tanggal';
}

export function inventoryStatus(item: StockItem): { label: string; tone: 'safe' | 'warning' | 'danger' } {
  const status = getStockStatus(item);
  if (status === 'Damage') return { label: 'Rusak', tone: 'danger' };
  if (status === 'Expired') return { label: 'Kedaluwarsa', tone: 'danger' };
  if (status === 'Karantina') return { label: 'Karantina', tone: 'warning' };
  if (!isStockPickable(item)) return { label: 'Buffer', tone: 'warning' };
  if (status === 'AMAN') return { label: 'Aman', tone: 'safe' };
  const months = status.match(/(?:under\s*)(\d+)/i)?.[1];
  if (months) return { label: '< ' + months + ' bulan', tone: 'warning' };
  if (status === 'Near ED') return { label: 'Mendekati kedaluwarsa', tone: 'warning' };
  return { label: status, tone: 'warning' };
}

export function inventoryMovementLabel(category: string) {
  return ({ 'FAST MOVING': 'Pergerakan cepat', MEDIUM: 'Pergerakan sedang', 'SLOW MOVING': 'Pergerakan lambat', 'BELUM ADA OUTBOUND': 'Belum ada outbound', 'DEAD STOCK': 'Tanpa pergerakan' } as Record<string, string>)[category] || category;
}
