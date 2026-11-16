import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlaceholderSkuName,
  resolvePreferredSkuName,
  extractCatalogRowsFromAoA,
  parseCatalogSheetRows,
  planCatalogStockBidirectionalSync,
  planCrossBranchCatalogMerge,
} from './catalogSync';
import type { CatalogItem, StockItem } from '../types';

const stubPackSizes = (skuId: string) =>
  skuId.toUpperCase() === '1007-01'
    ? { qtyCtnSize: 1000, qtyInnerSize: 12 }
    : { qtyCtnSize: 144, qtyInnerSize: 12 };

const stubBrand = (_skuId?: string, _skuName?: string, explicitBrand?: string) =>
  explicitBrand && explicitBrand !== '-' ? explicitBrand.toUpperCase() : 'Y.O.U';

const stubBarcode = (skuId: string, explicitBarcode?: string) =>
  explicitBarcode && explicitBarcode !== '-' ? explicitBarcode : `BC-${skuId}`;

test('isPlaceholderSkuName & resolvePreferredSkuName prioritize real product names over defaults', () => {
  assert.equal(isPlaceholderSkuName('1007-01', ''), true);
  assert.equal(isPlaceholderSkuName('1007-01', '-'), true);
  assert.equal(isPlaceholderSkuName('1007-01', 'N/A'), true);
  assert.equal(isPlaceholderSkuName('1007-01', 'Produk Baru'), true);
  assert.equal(isPlaceholderSkuName('1007-01', 'Unknown Item'), true);
  assert.equal(isPlaceholderSkuName('1007-01', '1007-01'), true);
  assert.equal(isPlaceholderSkuName('1007-01', '1007-01 Product'), true);
  assert.equal(isPlaceholderSkuName('1007-01', 'Product 1007-01'), true);
  assert.equal(isPlaceholderSkuName('1007-01', 'Product'), true);
  assert.equal(isPlaceholderSkuName('1007-01', '1007-01 Pensil Alis'), false);

  // Real name wins regardless of argument order
  assert.equal(
    resolvePreferredSkuName('1007-01', '1007-01 Product', '1007-01 Pensil Alis'),
    '1007-01 Pensil Alis'
  );
  assert.equal(
    resolvePreferredSkuName('1007-01', '1007-01 Pensil Alis', '1007-01 Product'),
    '1007-01 Pensil Alis'
  );
  // Empty candidates fallback safely to <SKU> Product
  assert.equal(resolvePreferredSkuName('1007-01', '', undefined), '1007-01 Product');
});

test('extractCatalogRowsFromAoA & parseCatalogSheetRows handle Mabang ERP exports, title rows, headerless paste & pack-size preservation', () => {
  const existingCatalog: CatalogItem[] = [
    {
      id: '1007-01',
      skuId: '1007-01',
      skuName: '1007-01 Product',
      brand: 'BRAND-LAMA',
      barcode: '899100701',
      qtyCtnSize: 1000,
      qtyInnerSize: 12,
    },
  ];

  // Workbook with leading report title row + Mabang ERP column names (no CTN/Inner columns) + duplicate SKU row
  const mabangAoA = [
    ['Export Data Produk Mabang ERP', '', ''],
    ['Generated 2026-11-15', '', ''],
    ['Inventory SKU Number', 'English Name', 'Warehouse Stock'],
    ['1007-01', '1007-01 Pensil Alis Lama', 50],
    ['1007-01', '1007-01 Pensil Alis', 100],
    ['1009-01', '1009-01 Plum Tube Lipgloss', 25],
    ['', 'Tanpa SKU', 10],
  ];

  const rows = extractCatalogRowsFromAoA(mabangAoA);
  const parsed = parseCatalogSheetRows(
    rows,
    existingCatalog,
    stubPackSizes,
    stubBrand,
    stubBarcode
  );

  // Deduplicated 1007-01 (latest wins) + 1009-01 + invalid empty SKU row
  assert.equal(parsed.length, 3);

  const row1007 = parsed.find(r => r.skuId === '1007-01');
  assert.ok(row1007);
  assert.equal(row1007.status, 'UPDATE');
  assert.equal(row1007.skuName, '1007-01 Pensil Alis');
  // Existing Qty CTN=1000, Qty Inner=12, Brand & Barcode preserved when omitted from ERP export
  assert.equal(row1007.qtyCtnSize, 1000);
  assert.equal(row1007.qtyInnerSize, 12);
  assert.equal(row1007.brand, 'BRAND-LAMA');
  assert.equal(row1007.barcode, '899100701');

  const row1009 = parsed.find(r => r.skuId === '1009-01');
  assert.ok(row1009);
  assert.equal(row1009.status, 'NEW');
  assert.equal(row1009.skuName, '1009-01 Plum Tube Lipgloss');

  const invalidRow = parsed.find(r => r.status === 'INVALID');
  assert.ok(invalidRow);
  assert.equal(invalidRow.errorReason, 'SKU ID Kosong');

  // Headerless TSV/2-column fallback preserves existing Qty CTN=1000 instead of falling back to 144
  const headerlessRows = extractCatalogRowsFromAoA([
    ['1007-01', '1007-01 Pensil Alis Coklat'],
    ['NEW-SKU', 'New Matte Lipstick', 'BRANDX', '123456', '720', '24'],
  ]);
  const parsedHeaderless = parseCatalogSheetRows(
    headerlessRows,
    existingCatalog,
    stubPackSizes,
    stubBrand,
    stubBarcode
  );
  assert.equal(parsedHeaderless[0].qtyCtnSize, 1000);
  assert.equal(parsedHeaderless[0].qtyInnerSize, 12);
  assert.equal(parsedHeaderless[1].qtyCtnSize, 720);
  assert.equal(parsedHeaderless[1].qtyInnerSize, 24);
});

