import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStockBatch } from './stockNormalization';
import { buildStockWritePlan, MAX_STOCK_WRITE_OPERATIONS, queueStockWritePlan } from './stockWritePlan';
import {
  getStockForcePushSafetyError,
  runStockForcePushIfSafe,
  type StockForcePushSnapshot
} from './stockForcePushSafety';
import {
  createLatestRequestSequence,
  initialStockSyncState,
  stockSyncFailed,
  stockSyncStarted,
  stockSyncSucceeded
} from './stockSyncSafety';
import {
  applyRevisionSnapshot,
  createLatestReadCoordinator,
  publishSnapshotWithRevisions,
  ReadTimeoutError,
  runReadRequest,
  StaleReadError
} from './readRequestSafety';

function stockRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1007-01_01_01_2027_A1',
    skuId: '1007-01',
    skuName: 'Product 1',
    expiredDate: '01/01/2027',
    location: 'A1',
    qty: 1234,
    totalQtySku: 1234,
    qtyCtnSize: 1000,
    qtyCtn: 1,
    qtyInnerSize: 12,
    qtyInner: 19,
    qtyLoose: 6,
    status: 'AMAN',
    ...overrides
  };
}

test('normalizes a complete stock record without changing its calculated quantities', () => {
  const [stock] = normalizeStockBatch([stockRecord()]);

  assert.equal(stock.qty, 1234);
  assert.equal(stock.qtyCtn, 1);
  assert.equal(stock.qtyInner, 19);
  assert.equal(stock.qtyLoose, 6);
  assert.equal(stock.totalQtySku, 1234);
});

test('fills derived fields for a legacy stock record', () => {
  const legacyRecord = stockRecord();
  delete legacyRecord.totalQtySku;
  delete legacyRecord.qtyCtnSize;
  delete legacyRecord.qtyCtn;
  delete legacyRecord.qtyInnerSize;
  delete legacyRecord.qtyInner;
  delete legacyRecord.qtyLoose;
  delete legacyRecord.status;

  const [stock] = normalizeStockBatch([legacyRecord]);

  assert.equal(stock.qty, 1234);
  assert.equal(stock.totalQtySku, 1234);
  assert.equal(stock.qtyCtnSize, 1000);
  assert.equal(stock.qtyInnerSize, 12);
  assert.equal(stock.qtyCtn, 1);
  assert.equal(stock.qtyInner, 19);
  assert.equal(stock.qtyLoose, 6);
  assert.equal(typeof stock.status, 'string');
});

test('recalculates null derived fields from the trusted quantity', () => {
  const [stock] = normalizeStockBatch([stockRecord({
    totalQtySku: null,
    qtyCtnSize: null,
    qtyCtn: null,
    qtyInnerSize: null,
    qtyInner: null,
    qtyLoose: null,
    status: null
  })]);

  assert.equal(stock.qty, 1234);
  assert.equal(stock.totalQtySku, 1234);
  assert.equal(stock.qtyCtnSize, 1000);
  assert.equal(stock.qtyInnerSize, 12);
  assert.equal(stock.qtyCtn, 1);
  assert.equal(stock.qtyInner, 19);
  assert.equal(stock.qtyLoose, 6);
  assert.equal(typeof stock.status, 'string');
});

test('rejects invalid quantities instead of coercing them to zero', () => {
  for (const qty of [Number.NaN, Number.POSITIVE_INFINITY, -1, '1234']) {
    assert.throws(
      () => normalizeStockBatch([stockRecord({ qty })]),
      /Dokumen stok ke-1 tidak valid/
    );
  }
});

test('rejects one invalid record in an otherwise valid stock batch', () => {
  assert.throws(
    () => normalizeStockBatch([stockRecord(), stockRecord({ qty: Number.NaN })]),
    /Dokumen stok ke-2 tidak valid/
  );
});

test('rejects an entire batch when any record is invalid', () => {
  assert.throws(
    () => normalizeStockBatch([stockRecord(), stockRecord({ id: '', qty: Number.NaN })]),
    /Dokumen stok ke-2 tidak valid/
  );
});

test('keeps same SKU and location in two warehouses as separate rows', () => {
  const result = normalizeStockBatch([
    stockRecord({ id: 'wh-a-stock', qty: 100, warehouseId: 'WH-A', location: 'A1' }),
    stockRecord({ id: 'wh-b-stock', qty: 200, warehouseId: 'WH-B', location: 'A1' })
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map(item => item.warehouseId)), new Set(['WH-A', 'WH-B']));
  assert.ok(result.every(item => item.totalQtySku === 300));
  assert.equal(result.reduce((total, item) => total + item.qty, 0), 300);
});

