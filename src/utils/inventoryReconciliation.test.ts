import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { 
  reconcileInventory, 
  parseErpTable, 
  detectColumnMapping, 
  buildReconcileTemplateWorkbook,
  RECONCILE_TEMPLATE_HEADERS,
  type ErpRowInput 
} from './inventoryReconciliation';
import type { StockItem, OutboundItem, CatalogItem } from '../types';

test('Reconciliation Case A: ERP 100, GOOD 89, DAMAGE 11 -> MATCH', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'SC032', qty: 100, errors: [] }
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'SC032_A1_GOOD',
      skuId: 'SC032',
      skuName: 'Product SC032',
      qty: 89,
      expiredDate: '15/10/2027',
      location: 'A1-01',
      status: 'AMAN',
      totalQtySku: 100,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    },
    {
      id: 'SC032_DMG_DAMAGE',
      skuId: 'SC032',
      skuName: 'Product SC032',
      qty: 11,
      expiredDate: 'No Expired',
      location: 'DAMAGED',
      status: 'Damage',
      totalQtySku: 100,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.sku, 'SC032');
  assert.equal(item.erpQty, 100);
  assert.equal(item.wmsGoodQty, 89);
  assert.equal(item.wmsDamageQty, 11);
  assert.equal(item.wmsTotalQty, 100);
  assert.equal(item.difference, 0);
  assert.equal(item.status, 'MATCH');

  assert.equal(summary.matchedCount, 1);
  assert.equal(summary.diffCount, 0);
  assert.equal(summary.accuracyRate, 100);
});

test('Reconciliation Case B: ERP 200, GOOD 185, DAMAGE 10 -> SELISIH -5', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'SC099', qty: 200, errors: [] }
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'SC099_A1',
      skuId: 'SC099',
      skuName: 'Product SC099',
      qty: 185,
      expiredDate: '20/12/2026',
      location: 'B1-02',
      status: 'AMAN',
      totalQtySku: 195,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    },
    {
      id: 'SC099_DMG',
      skuId: 'SC099',
      skuName: 'Product SC099',
      qty: 10,
      expiredDate: 'No Expired',
      location: 'DAMAGE',
      status: 'Damage',
      totalQtySku: 195,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.erpQty, 200);
  assert.equal(item.wmsGoodQty, 185);
  assert.equal(item.wmsDamageQty, 10);
  assert.equal(item.wmsTotalQty, 195);
  assert.equal(item.difference, -5); // WMS 195 - ERP 200 = -5
  assert.equal(item.status, 'SELISIH');

  assert.equal(summary.diffCount, 1);
  assert.equal(summary.totalNetDiff, -5);
  assert.equal(summary.totalAbsDiff, 5);
});

test('Reconciliation Case C: ERP 100, GOOD 100, DAMAGE 0 -> MATCH', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'SC100', qty: 100, errors: [] }
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'SC100_A1',
      skuId: 'SC100',
      skuName: 'Product SC100',
      qty: 100,
      expiredDate: '10/10/2027',
      location: 'C1-01',
      status: 'AMAN',
      totalQtySku: 100,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.wmsGoodQty, 100);
  assert.equal(item.wmsDamageQty, 0);
  assert.equal(item.wmsTotalQty, 100);
  assert.equal(item.difference, 0);
  assert.equal(item.status, 'MATCH');
});

test('Reconciliation Case D: SKU only in ERP -> ERP ONLY', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'ERP_EXCLUSIVE', qty: 50, name: 'Exclusive Item', errors: [] }
  ];

  const wmsStock: StockItem[] = [];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.sku, 'ERP_EXCLUSIVE');
  assert.equal(item.erpQty, 50);
  assert.equal(item.wmsTotalQty, 0);
  assert.equal(item.difference, -50);
  assert.equal(item.status, 'ERP_ONLY');

  assert.equal(summary.erpOnlyCount, 1);
  assert.equal(summary.totalErpUnits, 50);
  assert.equal(summary.totalWmsUnits, 0);
});

