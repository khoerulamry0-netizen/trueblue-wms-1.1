import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildGroupedHistory,
  buildOrderAddressMap,
  buildOrderHistoryExportRows,
  buildOrderPhoneMap,
  getOrderHistoryExportColWidths,
  resolveOrderCustomerAddress,
  resolveOrderCustomerPhone
} from '../src/utils/historyOrderHelpers.ts';

function makeOrderItem(overrides = {}) {
  return {
    id: overrides.id || 'item-1',
    referenceNumber: overrides.referenceNumber || 'REF-1',
    orderNumber: overrides.orderNumber,
    batchNumber: overrides.batchNumber,
    customerName: overrides.customerName,
    customerAddress: overrides.customerAddress,
    customerPhone: overrides.customerPhone,
    noPo: overrides.noPo,
    skuId: overrides.skuId || 'SKU-01',
    skuName: overrides.skuName || 'Produk A',
    expiredDate: overrides.expiredDate || '01-01-2027',
    qty: overrides.qty ?? 2,
    location: overrides.location || 'A1-01',
    timestamp: overrides.timestamp || '2026-11-14T08:00:00.000Z',
    scanned: true,
    status: overrides.status || 'Completed',
    notes: overrides.notes,
    createdBy: overrides.createdBy,
    pickedBy: overrides.pickedBy,
    sortedBy: overrides.sortedBy,
    packedBy: overrides.packedBy
  };
}

test('resolveOrderCustomerAddress resolves direct and sibling addresses without cross-order leakage', () => {
  const rows = [
    makeOrderItem({
      id: '1',
      referenceNumber: 'BATCH-0035',
      orderNumber: 'ORD-001',
      customerName: 'Budi',
      customerAddress: '  Jl. Sudirman No. 10, Jakarta  '
    }),
    makeOrderItem({
      id: '2',
      referenceNumber: 'BATCH-0035',
      orderNumber: 'ORD-001',
      skuId: 'SKU-02',
      customerName: 'Budi',
      customerAddress: ''
    }),
    makeOrderItem({
      id: '3',
      referenceNumber: 'BATCH-0035',
      orderNumber: 'ORD-002',
      customerName: 'Siti',
      customerAddress: undefined
    })
  ];

  const addressMap = buildOrderAddressMap(rows);
  assert.equal(resolveOrderCustomerAddress(rows[0], addressMap), 'Jl. Sudirman No. 10, Jakarta');
  assert.equal(resolveOrderCustomerAddress(rows[1], addressMap), 'Jl. Sudirman No. 10, Jakarta');
  assert.equal(resolveOrderCustomerAddress(rows[2], addressMap), '');
});

test('buildGroupedHistory groups orders per batch and exposes per-order minimize collapse keys and addresses', () => {
  const rows = [
    makeOrderItem({
      id: '1',
      batchNumber: '0035',
      referenceNumber: 'ORD-001',
      orderNumber: 'ORD-001',
      customerName: 'Andi',
      customerAddress: 'Jl. Asia Afrika No. 8, Bandung',
      qty: 3,
      timestamp: '2026-11-14T08:10:00.000Z'
    }),
    makeOrderItem({
      id: '2',
      batchNumber: '0035',
      referenceNumber: 'ORD-001',
      orderNumber: 'ORD-001',
      skuId: 'SKU-02',
      customerName: 'Andi',
      qty: 5,
      timestamp: '2026-11-14T08:12:00.000Z'
    }),
    makeOrderItem({
      id: '3',
      batchNumber: '0035',
      referenceNumber: 'ORD-002',
      orderNumber: 'ORD-002',
      customerName: 'Dewi',
      customerAddress: undefined,
      qty: 4,
      status: 'Pending',
      timestamp: '2026-11-14T08:20:00.000Z'
    })
  ];

  const addressMap = buildOrderAddressMap(rows);
  const { groupedByBatch, groupedByOrder } = buildGroupedHistory(rows, addressMap, 'timestamp', 'desc');

  assert.equal(groupedByBatch.length, 1);
  assert.equal(groupedByBatch[0].batchKey, '0035');
  assert.deepEqual(groupedByBatch[0].customerAddresses, ['Jl. Asia Afrika No. 8, Bandung']);
  assert.equal(groupedByBatch[0].orderGroups.length, 2);

  const ord2 = groupedByBatch[0].orderGroups[0];
  const ord1 = groupedByBatch[0].orderGroups[1];
  assert.equal(ord2.orderNumber, 'ORD-002');
  assert.equal(ord2.collapseKey, '0035::ORD-002');
  assert.equal(ord2.customerAddress, '');
  assert.equal(ord2.orderStatus, 'Pending');

  assert.equal(ord1.orderNumber, 'ORD-001');
  assert.equal(ord1.collapseKey, '0035::ORD-001');
  assert.equal(ord1.customerAddress, 'Jl. Asia Afrika No. 8, Bandung');
  assert.equal(ord1.uniqueSkuCount, 2);
  assert.equal(ord1.totalQty, 8);
  assert.equal(ord1.orderStatus, 'Completed');

  assert.equal(groupedByOrder.length, 2);
  assert.equal(groupedByOrder[0].collapseKey, '0035::ORD-002');
});

