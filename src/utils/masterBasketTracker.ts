import type { OutboundItem } from '../types';
import { findActiveBasketConflicts, formatBasketConflictSummary } from './orderSorting';

export type MasterBasketOrderStage = 'Sedang Dipicking' | 'Menunggu Sortir' | 'Siap Packing';

export interface MasterBasketOrderEntry {
  referenceNumber: string;
  orderNumber?: string;
  batchNumber?: string;
  customerName?: string;
  totalQty: number;
  skuCount: number;
  pickerName: string;
  sorterName: string;
  masterBasket: string;
  sortBasket: string;
  isPicked: boolean;
  isSorted: boolean;
  stage: MasterBasketOrderStage;
  timestamp: string;
}

export interface MasterBasketMonitorGroup {
  groupKey: string;
  basketCode: string;
  isMasterBasket: boolean;
  pickerNames: string[];
  orders: MasterBasketOrderEntry[];
  totalQty: number;
  stageCounts: { picking: number; waitingSort: number; readyPacking: number };
  canRenameGroup: boolean;
  latestTimestamp: string;
}

/** Resolve preserved picking master basket and post-sorting child basket for an order item. */
export function resolveItemBasketCodes(
  item: Pick<OutboundItem, 'basketNumber' | 'masterBasketNumber' | 'sortedAt' | 'sortedBy'>
): { masterBasket: string; sortBasket: string } {
  const isSorted = Boolean(item.sortedAt?.trim() && item.sortedBy?.trim());
  const current = (item.basketNumber || '').trim().toUpperCase();
  const explicitMaster = (item.masterBasketNumber || '').trim().toUpperCase();

  if (isSorted) {
    return { masterBasket: explicitMaster, sortBasket: current };
  }
  return { masterBasket: explicitMaster || current, sortBasket: '' };
}

/** Collect unique uppercase master and sorting basket codes across a group of items. */
export function summarizeOrderBaskets(items: OutboundItem[]): { masterBaskets: string[]; sortBaskets: string[] } {
  const masters = new Set<string>();
  const sorts = new Set<string>();

  for (const item of items) {
    const { masterBasket, sortBasket } = resolveItemBasketCodes(item);
    if (masterBasket) masters.add(masterBasket);
    if (sortBasket) sorts.add(sortBasket);
  }

  return {
    masterBaskets: Array.from(masters),
    sortBaskets: Array.from(sorts),
  };
}

function summarizePendingOrder(items: OutboundItem[]): MasterBasketOrderEntry {
  const first = items[0];
  const isPicked = items.every(i => Boolean(i.picked));
  const isSorted = items.every(i => Boolean(i.sortedAt?.trim() && i.sortedBy?.trim()));
  const { masterBaskets, sortBaskets } = summarizeOrderBaskets(items);

  const stage: MasterBasketOrderStage = isSorted
    ? 'Siap Packing'
    : isPicked
    ? 'Menunggu Sortir'
    : 'Sedang Dipicking';

  const pickers = Array.from(new Set(items.map(i => (i.pickedBy || i.pickingBy || '').trim()).filter(Boolean)));
  const sorters = Array.from(new Set(items.map(i => (i.sortedBy || '').trim()).filter(Boolean)));
  const latestTimestamp = items.reduce(
    (latest, it) => (new Date(it.timestamp).getTime() > new Date(latest).getTime() ? it.timestamp : latest),
    first.timestamp
  );

  return {
    referenceNumber: first.referenceNumber,
    orderNumber: items.find(i => i.orderNumber?.trim())?.orderNumber?.trim(),
    batchNumber: items.find(i => i.batchNumber?.trim())?.batchNumber?.trim(),
    customerName: items.find(i => i.customerName?.trim())?.customerName?.trim(),
    totalQty: items.reduce((sum, i) => sum + Number(i.qty || 0), 0),
    skuCount: new Set(items.map(i => i.skuId)).size,
    pickerName: pickers.join(', '),
    sorterName: sorters.join(', '),
    masterBasket: masterBaskets.join(', '),
    sortBasket: sortBaskets.join(', '),
    isPicked,
    isSorted,
    stage,
    timestamp: latestTimestamp,
  };
}

export function doesMonitorOrderMatchQuery(entry: MasterBasketOrderEntry, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const fields = [
    entry.referenceNumber,
    entry.orderNumber,
    entry.batchNumber,
    entry.customerName,
    entry.pickerName,
    entry.sorterName,
    entry.masterBasket,
    entry.sortBasket,
  ];
  return fields.some(val => Boolean(val && val.toLowerCase().includes(normalizedQuery)));
}