test('Reconciliation Case E: SKU only in WMS -> WMS ONLY', () => {
  const erpRows: ErpRowInput[] = [];

  const wmsStock: StockItem[] = [
    {
      id: 'WMS_ONLY_ITEM',
      skuId: 'WMS_ONLY_ITEM',
      skuName: 'WMS Item',
      qty: 30,
      expiredDate: 'No Expired',
      location: 'D1-01',
      status: 'AMAN',
      totalQtySku: 30,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.sku, 'WMS_ONLY_ITEM');
  assert.equal(item.erpQty, 0);
  assert.equal(item.wmsTotalQty, 30);
  assert.equal(item.difference, 30);
  assert.equal(item.status, 'WMS_ONLY');

  assert.equal(summary.wmsOnlyCount, 1);
});

test('Reconciliation Case F: Duplicate SKU in Excel -> VALIDATION WARNING & NEEDS REVIEW', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'DUP01', qty: 40, errors: [] },
    { rawRow: 5, sku: 'DUP01', qty: 60, errors: [] }
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'DUP01_LOC',
      skuId: 'DUP01',
      skuName: 'Duplicate Item',
      qty: 100,
      expiredDate: 'No Expired',
      location: 'A1-01',
      status: 'AMAN',
      totalQtySku: 100,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  // In default strict mode, duplicates must be flagged for review
  const { items, summary, validationWarnings } = reconcileInventory(erpRows, wmsStock, [], [], {
    allowAggregateDuplicateErp: false
  });

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.status, 'NEEDS_REVIEW');
  assert.equal(summary.needsReviewCount, 1);
  assert.ok(validationWarnings.some(w => w.includes('DUP01')));

  // In aggregate mode, duplicates are summed and status can be MATCH
  const aggResult = reconcileInventory(erpRows, wmsStock, [], [], {
    allowAggregateDuplicateErp: true
  });
  assert.equal(aggResult.items[0].status, 'MATCH');
  assert.equal(aggResult.items[0].erpQty, 100);
});

test('Reconciliation Case G: Warehouse mismatch -> NEEDS REVIEW', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'WH_MISMATCH', qty: 25, warehouse: 'WH-SURABAYA', errors: [] }
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'WH_MISMATCH_CENTRAL',
      skuId: 'WH_MISMATCH',
      skuName: 'Item Mismatch',
      qty: 25,
      expiredDate: 'No Expired',
      location: 'A1-01',
      status: 'AMAN',
      warehouseId: 'WH-CENTRAL',
      totalQtySku: 25,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  // Reconciling with specific warehouse WH-CENTRAL when ERP says WH-SURABAYA
  const { items } = reconcileInventory(erpRows, wmsStock, [], [], {
    warehouseId: 'WH-CENTRAL'
  });

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.status, 'NEEDS_REVIEW');
  assert.ok(item.issues.some(i => i.includes('tidak cocok')));
});

test('Reconciliation Case H: Spreadsheet Parsing & Header detection', () => {
  const tableData: unknown[][] = [
    ['Kode Barang', 'Saldo Akhir Pcs', 'Nama Produk', 'Gudang'],
    ['SKU-001', '50', 'Lipstick Red', 'Gudang Pusat'],
    ['SKU-002', 'invalid_qty', 'Eyeshadow', 'Gudang Pusat'],
    ['', '10', 'No Sku', 'Gudang Pusat']
  ];

  const { mapping } = detectColumnMapping(tableData[0]);
  assert.equal(mapping.skuCol, 0);
  assert.equal(mapping.qtyCol, 1);
  assert.equal(mapping.nameCol, 2);
  assert.equal(mapping.warehouseCol, 3);

  const { rows, parsingErrors } = parseErpTable(tableData, mapping);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sku, 'SKU-001');
  assert.equal(rows[0].qty, 50);
  assert.equal(rows[0].errors.length, 0);

  // Row with invalid qty has error
  assert.ok(rows[1].errors.some(e => e.includes('bukan angka valid')));

  // Row with empty SKU has error
  assert.ok(rows[2].errors.some(e => e.includes('SKU kosong')));
});

test('Reconciliation Case I & J: Read-Only guarantee and Reservation separation', () => {
  const originalStock: StockItem[] = [
    {
      id: 'ORIGINAL_STOCK_ROW',
      skuId: 'RESERVE_TEST',
      skuName: 'Reserve Test SKU',
      qty: 100,
      expiredDate: '10/10/2027',
      location: 'A1-05',
      status: 'AMAN',
      totalQtySku: 100,
      qtyCtnSize: 100,
      qtyCtn: 1,
      qtyInnerSize: 10,
      qtyInner: 10,
      qtyLoose: 0
    }
  ];

  const orderHistory: OutboundItem[] = [
    {
      id: 'ORDER_ACTIVE_PENDING',
      referenceNumber: 'ORD-TEST-001',
      expiredDate: '2027-12-31',
      scanned: false,
      skuId: 'RESERVE_TEST',
      skuName: 'Reserve Test SKU',
      qty: 20,
      status: 'Pending', // pending order has locked 20 pcs
      location: 'A1-05',
      timestamp: '2026-11-11 10:00:00'
    }
  ];

  const stockCopy = JSON.parse(JSON.stringify(originalStock));
  const orderCopy = JSON.parse(JSON.stringify(orderHistory));

  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'RESERVE_TEST', qty: 100, errors: [] }
  ];

  const { items } = reconcileInventory(erpRows, originalStock, orderHistory);

  assert.equal(items.length, 1);
  const item = items[0];

  // Physical on-hand stock is 100, which matches ERP 100
  assert.equal(item.wmsTotalQty, 100);
  assert.equal(item.wmsGoodQty, 100);
  assert.equal(item.erpQty, 100);
  assert.equal(item.difference, 0);
  assert.equal(item.status, 'MATCH');

  // Reserved stock is tracked separately: 20 pcs locked, 80 pcs available for picking
  assert.equal(item.wmsLockedQty, 20);
  assert.equal(item.wmsAvailableGoodQty, 80);

  // Assert complete immutability: original stock and orders were not modified
  assert.deepEqual(originalStock, stockCopy);
  assert.deepEqual(orderHistory, orderCopy);
});

