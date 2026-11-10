import type { DccLog, OutboundItem, StockItem } from '../types';
import { getCompletedOutbound, getItemStockBreakdown, getLockedStockSummary, getStockStatus, isStockPickable, isToday, type LockedStockSummary } from './calculations';
import { getInventorySkuTotals, inventorySkuKey } from './inventoryView';

export const inventoryFocusOptions = [
  { value: 'AVAILABLE', label: 'Tersedia untuk picking' },
  { value: 'ALLOCATED', label: 'Dialokasikan ke order' },
  { value: 'BLOCKED', label: 'Ditahan / rusak / kedaluwarsa / buffer' },
  { value: 'AMAN', label: 'Aman (≥ 24 bulan / tanpa kedaluwarsa)' },
  { value: 'Under 24Month', label: '18–<24 bulan' },
  { value: 'Under 18 Month', label: '6–<18 bulan' },
  { value: 'Under 6 Month', label: '3–<6 bulan' },
  { value: 'Under 3 Month', label: '<3 bulan' },
  { value: 'Damage', label: 'Rusak' },
  { value: 'Expired', label: 'Kedaluwarsa' },
  { value: 'Karantina', label: 'Karantina / periksa tanggal' }
];

export function matchesInventoryFocus(item: StockItem, focus: string, locked: LockedStockSummary): boolean {
  if (!focus || focus === 'ALL') return true;
  if (focus === 'BLOCKED') return !isStockPickable(item);
  if (focus === 'AVAILABLE') return getItemStockBreakdown(item, locked).availableQty > 0;
  if (focus === 'ALLOCATED') return getItemStockBreakdown(item, locked).lockedQty > 0;
  const status = getStockStatus(item);
  if (focus === 'AMAN' || focus.startsWith('Under ')) return isStockPickable(item) && status === focus;
  return status === focus;
}

export type OutboundMode = 'create' | 'pick' | 'validate' | 'history' | 'manifest';
export function initialOutboundMode(role?: string, requested?: OutboundMode): OutboundMode {
  if (role === 'Picker') return 'pick';
  if (role === 'Packer') return 'validate';
  if (role === 'Shipping') return 'manifest';
  return requested || 'create';
}
export const canBrowseInventory = (role?: string) => ['Administrator', 'Admin', 'Viewer'].includes(role || '');
export const canOpenWork = (role: string | undefined, stage: 'pick' | 'validate') => ['Administrator', 'Admin'].includes(role || '') || (role === 'Picker' && stage === 'pick') || (role === 'Packer' && stage === 'validate');
export const isOrderRowPicked = (order: OutboundItem) => order.picked === true || order.isPicked === true;

export function getDashboardView(stock: StockItem[], orders: OutboundItem[], logs: DccLog[]) {
  const locked = getLockedStockSummary(orders);
  const skuTotals = getInventorySkuTotals(stock, locked);
  const totals = [...skuTotals.values()].reduce((sum, item) => ({ physical: sum.physical + item.physical, allocated: sum.allocated + item.allocated, available: sum.available + item.available, held: sum.held + item.held }), { physical: 0, allocated: 0, available: 0, held: 0 });
  const definitions = [
    { focus: 'AMAN', label: 'Aman', detail: '≥24 bulan / tanpa kedaluwarsa', tone: 'safe' },
    { focus: 'Under 24Month', label: '18–<24 bulan', detail: 'Sisa masa simpan', tone: 'warning' },
    { focus: 'Under 18 Month', label: '6–<18 bulan', detail: 'Sisa masa simpan', tone: 'warning' },
    { focus: 'Under 6 Month', label: '3–<6 bulan', detail: 'Prioritaskan pengeluaran', tone: 'danger' },
    { focus: 'Under 3 Month', label: '<3 bulan', detail: 'Prioritaskan pengeluaran', tone: 'danger' },
    { focus: 'BLOCKED', label: 'Ditahan / buffer', detail: 'Termasuk rusak & kedaluwarsa', tone: 'danger' }
  ];
  const buckets = new Map(definitions.map(def => [def.focus, { ...def, qty: 0, skuSet: new Set<string>() }]));
  for (const item of stock) {
    const focus = isStockPickable(item) ? getStockStatus(item) : 'BLOCKED';
    const bucket = buckets.get(focus);
    if (!bucket) continue;
    bucket.qty += item.qty;
    if (item.qty > 0) bucket.skuSet.add(inventorySkuKey(item.skuId));
  }
  const expiry = [...buckets.values()].map(({skuSet,...bucket}) => ({...bucket, skus:skuSet.size, percent:totals.physical > 0 ? Math.round(bucket.qty / totals.physical * 1000) / 10 : 0}));
  const waiting = new Map<string, OutboundItem[]>();
  for (const order of orders.filter(o => o.status === 'Pending')) {
    const key = order.referenceNumber || order.orderNumber || order.id;
    if (!waiting.has(key)) waiting.set(key, []);
    waiting.get(key)!.push(order);
  }
  const groups = [...waiting.values()];
  const queue = (items: OutboundItem[]) => ({ qty: items.reduce((n, s) => n + s.qty, 0), orders: new Set(items.map(s => s.referenceNumber || s.orderNumber || s.id)).size });
  const logQty = (type: string) => logs.filter(l => l.type === type && isToday(l.timestamp)).reduce((n, s) => n + s.qty, 0);
  return { totals, expiry, skuCount: skuTotals.size, stockedSkus: new Set(stock.filter(s => s.qty > 0).map(s => inventorySkuKey(s.skuId))).size, rows: stock.length,
    picking: queue(groups.filter(items => !items.every(isOrderRowPicked)).flatMap(items => items.filter(o => !isOrderRowPicked(o)))), packing: queue(groups.filter(items => items.every(isOrderRowPicked)).flat()),
    today: { outbound: getCompletedOutbound(orders).filter(o => isToday(o.completedAt || o.packedAt || o.timestamp)).reduce((n, s) => n + s.qty, 0), internal: logQty('TRANSFER'), incoming: logQty('TRANSFER_IN') }
  };
}
