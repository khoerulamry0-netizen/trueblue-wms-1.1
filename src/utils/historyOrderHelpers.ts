import type { OutboundItem } from '../types';
import { formatToWibString } from './calculations';
import { resolveItemBasketCodes, summarizeOrderBaskets } from './masterBasketTracker';
import { getOrderStageHistory } from './orderStageHistory';

export interface HistoryOrderGroup {
  collapseKey: string;
  batchKey: string;
  orderKey: string;
  orderNumber?: string;
  displayOrderLabel: string;
  items: OutboundItem[];
  latestTimestamp: string;
  totalQty: number;
  uniqueSkuCount: number;
  refs: string[];
  poNumbers: string[];
  customers: string[];
  customerAddress: string;
  orderStatus: 'Completed' | 'Pending' | 'Cancelled';
  masterBaskets: string[];
  sortBaskets: string[];
  createdBy: string;
  pickedBy: string;
  sortedBy: string;
  packedBy: string;
}

export interface HistoryBatchGroup {
  batchKey: string;
  items: OutboundItem[];
  orderGroups: HistoryOrderGroup[];
  latestTimestamp: string;
  totalQty: number;
  uniqueSkuCount: number;
  refs: string[];
  orderNumbers: string[];
  poNumbers: string[];
  customers: string[];
  customerAddresses: string[];
  groupStatus: 'Completed' | 'Pending' | 'Cancelled';
  masterBaskets: string[];
  sortBaskets: string[];
  createdBy: string;
  pickedBy: string;
  sortedBy: string;
  packedBy: string;
}

export function getHistoryBatchKey(item: OutboundItem): string {
  return item.batchNumber?.trim() || item.referenceNumber?.trim() || item.orderNumber?.trim() || 'TANPA-BATCH';
}

export function getHistoryOrderKey(item: OutboundItem): string {
  return item.orderNumber?.trim() || item.referenceNumber?.trim() || 'TANPA-ORDER';
}

function getOrderAddressLookupKey(item: OutboundItem): string {
  const orderNumber = item.orderNumber?.trim();
  if (orderNumber) return `ord:${orderNumber}`;
  const referenceNumber = item.referenceNumber?.trim();
  if (referenceNumber) return `ref:${referenceNumber}`;
  return `id:${item.id}`;
}

function buildOrderFieldMap(
  orderHistory: OutboundItem[],
  getter: (item: OutboundItem) => string | undefined
): Map<string, string> {
  const fieldMap = new Map<string, string>();
  for (const item of orderHistory) {
    const val = getter(item)?.trim();
    if (!val) continue;
    const key = getOrderAddressLookupKey(item);
    if (!fieldMap.has(key)) {
      fieldMap.set(key, val);
    }
  }
  return fieldMap;
}

function resolveOrderField(
  item: OutboundItem,
  getter: (item: OutboundItem) => string | undefined,
  fieldMap?: Map<string, string>
): string {
  const direct = getter(item)?.trim();
  if (direct) return direct;
  return fieldMap?.get(getOrderAddressLookupKey(item)) || '';
}

export function buildOrderAddressMap(orderHistory: OutboundItem[]): Map<string, string> {
  return buildOrderFieldMap(orderHistory, item => item.customerAddress);
}

export function resolveOrderCustomerAddress(
  item: OutboundItem,
  addressMap?: Map<string, string>
): string {
  return resolveOrderField(item, item => item.customerAddress, addressMap);
}

export function buildOrderPhoneMap(orderHistory: OutboundItem[]): Map<string, string> {
  return buildOrderFieldMap(orderHistory, item => item.customerPhone);
}

export function resolveOrderCustomerPhone(
  item: OutboundItem,
  phoneMap?: Map<string, string>
): string {
  return resolveOrderField(item, item => item.customerPhone, phoneMap);
}

