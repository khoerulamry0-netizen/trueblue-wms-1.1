import type { CatalogItem, StockItem } from '../types';
import { calculatePackQuantities } from './calculations';

const GENERIC_PLACEHOLDER_NAMES = new Set([
  '-',
  '--',
  'n/a',
  'na',
  'produk baru',
  'unknown',
  'unknown item',
  'item belum terdeteksi',
  'sku belum terdaftar di katalog',
]);

export function normalizeSkuKey(skuId?: string | null): string {
  return String(skuId ?? '').trim().toUpperCase();
}

export function isPlaceholderSkuName(skuId?: string | null, skuName?: string | null): boolean {
  const cleanName = String(skuName ?? '').trim().replace(/\s+/g, ' ');
  if (!cleanName) return true;

  const lowerName = cleanName.toLowerCase();
  if (GENERIC_PLACEHOLDER_NAMES.has(lowerName)) return true;
  if (lowerName === 'product') return true;

  const cleanSku = normalizeSkuKey(skuId);
  if (!cleanSku) return false;

  const upperName = cleanName.toUpperCase();
  return (
    upperName === cleanSku ||
    upperName === `${cleanSku} PRODUCT` ||
    upperName === `${cleanSku}-PRODUCT` ||
    upperName === `PRODUCT ${cleanSku}`
  );
}

export function resolvePreferredSkuName(
  skuId: string,
  ...candidates: Array<string | undefined | null>
): string {
  const cleaned = candidates
    .map(c => String(c ?? '').trim())
    .filter(Boolean);

  for (const candidate of cleaned) {
    if (!isPlaceholderSkuName(skuId, candidate)) {
      return candidate;
    }
  }

  if (cleaned.length > 0) {
    return cleaned[0];
  }

  const cleanSku = normalizeSkuKey(skuId);
  return cleanSku ? `${cleanSku} Product` : 'Produk Baru';
}

export function getCatalogItemName(cat?: Pick<CatalogItem, 'skuName' | 'name'> | null): string {
  return String(cat?.skuName || cat?.name || '').trim();
}

export function buildCatalogLookupMap(catalog: CatalogItem[]): Map<string, CatalogItem> {
  const map = new Map<string, CatalogItem>();
  catalog.forEach(cat => {
    const key = normalizeSkuKey(cat.skuId || cat.sku);
    if (key) {
      map.set(key, cat);
    }
  });
  return map;
}

export interface ParsedCatalogSheetRow {
  skuId: string;
  skuName: string;
  brand: string;
  barcode: string;
  qtyCtnSize: number;
  qtyInnerSize: number;
  status: 'NEW' | 'UPDATE' | 'INVALID';
  errorReason?: string;
}