test('buildOrderHistoryExportRows includes Customer Address and No Telepon Customer right after Customer Name with aligned column widths', () => {
  const rows = [
    makeOrderItem({
      id: '1',
      batchNumber: '0035',
      orderNumber: 'ORD-001',
      customerName: 'Toko Jaya',
      customerAddress: 'Jl. Diponegoro No. 45, Surabaya',
      customerPhone: '081234567890',
      notes: 'Catatan'
    }),
    makeOrderItem({
      id: '2',
      batchNumber: '0035',
      orderNumber: 'ORD-001',
      skuId: 'SKU-02',
      customerName: 'Toko Jaya'
    }),
    makeOrderItem({
      id: '3',
      batchNumber: '0036',
      orderNumber: 'ORD-009',
      customerName: 'Toko Tanpa Alamat'
    })
  ];

  const addressMap = buildOrderAddressMap(rows);
  const phoneMap = buildOrderPhoneMap(rows);
  assert.equal(resolveOrderCustomerPhone(rows[0], phoneMap), '081234567890');
  assert.equal(resolveOrderCustomerPhone(rows[1], phoneMap), '081234567890');
  assert.equal(resolveOrderCustomerPhone(rows[2], phoneMap), '');

  const exportedWithDesc = buildOrderHistoryExportRows(rows, addressMap, { includeDescription: true, phoneMap });
  const keys = Object.keys(exportedWithDesc[0]);

  assert.equal(keys[keys.indexOf('Customer Name') + 1], 'Customer Address');
  assert.equal(keys[keys.indexOf('Customer Address') + 1], 'No Telepon Customer');
  assert.equal(exportedWithDesc[0]['Customer Address'], 'Jl. Diponegoro No. 45, Surabaya');
  assert.equal(exportedWithDesc[1]['Customer Address'], 'Jl. Diponegoro No. 45, Surabaya');
  assert.equal(exportedWithDesc[2]['Customer Address'], '-');
  assert.equal(exportedWithDesc[0]['No Telepon Customer'], '081234567890');
  assert.equal(exportedWithDesc[1]['No Telepon Customer'], '081234567890');
  assert.equal(exportedWithDesc[2]['No Telepon Customer'], '-');
  assert.equal(keys.length, getOrderHistoryExportColWidths(true).length);

  const exportedNoDesc = buildOrderHistoryExportRows(rows, addressMap, { includeDescription: false });
  assert.equal(Object.keys(exportedNoDesc[0]).length, getOrderHistoryExportColWidths(false).length);
});