test('builds one force-push plan containing stock upserts and empty-flag deletion', () => {
  const oldRows = [{ ...stockRecord(), id: 'old-row', __wms_revision: 3 }];
  const newRows = [
    { ...stockRecord(), id: 'new-row', __wms_revision: 0 },
    { ...stockRecord(), id: 'existing-row', __wms_revision: 5 }
  ];
  const emptyFlag = { ...stockRecord(), id: 'SYSTEM_EMPTY_FLAG', skuId: 'SYSTEM_EMPTY', __wms_revision: 0 };

  const plan = buildStockWritePlan(newRows, oldRows, emptyFlag, {
    forceUpserts: true,
    expectedRevisions: new Map([['old-row', 3], ['new-row', 0], ['existing-row', 5]])
  });

  assert.deepEqual(plan.map(operation => [operation.type, operation.id, operation.expectedRevision]), [
    ['delete', 'SYSTEM_EMPTY_FLAG', null],
    ['set', 'new-row', 0],
    ['set', 'existing-row', 5],
    ['delete', 'old-row', 3]
  ]);
  assert.equal(plan.filter(operation => operation.type === 'set').length, newRows.length);
  assert.equal(MAX_STOCK_WRITE_OPERATIONS, 20000);
});

test('keeps ordinary stock saves diff-based and empty-stock flag creation unchanged', () => {
  const unchanged = { ...stockRecord(), id: 'same-row' };
  const changed = { ...stockRecord(), id: 'changed-row', qty: 10 };
  const emptyFlag = { ...stockRecord(), id: 'SYSTEM_EMPTY_FLAG', skuId: 'SYSTEM_EMPTY' };

  assert.deepEqual(
    buildStockWritePlan([unchanged, changed], [unchanged], emptyFlag)
      .map(operation => [operation.type, operation.id]),
    [['delete', 'SYSTEM_EMPTY_FLAG'], ['set', 'changed-row']]
  );
  assert.deepEqual(
    buildStockWritePlan([], [unchanged], emptyFlag)
      .map(operation => [operation.type, operation.id]),
    [['set', 'SYSTEM_EMPTY_FLAG'], ['delete', 'same-row']]
  );
});

test('does not duplicate the empty-flag delete when it is also in the old stock snapshot', () => {
  const row = { ...stockRecord(), id: 'active-row' };
  const emptyFlag = { ...stockRecord(), id: 'SYSTEM_EMPTY_FLAG', skuId: 'SYSTEM_EMPTY' };

  assert.deepEqual(
    buildStockWritePlan([row], [row, emptyFlag], emptyFlag, {
      forceUpserts: true,
      expectedRevisions: new Map([['active-row', 2], ['SYSTEM_EMPTY_FLAG', 4]])
    }).map(operation => [operation.type, operation.id, operation.expectedRevision]),
    [['delete', 'SYSTEM_EMPTY_FLAG', 4], ['set', 'active-row', 2]]
  );
});

type TestSnapshotStock = { id: string; __wms_revision?: number };

function forcePushSnapshot(overrides: Partial<StockForcePushSnapshot<TestSnapshotStock>> = {}) {
  const items = [{ ...stockRecord(), id: 'stock-a', __wms_revision: 7 }];
  return {
    branchId: 'CENTER',
    items,
    revisions: new Map([['stock-a', 7]]),
    complete: true,
    valid: true,
    branchWide: true,
    loadedAt: 1000,
    atomicSnapshotToken: 'isolated-test-token',
    ...overrides
  } satisfies StockForcePushSnapshot<TestSnapshotStock>;
}

test('accepts a complete, validated, current branch-wide snapshot with pinned revisions', () => {
  const snapshot = forcePushSnapshot();
  assert.equal(getStockForcePushSafetyError(snapshot, snapshot.items, 'CENTER', true, 2000), null);
});

test('rejects a snapshot limited to one warehouse or missing a page', () => {
  const snapshot = forcePushSnapshot();
  assert.match(getStockForcePushSafetyError({ ...snapshot, branchWide: false }, snapshot.items, 'CENTER', true, 2000) || '', /seluruh cabang/);
  assert.match(getStockForcePushSafetyError({ ...snapshot, complete: false }, snapshot.items, 'CENTER', true, 2000) || '', /belum lengkap/);
});

