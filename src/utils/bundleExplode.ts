import type { BundleComponent, CatalogItem, OutboundItem, StockItem } from '../types';
import { getAvailableStockPool, isStockPickable } from './calculations';

export interface BundleValidationResult {
  ok: boolean;
  components: BundleComponent[];
  error?: string;
}

export interface BundleComponentAvailability {
  skuId: string;
  skuName: string;
  qtyPerBundle: number;
  availableQty: number;
  maxPacksForComponent: number;
}

export interface BundleAvailabilitySummary {
  maxPacks: number;
  limitingSku?: string;
  components: BundleComponentAvailability[];
}

export interface ManualBundleInputEntry {
  skuId: string;
  qty: number;
  originalText: string;
}

export interface ExpandedManualBundleEntry {
  skuId: string;
  qty: number;
  originalText: string;
  bundleSku?: string;
  bundleName?: string;
  bundleQty?: number;
}

export function normalizeBundleSkuKey(skuId: string | undefined | null): string {
  return String(skuId || '').trim().toUpperCase();
}

export function isBundleCatalogItem(item: Partial<CatalogItem> | null | undefined): boolean {
  return Boolean(
    item &&
      item.isBundle &&
      Array.isArray(item.bundleComponents) &&
      item.bundleComponents.length > 0
  );
}

/**
 * Validates and normalizes bundle components:
 * - Uppercases SKU IDs
 * - Merges duplicate component SKUs by summing quantities
 * - Rejects empty component list, non-positive/non-integer qty, self-reference, and nested bundles
 */
export function normalizeBundleComponents(
  rawComponents: Array<{ skuId: string; skuName?: string; qty: number }>,
  selfSkuId: string,
  catalog: CatalogItem[] = []
): BundleValidationResult {
  const selfKey = normalizeBundleSkuKey(selfSkuId);
  if (!selfKey) {
    return { ok: false, components: [], error: 'Kode SKU Bundling wajib diisi.' };
  }

  const catalogByKey = new Map<string, CatalogItem>();
  for (const item of catalog) {
    const key = normalizeBundleSkuKey(item.skuId);
    if (key) catalogByKey.set(key, item);
  }

  const mergedMap = new Map<string, BundleComponent>();

  for (const raw of rawComponents) {
    const compKey = normalizeBundleSkuKey(raw.skuId);
    if (!compKey) {
      return { ok: false, components: [], error: 'Semua baris komponen bundling harus memilih SKU yang valid.' };
    }
    if (compKey === selfKey) {
      return {
        ok: false,
        components: [],
        error: `SKU Bundling "${selfKey}" tidak boleh memasukkan dirinya sendiri sebagai komponen.`
      };
    }

    const qtyNum = Number(raw.qty);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      return {
        ok: false,
        components: [],
        error: `Qty komponen "${compKey}" harus berupa bilangan bulat positif (>= 1).`
      };
    }

    const existingCatalog = catalogByKey.get(compKey);
    if (existingCatalog && isBundleCatalogItem(existingCatalog)) {
      return {
        ok: false,
        components: [],
        error: `Komponen "${compKey}" adalah SKU Bundling lain. Nested bundling tidak diperbolehkan.`
      };
    }

    const resolvedName = (raw.skuName || existingCatalog?.skuName || '').trim() || undefined;
    const prev = mergedMap.get(compKey);
    if (prev) {
      prev.qty += qtyNum;
      if (!prev.skuName && resolvedName) prev.skuName = resolvedName;
    } else {
      mergedMap.set(compKey, {
        skuId: compKey,
        ...(resolvedName ? { skuName: resolvedName } : {}),
        qty: qtyNum
      });
    }
  }

  const components = Array.from(mergedMap.values());
  if (components.length === 0) {
    return {
      ok: false,
      components: [],
      error: 'Bundling harus memiliki minimal 1 SKU komponen.'
    };
  }

  return { ok: true, components };
}

/**
 * Builds a lookup map of bundle catalog items keyed by normalized SKU ID
 * (and also by normalized barcode when present and distinct).
 */
