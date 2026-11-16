import type { StockItem } from '../types';
import { calculateRemainingExpiry, getItemStockBreakdown, getStockStatus, isNoExpiryDate, isStockPickable, normalizeDateToDmy, type LockedStockSummary, type RemainingExpiryResult } from './calculations';

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

export function inventoryDateLabel(item: StockItem, lang: 'id' | 'en' = 'id'): string {
  const value = normalizeDateToDmy(item.expiredDate);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  if (!value || value === 'No Expired' || value === '--' || isNoExpiryDate(item.expiredDate) || isNoExpiryDate(value)) {
    return lang === 'en' ? 'No expiry date' : 'Tanpa kedaluwarsa';
  }
  if (/damage|rusak|expired|kedaluwarsa/i.test(value || item.expiredDate || '')) return '—';
  return lang === 'en' ? 'Check date' : 'Periksa tanggal';
}

export function inventoryStatus(item: StockItem, lang: 'id' | 'en' = 'id'): { label: string; tone: 'safe' | 'amber' | 'warning' | 'danger' | 'neutral' } {
  const status = getStockStatus(item);
  if (status === 'Damage') return { label: lang === 'en' ? 'Damaged' : 'Rusak', tone: 'danger' };
  if (status === 'Karantina') return { label: lang === 'en' ? 'Quarantine' : 'Karantina', tone: 'warning' };
  if (!isStockPickable(item)) return { label: 'Buffer', tone: 'warning' };

  // Hitung sisa ED presisi (Bulan & Hari) sesuai Gambar No 2
  const remaining = calculateRemainingExpiry(item.expiredDate);
  if (remaining.isExpired || status === 'Expired') {
    if (remaining.totalDays < 0) {
      const d = Math.abs(remaining.totalDays);
      return { 
        label: lang === 'en' ? `Expired (${d} d ago)` : `Lewat ED (${d} hr)`, 
        tone: 'danger' 
      };
    }
    return { label: lang === 'en' ? 'Expired' : 'Kedaluwarsa', tone: 'danger' };
  }
  if (remaining.label === 'Tanpa ED') {
    return { label: lang === 'en' ? 'No Expiry' : 'Tanpa ED', tone: 'safe' };
  }
  if (remaining.label === 'Rusak') {
    return { label: lang === 'en' ? 'Damaged' : 'Rusak', tone: 'danger' };
  }

  // Format bilingual: "20 bln 21 hari" vs "20 mos 21 days"
  const mUnit = lang === 'en' ? 'mos' : 'bln';
  const dUnit = lang === 'en' ? (remaining.days === 1 ? 'day' : 'days') : 'hari';
  let formattedLabel = remaining.label;

  if (remaining.months > 0 && remaining.days > 0) {
    formattedLabel = `${remaining.months} ${mUnit} ${remaining.days} ${dUnit}`;
  } else if (remaining.months > 0) {
    formattedLabel = `${remaining.months} ${mUnit}`;
  } else if (remaining.days > 0) {
    formattedLabel = `${remaining.days} ${dUnit}`;
  }

  return { label: formattedLabel, tone: remaining.tone };
}

export function inventoryMovementLabel(category: string, lang: 'id' | 'en' = 'id') {
  if (lang === 'en') {
    return ({ 
      'FAST MOVING': 'Fast Moving', 
      'MEDIUM': 'Medium Moving', 
      'SLOW MOVING': 'Slow Moving', 
      'BELUM ADA OUTBOUND': 'No Outbound Yet', 
      'DEAD STOCK': 'Dead Stock' 
    } as Record<string, string>)[category] || category;
  }
  return ({ 
    'FAST MOVING': 'Pergerakan cepat', 
    MEDIUM: 'Pergerakan sedang', 
    'SLOW MOVING': 'Pergerakan lambat', 
    'BELUM ADA OUTBOUND': 'Belum ada outbound', 
    'DEAD STOCK': 'Tanpa pergerakan' 
  } as Record<string, string>)[category] || category;
}