test('rejects stale, offline, changed, and unknown-revision snapshots', () => {
  const snapshot = forcePushSnapshot();
  assert.match(getStockForcePushSafetyError(snapshot, snapshot.items, 'CENTER', true, 32_000) || '', /tidak terbaru/);
  assert.match(getStockForcePushSafetyError(snapshot, snapshot.items, 'CENTER', false, 2000) || '', /koneksi/);
  assert.match(getStockForcePushSafetyError(snapshot, [...snapshot.items], 'CENTER', true, 2000) || '', /berubah/);
  const unknownRevision = forcePushSnapshot({
    items: [{ ...stockRecord(), id: 'stock-a' }]
  });
  assert.match(getStockForcePushSafetyError(unknownRevision, unknownRevision.items, 'CENTER', true, 2000) || '', /revision.*tidak diketahui/);
});

test('pins the old expected revision despite a newer operator revision arriving later', () => {
  const oldRows = [{ ...stockRecord(), id: 'stock-a', __wms_revision: 7 }];
  const revisions = new Map([['stock-a', 7]]);
  const plan = buildStockWritePlan(oldRows, oldRows, { ...oldRows[0], id: 'SYSTEM_EMPTY_FLAG' }, {
    forceUpserts: true,
    expectedRevisions: revisions
  });
  revisions.set('stock-a', 8);

  assert.equal(plan.find(operation => operation.type === 'set')?.expectedRevision, 7);
});

test('pins null for an ID created during the backup wait so it conflicts instead of adopting a newer revision', () => {
  const row = { ...stockRecord(), id: 'new-during-backup', __wms_revision: 0 };
  const plan = buildStockWritePlan([row], [], { ...row, id: 'SYSTEM_EMPTY_FLAG' }, {
    forceUpserts: true,
    expectedRevisions: new Map()
  });

  assert.equal(plan.find(operation => operation.type === 'set')?.expectedRevision, null);
});

test('queues force-push writes with snapshot-pinned revisions and strips revision metadata from payloads', () => {
  const rows = [{ ...stockRecord(), id: 'stock-a', __wms_revision: 7 }];
  const plan = buildStockWritePlan(rows, rows, { ...rows[0], id: 'SYSTEM_EMPTY_FLAG' }, {
    forceUpserts: true,
    expectedRevisions: new Map([['stock-a', 7]])
  });
  const writes: Array<{ type: string; id: string; revision: number | null; payload?: object }> = [];
  const batch = {
    set(reference: { id: string; expectedRevision: number | null }, payload: object) {
      writes.push({ type: 'set', id: reference.id, revision: reference.expectedRevision, payload });
    },
    delete(reference: { id: string; expectedRevision: number | null }) {
      writes.push({ type: 'delete', id: reference.id, revision: reference.expectedRevision });
    }
  };

  queueStockWritePlan(
    batch,
    plan,
    id => ({ id, expectedRevision: null }),
    (reference, expectedRevision) => ({ ...reference, expectedRevision }),
    true
  );

  assert.deepEqual(writes.map(({ type, id, revision }) => [type, id, revision]), [
    ['delete', 'SYSTEM_EMPTY_FLAG', null],
    ['set', 'stock-a', 7]
  ]);
  assert.equal(writes[1].payload && '__wms_revision' in writes[1].payload, false);
});

test('rejects unsafe force push before invoking the writer or issuing deletes', async () => {
  const snapshot = forcePushSnapshot({ atomicSnapshotToken: undefined });
  let writeBatchCalls = 0;
  let deleteOperations = 0;

  await assert.rejects(runStockForcePushIfSafe(
    snapshot,
    snapshot.items,
    'CENTER',
    true,
    async () => {
      writeBatchCalls += 1;
      deleteOperations += 1;
    },
    2000
  ), /server belum menyediakan bukti snapshot atomik/);
  assert.equal(writeBatchCalls, 0);
  assert.equal(deleteOperations, 0);
});

test('merges duplicate SKU/location records within the same warehouse using existing behavior', () => {
  const result = normalizeStockBatch([
    stockRecord({ id: 'duplicate-one', qty: 10, warehouseId: 'WH-A', location: 'A1' }),
    stockRecord({ id: 'duplicate-two', qty: 15, warehouseId: 'WH-A', location: 'A1' })
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].warehouseId, 'WH-A');
  assert.equal(result[0].qty, 25);
  assert.equal(result[0].totalQtySku, 25);
});