test('HistoryOrder component starts batches and orders minimized and exposes minimize/maximize controls', () => {
  const source = readFileSync(new URL('../src/components/HistoryOrder.tsx', import.meta.url), 'utf8');
  assert.match(source, /buildOrderHistoryExportRows/);
  assert.match(source, /resolveCustomerAddress/);
  assert.match(source, /expandedBatches/);
  assert.match(source, /expandedOrders/);
  assert.match(source, /const isCollapsed = !expandedBatches\[group\.batchKey\]/);
  assert.match(source, /const isOrderCollapsed = !expandedOrders\[orderGroup\.collapseKey\]/);
  assert.match(source, /order\.minimizeOrder/);
  assert.match(source, /order\.maximizeOrder/);
  assert.match(source, /order\.expandAllOrders/);
  assert.match(source, /order\.collapseAllOrders/);
});


test('buildOrderHistoryExportRows, getOrderHistoryExportColWidths, and buildGroupedHistory expose Keranjang Induk and Keranjang Sortir', () => {
  const sampleItems = [
    {
      id: 'exp-1',
      batchNumber: 'BATCH-BASKET',
      referenceNumber: 'REF-EXP-1',
      skuId: 'SKU-EXP',
      skuName: 'Produk Export',
      qty: 3,
      expiredDate: '01/01/2030',
      location: 'A1',
      timestamp: '2026-11-15T10:00:00.000Z',
      scanned: true,
      status: 'Pending',
      picked: true,
      stockDeducted: true,
      shipped: false,
      basketNumber: 'A1',
      masterBasketNumber: 'GB-05',
      sortedAt: '2026-11-15T10:05:00.000Z',
      sortedBy: 'Sorter Rudi',
      customerName: 'Andi',
      customerAddress: 'Jl. Merdeka'
    },
    {
      id: 'exp-2',
      batchNumber: 'BATCH-BASKET',
      referenceNumber: 'REF-EXP-2',
      skuId: 'SKU-EXP',
      skuName: 'Produk Export',
      qty: 1,
      expiredDate: '01/01/2030',
      location: 'A1',
      timestamp: '2026-11-15T10:10:00.000Z',
      scanned: false,
      status: 'Pending',
      picked: true,
      stockDeducted: true,
      shipped: false,
      basketNumber: 'GB-06',
      customerName: 'Siti',
      customerAddress: 'Jl. Sudirman'
    }
  ];

  const grouped = buildGroupedHistory(sampleItems, new Map(), 'timestamp', 'desc');
  assert.equal(grouped.groupedByBatch.length, 1);
  assert.deepEqual(grouped.groupedByBatch[0].masterBaskets, ['GB-05', 'GB-06']);
  assert.deepEqual(grouped.groupedByBatch[0].sortBaskets, ['A1']);

  const exp1Group = grouped.groupedByOrder.find(g => g.orderKey === 'REF-EXP-1');
  const exp2Group = grouped.groupedByOrder.find(g => g.orderKey === 'REF-EXP-2');
  assert.ok(exp1Group && exp2Group);
  assert.deepEqual(exp1Group.masterBaskets, ['GB-05']);
  assert.deepEqual(exp1Group.sortBaskets, ['A1']);
  assert.deepEqual(exp2Group.masterBaskets, ['GB-06']);
  assert.deepEqual(exp2Group.sortBaskets, []);

  const rows = buildOrderHistoryExportRows(sampleItems, new Map(), { includeDescription: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Keranjang Induk'], 'GB-05');
  assert.equal(rows[0]['Keranjang Sortir'], 'A1');
  assert.equal(rows[1]['Keranjang Induk'], 'GB-06');
  assert.equal(rows[1]['Keranjang Sortir'], '-');

  const keys = Object.keys(rows[0]);
  assert.equal(keys[keys.indexOf('Status') + 1], 'Keranjang Induk');
  assert.equal(keys[keys.indexOf('Status') + 2], 'Keranjang Sortir');
  assert.equal(keys[keys.indexOf('Customer Name') + 1], 'Customer Address');
  assert.equal(keys.length, getOrderHistoryExportColWidths(false).length);

  const rowsWithDesc = buildOrderHistoryExportRows(sampleItems, new Map(), { includeDescription: true });
  assert.equal(Object.keys(rowsWithDesc[0]).length, getOrderHistoryExportColWidths(true).length);
});