test('planCatalogStockBidirectionalSync syncs missing catalog SKUs, upgrades placeholders & aligns stock rows', () => {
  const catalog: CatalogItem[] = [
    // Placeholder in catalog while stock already knows the real name -> catalog should upgrade
    {
      id: 'SKU-A',
      skuId: 'SKU-A',
      skuName: 'SKU-A Product',
      brand: 'BRAND-A',
      barcode: 'BC-A',
      qtyCtnSize: 144,
      qtyInnerSize: 12,
    },
    // Real name in catalog while stock is stuck on placeholder -> stock should update
    {
      id: 'SKU-B',
      skuId: 'SKU-B',
      skuName: 'SKU-B Eyeliner Waterproof',
      brand: 'BRAND-B',
      barcode: 'BC-B',
      qtyCtnSize: 720,
      qtyInnerSize: 12,
    },
    // Custom real name in catalog, different real name in stock -> catalog remains master & aligns stock
    {
      id: 'SKU-CUSTOM',
      skuId: 'SKU-CUSTOM',
      skuName: 'Nama Master Katalog Resmi',
      brand: 'BRAND-C',
      barcode: 'BC-C',
      qtyCtnSize: 144,
      qtyInnerSize: 12,
    },
  ];

  const stock: StockItem[] = [
    {
      id: 'SKU-A_R1',
      skuId: 'SKU-A',
      skuName: 'SKU-A Lip Cream',
      qty: 150,
      expiredDate: '10/10/2027',
      location: 'R1-01',
      status: 'AMAN',
      totalQtySku: 150,
      qtyCtnSize: 144,
      qtyCtn: 1,
      qtyInnerSize: 12,
      qtyInner: 0,
      qtyLoose: 6,
    },
    {
      id: 'SKU-B_R2',
      skuId: 'SKU-B',
      skuName: 'SKU-B Product',
      qty: 732,
      expiredDate: '10/10/2027',
      location: 'R2-01',
      status: 'AMAN',
      totalQtySku: 732,
      qtyCtnSize: 144, // outdated pack size too
      qtyCtn: 5,
      qtyInnerSize: 12,
      qtyInner: 1,
      qtyLoose: 0,
    },
    {
      id: 'SKU-CUSTOM_R3',
      skuId: 'SKU-CUSTOM',
      skuName: 'Nama Lama Di Stok',
      qty: 10,
      expiredDate: '10/10/2027',
      location: 'R3-01',
      status: 'AMAN',
      totalQtySku: 10,
      qtyCtnSize: 144,
      qtyCtn: 0,
      qtyInnerSize: 12,
      qtyInner: 0,
      qtyLoose: 10,
    },
    {
      id: 'SKU-NEW_R4',
      skuId: 'SKU-NEW',
      skuName: 'SKU-NEW Setting Spray',
      qty: 50,
      expiredDate: '10/10/2027',
      location: 'R4-01',
      status: 'AMAN',
      totalQtySku: 50,
      qtyCtnSize: 144,
      qtyCtn: 0,
      qtyInnerSize: 12,
      qtyInner: 4,
      qtyLoose: 2,
    },
  ];

  const plan = planCatalogStockBidirectionalSync(
    catalog,
    stock,
    stubPackSizes,
    stubBrand,
    stubBarcode
  );

  assert.equal(plan.addedCatalogCount, 1);
  assert.equal(plan.updatedCatalogCount, 1);

  const upgradedA = plan.mergedCatalog.find(c => c.skuId === 'SKU-A');
  assert.equal(upgradedA?.skuName, 'SKU-A Lip Cream');

  const preservedCustom = plan.mergedCatalog.find(c => c.skuId === 'SKU-CUSTOM');
  assert.equal(preservedCustom?.skuName, 'Nama Master Katalog Resmi');

  const addedNew = plan.mergedCatalog.find(c => c.skuId === 'SKU-NEW');
  assert.equal(addedNew?.skuName, 'SKU-NEW Setting Spray');

  const updatedStockB = plan.stockUpdates.find(s => s.id === 'SKU-B_R2');
  assert.ok(updatedStockB);
  assert.equal(updatedStockB.skuName, 'SKU-B Eyeliner Waterproof');
  assert.equal(updatedStockB.qtyCtnSize, 720);
  assert.equal(updatedStockB.qtyCtn, 1);
  assert.equal(updatedStockB.qtyInner, 1);

  const updatedStockCustom = plan.stockUpdates.find(s => s.id === 'SKU-CUSTOM_R3');
  assert.equal(updatedStockCustom?.skuName, 'Nama Master Katalog Resmi');
});