test('Reconciliation Case K: Detects Mabang template columns and reads stock from SISA erp', () => {
  const tableData: unknown[][] = [
    ['Inventory SKU Number', 'English Name', 'Available Inventory', 'UNSHIPPED', 'SISA erp'],
    ['2173', '', 0, 0, 0],
    ['SC064-M17', 'SC064-M17 Misty Kiss Lock Color Matte Lipstick M17', 43, 2, 45],
    ['SC064-M18', 'SC064-M18 Misty Kiss Lock Color Matte Lipstick M18', 1, 0, 1],
  ];

  const { mapping, detectedHeaders } = detectColumnMapping(tableData[0]);
  assert.equal(mapping.skuCol, 0);
  assert.equal(mapping.nameCol, 1);
  assert.equal(mapping.qtyCol, 4);
  assert.equal(mapping.warehouseCol, undefined);
  assert.equal(detectedHeaders.sku, 'Inventory SKU Number');
  assert.equal(detectedHeaders.name, 'English Name');
  assert.equal(detectedHeaders.qty, 'SISA erp');

  const { rows, parsingErrors } = parseErpTable(tableData, mapping);
  assert.equal(parsingErrors.length, 0);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sku, '2173');
  assert.equal(rows[0].qty, 0);
  assert.equal(rows[1].sku, 'SC064-M17');
  assert.equal(rows[1].qty, 45);
  assert.equal(rows[2].sku, 'SC064-M18');
  assert.equal(rows[2].qty, 1);

  const wmsStock: StockItem[] = [
    {
      id: 'SC064-M17_LOC',
      skuId: 'SC064-M17',
      skuName: 'SC064-M17 Misty Kiss Lock Color Matte Lipstick M17',
      qty: 40,
      expiredDate: '10/10/2027',
      location: 'A1-01',
      status: 'AMAN',
      totalQtySku: 45,
      qtyCtnSize: 100,
      qtyCtn: 0,
      qtyInnerSize: 10,
      qtyInner: 0,
      qtyLoose: 40,
    },
    {
      id: 'SC064-M17_DMG',
      skuId: 'SC064-M17',
      skuName: 'SC064-M17 Misty Kiss Lock Color Matte Lipstick M17',
      qty: 5,
      expiredDate: 'No Expired',
      location: 'DMG-01',
      status: 'Damage',
      totalQtySku: 45,
      qtyCtnSize: 100,
      qtyCtn: 0,
      qtyInnerSize: 10,
      qtyInner: 0,
      qtyLoose: 5,
    },
  ];

  const { items } = reconcileInventory(rows.slice(1, 2), wmsStock);
  assert.equal(items.length, 1);
  assert.equal(items[0].erpQty, 45);
  assert.equal(items[0].wmsTotalQty, 45);
  assert.equal(items[0].difference, 0);
  assert.equal(items[0].status, 'MATCH');
});

test('Reconciliation Case L: Downloaded Excel template matches 5-column SISA erp layout and parses back cleanly', () => {
  const wb = buildReconcileTemplateWorkbook();
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readBack = XLSX.read(bytes, { type: 'buffer' });
  const sheet = readBack.Sheets[readBack.SheetNames[0]];
  const table = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

  assert.deepEqual(table[0], [...RECONCILE_TEMPLATE_HEADERS]);
  const { mapping } = detectColumnMapping(table[0]);
  assert.equal(mapping.skuCol, 0);
  assert.equal(mapping.nameCol, 1);
  assert.equal(mapping.qtyCol, 4);

  const { rows } = parseErpTable(table, mapping);
  assert.deepEqual(
    rows.map((r) => ({ sku: r.sku, qty: r.qty, errCount: r.errors.length })),
    [
      { sku: 'SC064-M17', qty: 45, errCount: 0 },
      { sku: 'SC064-M18', qty: 1, errCount: 0 },
      { sku: 'SC048-02', qty: 0, errCount: 0 },
    ],
  );
});