export function resolveHistoryGroupStatus(
  items: OutboundItem[]
): 'Completed' | 'Pending' | 'Cancelled' {
  if (items.length === 0) return 'Pending';
  const allCancelled = items.every(i => i.status === 'Cancelled');
  if (allCancelled) return 'Cancelled';
  const hasPending = items.some(i => i.status === 'Pending');
  if (hasPending) return 'Pending';
  const allCompleted = items
    .filter(i => i.status !== 'Cancelled')
    .every(i => i.status === 'Completed');
  return allCompleted ? 'Completed' : 'Pending';
}

function summarizeHistoryItems(
  items: OutboundItem[],
  addressMap: Map<string, string>,
  epochCache: Map<string, number>
) {
  const getEpoch = (ts: string) => {
    let cached = epochCache.get(ts);
    if (cached === undefined) {
      cached = Date.parse(ts);
      epochCache.set(ts, cached);
    }
    return cached;
  };

  let latestTimestamp = items[0].timestamp;
  let latestMs = getEpoch(latestTimestamp);
  let activeTotalQty = 0;
  let rawTotalQty = 0;
  let allCancelled = items.length > 0;
  let hasPending = false;
  let allNonCancelledCompleted = true;

  const skuSet = new Set<string>();
  const refSet = new Set<string>();
  const orderSet = new Set<string>();
  const poSet = new Set<string>();
  const customerSet = new Set<string>();
  const addressSet = new Set<string>();
  const createdSet = new Set<string>();
  const pickedSet = new Set<string>();
  const sortedSet = new Set<string>();
  const packedSet = new Set<string>();

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const tsMs = getEpoch(it.timestamp);
    if (tsMs > latestMs) {
      latestMs = tsMs;
      latestTimestamp = it.timestamp;
    }

    rawTotalQty += it.qty;
    if (it.status === 'Cancelled') {
      // stays neutral on non-cancelled status check
    } else {
      allCancelled = false;
      activeTotalQty += it.qty;
      if (it.status === 'Pending') {
        hasPending = true;
      } else if (it.status !== 'Completed') {
        allNonCancelledCompleted = false;
      }
    }

    if (it.skuId) skuSet.add(it.skuId);
    if (it.referenceNumber) refSet.add(it.referenceNumber);
    if (it.orderNumber) orderSet.add(it.orderNumber);
    if (it.noPo) poSet.add(it.noPo);
    if (it.customerName) customerSet.add(it.customerName);
    const addr = resolveOrderCustomerAddress(it, addressMap);
    if (addr) addressSet.add(addr);
    if (it.createdBy) createdSet.add(it.createdBy);
    if (it.pickedBy) pickedSet.add(it.pickedBy);
    if (it.sortedBy) sortedSet.add(it.sortedBy);
    if (it.packedBy) packedSet.add(it.packedBy);
  }

  const { masterBaskets, sortBaskets } = summarizeOrderBaskets(items);
  const status: 'Completed' | 'Pending' | 'Cancelled' =
    items.length === 0
      ? 'Pending'
      : allCancelled
      ? 'Cancelled'
      : hasPending
      ? 'Pending'
      : allNonCancelledCompleted
      ? 'Completed'
      : 'Pending';

  return {
    latestTimestamp,
    latestMs,
    totalQty: activeTotalQty || rawTotalQty,
    uniqueSkuCount: skuSet.size,
    refs: Array.from(refSet),
    orderNumbers: Array.from(orderSet),
    poNumbers: Array.from(poSet),
    customers: Array.from(customerSet),
    customerAddresses: Array.from(addressSet),
    status,
    masterBaskets,
    sortBaskets,
    createdBy: Array.from(createdSet).join(', '),
    pickedBy: Array.from(pickedSet).join(', '),
    sortedBy: Array.from(sortedSet).join(', '),
    packedBy: Array.from(packedSet).join(', ')
  };
}

