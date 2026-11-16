import * as XLSX from 'xlsx';
import type { StockItem, OutboundItem, CatalogItem } from '../types';
import { getStockStatus, getLockedStockSummary } from './calculations';
import { buildCatalogLookupMap, getCatalogItemName, resolvePreferredSkuName } from './catalogSync';

export type ReconciliationStatus = 'MATCH' | 'SELISIH' | 'ERP_ONLY' | 'WMS_ONLY' | 'NEEDS_REVIEW';

export interface ErpRowInput {
  rawRow: number;
  sku: string;
  qty: number;
  name?: string;
  warehouse?: string;
  errors: string[];
}

export interface ColumnMapping {
  skuCol: number;
  qtyCol: number;
  nameCol?: number;
  warehouseCol?: number;
}

export interface ReconciliationItem {
  sku: string;
  skuName: string;
  erpQty: number;
  wmsGoodQty: number;
  wmsDamageQty: number;
  wmsExpiredQty: number;
  wmsQuarantineQty: number;
  wmsOtherQty: number;
  wmsTotalQty: number;
  wmsAvailableGoodQty: number;
  wmsLockedQty: number;
  difference: number; // wmsTotalQty - erpQty
  status: ReconciliationStatus;
  locations: string[];
  erpRawRows: number[];
  issues: string[];
  inCatalog: boolean;
  warehouseScope?: string;
}

export interface ReconciliationSummary {
  totalSkus: number;
  matchedCount: number;
  diffCount: number;
  erpOnlyCount: number;
  wmsOnlyCount: number;
  needsReviewCount: number;
  totalErpUnits: number;
  totalWmsUnits: number;
  totalWmsGoodUnits: number;
  totalWmsDamageUnits: number;
  totalWmsOtherUnits: number;
  totalNetDiff: number; // totalWmsUnits - totalErpUnits
  totalAbsDiff: number; // sum(|difference|)
  accuracyRate: number; // (matchedCount / totalSkus) * 100
}

export interface ReconciliationSession {
  id: string;
  createdAt: string;
  erpSnapshotTime: string;
  fileName: string;
  warehouseId: string;
  summary: ReconciliationSummary;
  items: ReconciliationItem[];
  createdBy?: string;
}

export interface ReconcileOptions {
  warehouseId?: string; // 'ALL' or specific WH ID
  allowAggregateDuplicateErp?: boolean; // if true, sums duplicate SKU rows instead of marking NEEDS_REVIEW
}

export const RECONCILE_TEMPLATE_HEADERS = [
  'Inventory SKU Number',
  'English Name',
  'Available Inventory',
  'UNSHIPPED',
  'SISA erp',
] as const;

export const RECONCILE_TEMPLATE_COL_WIDTHS = [
  { wch: 24 },
  { wch: 44 },
  { wch: 20 },
  { wch: 14 },
  { wch: 16 },
];

/**
 * Builds the 5-column Mabang ERP reconciliation Excel template matching
 * Inventory SKU Number | English Name | Available Inventory | UNSHIPPED | SISA erp.
 */