test('normalizes batches of 500, 1000, and 5000 records without loss', () => {
  for (const count of [500, 1000, 5000]) {
    const records = Array.from({ length: count }, (_, index) => stockRecord({
      id: `batch-${count}-${index}`,
      skuId: `BATCH-${count}-${index}`,
      qty: index + 1,
      location: `A${index}`
    }));

    const result = normalizeStockBatch(records);

    assert.equal(result.length, count);
    assert.equal(result.reduce((total, item) => total + item.qty, 0), count * (count + 1) / 2);
  }
});

test('ignores a snapshot request that completes after a newer request', async () => {
  const sequence = createLatestRequestSequence();
  const delivered: string[] = [];
  let resolveOld!: (value: string) => void;
  let resolveNew!: (value: string) => void;
  const oldResponse = new Promise<string>(resolve => { resolveOld = resolve; });
  const newResponse = new Promise<string>(resolve => { resolveNew = resolve; });
  const oldRequest = sequence.begin();
  const newRequest = sequence.begin();
  const applyWhenCurrent = async (request: number, response: Promise<string>) => {
    const value = await response;
    if (sequence.isCurrent(request)) delivered.push(value);
  };
  const oldApply = applyWhenCurrent(oldRequest, oldResponse);
  const newApply = applyWhenCurrent(newRequest, newResponse);

  resolveNew('new');
  await newApply;
  resolveOld('old');
  await oldApply;

  assert.deepEqual(delivered, ['new']);
});

test('reports sync failure as stale and recovers after a valid snapshot', () => {
  const syncing = stockSyncStarted(initialStockSyncState);
  const failed = stockSyncFailed(new Error('record invalid'));
  assert.equal(syncing.phase, 'syncing');
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.stale, true);
  assert.match(failed.message, /mungkin tidak terbaru/);

  const recoveredStock = normalizeStockBatch([stockRecord()]);
  const recovered = recoveredStock.length > 0 ? stockSyncSucceeded() : failed;
  assert.equal(recovered.phase, 'synced');
  assert.equal(recovered.stale, false);
});

test('rejects an older read after a newer read starts and applies only the latest revision', async () => {
  const coordinator = createLatestReadCoordinator();
  const versions = new Map<string, number>([[JSON.stringify(['CENTER', 'stock', 'item']), 1]]);
  let resolveOld!: (value: number) => void;
  const oldRequest = coordinator.begin();
  const oldRead = runReadRequest(() => new Promise<number>(resolve => { resolveOld = resolve; }), oldRequest.isCurrent, [oldRequest.signal], 1000)
    .then(value => {
      applyRevisionSnapshot(versions, 'CENTER', 'stock', [{document_id: 'item', revision: value}], oldRequest.isCurrent, 'CENTER');
      return value;
    });

  await Promise.resolve();
  const latestRequest = coordinator.begin();
  await assert.rejects(oldRead, StaleReadError);
  assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 1);

  const latestRevision = await runReadRequest(async () => 3, latestRequest.isCurrent, [latestRequest.signal], 1000);
  applyRevisionSnapshot(versions, 'CENTER', 'stock', [{document_id: 'item', revision: latestRevision}], latestRequest.isCurrent, 'CENTER');
  resolveOld(2);
  await Promise.resolve();
  assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 3);
});

test('cancels a stale request and settles its promise without waiting for the network', async () => {
  const coordinator = createLatestReadCoordinator();
  const oldRequest = coordinator.begin();
  let settled = false;
  const pending = runReadRequest(() => new Promise<string>(() => {}), oldRequest.isCurrent, [oldRequest.signal], 1000)
    .finally(() => { settled = true; });

  coordinator.begin();
  await assert.rejects(pending, StaleReadError);
  assert.equal(settled, true);
});

test('rejects a read when the warehouse context changes during fetch', async () => {
  const coordinator = createLatestReadCoordinator();
  let activeWarehouse = 'WH-A';
  const request = coordinator.begin(() => activeWarehouse === 'WH-A');
  const pending = runReadRequest(() => new Promise<string>(() => {}), request.isCurrent, [request.signal], 1000);

  activeWarehouse = 'WH-B';
  coordinator.invalidate();
  await assert.rejects(pending, StaleReadError);
});