function compareGroupSort(
  a: { latestTimestamp: string; totalQty: number },
  b: { latestTimestamp: string; totalQty: number },
  sortBy: 'timestamp' | 'qty',
  sortOrder: 'asc' | 'desc',
  epochByGroup?: WeakMap<object, number>
): number {
  const valA = sortBy === 'timestamp' ? (epochByGroup?.get(a) ?? Date.parse(a.latestTimestamp)) : a.totalQty;
  const valB = sortBy === 'timestamp' ? (epochByGroup?.get(b) ?? Date.parse(b.latestTimestamp)) : b.totalQty;
  if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
  if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
  return 0;
}

export function buildGroupedHistory(
  filteredHistory: OutboundItem[],
  addressMap: Map<string, string>,
  sortBy: 'timestamp' | 'qty',
  sortOrder: 'asc' | 'desc'
): { groupedByBatch: HistoryBatchGroup[]; groupedByOrder: HistoryOrderGroup[] } {
  const epochCache = new Map<string, number>();
  const groupEpoch = new WeakMap<object, number>();
  const batchMap = new Map<string, OutboundItem[]>();
  for (const item of filteredHistory) {
    const bKey = getHistoryBatchKey(item);
    let list = batchMap.get(bKey);
    if (!list) {
      list = [];
      batchMap.set(bKey, list);
    }
    list.push(item);
  }

  const allOrderGroups: HistoryOrderGroup[] = [];

  const groupedByBatch: HistoryBatchGroup[] = Array.from(batchMap.entries()).map(([batchKey, items]) => {
    const summary = summarizeHistoryItems(items, addressMap, epochCache);

    const orderMap = new Map<string, OutboundItem[]>();
    for (const item of items) {
      const oKey = getHistoryOrderKey(item);
      let list = orderMap.get(oKey);
      if (!list) {
        list = [];
        orderMap.set(oKey, list);
      }
      list.push(item);
    }

    const orderGroups: HistoryOrderGroup[] = Array.from(orderMap.entries()).map(([orderKey, orderItems]) => {
      const orderSummary = summarizeHistoryItems(orderItems, addressMap, epochCache);
      const explicitOrderNumber = orderItems.find(i => i.orderNumber?.trim())?.orderNumber?.trim();
      const group: HistoryOrderGroup = {
        collapseKey: `${batchKey}::${orderKey}`,
        batchKey,
        orderKey,
        orderNumber: explicitOrderNumber,
        displayOrderLabel: explicitOrderNumber || orderSummary.refs[0] || orderKey,
        items: orderItems,
        latestTimestamp: orderSummary.latestTimestamp,
        totalQty: orderSummary.totalQty,
        uniqueSkuCount: orderSummary.uniqueSkuCount,
        refs: orderSummary.refs,
        poNumbers: orderSummary.poNumbers,
        customers: orderSummary.customers,
        customerAddress: orderSummary.customerAddresses.join(' | '),
        orderStatus: orderSummary.status,
        masterBaskets: orderSummary.masterBaskets,
        sortBaskets: orderSummary.sortBaskets,
        createdBy: orderSummary.createdBy,
        pickedBy: orderSummary.pickedBy,
        sortedBy: orderSummary.sortedBy,
        packedBy: orderSummary.packedBy
      };
      groupEpoch.set(group, orderSummary.latestMs);
      return group;
    });

    orderGroups.sort((a, b) => compareGroupSort(a, b, sortBy, sortOrder, groupEpoch));
    allOrderGroups.push(...orderGroups);

    const batchGroup: HistoryBatchGroup = {
      batchKey,
      items,
      orderGroups,
      latestTimestamp: summary.latestTimestamp,
      totalQty: summary.totalQty,
      uniqueSkuCount: summary.uniqueSkuCount,
      refs: summary.refs,
      orderNumbers: summary.orderNumbers,
      poNumbers: summary.poNumbers,
      customers: summary.customers,
      customerAddresses: summary.customerAddresses,
      groupStatus: summary.status,
      masterBaskets: summary.masterBaskets,
      sortBaskets: summary.sortBaskets,
      createdBy: summary.createdBy,
      pickedBy: summary.pickedBy,
      sortedBy: summary.sortedBy,
      packedBy: summary.packedBy
    };
    groupEpoch.set(batchGroup, summary.latestMs);
    return batchGroup;
  });

  groupedByBatch.sort((a, b) => compareGroupSort(a, b, sortBy, sortOrder, groupEpoch));
  allOrderGroups.sort((a, b) => compareGroupSort(a, b, sortBy, sortOrder, groupEpoch));

  return { groupedByBatch, groupedByOrder: allOrderGroups };
}