/** Group active Pending unshipped orders by master basket (and list search-matching unassigned orders). */
export function buildMasterBasketMonitorData(
  history: OutboundItem[],
  searchTerm = ''
): { groups: MasterBasketMonitorGroup[]; matchingUnassigned: MasterBasketOrderEntry[] } {
  const byRef = new Map<string, OutboundItem[]>();
  for (const item of history) {
    if (item.status !== 'Pending' || item.shipped) continue;
    const list = byRef.get(item.referenceNumber) || [];
    list.push(item);
    byRef.set(item.referenceNumber, list);
  }

  const groupBuckets = new Map<string, { isMasterBasket: boolean; basketCode: string; orders: MasterBasketOrderEntry[] }>();
  const unassigned: MasterBasketOrderEntry[] = [];

  for (const items of byRef.values()) {
    const entry = summarizePendingOrder(items);
    const primaryMaster = entry.masterBasket.split(',')[0]?.trim() || '';
    const primarySort = entry.sortBasket.split(',')[0]?.trim() || '';

    if (!primaryMaster && !primarySort) {
      unassigned.push(entry);
      continue;
    }

    const isMasterBasket = Boolean(primaryMaster);
    const basketCode = primaryMaster || primarySort;
    const groupKey = isMasterBasket ? `MASTER:${basketCode}` : `SORTONLY:${basketCode}`;
    const bucket = groupBuckets.get(groupKey) || { isMasterBasket, basketCode, orders: [] };
    bucket.orders.push(entry);
    groupBuckets.set(groupKey, bucket);
  }

  const allGroups: MasterBasketMonitorGroup[] = Array.from(groupBuckets.entries()).map(([groupKey, bucket]) => {
    const orders = bucket.orders.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const pickerNames = Array.from(new Set(orders.map(o => o.pickerName).filter(Boolean)));
    const stageCounts = {
      picking: orders.filter(o => o.stage === 'Sedang Dipicking').length,
      waitingSort: orders.filter(o => o.stage === 'Menunggu Sortir').length,
      readyPacking: orders.filter(o => o.stage === 'Siap Packing').length,
    };
    const totalQty = orders.reduce((sum, o) => sum + o.totalQty, 0);
    const canRenameGroup = bucket.isMasterBasket && orders.length > 0 && orders.every(o => !o.isSorted);
    const latestTimestamp = orders.reduce(
      (latest, o) => (new Date(o.timestamp).getTime() > new Date(latest).getTime() ? o.timestamp : latest),
      orders[0].timestamp
    );

    return {
      groupKey,
      basketCode: bucket.basketCode,
      isMasterBasket: bucket.isMasterBasket,
      pickerNames,
      orders,
      totalQty,
      stageCounts,
      canRenameGroup,
      latestTimestamp,
    };
  });

  allGroups.sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());

  const normalizedQuery = searchTerm.trim().toLowerCase();
  const groups = normalizedQuery
    ? allGroups.filter(
        g =>
          g.basketCode.toLowerCase().includes(normalizedQuery) ||
          g.orders.some(ord => doesMonitorOrderMatchQuery(ord, normalizedQuery))
      )
    : allGroups;

  const matchingUnassigned = normalizedQuery
    ? unassigned
        .filter(ord => doesMonitorOrderMatchQuery(ord, normalizedQuery))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    : [];

  return { groups, matchingUnassigned };
}

/** Validate an admin master-basket correction before writing via commit_wms_write session update. */
export function validateMasterBasketUpdate(
  history: OutboundItem[],
  targetRefs: string[],
  newBasketCode: string,
  mode: 'rename_group' | 'move_order'
): { cleanBasket: string } | { error: string } {
  const cleanBasket = newBasketCode.trim().toUpperCase();
  if (!cleanBasket || cleanBasket.length > 128) {
    return { error: 'Kode Keranjang Induk harus diisi (1–128 karakter).' };
  }

  const cleanRefs = Array.from(new Set(targetRefs.map(r => r.trim()).filter(Boolean)));
  if (cleanRefs.length === 0) {
    return { error: 'Tidak ada order yang dipilih untuk dikoreksi.' };
  }

  for (const ref of cleanRefs) {
    const rows = history.filter(item => item.referenceNumber === ref);
    if (rows.length === 0 || rows.some(item => item.status !== 'Pending' || item.shipped)) {
      return { error: `Order ${ref} sudah selesai, dikirim, atau dibatalkan sehingga keranjangnya tidak dapat diubah.` };
    }
    if (rows.some(item => Boolean(item.sortedAt?.trim() && item.sortedBy?.trim()))) {
      return { error: `Order ${ref} sudah masuk/selesai proses Sortir sehingga kode keranjang induknya tidak bisa diubah.` };
    }
  }

  const conflicts = findActiveBasketConflicts(history, [cleanBasket], cleanRefs);
  const packingConflicts = conflicts.filter(c => c.stage === 'Packing');
  if (packingConflicts.length > 0) {
    return {
      error: `Kode "${cleanBasket}" sedang aktif dipakai keranjang Packing (${formatBasketConflictSummary(packingConflicts)}). Gunakan kode lain!`,
    };
  }

  if (mode === 'rename_group' && conflicts.length > 0) {
    return {
      error: `Kode "${cleanBasket}" sedang dipakai batch lain (${formatBasketConflictSummary(conflicts)}). Gunakan tombol "Pindah" di baris order jika ingin memindahkan ke keranjang tersebut.`,
    };
  }

  return { cleanBasket };
}