test('settles network errors and timeouts explicitly', async () => {
  await assert.rejects(
    runReadRequest(async () => { throw new Error('network unavailable'); }, () => true, [], 1000),
    /network unavailable/
  );
  await assert.rejects(
    runReadRequest(() => new Promise<string>(() => {}), () => true, [], 5),
    ReadTimeoutError
  );
});

test('does not apply revisions when result validation fails or request is stale', () => {
  const versions = new Map<string, number>([[JSON.stringify(['CENTER', 'stock', 'item']), 4]]);
  const invalidBatch = [stockRecord(), stockRecord({qty: Number.NaN})];
  assert.throws(() => normalizeStockBatch(invalidBatch), /Dokumen stok ke-2 tidak valid/);
  assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 4);

  assert.throws(
    () => applyRevisionSnapshot(versions, 'CENTER', 'stock', [{document_id: 'item', revision: 5}], () => false, 'CENTER'),
    StaleReadError
  );
  assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 4);
});

test('applies revisions only for a valid current response and active warehouse', () => {
  const versions = new Map<string, number>([[JSON.stringify(['WH-A', 'stock', 'item']), 1]]);
  const result = normalizeStockBatch([stockRecord()]);
  assert.equal(result.length, 1);

  applyRevisionSnapshot(
    versions,
    'WH-A',
    'stock',
    [{document_id: 'item', revision: 2}],
    () => true,
    'WH-A'
  );

  assert.equal(versions.get(JSON.stringify(['WH-A', 'stock', 'item'])), 2);
});

test('publishes a validated snapshot after its revision is visible and marks success afterward', () => {
  const versions = new Map<string, number>([[JSON.stringify(['CENTER', 'stock', 'item']), 1]]);
  let success = false;
  const order: string[] = [];

  publishSnapshotWithRevisions(
    versions,
    'CENTER',
    'stock',
    [{document_id: 'item', revision: 2}],
    () => true,
    'CENTER',
    () => {
      order.push('callback');
      assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 2);
      assert.equal(success, false);
    },
    () => {
      order.push('success');
      success = true;
    }
  );

  assert.deepEqual(order, ['callback', 'success']);
  assert.equal(success, true);
});

test('rolls back revision and does not publish success when snapshot callback throws', () => {
  const versions = new Map<string, number>([[JSON.stringify(['CENTER', 'stock', 'item']), 1]]);
  let success = false;

  assert.throws(() => publishSnapshotWithRevisions(
    versions,
    'CENTER',
    'stock',
    [{document_id: 'item', revision: 2}],
    () => true,
    'CENTER',
    () => { throw new Error('consumer failed'); },
    () => { success = true; }
  ), /consumer failed/);

  assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 1);
  assert.equal(success, false);
});

test('reentrant callback reads the newly published revision', () => {
  const versions = new Map<string, number>([[JSON.stringify(['CENTER', 'stock', 'item']), 1]]);
  let observedRevision: number | undefined;

  publishSnapshotWithRevisions(
    versions,
    'CENTER',
    'stock',
    [{document_id: 'item', revision: 7}],
    () => true,
    'CENTER',
    () => {
      observedRevision = versions.get(JSON.stringify(['CENTER', 'stock', 'item']));
    }
  );

  assert.equal(observedRevision, 7);
});

test('keeps status unsuccessful if the required post-publish step throws', () => {
  const versions = new Map<string, number>([[JSON.stringify(['CENTER', 'stock', 'item']), 1]]);
  let success = false;

  assert.throws(() => publishSnapshotWithRevisions(
    versions,
    'CENTER',
    'stock',
    [{document_id: 'item', revision: 2}],
    () => true,
    'CENTER',
    () => {},
    () => { throw new Error('required stage failed'); }
  ), /required stage failed/);

  assert.equal(versions.get(JSON.stringify(['CENTER', 'stock', 'item'])), 1);
  assert.equal(success, false);
});

test('ends loading state when an in-flight request is cancelled', async () => {
  const coordinator = createLatestReadCoordinator();
  const request = coordinator.begin();
  let loading = true;
  const operation = runReadRequest(() => new Promise<string>(() => {}), request.isCurrent, [request.signal], 1000)
    .finally(() => { loading = false; });

  coordinator.invalidate();
  await assert.rejects(operation, StaleReadError);
  assert.equal(loading, false);
});
