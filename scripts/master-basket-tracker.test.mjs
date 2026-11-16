import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMasterBasketMonitorData,
  doesMonitorOrderMatchQuery,
  resolveItemBasketCodes,
  summarizeOrderBaskets,
  validateMasterBasketUpdate
} from '../src/utils/masterBasketTracker.ts';
import { prepareSortingUpdates } from '../src/utils/orderSorting.ts';

function makeOutboundItem(overrides = {}) {
  return {
    id: 'row-1',
    referenceNumber: 'REF-001',
    orderNumber: 'ORD-001',
    batchNumber: 'BATCH-1',
    customerName: 'Budi Santoso',
    skuId: 'SKU-A',
    skuName: 'Produk A',
    qty: 2,
    expiredDate: '01/01/2030',
    location: 'A1',
    timestamp: '2026-11-15T08:00:00.000Z',
    scanned: false,
    status: 'Pending',
    picked: true,
    pickedBy: 'Picker Ani',
    stockDeducted: true,
    shipped: false,
    basketNumber: 'GB-01',
    masterBasketNumber: 'GB-01',
    ...overrides
  };
}

test('resolveItemBasketCodes & prepareSortingUpdates preserve masterBasketNumber after sorting', () => {
  const preSort = makeOutboundItem({ basketNumber: 'GB-01', masterBasketNumber: 'GB-01' });
  assert.deepEqual(resolveItemBasketCodes(preSort), { masterBasket: 'GB-01', sortBasket: '' });

  // Explicit masterBasketNumber is preserved while basketNumber changes to child basket B1
  const updates = prepareSortingUpdates(
    [preSort],
    [{ referenceNumber: 'REF-001', masterBasket: 'GB-01', basketCode: 'B1', items: [preSort], counts: { 'row-1': 2 } }],
    'Packer Rudi'
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].basketNumber, 'B1');
  assert.equal(updates[0].masterBasketNumber, 'GB-01');
  assert.deepEqual(resolveItemBasketCodes(updates[0]), { masterBasket: 'GB-01', sortBasket: 'B1' });

  // Backfill fallback for in-flight orders picked prior to masterBasketNumber field rollout
  const legacyPreSort = makeOutboundItem({
    id: 'row-legacy',
    referenceNumber: 'REF-LEGACY',
    basketNumber: 'GB-OLD',
    masterBasketNumber: undefined
  });
  const legacyUpdates = prepareSortingUpdates(
    [legacyPreSort],
    [{ referenceNumber: 'REF-LEGACY', masterBasket: 'GB-OLD', basketCode: 'B2', items: [legacyPreSort], counts: { 'row-legacy': 2 } }],
    'Packer Rudi'
  );
  assert.equal(legacyUpdates[0].basketNumber, 'B2');
  assert.equal(legacyUpdates[0].masterBasketNumber, 'GB-OLD');
  assert.deepEqual(summarizeOrderBaskets(legacyUpdates), {
    masterBaskets: ['GB-OLD'],
    sortBaskets: ['B2']
  });
});

