import { isStockItem, type StockItem, type StockItemInput } from '../types';
import { calculatePackQuantities, deduplicateAndMergeStock, getProductPackSizes, getStockStatus, normalizeDateToDmy } from './calculations';

function normalizeStockItem(item: StockItemInput): StockItem {
  const skuId = item.skuId.trim().toUpperCase();
  const expiredDate = normalizeDateToDmy(item.expiredDate) || 'No Expired';
  const location = item.location.trim().toUpperCase();
  const { qtyCtnSize: catalogCtnSize, qtyInnerSize: catalogInnerSize } = getProductPackSizes(skuId);
  const qtyCtnSize = catalogCtnSize || item.qtyCtnSize || 720;
  const qtyInnerSize = catalogInnerSize || item.qtyInnerSize || 12;
  if (!Number.isSafeInteger(qtyCtnSize) || qtyCtnSize <= 0
    || !Number.isSafeInteger(qtyInnerSize) || qtyInnerSize <= 0) {
    throw new Error('ukuran karton/inner tidak valid');
  }
  const quantities = calculatePackQuantities(item.qty, qtyCtnSize, qtyInnerSize);

  return {
    ...item,
    skuId,
    expiredDate,
    location,
    totalQtySku: item.totalQtySku ?? item.qty,
    qtyCtnSize,
    qtyCtn: quantities.qtyCtn,
    qtyInnerSize,
    qtyInner: quantities.qtyInner,
    qtyLoose: quantities.qtyLoose,
    status: getStockStatus({
      expiredDate,
      location,
      status: item.status ?? ''
    })
  };
}

export function normalizeStockBatch(records: unknown[]): StockItem[] {
  const normalized = records.map((record, index) => {
    if (!isStockItem(record)) {
      throw new Error(`Dokumen stok ke-${index + 1} tidak valid; sinkronisasi dibatalkan.`);
    }

    try {
      const metadata = record as StockItemInput & {
        __wms_document_id?: unknown;
        __wms_source_ids?: unknown;
        __wms_source_revisions?: unknown;
      };
      const documentId = typeof metadata.__wms_document_id === 'string' && metadata.__wms_document_id
        ? metadata.__wms_document_id
        : record.id;
      const sourceIds = new Set<string>([documentId]);
      if (Array.isArray(metadata.__wms_source_ids)) {
        metadata.__wms_source_ids.forEach(id => {
          if (typeof id === 'string' && id) sourceIds.add(id);
        });
      }
      const sourceRevisions: Record<string, number> = {};
      if (metadata.__wms_source_revisions && typeof metadata.__wms_source_revisions === 'object') {
        Object.entries(metadata.__wms_source_revisions as Record<string, unknown>).forEach(([id, revision]) => {
          if (id && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) {
            sourceRevisions[id] = revision;
          }
        });
      }
      if (typeof record.__wms_revision === 'number' && Number.isSafeInteger(record.__wms_revision)) {
        sourceRevisions[documentId] = record.__wms_revision;
      }
      return normalizeStockItem({
        ...record,
        __wms_revision_document_id: record.__wms_revision === undefined ? undefined : documentId,
        __wms_source_ids: [...sourceIds],
        __wms_source_revisions: sourceRevisions
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Dokumen stok ke-${index + 1} tidak dapat dinormalisasi dengan aman: ${detail}`);
    }
  });

  const merged = deduplicateAndMergeStock(normalized);
  if (merged.some((item) => !Number.isSafeInteger(item.qty) || !Number.isSafeInteger(item.totalQtySku))) {
    throw new Error('Total stok hasil penggabungan melebihi rentang integer aman; sinkronisasi dibatalkan.');
  }
  return merged;
}