const normalizeHeaderKey = (key: unknown): string =>
  String(key ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const SKU_HEADER_ALIASES = [
  'skuid',
  'kodesku',
  'sku',
  'inventoryskunumber',
  'inventorysku',
  'skunumber',
  'kodebarang',
  'kodeproduk',
  'idsku',
  'itemcode',
  'productcode',
  'nomorsku',
  'barangkode',
  'partnumber',
  'kode',
  'id',
];

const NAME_HEADER_ALIASES = [
  'namabarang',
  'namasku',
  'namaproduct',
  'namaproduk',
  'namabarangsku',
  'englishname',
  'itemenglishname',
  'skuname',
  'productname',
  'itemname',
  'namaitem',
  'nama',
  'description',
  'deskripsi',
  'title',
];

const BRAND_HEADER_ALIASES = ['brand', 'merk', 'merek', 'pabrik', 'produsen', 'vendor'];
const BARCODE_HEADER_ALIASES = [
  'barcode',
  'barcodeterhubungscanner',
  'upc',
  'ean',
  'kodebarcode',
  'qr',
  'scancode',
];
const CTN_HEADER_ALIASES = [
  'qtyctn',
  'qtyctnsize',
  'qtyctnpcs',
  'ctnsize',
  'ctn',
  'karton',
  'qtykarton',
  'isikarton',
];
const INNER_HEADER_ALIASES = [
  'qtyinner',
  'qtyinnersize',
  'qtyinnerpcs',
  'innersize',
  'inner',
  'box',
  'qtybox',
  'isiinner',
];

/**
 * Extracts normalized row objects from a raw 2D worksheet matrix.
 * Supports spreadsheets with leading title/summary rows before the real header row.
 */
export function extractCatalogRowsFromAoA(rawAoA: unknown[][]): Record<string, unknown>[] {
  const nonEmptyRows = rawAoA.filter(
    row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== '')
  );
  if (nonEmptyRows.length === 0) return [];

  let headerIdx = -1;
  const maxScan = Math.min(15, nonEmptyRows.length);

  for (let i = 0; i < maxScan; i++) {
    const normCells = nonEmptyRows[i].map(normalizeHeaderKey).filter(Boolean);
    const hasSkuHeader = normCells.some(c => SKU_HEADER_ALIASES.includes(c));
    const hasNameHeader = normCells.some(c => NAME_HEADER_ALIASES.includes(c));
    if (hasSkuHeader && hasNameHeader) {
      headerIdx = i;
      break;
    }
    if (headerIdx === -1 && (hasSkuHeader || hasNameHeader) && normCells.length >= 2) {
      headerIdx = i;
    }
  }

  if (headerIdx >= 0) {
    const headers = nonEmptyRows[headerIdx].map((cell, idx) => {
      const label = String(cell ?? '').trim();
      return label || `__col_${idx}`;
    });
    const objects: Record<string, unknown>[] = [];
    for (let r = headerIdx + 1; r < nonEmptyRows.length; r++) {
      const cells = nonEmptyRows[r];
      const obj: Record<string, unknown> = {};
      let hasValue = false;
      headers.forEach((h, cIdx) => {
        const val = cells[cIdx];
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          hasValue = true;
        }
        obj[h] = val ?? '';
      });
      if (hasValue) objects.push(obj);
    }
    return objects;
  }

  // Fallback for headerless sheets pasted or saved as plain 2..6 columns: SKU | Nama | Brand | Barcode | Qty CTN | Qty Inner
  return nonEmptyRows.map(cells => ({
    'SKU ID': cells[0] ?? '',
    'Nama Barang': cells[1] ?? '',
    Brand: cells[2] ?? '',
    Barcode: cells[3] ?? '',
    'Qty CTN': cells[4] ?? '',
    'Qty Inner': cells[5] ?? '',
  }));
}

function pickFieldByAliases(row: Record<string, unknown>, aliases: string[]): unknown {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const found = entries.find(([k]) => normalizeHeaderKey(k) === alias);
    if (found !== undefined) {
      return found[1];
    }
  }
  return undefined;
}