export function buildBundleMap(catalog: CatalogItem[] = []): Map<string, CatalogItem> {
  const map = new Map<string, CatalogItem>();
  for (const item of catalog) {
    if (!isBundleCatalogItem(item)) continue;
    const skuKey = normalizeBundleSkuKey(item.skuId);
    if (skuKey) {
      map.set(skuKey, item);
    }
    const barcodeKey = normalizeBundleSkuKey(item.barcode);
    if (barcodeKey && barcodeKey !== '-' && !map.has(barcodeKey)) {
      map.set(barcodeKey, item);
    }
  }
  return map;
}

/**
 * Computes maximum available packs for a bundle based on free pickable stock
 * (after subtracting pending order reservations if orderHistory is provided).
 */
export function computeBundleAvailablePacks(
  bundle: Pick<CatalogItem, 'bundleComponents'>,
  stock: StockItem[],
  orderHistory: OutboundItem[] = [],
  warehouseId?: string,
  catalog: CatalogItem[] = []
): BundleAvailabilitySummary {
  const components = Array.isArray(bundle.bundleComponents) ? bundle.bundleComponents : [];
  if (components.length === 0) {
    return { maxPacks: 0, components: [] };
  }

  const whFilter = warehouseId ? warehouseId.trim().toUpperCase() : '';
  const freePool = getAvailableStockPool(stock, orderHistory).filter((s) => {
    if (!isStockPickable(s) || s.qty <= 0) return false;
    if (whFilter && (s.warehouseId || 'WH-CENTRAL').toUpperCase() !== whFilter) return false;
    return true;
  });

  const freeBySku = new Map<string, number>();
  const nameBySku = new Map<string, string>();
  for (const item of freePool) {
    const key = normalizeBundleSkuKey(item.skuId);
    if (!key) continue;
    freeBySku.set(key, (freeBySku.get(key) || 0) + item.qty);
    if (item.skuName && !nameBySku.has(key)) {
      nameBySku.set(key, item.skuName);
    }
  }
  for (const c of catalog) {
    const key = normalizeBundleSkuKey(c.skuId);
    if (key && c.skuName && !nameBySku.has(key)) {
      nameBySku.set(key, c.skuName);
    }
  }

  let maxPacks = Number.POSITIVE_INFINITY;
  let limitingSku: string | undefined;

  const details: BundleComponentAvailability[] = components.map((comp) => {
    const key = normalizeBundleSkuKey(comp.skuId);
    const qtyPerBundle = Math.max(1, Math.floor(Number(comp.qty) || 1));
    const availableQty = freeBySku.get(key) || 0;
    const maxPacksForComponent = Math.floor(availableQty / qtyPerBundle);

    if (maxPacksForComponent < maxPacks) {
      maxPacks = maxPacksForComponent;
      limitingSku = key;
    }

    return {
      skuId: key,
      skuName: comp.skuName || nameBySku.get(key) || key,
      qtyPerBundle,
      availableQty,
      maxPacksForComponent
    };
  });

  return {
    maxPacks: Number.isFinite(maxPacks) ? maxPacks : 0,
    limitingSku,
    components: details
  };
}

/**
 * Expands manual outbound input entries: if an entry's SKU matches a bundle recipe,
 * replaces it with its component SKUs (qty = entry.qty * component.qty).
 */
export function expandManualEntriesForBundles(
  entries: ManualBundleInputEntry[],
  bundleMap: Map<string, CatalogItem>
): ExpandedManualBundleEntry[] {
  if (bundleMap.size === 0) {
    return entries.map((e) => ({
      skuId: normalizeBundleSkuKey(e.skuId),
      qty: e.qty,
      originalText: e.originalText
    }));
  }

  const expanded: ExpandedManualBundleEntry[] = [];
  for (const entry of entries) {
    const key = normalizeBundleSkuKey(entry.skuId);
    const bundle = bundleMap.get(key);
    if (bundle && isBundleCatalogItem(bundle) && bundle.bundleComponents) {
      for (const comp of bundle.bundleComponents) {
        const compSku = normalizeBundleSkuKey(comp.skuId);
        if (!compSku) continue;
        expanded.push({
          skuId: compSku,
          qty: entry.qty * comp.qty,
          originalText: entry.originalText,
          bundleSku: normalizeBundleSkuKey(bundle.skuId),
          bundleName: bundle.skuName,
          bundleQty: entry.qty
        });
      }
    } else {
      expanded.push({
        skuId: key,
        qty: entry.qty,
        originalText: entry.originalText
      });
    }
  }
  return expanded;
}