test('Reconciliation Case M: ERP SKU with qty 0 and missing in WMS active stock -> MATCH', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: '1007-01', qty: 0, name: '1007-01 Pensil Alis', errors: [] },
    { rawRow: 3, sku: '1007-02', qty: 0, name: '1007-02 Pensil Alis', errors: [] },
    { rawRow: 4, sku: 'SC064-M17', qty: 10, name: 'Lipstick M17', errors: [] },
    { rawRow: 5, sku: 'ERP-MISSING-POS', qty: 5, name: 'Stok Hilang di WMS', errors: [] },
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'SC064-M17_LOC',
      skuId: 'SC064-M17',
      skuName: 'Lipstick M17',
      qty: 10,
      expiredDate: '10/10/2027',
      location: 'A1-01',
      status: 'AMAN',
      totalQtySku: 10,
      qtyCtnSize: 100,
      qtyCtn: 0,
      qtyInnerSize: 10,
      qtyInner: 0,
      qtyLoose: 10,
    },
  ];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  assert.equal(items.length, 4);
  const zeroItem = items.find((it) => it.sku === '1007-01');
  assert.ok(zeroItem);
  assert.equal(zeroItem.status, 'MATCH');
  assert.equal(zeroItem.difference, 0);
  assert.deepEqual(zeroItem.issues, []);

  // Only ERP > 0 missing in WMS remains ERP_ONLY
  const missingPosItem = items.find((it) => it.sku === 'ERP-MISSING-POS');
  assert.ok(missingPosItem);
  assert.equal(missingPosItem.status, 'ERP_ONLY');

  assert.equal(summary.matchedCount, 3);
  assert.equal(summary.erpOnlyCount, 1);
  assert.equal(summary.wmsOnlyCount, 0);
  assert.equal(summary.accuracyRate, 75);
});

test('Reconciliation Case N: Invalid/duplicate 0-qty ERP row stays NEEDS_REVIEW while 0-qty WMS-only record is MATCH', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: 'BAD-QTY', qty: 0, errors: ['Qty bukan angka valid (abc) pada baris 2'] },
  ];

  const wmsStock: StockItem[] = [
    {
      id: 'WMS-ZERO',
      skuId: 'WMS-ZERO',
      skuName: 'WMS Zero Placeholder',
      qty: 0,
      expiredDate: 'No Expired',
      location: 'A1-01',
      status: 'AMAN',
      totalQtySku: 0,
      qtyCtnSize: 100,
      qtyCtn: 0,
      qtyInnerSize: 10,
      qtyInner: 0,
      qtyLoose: 0,
    },
  ];

  const { items, summary } = reconcileInventory(erpRows, wmsStock);

  const badItem = items.find((it) => it.sku === 'BAD-QTY');
  assert.ok(badItem);
  assert.equal(badItem.status, 'NEEDS_REVIEW');

  const wmsZeroItem = items.find((it) => it.sku === 'WMS-ZERO');
  assert.ok(wmsZeroItem);
  assert.equal(wmsZeroItem.status, 'MATCH');

  assert.equal(summary.needsReviewCount, 1);
  assert.equal(summary.wmsOnlyCount, 0);
  assert.equal(summary.matchedCount, 1);
});

test('Reconciliation Case O: Standard CatalogItem { id, skuId, skuName } resolves inCatalog=true and overrides WMS placeholder name', () => {
  const erpRows: ErpRowInput[] = [
    { rawRow: 2, sku: '1007-01', qty: 100, errors: [] },
  ];

  const wmsStock: StockItem[] = [
    {
      id: '1007-01_RAK01',
      skuId: '1007-01',
      skuName: '1007-01 Product',
      qty: 100,
      expiredDate: 'No Expired',
      location: 'RAK-01',
      status: 'AMAN',
      totalQtySku: 100,
      qtyCtnSize: 1000,
      qtyCtn: 0,
      qtyInnerSize: 12,
      qtyInner: 8,
      qtyLoose: 4,
    },
  ];

  const catalog: CatalogItem[] = [
    {
      id: '1007-01',
      skuId: '1007-01',
      skuName: '1007-01 Pensil Alis',
      brand: 'Y.O.U',
      barcode: '899100701',
      qtyCtnSize: 1000,
      qtyInnerSize: 12,
    },
  ];

  const { items } = reconcileInventory(erpRows, wmsStock, [], catalog);
  assert.equal(items.length, 1);
  assert.equal(items[0].inCatalog, true);
  assert.equal(items[0].skuName, '1007-01 Pensil Alis');
  assert.equal(items[0].status, 'MATCH');
});