test('buildMasterBasketMonitorData finds post-sorting orders by order number, basket code, picker, and unassigned orders', () => {
  const history = [
    makeOutboundItem({
      id: 'picking-1',
      referenceNumber: 'REF-PICK-1',
      orderNumber: 'ORD-PICK-1',
      picked: false,
      pickingBy: 'Picker Ani',
      pickedBy: undefined,
      basketNumber: 'GB-01',
      masterBasketNumber: 'GB-01',
      timestamp: '2026-11-15T09:00:00.000Z'
    }),
    makeOutboundItem({
      id: 'wait-sort-1',
      referenceNumber: 'REF-WAIT-1',
      orderNumber: 'ORD-WAIT-1',
      picked: true,
      pickedBy: 'Picker Ani',
      basketNumber: 'GB-01',
      masterBasketNumber: 'GB-01',
      timestamp: '2026-11-15T09:05:00.000Z'
    }),
    makeOutboundItem({
      id: 'sorted-1',
      referenceNumber: 'REF-SORTED-1',
      orderNumber: 'ORD-SORTED-1',
      picked: true,
      pickedBy: 'PickerAni2',
      basketNumber: 'A1',
      masterBasketNumber: 'GB-02',
      sortedAt: '2026-11-15T09:10:00.000Z',
      sortedBy: 'Sorter Rina',
      timestamp: '2026-11-15T09:10:00.000Z'
    }),
    makeOutboundItem({
      id: 'unassigned-1',
      referenceNumber: 'REF-NO-BASKET',
      orderNumber: 'ORD-NOBASKET',
      picked: false,
      pickedBy: undefined,
      pickingBy: undefined,
      basketNumber: '',
      masterBasketNumber: '',
      timestamp: '2026-11-15T09:15:00.000Z'
    }),
    makeOutboundItem({
      id: 'completed-1',
      referenceNumber: 'REF-DONE',
      orderNumber: 'ORD-DONE',
      status: 'Completed',
      shipped: true,
      basketNumber: 'C1',
      masterBasketNumber: 'GB-99',
      sortedAt: '2026-11-14T10:00:00.000Z',
      sortedBy: 'Sorter Rina'
    })
  ];

  const all = buildMasterBasketMonitorData(history, '');
  assert.equal(all.groups.length, 2);
  assert.equal(all.matchingUnassigned.length, 0);

  const gb02 = all.groups.find(g => g.basketCode === 'GB-02');
  assert.ok(gb02);
  assert.equal(gb02.canRenameGroup, false);
  assert.equal(gb02.stageCounts.readyPacking, 1);
  assert.equal(gb02.orders[0].masterBasket, 'GB-02');
  assert.equal(gb02.orders[0].sortBasket, 'A1');

  const gb01 = all.groups.find(g => g.basketCode === 'GB-01');
  assert.ok(gb01);
  assert.equal(gb01.canRenameGroup, true);
  assert.deepEqual(gb01.stageCounts, { picking: 1, waitingSort: 1, readyPacking: 0 });

  // Search sorted order by orderNumber -> reveals parent Keranjang Induk GB-02 & sort basket A1
  const byOrder = buildMasterBasketMonitorData(history, 'ORD-SORTED-1');
  assert.equal(byOrder.groups.length, 1);
  assert.equal(byOrder.groups[0].basketCode, 'GB-02');
  assert.equal(doesMonitorOrderMatchQuery(byOrder.groups[0].orders[0], 'ord-sorted-1'), true);

  // Search by child sort basket A1 -> still maps back to GB-02
  const byChildBasket = buildMasterBasketMonitorData(history, 'a1');
  assert.equal(byChildBasket.groups.length, 1);
  assert.equal(byChildBasket.groups[0].basketCode, 'GB-02');

  // Search by picker name -> finds Picker Ani batch GB-01
  const byPicker = buildMasterBasketMonitorData(history, 'Picker Ani');
  assert.equal(byPicker.groups.length, 1);
  assert.equal(byPicker.groups[0].basketCode, 'GB-01');

  // Search unassigned order -> surfaces in matchingUnassigned
  const unassignedSearch = buildMasterBasketMonitorData(history, 'ORD-NOBASKET');
  assert.equal(unassignedSearch.groups.length, 0);
  assert.equal(unassignedSearch.matchingUnassigned.length, 1);
  assert.equal(unassignedSearch.matchingUnassigned[0].referenceNumber, 'REF-NO-BASKET');
});

test('validateMasterBasketUpdate guards sorted orders, active Packing conflicts, and mode rules', () => {
  const history = [
    makeOutboundItem({
      id: 'u1',
      referenceNumber: 'REF-U1',
      basketNumber: 'GB-01',
      masterBasketNumber: 'GB-01'
    }),
    makeOutboundItem({
      id: 'u2',
      referenceNumber: 'REF-U2',
      basketNumber: 'GB-02',
      masterBasketNumber: 'GB-02'
    }),
    makeOutboundItem({
      id: 's1',
      referenceNumber: 'REF-S1',
      basketNumber: 'A1',
      masterBasketNumber: 'GB-03',
      sortedAt: '2026-11-15T10:00:00.000Z',
      sortedBy: 'Sorter X'
    }),
    makeOutboundItem({
      id: 'done-1',
      referenceNumber: 'REF-DONE',
      status: 'Completed',
      shipped: true,
      basketNumber: 'B1',
      masterBasketNumber: 'GB-99',
      sortedAt: '2026-11-14T10:00:00.000Z',
      sortedBy: 'Sorter X'
    })
  ];

  // Empty basket rejected
  const emptyRes = validateMasterBasketUpdate(history, ['REF-U1'], '   ', 'rename_group');
  assert.ok('error' in emptyRes);

  // Sorted order cannot have master basket renamed
  const sortedRes = validateMasterBasketUpdate(history, ['REF-S1'], 'JJ1', 'rename_group');
  assert.ok('error' in sortedRes);
  assert.match(sortedRes.error, /Sudah|Sortir/i);

  // Completed/shipped order blocked
  const doneRes = validateMasterBasketUpdate(history, ['REF-DONE'], 'JJ1', 'move_order');
  assert.ok('error' in doneRes);

  // Active Packing child basket A1 blocked in both modes
  const packConflictRename = validateMasterBasketUpdate(history, ['REF-U1'], 'a1', 'rename_group');
  assert.ok('error' in packConflictRename);
  assert.match(packConflictRename.error, /Packing/);

  const packConflictMove = validateMasterBasketUpdate(history, ['REF-U1'], 'A1', 'move_order');
  assert.ok('error' in packConflictMove);
  assert.match(packConflictMove.error, /Packing/);

  // rename_group rejects merging into another active batch GB-02
  const renameMerge = validateMasterBasketUpdate(history, ['REF-U1'], 'gb-02', 'rename_group');
  assert.ok('error' in renameMerge);
  assert.match(renameMerge.error, /dipakai batch lain/);

  // rename_group accepts unused code jj2 and uppercases it
  assert.deepEqual(
    validateMasterBasketUpdate(history, ['REF-U1'], ' jj2 ', 'rename_group'),
    { cleanBasket: 'JJ2' }
  );

  // move_order allows moving an unsorted order into existing unsorted batch GB-02
  assert.deepEqual(
    validateMasterBasketUpdate(history, ['REF-U1'], 'gb-02', 'move_order'),
    { cleanBasket: 'GB-02' }
  );
});