export function buildReconcileTemplateWorkbook(): XLSX.WorkBook {
  const rows: unknown[][] = [
    [...RECONCILE_TEMPLATE_HEADERS],
    ['SC064-M17', 'SC064-M17 Misty Kiss Lock Color Matte Lipstick M17', 43, 2, { t: 'n', f: 'C2+D2', v: 45 }],
    ['SC064-M18', 'SC064-M18 Misty Kiss Lock Color Matte Lipstick M18', 1, 0, { t: 'n', f: 'C3+D3', v: 1 }],
    ['SC048-02', 'SC048-02 Lip & Cheek Balm', 0, 0, { t: 'n', f: 'C4+D4', v: 0 }],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = RECONCILE_TEMPLATE_COL_WIDTHS.map((c) => ({ ...c }));
  ws['!autofilter'] = { ref: 'A1:E4' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template Mabang ERP');
  return wb;
}

/**
 * Common column header aliases for auto-detecting Mabang ERP spreadsheet columns.
 */
const COLUMN_ALIASES = {
  sku: [
    'inventoryskunumber',
    'inventorysku',
    'skunumber',
    'sku',
    'skuid',
    'kodebarang',
    'itemcode',
    'kodesku',
    'partnumber',
    'nomorsku',
    'productcode',
    'barangkode',
  ],
  qtyPriority: ['sisaerp', 'sisa', 'sisastok', 'sisasaldo', 'stokakhir'],
  qty: [
    'saldoakhirpcs',
    'qty',
    'jumlah',
    'total',
    'stock',
    'stok',
    'totalstok',
    'qtytotal',
    'kuantitas',
    'saldo',
    'saldoakhir',
    'qtyonhand',
    'quantity',
    'availableinventory',
    'available',
  ],
  name: [
    'englishname',
    'itemenglishname',
    'skuname',
    'namabarang',
    'nama',
    'productname',
    'description',
    'deskripsi',
    'itemname',
    'namaproduk',
  ],
  warehouse: ['gudang', 'warehouse', 'wh', 'lokasi', 'depot', 'namagudang', 'kodegudang'],
};

/**
 * Automatically inspects the first row of table data to suggest column mapping.
 */
export function detectColumnMapping(headers: unknown[]): {
  mapping: ColumnMapping;
  detectedHeaders: { sku?: string; qty?: string; name?: string; warehouse?: string };
} {
  const normHeaders = headers.map(h => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''));

  const findIndex = (aliases: string[]): number => {
    for (const alias of aliases) {
      const idx = normHeaders.indexOf(alias);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const skuCol = findIndex(COLUMN_ALIASES.sku);
  const priorityQtyCol = findIndex(COLUMN_ALIASES.qtyPriority);
  const fallbackQtyCol = findIndex(COLUMN_ALIASES.qty);
  const qtyCol = priorityQtyCol >= 0 ? priorityQtyCol : fallbackQtyCol;
  const nameCol = findIndex(COLUMN_ALIASES.name);
  const warehouseCol = findIndex(COLUMN_ALIASES.warehouse);

  return {
    mapping: {
      skuCol: skuCol >= 0 ? skuCol : 0,
      qtyCol: qtyCol >= 0 ? qtyCol : 1,
      nameCol: nameCol >= 0 ? nameCol : undefined,
      warehouseCol: warehouseCol >= 0 ? warehouseCol : undefined
    },
    detectedHeaders: {
      sku: skuCol >= 0 ? String(headers[skuCol]) : undefined,
      qty: qtyCol >= 0 ? String(headers[qtyCol]) : undefined,
      name: nameCol >= 0 ? String(headers[nameCol]) : undefined,
      warehouse: warehouseCol >= 0 ? String(headers[warehouseCol]) : undefined
    }
  };
}

/**
 * Parses raw table data from Excel/CSV and validates each line.
 * Read-only operation that does not modify inventory.
 */
export function parseErpTable(
  table: unknown[][],
  mapping: ColumnMapping
): { rows: ErpRowInput[]; parsingErrors: string[]; warnings: string[] } {
  const parsingErrors: string[] = [];
  const warnings: string[] = [];

  if (!table || table.length < 2) {
    parsingErrors.push('File spreadsheet harus memiliki header kolom dan minimal satu baris data.');
    return { rows: [], parsingErrors, warnings };
  }

  const { skuCol, qtyCol, nameCol, warehouseCol } = mapping;
  const rows: ErpRowInput[] = [];

  table.slice(1).forEach((cells, idx) => {
    // Skip completely empty rows
    if (!cells || cells.every(c => c == null || String(c).trim() === '')) {
      return;
    }

    const rowNum = idx + 2; // 1-based index including header
    const rawSku = String(cells[skuCol] ?? '').trim();
    const rawQty = cells[qtyCol];
    const rawName = nameCol != null ? String(cells[nameCol] ?? '').trim() : undefined;
    const rawWh = warehouseCol != null ? String(cells[warehouseCol] ?? '').trim() : undefined;

    const rowErrors: string[] = [];

    if (!rawSku) {
      rowErrors.push('SKU kosong pada baris ' + rowNum);
    } else if (rawSku.length > 128) {
      rowErrors.push(`SKU melebihi 128 karakter pada baris ${rowNum}`);
    }

    // Numerical validation for Qty
    let parsedQty = 0;
    if (rawQty == null || String(rawQty).trim() === '') {
      rowErrors.push(`Qty kosong pada baris ${rowNum}`);
    } else {
      const cleanQtyStr = String(rawQty).replace(/,/g, '').trim();
      const num = Number(cleanQtyStr);
      if (isNaN(num)) {
        rowErrors.push(`Qty bukan angka valid (${rawQty}) pada baris ${rowNum}`);
      } else if (!Number.isFinite(num)) {
        rowErrors.push(`Qty tidak berhingga pada baris ${rowNum}`);
      } else if (num < 0) {
        rowErrors.push(`Qty bernilai negatif (${num}) pada baris ${rowNum}`);
      } else {
        parsedQty = Math.floor(num); // Standard unit count (pcs)
      }
    }

    rows.push({
      rawRow: rowNum,
      sku: rawSku.toUpperCase(),
      qty: parsedQty,
      name: rawName,
      warehouse: rawWh,
      errors: rowErrors
    });
  });

  if (rows.length === 0 && parsingErrors.length === 0) {
    parsingErrors.push('Tidak ada baris data yang berhasil dibaca dari file.');
  }

  return { rows, parsingErrors, warnings };
}

/**
 * Core Reconciliation Engine:
 * Compares Mabang ERP data against TrueBlue WMS Good and Damage physical stock.
 * Fully read-only, non-destructive, and guarantees zero side effects on physical inventory.
 */
export function reconcileInventory(
  erpRows: ErpRowInput[],
  wmsStock: StockItem[],
  orderHistory: OutboundItem[] = [],
  catalog: CatalogItem[] = [],
  options: ReconcileOptions = {}
): {
  items: ReconciliationItem[];
  summary: ReconciliationSummary;
  validationWarnings: string[];
} {
  const validationWarnings: string[] = [];
  const selectedWh = options.warehouseId || 'ALL';
  const allowAggregateDuplicateErp = Boolean(options.allowAggregateDuplicateErp);

  // 1. Build Master Catalog lookup (supports skuId/skuName as well as legacy sku/name)
  const catalogMap = buildCatalogLookupMap(catalog);

  // 2. Build Locked / Reserved stock lookup from active outbound orders
  const lockedStockSummary = getLockedStockSummary(orderHistory);

  // 3. Aggregate WMS Stock by clean SKU
  interface WmsSkuAggregate {
    sku: string;
    skuName: string;
    goodQty: number;
    damageQty: number;
    expiredQty: number;
    quarantineQty: number;
    otherQty: number;
    locations: Set<string>;
    warehouses: Set<string>;
  }

  const wmsAggregateMap = new Map<string, WmsSkuAggregate>();

  wmsStock.forEach(item => {
    const cleanSku = (item.skuId || '').trim().toUpperCase();
    if (!cleanSku) return;

    const itemWh = item.warehouseId || 'WH-CENTRAL';
    // If a specific warehouse filter is selected, skip rows from other warehouses
    if (selectedWh !== 'ALL' && itemWh !== selectedWh) {
      return;
    }

    const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
    const status = getStockStatus(item);

    let agg = wmsAggregateMap.get(cleanSku);
    if (!agg) {
      const catName = getCatalogItemName(catalogMap.get(cleanSku));
      agg = {
        sku: cleanSku,
        skuName: (item.skuName?.trim() || catName)
          ? resolvePreferredSkuName(cleanSku, item.skuName, catName)
          : cleanSku,
        goodQty: 0,
        damageQty: 0,
        expiredQty: 0,
        quarantineQty: 0,
        otherQty: 0,
        locations: new Set<string>(),
        warehouses: new Set<string>()
      };
      wmsAggregateMap.set(cleanSku, agg);
    }

    if (item.location) agg.locations.add(item.location.trim().toUpperCase());
    if (itemWh) agg.warehouses.add(itemWh);

    const lowerStatus = (status || '').toLowerCase().trim();

    if (lowerStatus === 'damage' || lowerStatus === 'rusak') {
      agg.damageQty += qty;
    } else if (lowerStatus === 'expired' || lowerStatus === 'kedaluwarsa') {
      agg.expiredQty += qty;
    } else if (lowerStatus.includes('karantina') || lowerStatus.includes('hold') || lowerStatus.includes('quarantine')) {
      agg.quarantineQty += qty;
    } else {
      // Standard saleable / good physical stock (AMAN, Under 24M, Under 18M, Under 6M, Under 3M, Near ED, Good)
      agg.goodQty += qty;
    }
  });

  // 4. Group ERP Rows by SKU and detect duplicates
  interface ErpSkuGroup {
    sku: string;
    name?: string;
    totalQty: number;
    rawRows: number[];
    warehouses: Set<string>;
    rowErrors: string[];
    isDuplicate: boolean;
  }

  const erpGroupMap = new Map<string, ErpSkuGroup>();

  erpRows.forEach(row => {
    if (!row.sku) return;
    const cleanSku = row.sku.trim().toUpperCase();

    let grp = erpGroupMap.get(cleanSku);
    if (!grp) {
      grp = {
        sku: cleanSku,
        name: row.name,
        totalQty: 0,
        rawRows: [],
        warehouses: new Set<string>(),
        rowErrors: [],
        isDuplicate: false
      };
      erpGroupMap.set(cleanSku, grp);
    } else {
      grp.isDuplicate = true;
    }

    grp.totalQty += row.qty;
    grp.rawRows.push(row.rawRow);
    if (row.warehouse) grp.warehouses.add(row.warehouse.trim().toUpperCase());
    if (row.name && !grp.name) grp.name = row.name;
    if (row.errors.length > 0) grp.rowErrors.push(...row.errors);
  });

  // Check for duplicates in ERP rows
  erpGroupMap.forEach(grp => {
    if (grp.isDuplicate) {
      const msg = `SKU ${grp.sku} memiliki ${grp.rawRows.length} baris di file Excel (Baris: ${grp.rawRows.join(', ')}).`;
      if (!allowAggregateDuplicateErp) {
        validationWarnings.push(msg + ' Ditandai sebagai NEEDS REVIEW.');
      } else {
        validationWarnings.push(msg + ' Kuantitas otomatis digabungkan sesuai pengaturan.');
      }
    }
  });

  // 5. Build Union of all SKUs
  const allSkus = new Set<string>([
    ...Array.from(erpGroupMap.keys()),
    ...Array.from(wmsAggregateMap.keys())
  ]);

  const items: ReconciliationItem[] = [];

  allSkus.forEach(sku => {
    const erp = erpGroupMap.get(sku);
    const wms = wmsAggregateMap.get(sku);
    const cat = catalogMap.get(sku);

    const issues: string[] = [];

    const erpQty = erp ? erp.totalQty : 0;
    const wmsGoodQty = wms ? wms.goodQty : 0;
    const wmsDamageQty = wms ? wms.damageQty : 0;
    const wmsExpiredQty = wms ? wms.expiredQty : 0;
    const wmsQuarantineQty = wms ? wms.quarantineQty : 0;
    const wmsOtherQty = wms ? wms.otherQty : 0;

    // Physical on-hand stock includes Good, Damage, Expired, and Quarantine
    const wmsTotalQty = wmsGoodQty + wmsDamageQty + wmsExpiredQty + wmsQuarantineQty + wmsOtherQty;

    // Allocated / locked stock by pending active orders
    const wmsLockedQty = lockedStockSummary.bySku.get(sku) || 0;
    const wmsAvailableGoodQty = Math.max(0, wmsGoodQty - wmsLockedQty);

    const difference = wmsTotalQty - erpQty;

    const catName = getCatalogItemName(cat);
    const hasAnyName = Boolean(wms?.skuName?.trim() || erp?.name?.trim() || catName);
    const skuName = hasAnyName
      ? resolvePreferredSkuName(sku, catName, erp?.name, wms?.skuName)
      : sku;
    const locations = wms ? Array.from(wms.locations) : [];
    const erpRawRows = erp ? erp.rawRows : [];

    if (erp && erp.rowErrors.length > 0) {
      issues.push(...erp.rowErrors);
    }

    if (erp && erp.isDuplicate) {
      if (!allowAggregateDuplicateErp) {
        issues.push(`SKU duplikat di baris Excel (${erp.rawRows.join(', ')})`);
      } else {
        issues.push(`Qty gabungan dari ${erp.rawRows.length} baris Excel`);
      }
    }

    // Warehouse mismatch check
    if (selectedWh !== 'ALL' && erp && erp.warehouses.size > 0) {
      const matchWh = Array.from(erp.warehouses).some(wh => wh === selectedWh || wh.includes(selectedWh));
      if (!matchWh) {
        issues.push(`Gudang ERP (${Array.from(erp.warehouses).join(', ')}) tidak cocok dengan filter WMS (${selectedWh})`);
      }
    }

    // Determine Status
    let status: ReconciliationStatus;
    const hasCriticalRowError = Boolean(erp && erp.rowErrors.length > 0);
    const hasMismatchIssue = issues.some(
      i => i.toLowerCase().includes('tidak cocok') || i.toLowerCase().includes('bukan angka')
    );

    if (erp && erp.isDuplicate && !allowAggregateDuplicateErp) {
      status = 'NEEDS_REVIEW';
      if (!wms && erpQty > 0) {
        issues.push('Tidak ditemukan dalam stok fisik TrueBlue WMS');
      }
    } else if (hasCriticalRowError || hasMismatchIssue) {
      status = 'NEEDS_REVIEW';
      if (!wms && erp && erpQty > 0) {
        issues.push('Tidak ditemukan dalam stok fisik TrueBlue WMS');
      }
    } else if (!wms && erp) {
      if (erpQty === 0) {
        // ERP stock is 0 and SKU has no active physical stock in TrueBlue WMS (0 = 0)
        status = 'MATCH';
      } else {
        // In ERP file with stock > 0, but not found in TrueBlue WMS
        status = 'ERP_ONLY';
        issues.push('Tidak ditemukan dalam stok fisik TrueBlue WMS');
      }
    } else if (wms && !erp) {
      if (wmsTotalQty === 0) {
        // WMS only holds a 0-qty record and SKU is absent from ERP (0 = 0)
        status = 'MATCH';
      } else {
        // In TrueBlue WMS with stock > 0, but not found in ERP file
        status = 'WMS_ONLY';
        issues.push('Tidak tercantum dalam file Mabang ERP');
      }
    } else if (difference === 0) {
      status = 'MATCH';
    } else {
      status = 'SELISIH';
    }

    items.push({
      sku,
      skuName,
      erpQty,
      wmsGoodQty,
      wmsDamageQty,
      wmsExpiredQty,
      wmsQuarantineQty,
      wmsOtherQty,
      wmsTotalQty,
      wmsAvailableGoodQty,
      wmsLockedQty,
      difference,
      status,
      locations,
      erpRawRows,
      issues,
      inCatalog: !!cat,
      warehouseScope: selectedWh
    });
  });

  // Sort items: SELISIH & NEEDS_REVIEW first, then ERP_ONLY, WMS_ONLY, then MATCH
  const statusPriority: Record<ReconciliationStatus, number> = {
    SELISIH: 1,
    NEEDS_REVIEW: 2,
    ERP_ONLY: 3,
    WMS_ONLY: 4,
    MATCH: 5
  };

  items.sort((a, b) => {
    const prioDiff = statusPriority[a.status] - statusPriority[b.status];
    if (prioDiff !== 0) return prioDiff;
    return Math.abs(b.difference) - Math.abs(a.difference) || a.sku.localeCompare(b.sku);
  });

  // 6. Compute Executive Summary Metrics
  let matchedCount = 0;
  let diffCount = 0;
  let erpOnlyCount = 0;
  let wmsOnlyCount = 0;
  let needsReviewCount = 0;

  let totalErpUnits = 0;
  let totalWmsUnits = 0;
  let totalWmsGoodUnits = 0;
  let totalWmsDamageUnits = 0;
  let totalWmsOtherUnits = 0;
  let totalAbsDiff = 0;

  items.forEach(it => {
    if (it.status === 'MATCH') matchedCount++;
    else if (it.status === 'SELISIH') diffCount++;
    else if (it.status === 'ERP_ONLY') erpOnlyCount++;
    else if (it.status === 'WMS_ONLY') wmsOnlyCount++;
    else if (it.status === 'NEEDS_REVIEW') needsReviewCount++;

    totalErpUnits += it.erpQty;
    totalWmsUnits += it.wmsTotalQty;
    totalWmsGoodUnits += it.wmsGoodQty;
    totalWmsDamageUnits += it.wmsDamageQty;
    totalWmsOtherUnits += it.wmsExpiredQty + it.wmsQuarantineQty + it.wmsOtherQty;
    totalAbsDiff += Math.abs(it.difference);
  });

  const totalSkus = items.length;
  const accuracyRate = totalSkus > 0 ? Number(((matchedCount / totalSkus) * 100).toFixed(2)) : 0;
  const totalNetDiff = totalWmsUnits - totalErpUnits;

  const summary: ReconciliationSummary = {
    totalSkus,
    matchedCount,
    diffCount,
    erpOnlyCount,
    wmsOnlyCount,
    needsReviewCount,
    totalErpUnits,
    totalWmsUnits,
    totalWmsGoodUnits,
    totalWmsDamageUnits,
    totalWmsOtherUnits,
    totalNetDiff,
    totalAbsDiff,
    accuracyRate
  };

  return { items, summary, validationWarnings };
}

/**
 * Generates an Excel workbook (.xlsx) containing executive summary, full SKU comparison, and differences.
 */
export function exportReconciliationToExcel(
  session: ReconciliationSession,
  branchId: string
): void {
  const { summary, items, erpSnapshotTime, fileName, warehouseId, createdAt } = session;

  // Sheet 1: Executive KPI Summary
  const summaryAoa: unknown[][] = [
    ['TRUEBLUE WMS — LAPORAN REKONSILIASI STOK (ERP VS WMS)'],
    ['Waktu Laporan:', createdAt],
    ['Cabang Operasional:', branchId],
    ['Cakupan Gudang:', warehouseId === 'ALL' ? 'Semua Gudang' : warehouseId],
    ['File Sumber Mabang ERP:', fileName],
    ['Waktu Snapshot ERP:', erpSnapshotTime || 'Tidak tercatat'],
    ['Sifat Dokumen:', 'READ-ONLY (Tidak mengubah saldo persediaan fisik)'],
    [''],
    ['RINGKASAN EKSEKUTIF METRIK REKONSILIASI'],
    ['Total SKU Diperiksa:', summary.totalSkus],
    ['SKU Cocok (MATCH):', summary.matchedCount],
    ['SKU Berselisih (SELISIH):', summary.diffCount],
    ['SKU Hanya di ERP (ERP ONLY):', summary.erpOnlyCount],
    ['SKU Hanya di WMS (WMS ONLY):', summary.wmsOnlyCount],
    ['SKU Perlu Review (NEEDS REVIEW):', summary.needsReviewCount],
    ['Tingkat Akurasi SKU (%):', `${summary.accuracyRate}%`],
    [''],
    ['TOTAL UNIT FISIK'],
    ['Total Unit Mabang ERP:', summary.totalErpUnits],
    ['Total Unit TrueBlue WMS:', summary.totalWmsUnits],
    ['Total WMS Good (Layak):', summary.totalWmsGoodUnits],
    ['Total WMS Damage (Rusak):', summary.totalWmsDamageUnits],
    ['Total WMS Lainnya (Expired/Karantina):', summary.totalWmsOtherUnits],
    ['Total Selisih Net (WMS - ERP):', summary.totalNetDiff],
    ['Total Selisih Absolut:', summary.totalAbsDiff],
  ];

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoa);
  wsSummary['!cols'] = [{ wch: 36 }, { wch: 45 }];

  // Sheet 2: Full Table of All SKUs
  const fullRows = items.map((it, idx) => ({
    'No': idx + 1,
    'SKU ID': it.sku,
    'Nama Barang': it.skuName,
    'ERP QTY (Total)': it.erpQty,
    'WMS GOOD (Layak)': it.wmsGoodQty,
    'WMS DAMAGE (Rusak)': it.wmsDamageQty,
    'WMS LAINNYA (ED/QC)': it.wmsExpiredQty + it.wmsQuarantineQty + it.wmsOtherQty,
    'WMS TOTAL FISIK': it.wmsTotalQty,
    'SELISIH (WMS - ERP)': it.difference > 0 ? `+${it.difference}` : it.difference,
    'STATUS': it.status,
    'WMS Tersedia (Picking)': it.wmsAvailableGoodQty,
    'WMS Terkunci (Order)': it.wmsLockedQty,
    'Lokasi Rak WMS': it.locations.join(', ') || '-',
    'Baris Excel ERP': it.erpRawRows.join(', ') || '-',
    'Catatan / Catatan Issue':
      it.issues.join(' | ') ||
      (it.erpQty === 0 && it.wmsTotalQty === 0 ? 'Stok sama-sama 0 (tidak ada fisik di WMS)' : '-')
  }));

  const wsFull = XLSX.utils.json_to_sheet(fullRows);
  wsFull['!cols'] = [
    { wch: 6 },
    { wch: 18 },
    { wch: 36 },
    { wch: 16 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 },
    { wch: 18 },
    { wch: 20 },
    { wch: 16 },
    { wch: 20 },
    { wch: 18 },
    { wch: 24 },
    { wch: 18 },
    { wch: 40 }
  ];

  // Sheet 3: Discrepancy & Anomalies Only
  const anomalyRows = items
    .filter(it => it.status !== 'MATCH')
    .map((it, idx) => ({
      'No': idx + 1,
      'SKU ID': it.sku,
      'Nama Barang': it.skuName,
      'ERP QTY': it.erpQty,
      'WMS TOTAL FISIK': it.wmsTotalQty,
      'WMS GOOD': it.wmsGoodQty,
      'WMS DAMAGE': it.wmsDamageQty,
      'SELISIH': it.difference > 0 ? `+${it.difference}` : it.difference,
      'STATUS': it.status,
      'Lokasi Rak WMS': it.locations.join(', ') || '-',
      'Penyebab / Keterangan': it.issues.join(' | ') || (it.difference !== 0 ? `Selisih fisik ${it.difference > 0 ? '+' : ''}${it.difference} pcs` : '-')
    }));

  const wsAnomaly = XLSX.utils.json_to_sheet(anomalyRows.length > 0 ? anomalyRows : [{ 'Info': 'Tidak ada selisih. Seluruh SKU 100% MATCH.' }]);
  wsAnomaly['!cols'] = [
    { wch: 6 },
    { wch: 18 },
    { wch: 36 },
    { wch: 14 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 24 },
    { wch: 45 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, 'RINGKASAN');
  XLSX.utils.book_append_sheet(wb, wsFull, 'REKONSILIASI_LENGKAP');
  XLSX.utils.book_append_sheet(wb, wsAnomaly, 'ANOMALI_DAN_SELISIH');

  const cleanDateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `Rekonsiliasi_Mabang_vs_WMS_${branchId}_${cleanDateStr}.xlsx`);
}
