export const MAX_STOCK_WRITE_OPERATIONS = 20000;

export type StockWriteOperation<T> =
  | { type: 'set'; id: string; data: T; expectedRevision?: number | null }
  | { type: 'delete'; id: string; expectedRevision?: number | null };

export function queueStockWritePlan<
  T extends { id: string; __wms_revision?: number },
  R
>(
  batch: { set: (reference: R, data: object) => void; delete: (reference: R) => void },
  operations: StockWriteOperation<T>[],
  createReference: (id: string) => R,
  pinExpectedRevision: (reference: R, revision: number | null) => R,
  pinRevisions: boolean
): void {
  for (const operation of operations) {
    const reference = createReference(operation.id);
    if (pinRevisions && operation.expectedRevision === undefined) {
      throw new Error(`Revision tidak dipatok untuk dokumen ${operation.id}.`);
    }

    if (operation.type === 'set') {
      if (pinRevisions) {
        const payload = { ...operation.data };
        delete payload.__wms_revision;
        batch.set(pinExpectedRevision(reference, operation.expectedRevision ?? null), payload);
      } else {
        batch.set(reference, operation.data);
      }
    } else {
      batch.delete(pinRevisions
        ? pinExpectedRevision(reference, operation.expectedRevision ?? null)
        : reference);
    }
  }
}

export function buildStockWritePlan<T extends { id: string }>(
  newStock: T[],
  oldStock: T[],
  emptyFlag: T,
  options: { forceUpserts?: boolean; expectedRevisions?: ReadonlyMap<string, number> } = {}
): StockWriteOperation<T>[] {
  const forceUpserts = options.forceUpserts ?? false;
  const expectedRevisions = options.expectedRevisions;
  const oldMap = new Map(oldStock.map(item => [item.id, item]));
  const newMap = new Map(newStock.map(item => [item.id, item]));
  const operations: StockWriteOperation<T>[] = [];

  if (newStock.length === 0) {
    newMap.set(emptyFlag.id, emptyFlag);
  } else if (oldMap.has(emptyFlag.id)) {
    operations.push({
      type: 'delete',
      id: emptyFlag.id,
      ...(forceUpserts ? { expectedRevision: expectedRevisions?.get(emptyFlag.id) ?? null } : {})
    });
  }

  for (const [id, newItem] of newMap) {
    const oldItem = oldMap.get(id);
    if (forceUpserts || !oldItem || JSON.stringify(newItem) !== JSON.stringify(oldItem)) {
      operations.push({
        type: 'set',
        id,
        data: newItem,
        ...(forceUpserts ? { expectedRevision: expectedRevisions?.get(id) ?? null } : {})
      });
    }
  }

  for (const id of oldMap.keys()) {
    if (!newMap.has(id) && !(newStock.length > 0 && id === emptyFlag.id)) {
      operations.push({
        type: 'delete',
        id,
        ...(forceUpserts ? { expectedRevision: expectedRevisions?.get(id) ?? null } : {})
      });
    }
  }

  return operations;
}