import { isOrderClaimedByAnotherPicker, prepareOrderSessionUpdates } from '../src/utils/orderSession.ts';
import { prepareOrderCompletion } from '../src/utils/orderCompletion.ts';

test('prepareOrderSessionUpdates normalizes and validates masterBasketNumber alongside basketNumber', () => {
  const orders = [
    makeOutboundItem({
      referenceNumber: 'REF-SESS-1',
      basketNumber: 'GB-01',
      masterBasketNumber: 'GB-01'
    })
  ];

  const renamed = prepareOrderSessionUpdates(
    orders,
    ['REF-SESS-1'],
    { basketNumber: ' jj-09 ', masterBasketNumber: ' jj-09 ' }
  );
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].basketNumber, 'JJ-09');
  assert.equal(renamed[0].masterBasketNumber, 'JJ-09');

  const cleared = prepareOrderSessionUpdates(orders, 'REF-SESS-1', { masterBasketNumber: null });
  assert.equal('masterBasketNumber' in cleared[0], false);
  assert.equal(cleared[0].basketNumber, 'GB-01');

  assert.throws(
    () => prepareOrderSessionUpdates(orders, ['REF-SESS-1'], { masterBasketNumber: '   ' }),
    /Kode keranjang harus berisi 1–128 karakter/
  );
});

test('isOrderClaimedByAnotherPicker & prepareOrderSessionUpdates prevent multi-picker claim overlap without breaking Admin corrections', () => {
  const unclaimed = makeOutboundItem({
    referenceNumber: 'REF-FREE',
    picked: false,
    pickingBy: undefined,
    basketNumber: '',
    masterBasketNumber: ''
  });
  const claimedByPicker1 = makeOutboundItem({
    referenceNumber: 'REF-P1',
    picked: false,
    pickingBy: 'Picker 1',
    basketNumber: 'MB-01',
    masterBasketNumber: 'MB-01'
  });
  const boundWithoutPickerName = makeOutboundItem({
    referenceNumber: 'REF-BOUND-ANON',
    picked: false,
    pickingBy: undefined,
    basketNumber: 'MB-09',
    masterBasketNumber: 'MB-09'
  });

  assert.equal(isOrderClaimedByAnotherPicker(unclaimed, 'Picker 2'), false);
  assert.equal(isOrderClaimedByAnotherPicker(claimedByPicker1, 'Picker 2'), true);
  assert.equal(isOrderClaimedByAnotherPicker(claimedByPicker1, 'Picker 1'), false);
  assert.equal(isOrderClaimedByAnotherPicker(claimedByPicker1, ''), true);
  assert.equal(isOrderClaimedByAnotherPicker(boundWithoutPickerName, 'Picker 2'), true);

  // Picker 2 cannot overwrite Picker 1's active picking/basket session
  assert.throws(
    () =>
      prepareOrderSessionUpdates([claimedByPicker1], ['REF-P1'], {
        basketNumber: 'MB-02',
        masterBasketNumber: 'MB-02',
        pickingBy: 'Picker 2',
        pickingStartedAt: '2026-11-15T09:00:00.000Z'
      }),
    /sedang diambil oleh "Picker 1"/
  );

  // Picker cannot overwrite already-bound basket even when pickingBy was empty
  assert.throws(
    () =>
      prepareOrderSessionUpdates([boundWithoutPickerName], ['REF-BOUND-ANON'], {
        basketNumber: 'MB-02',
        masterBasketNumber: 'MB-02',
        pickingBy: 'Picker 2',
        pickingStartedAt: '2026-11-15T09:00:00.000Z'
      }),
    /sudah terikat ke keranjang MB-09/
  );

  // Picker cannot re-bind an order that was already picked
  const alreadyPicked = makeOutboundItem({
    referenceNumber: 'REF-PICKED',
    picked: true,
    pickingBy: undefined,
    basketNumber: 'MB-OLD',
    masterBasketNumber: 'MB-OLD'
  });
  assert.throws(
    () =>
      prepareOrderSessionUpdates([alreadyPicked], ['REF-PICKED'], {
        basketNumber: 'MB-NEW',
        masterBasketNumber: 'MB-NEW',
        pickingBy: 'Picker 2',
        pickingStartedAt: '2026-11-15T09:00:00.000Z'
      }),
    /sudah selesai dipick/
  );

  // Admin correction in MasterBasketMonitorModal omits pickingBy and MUST still succeed
  const adminRenamed = prepareOrderSessionUpdates([claimedByPicker1], ['REF-P1'], {
    basketNumber: 'JJ2',
    masterBasketNumber: 'JJ2'
  });
  assert.equal(adminRenamed[0].basketNumber, 'JJ2');
  assert.equal(adminRenamed[0].masterBasketNumber, 'JJ2');
  assert.equal(adminRenamed[0].pickingBy, 'Picker 1');

  // Explicit unlock clears pickingBy so another operator can take over
  const released = prepareOrderSessionUpdates([claimedByPicker1], ['REF-P1'], {
    pickingBy: null,
    pickingStartedAt: null
  });
  assert.equal('pickingBy' in released[0], false);
  assert.equal('pickingStartedAt' in released[0], false);
});