export function buildOrderHistoryExportRows(
  items: OutboundItem[],
  addressMap: Map<string, string>,
  options: { includeDescription: boolean; phoneMap?: Map<string, string> }
): Array<Record<string, unknown>> {
  const resolvedPhoneMap = options.phoneMap ?? buildOrderPhoneMap(items);
  return items.map(item => {
    const customerAddress = resolveOrderCustomerAddress(item, addressMap);
    const customerPhone = resolveOrderCustomerPhone(item, resolvedPhoneMap);
    const { masterBasket, sortBasket } = resolveItemBasketCodes(item);
    const row: Record<string, unknown> = {
      'Waktu Keluar': formatToWibString(item.timestamp),
      'Batch Number': getHistoryBatchKey(item),
      'No Referensi': item.referenceNumber || '-',
      'Order Number': item.orderNumber || '-',
      'No PO': item.noPo || '-',
      'Customer Name': item.customerName || '-',
      'Customer Address': customerAddress || '-',
      'No Telepon Customer': customerPhone || '-',
      'SKU ID': item.skuId,
      'Nama Barang': item.skuName,
      'Expired': item.expiredDate,
      'Lokasi Rak': item.location,
      'Qty (Pcs)': item.qty,
      'Status': item.status,
      'Keranjang Induk': masterBasket || '-',
      'Keranjang Sortir': sortBasket || '-',
      'Petugas Input': item.createdBy || 'Belum tercatat',
      'Petugas Picking': item.pickedBy || 'Belum tercatat',
      'Petugas Sortir': item.sortedBy || 'Belum tercatat',
      'Petugas Packing / Validasi': item.packedBy || 'Belum tercatat',
      ...Object.fromEntries(getOrderStageHistory(item).map(stageRow => ['Waktu ' + stageRow.stage + ' (WIB)', stageRow.timeLabel]))
    };

    if (options.includeDescription) {
      row['Deskripsi / Dokumen'] = item.referenceNumber || item.notes || '-';
    }

    return row;
  });
}

export function getOrderHistoryExportColWidths(includeDescription: boolean): Array<{ wch: number }> {
  const colWidths = [
    { wch: 18 }, // Waktu Keluar
    { wch: 22 }, // Batch Number
    { wch: 22 }, // No Referensi
    { wch: 15 }, // Order Number
    { wch: 15 }, // No PO
    { wch: 25 }, // Customer Name
    { wch: 38 }, // Customer Address
    { wch: 18 }, // No Telepon Customer
    { wch: 15 }, // SKU ID
    { wch: 30 }, // Nama Barang
    { wch: 12 }, // Expired
    { wch: 12 }, // Lokasi Rak
    { wch: 10 }, // Qty (Pcs)
    { wch: 12 }, // Status
    { wch: 18 }, // Keranjang Induk
    { wch: 18 }, // Keranjang Sortir
    { wch: 24 },
    { wch: 24 },
    { wch: 24 },
    { wch: 24 },
    { wch: 28 },
    { wch: 28 },
    { wch: 28 },
    { wch: 28 }
  ];
  if (includeDescription) {
    colWidths.push({ wch: 25 }); // Deskripsi / Dokumen
  }
  return colWidths;
}