function parsePositiveIntOrNull(val: unknown): number | null {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  if (typeof val === 'number') {
    const floored = Math.floor(val);
    return Number.isSafeInteger(floored) && floored > 0 ? floored : null;
  }
  const str = String(val).trim();
  const normalized = str.replace(/[\s,]+/g, '');
  if (/^\d+(?:\.\d{3})+$/.test(str)) {
    const thousands = parseInt(str.replace(/\./g, ''), 10);
    return Number.isSafeInteger(thousands) && thousands > 0 ? thousands : null;
  }
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    const floored = Math.floor(numeric);
    return Number.isSafeInteger(floored) && floored > 0 ? floored : null;
  }
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return null;
  const parsed = parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseCatalogSheetRows(
  rawRows: Record<string, unknown>[],
  existingCatalog: CatalogItem[],
  resolvePackSizes: (skuId: string) => { qtyCtnSize: number; qtyInnerSize: number },
  resolveBrand: (skuId?: string, skuName?: string, explicitBrand?: string) => string,
  resolveBarcode: (skuId: string, explicitBarcode?: string) => string
): ParsedCatalogSheetRow[] {
  const catalogMap = buildCatalogLookupMap(existingCatalog);
  const parsed: ParsedCatalogSheetRow[] = [];
  const validIndexBySku = new Map<string, number>();

  rawRows.forEach(row => {
    const rawSkuVal = pickFieldByAliases(row, SKU_HEADER_ALIASES);
    const rawNameVal = pickFieldByAliases(row, NAME_HEADER_ALIASES);
    const rawBrandVal = pickFieldByAliases(row, BRAND_HEADER_ALIASES);
    const rawBarcodeVal = pickFieldByAliases(row, BARCODE_HEADER_ALIASES);
    const rawCtnVal = pickFieldByAliases(row, CTN_HEADER_ALIASES);
    const rawInnerVal = pickFieldByAliases(row, INNER_HEADER_ALIASES);

    const rawSkuId = normalizeSkuKey(String(rawSkuVal ?? '').replace(/^['#]/, ''));
    const rawSkuName = String(rawNameVal ?? '').trim().replace(/\s+/g, ' ');
    const rawBrandInput = String(rawBrandVal ?? '').trim();
    const rawBarcodeInput = String(rawBarcodeVal ?? '').trim();

    const parsedCtn = parsePositiveIntOrNull(rawCtnVal);
    const parsedInner = parsePositiveIntOrNull(rawInnerVal);
    const fallbackSizes = rawSkuId ? resolvePackSizes(rawSkuId) : { qtyCtnSize: 144, qtyInnerSize: 12 };

    if (!rawSkuId) {
      parsed.push({
        skuId: '-',
        skuName: rawSkuName || '-',
        brand: rawBrandInput || '-',
        barcode: rawBarcodeInput || '-',
        qtyCtnSize: parsedCtn ?? 144,
        qtyInnerSize: parsedInner ?? 12,
        status: 'INVALID',
        errorReason: 'SKU ID Kosong',
      });
      return;
    }

    const existingCat = catalogMap.get(rawSkuId);
    const preservedCtnSize = parsedCtn ?? existingCat?.qtyCtnSize ?? fallbackSizes.qtyCtnSize ?? 144;
    const preservedInnerSize = parsedInner ?? existingCat?.qtyInnerSize ?? fallbackSizes.qtyInnerSize ?? 12;

    if (!rawSkuName) {
      parsed.push({
        skuId: rawSkuId,
        skuName: '-',
        brand: rawBrandInput || existingCat?.brand || resolveBrand(rawSkuId, rawSkuName),
        barcode: rawBarcodeInput || existingCat?.barcode || resolveBarcode(rawSkuId),
        qtyCtnSize: preservedCtnSize,
        qtyInnerSize: preservedInnerSize,
        status: 'INVALID',
        errorReason: 'Nama Barang Kosong',
      });
      return;
    }

    const effectiveBrand = rawBrandInput
      ? resolveBrand(rawSkuId, rawSkuName, rawBrandInput)
      : existingCat?.brand || resolveBrand(rawSkuId, rawSkuName, '');
    const effectiveBarcode =
      rawBarcodeInput && rawBarcodeInput !== '-'
        ? resolveBarcode(rawSkuId, rawBarcodeInput)
        : existingCat?.barcode && existingCat.barcode !== '-'
          ? existingCat.barcode
          : resolveBarcode(rawSkuId);

    const nextRow: ParsedCatalogSheetRow = {
      skuId: rawSkuId,
      skuName: rawSkuName,
      brand: effectiveBrand,
      barcode: effectiveBarcode,
      qtyCtnSize: preservedCtnSize,
      qtyInnerSize: preservedInnerSize,
      status: existingCat ? 'UPDATE' : 'NEW',
    };

    const prevIdx = validIndexBySku.get(rawSkuId);
    if (prevIdx !== undefined) {
      parsed[prevIdx] = nextRow;
    } else {
      validIndexBySku.set(rawSkuId, parsed.length);
      parsed.push(nextRow);
    }
  });

  return parsed;
}

export interface BidirectionalSyncPlan {
  catalogUpserts: CatalogItem[];
  mergedCatalog: CatalogItem[];
  stockUpdates: StockItem[];
  addedCatalogCount: number;
  updatedCatalogCount: number;
  syncedStockCount: number;
}

export function planCatalogStockBidirectionalSync(
  catalog: CatalogItem[],
  stock: StockItem[],
  resolvePackSizes: (skuId: string) => { qtyCtnSize: number; qtyInnerSize: number },
  resolveBrand: (skuId?: string, skuName?: string, explicitBrand?: string) => string,
  resolveBarcode: (skuId: string, explicitBarcode?: string) => string
): BidirectionalSyncPlan {
  const bestStockBySku = new Map<
    string,
    {
      skuId: string;
      skuName: string;
      brand?: string;
      barcode?: string;
      qtyCtnSize: number;
      qtyInnerSize: number;
    }
  >();

  stock.forEach(s => {
    const normSku = normalizeSkuKey(s.skuId);
    if (!normSku) return;
    const prev = bestStockBySku.get(normSku);
    const defaultSizes = resolvePackSizes(s.skuId);
    const candidateName = resolvePreferredSkuName(normSku, prev?.skuName, s.skuName);
    bestStockBySku.set(normSku, {
      skuId: normSku,
      skuName: candidateName,
      brand: prev?.brand || s.brand,
      barcode: prev?.barcode && prev.barcode !== '-' ? prev.barcode : s.barcode,
      qtyCtnSize: prev?.qtyCtnSize || defaultSizes.qtyCtnSize || s.qtyCtnSize || 720,
      qtyInnerSize: prev?.qtyInnerSize || defaultSizes.qtyInnerSize || s.qtyInnerSize || 12,
    });
  });

  const existingCatalogMap = buildCatalogLookupMap(catalog);
  const nextCatalogMap = new Map<string, CatalogItem>();
  existingCatalogMap.forEach((cat, key) => {
    nextCatalogMap.set(key, { ...cat, id: key, skuId: cat.skuId || key });
  });

  const catalogUpserts: CatalogItem[] = [];
  let addedCatalogCount = 0;
  let updatedCatalogCount = 0;

  bestStockBySku.forEach((stockMeta, normSku) => {
    const existing = nextCatalogMap.get(normSku);
    if (!existing) {
      const resolvedBrand = resolveBrand(normSku, stockMeta.skuName, stockMeta.brand);
      const resolvedBarcode = resolveBarcode(normSku, stockMeta.barcode);
      const created: CatalogItem = {
        id: normSku,
        skuId: normSku,
        skuName: stockMeta.skuName,
        brand: resolvedBrand,
        barcode: resolvedBarcode,
        qtyCtnSize: stockMeta.qtyCtnSize,
        qtyInnerSize: stockMeta.qtyInnerSize,
      };
      nextCatalogMap.set(normSku, created);
      catalogUpserts.push(created);
      addedCatalogCount += 1;
      return;
    }

    const currentCatName = getCatalogItemName(existing);
    if (
      isPlaceholderSkuName(normSku, currentCatName) &&
      !isPlaceholderSkuName(normSku, stockMeta.skuName)
    ) {
      const upgraded: CatalogItem = {
        ...existing,
        id: normSku,
        skuId: existing.skuId || normSku,
        skuName: stockMeta.skuName,
        brand: resolveBrand(normSku, stockMeta.skuName, existing.brand || stockMeta.brand),
        barcode: resolveBarcode(
          normSku,
          existing.barcode && existing.barcode !== '-' ? existing.barcode : stockMeta.barcode
        ),
      };
      nextCatalogMap.set(normSku, upgraded);
      catalogUpserts.push(upgraded);
      updatedCatalogCount += 1;
    }
  });

  const stockUpdates: StockItem[] = [];
  stock.forEach(s => {
    const normSku = normalizeSkuKey(s.skuId);
    const cat = nextCatalogMap.get(normSku);
    if (!cat) return;

    const catName = getCatalogItemName(cat);
    const nextSkuName = resolvePreferredSkuName(normSku, catName, s.skuName);
    const targetCtnSize = cat.qtyCtnSize || s.qtyCtnSize;
    const targetInnerSize = cat.qtyInnerSize || s.qtyInnerSize;
    const nextBrand = resolveBrand(normSku, nextSkuName, cat.brand || s.brand);
    const nextBarcode = resolveBarcode(
      normSku,
      cat.barcode && cat.barcode !== '-' ? cat.barcode : s.barcode
    );

    const nameChanged = nextSkuName.trim() !== String(s.skuName ?? '').trim();
    const packSizeChanged =
      targetCtnSize !== s.qtyCtnSize || targetInnerSize !== s.qtyInnerSize;
    const brandChanged = nextBrand !== (s.brand ?? '');
    const barcodeChanged =
      nextBarcode !== '-' && nextBarcode !== (s.barcode ?? '-');

    if (nameChanged || packSizeChanged || brandChanged || barcodeChanged) {
      const splits = calculatePackQuantities(s.qty, targetCtnSize, targetInnerSize);
      stockUpdates.push({
        ...s,
        skuName: nextSkuName,
        brand: nextBrand,
        barcode: nextBarcode,
        qtyCtnSize: targetCtnSize,
        qtyInnerSize: targetInnerSize,
        qtyCtn: splits.qtyCtn,
        qtyInner: splits.qtyInner,
        qtyLoose: splits.qtyLoose,
      });
    }
  });

  return {
    catalogUpserts,
    mergedCatalog: Array.from(nextCatalogMap.values()),
    stockUpdates,
    addedCatalogCount,
    updatedCatalogCount,
    syncedStockCount: stockUpdates.length,
  };
}

export interface CrossBranchMergePreviewRow {
  skuId: string;
  currentName: string;
  nextName: string;
  action: 'UPDATE_PLACEHOLDER' | 'OVERWRITE' | 'NEW';
}

export interface CrossBranchMergePlan {
  itemsToImport: Omit<CatalogItem, 'id'>[];
  previewRows: CrossBranchMergePreviewRow[];
  skippedPlaceholderSourceCount: number;
  unchangedCount: number;
}

export function planCrossBranchCatalogMerge(
  targetCatalog: CatalogItem[],
  sourceCatalog: CatalogItem[],
  options: {
    mode: 'fill_placeholders' | 'overwrite_all';
    includeNewSkus: boolean;
  },
  resolvePackSizes: (skuId: string) => { qtyCtnSize: number; qtyInnerSize: number },
  resolveBrand: (skuId?: string, skuName?: string, explicitBrand?: string) => string,
  resolveBarcode: (skuId: string, explicitBarcode?: string) => string
): CrossBranchMergePlan {
  const targetMap = buildCatalogLookupMap(targetCatalog);
  const dedupedSourceMap = new Map<string, CatalogItem>();
  let skippedPlaceholderSourceCount = 0;

  sourceCatalog.forEach(item => {
    const skuKey = normalizeSkuKey(item.skuId || item.sku);
    if (!skuKey) return;
    const srcName = getCatalogItemName(item);
    if (isPlaceholderSkuName(skuKey, srcName)) {
      skippedPlaceholderSourceCount += 1;
      return;
    }
    dedupedSourceMap.set(skuKey, { ...item, skuId: skuKey, skuName: srcName });
  });

  const itemsToImport: Omit<CatalogItem, 'id'>[] = [];
  const previewRows: CrossBranchMergePreviewRow[] = [];
  let unchangedCount = 0;

  dedupedSourceMap.forEach((src, skuKey) => {
    const existing = targetMap.get(skuKey);
    const defaultSizes = resolvePackSizes(skuKey);

    if (existing) {
      const currentName = getCatalogItemName(existing);
      const isTargetPlaceholder = isPlaceholderSkuName(skuKey, currentName);
      const sameRealName = currentName.trim() === src.skuName.trim();

      if (sameRealName) {
        unchangedCount += 1;
        return;
      }
      if (options.mode === 'fill_placeholders' && !isTargetPlaceholder) {
        unchangedCount += 1;
        return;
      }

      const ctnSize = existing.qtyCtnSize || src.qtyCtnSize || defaultSizes.qtyCtnSize || 144;
      const innerSize = existing.qtyInnerSize || src.qtyInnerSize || defaultSizes.qtyInnerSize || 12;
      itemsToImport.push({
        skuId: skuKey,
        skuName: src.skuName,
        brand: resolveBrand(skuKey, src.skuName, existing.brand || src.brand),
        barcode: resolveBarcode(
          skuKey,
          existing.barcode && existing.barcode !== '-' ? existing.barcode : src.barcode
        ),
        qtyCtnSize: ctnSize,
        qtyInnerSize: innerSize,
      });
      previewRows.push({
        skuId: skuKey,
        currentName: currentName || '(kosong)',
        nextName: src.skuName,
        action: isTargetPlaceholder ? 'UPDATE_PLACEHOLDER' : 'OVERWRITE',
      });
      return;
    }

    if (!options.includeNewSkus) {
      unchangedCount += 1;
      return;
    }

    itemsToImport.push({
      skuId: skuKey,
      skuName: src.skuName,
      brand: resolveBrand(skuKey, src.skuName, src.brand),
      barcode: resolveBarcode(skuKey, src.barcode),
      qtyCtnSize: src.qtyCtnSize || defaultSizes.qtyCtnSize || 144,
      qtyInnerSize: src.qtyInnerSize || defaultSizes.qtyInnerSize || 12,
    });
    previewRows.push({
      skuId: skuKey,
      currentName: '(Belum Ada Di Cabang Ini)',
      nextName: src.skuName,
      action: 'NEW',
    });
  });

  return {
    itemsToImport,
    previewRows,
    skippedPlaceholderSourceCount,
    unchangedCount,
  };
}