test('prepareOrderCompletion skips redundant stock writes when Packing leaves net stock qty unchanged', () => {
  const stock = [
    {
      id: 'stk-1',
      skuId: 'SKU-A',
      skuName: 'Produk A',
      qty: 98,
      qtyCtn: 0,
      qtyInner: 0,
      qtyLoose: 98,
      location: 'A1',
      expiredDate: '01/01/2030',
      status: 'Good',
      warehouseId: 'WH-CENTRAL',
      __wms_revision: 10
    },
    {
      id: 'stk-2',
      skuId: 'SKU-A',
      skuName: 'Produk A',
      qty: 50,
      qtyCtn: 0,
      qtyInner: 0,
      qtyLoose: 50,
      location: 'B1',
      expiredDate: '01/01/2030',
      status: 'Good',
      warehouseId: 'WH-CENTRAL',
      __wms_revision: 5
    }
  ];

  // Unpicked -> Picking deducts 2 from A1 and MUST emit stk-1 in changedStock
  const unpickedRow = makeOutboundItem({
    id: 'ord-pick-1',
    referenceNumber: 'REF-PACK-1',
    picked: false,
    stockDeducted: false,
    __wms_revision: 1
  });
  const pickPlan = prepareOrderCompletion(stock, [unpickedRow], [
    { refNum: 'REF-PACK-1', updatedItems: [{ ...unpickedRow, picked: true, isPicked: true }], isPicking: true }
  ]);
  assert.equal(pickPlan.changedStock.length, 1);
  assert.equal(pickPlan.changedStock[0].id, 'stk-1');
  assert.equal(pickPlan.changedStock[0].qty, 96);

  // Already-deducted Packing (isPicking: false) with unchanged allocation MUST emit 0 changedStock rows
  const pickedRow = makeOutboundItem({
    id: 'ord-pack-1',
    referenceNumber: 'REF-PACK-2',
    picked: true,
    stockDeducted: true,
    __wms_revision: 2
  });
  const packPlan = prepareOrderCompletion(stock, [pickedRow], [
    { refNum: 'REF-PACK-2', updatedItems: [{ ...pickedRow, status: 'Completed', scanned: true, packed: true }], isPicking: false }
  ]);
  assert.equal(packPlan.changedStock.length, 0);
  assert.equal(packPlan.orders[0].status, 'Completed');
  assert.equal(packPlan.orders[0].stockDeducted, true);

  // Moving an already-deducted order from A1 -> B1 during edit still updates both stock rows
  const reallocatePlan = prepareOrderCompletion(stock, [pickedRow], [
    { refNum: 'REF-PACK-2', updatedItems: [{ ...pickedRow, location: 'B1' }], isPicking: true }
  ]);
  assert.deepEqual(
    reallocatePlan.changedStock.map(s => ({ id: s.id, qty: s.qty })).sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'stk-1', qty: 100 },
      { id: 'stk-2', qty: 48 }
    ]
  );
});