test('planCrossBranchCatalogMerge fills placeholders safely while preserving target pack sizes', () => {
  const jktTargetCatalog: CatalogItem[] = [
    {
      id: '1007-01',
      skuId: '1007-01',
      skuName: '1007-01 Product',
      brand: 'BRAND-JKT',
      barcode: 'BC-JKT-01',
      qtyCtnSize: 1000,
      qtyInnerSize: 12,
    },
    {
      id: '1007-02',
      skuId: '1007-02',
      skuName: 'Nama Khusus Cabang JKT',
      brand: 'BRAND-JKT',
      barcode: 'BC-JKT-02',
      qtyCtnSize: 720,
      qtyInnerSize: 12,
    },
    {
      id: '1007-03',
      skuId: '1007-03',
      skuName: '1007-03 Product',
      brand: 'BRAND-JKT',
      barcode: '-',
      qtyCtnSize: 576,
      qtyInnerSize: 12,
    },
  ];

  const centerSourceCatalog: CatalogItem[] = [
    {
      id: '1007-01',
      skuId: '1007-01',
      skuName: '1007-01 Pensil Alis',
      brand: 'Y.O.U',
      barcode: 'BC-CENTER-01',
      qtyCtnSize: 144,
      qtyInnerSize: 12,
    },
    {
      id: '1007-02',
      skuId: '1007-02',
      skuName: '1007-02 Pensil Alis Coklat',
      brand: 'Y.O.U',
      barcode: 'BC-CENTER-02',
      qtyCtnSize: 144,
      qtyInnerSize: 12,
    },
    // Source itself is a placeholder -> must be skipped
    {
      id: '1007-03',
      skuId: '1007-03',
      skuName: '1007-03 Product',
      brand: 'Y.O.U',
      barcode: '-',
      qtyCtnSize: 144,
      qtyInnerSize: 12,
    },
    // Exists in CENTER only
    {
      id: '1009-01',
      skuId: '1009-01',
      skuName: '1009-01 Plum Tube Lipgloss',
      brand: 'Y.O.U',
      barcode: 'BC-CENTER-09',
      qtyCtnSize: 720,
      qtyInnerSize: 12,
    },
  ];

  // Safe fill_placeholders mode without adding new SKUs
  const safePlan = planCrossBranchCatalogMerge(
    jktTargetCatalog,
    centerSourceCatalog,
    { mode: 'fill_placeholders', includeNewSkus: false },
    stubPackSizes,
    stubBrand,
    stubBarcode
  );

  assert.equal(safePlan.skippedPlaceholderSourceCount, 1);
  assert.equal(safePlan.itemsToImport.length, 1);
  assert.equal(safePlan.itemsToImport[0].skuId, '1007-01');
  assert.equal(safePlan.itemsToImport[0].skuName, '1007-01 Pensil Alis');
  // Must keep JKT's existing pack size, brand & barcode
  assert.equal(safePlan.itemsToImport[0].qtyCtnSize, 1000);
  assert.equal(safePlan.itemsToImport[0].qtyInnerSize, 12);
  assert.equal(safePlan.itemsToImport[0].brand, 'BRAND-JKT');
  assert.equal(safePlan.itemsToImport[0].barcode, 'BC-JKT-01');
  assert.equal(safePlan.previewRows[0].action, 'UPDATE_PLACEHOLDER');

  // overwrite_all + includeNewSkus should update 1007-01, overwrite 1007-02, and add 1009-01
  const fullPlan = planCrossBranchCatalogMerge(
    jktTargetCatalog,
    centerSourceCatalog,
    { mode: 'overwrite_all', includeNewSkus: true },
    stubPackSizes,
    stubBrand,
    stubBarcode
  );
  assert.equal(fullPlan.itemsToImport.length, 3);
  assert.equal(fullPlan.previewRows.find(r => r.skuId === '1007-02')?.action, 'OVERWRITE');
  assert.equal(fullPlan.previewRows.find(r => r.skuId === '1009-01')?.action, 'NEW');
});
