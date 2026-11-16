import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findActiveBasketConflicts,
  formatBasketConflictSummary,
  prepareSortingUpdates,
  selectSortLoadCandidates
} from '../src/utils/orderSorting.ts';

function sampleItem(overrides = {}) {
  return {
    id: 'row-1',
    referenceNumber: 'ORD-001',
    skuId: 'SKU-1',
    skuName: 'Produk 1',
    qty: 1,
    expiredDate: '01/01/2030',
    location: 'A1',
    timestamp: '2026-11-15T00:00:00.000Z',
    scanned: false,
    status: 'Pending',
    picked: true,
    stockDeducted: true,
    shipped: false,
    basketNumber: 'GB-01',
    ...overrides
  };
}

test('findActiveBasketConflicts blocks baskets still in Packing or Picking/Sorting queue and frees Completed/shipped baskets', () => {
  const history = [
    sampleItem({
      id: 'packing-1',
      referenceNumber: 'ORD-PACK-2',
      basketNumber: 'A2',
      sortedAt: '2026-11-15T08:00:00.000Z',
      sortedBy: 'Packer 1'
    }),
    sampleItem({
      id: 'picking-1',
      referenceNumber: 'ORD-PICK-1',
      basketNumber: 'GB-99',
      sortedAt: undefined,
      sortedBy: undefined
    }),
    sampleItem({
      id: 'completed-1',
      referenceNumber: 'ORD-DONE-1',
      status: 'Completed',
      shipped: true,
      basketNumber: 'B1',
      sortedAt: '2026-11-14T10:00:00.000Z',
      sortedBy: 'Packer 1'
    }),
    sampleItem({
      id: 'current-1',
      referenceNumber: 'ORD-CURR-1',
      basketNumber: 'A1'
    })
  ];

  // Batch ["A1", "A2"] conflicts on A2 (Packing), excludes own reference ORD-CURR-1 on A1
  const conflicts = findActiveBasketConflicts(history, ['a1', 'a2'], ['ORD-CURR-1']);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    { basketCode: conflicts[0].basketCode, referenceNumber: conflicts[0].referenceNumber, stage: conflicts[0].stage },
    { basketCode: 'A2', referenceNumber: 'ORD-PACK-2', stage: 'Packing' }
  );
  assert.match(formatBasketConflictSummary(conflicts), /A2 \(ORD-PACK-2 - Packing\)/);

  // Conflict against another batch in Picking / Sortir stage
  const pickingConflict = findActiveBasketConflicts(history, ['gb-99']);
  assert.equal(pickingConflict.length, 1);
  assert.equal(pickingConflict[0].stage, 'Picking / Sortir');

  // Completed / shipped basket code B1 is free to reuse
  const reusable = findActiveBasketConflicts(history, ['B1', 'B2'], ['ORD-CURR-1']);
  assert.equal(reusable.length, 0);
});

test('prepareSortingUpdates refuses saving sorting tasks whose basket code collides with Packing queue', () => {
  const activeOrder = sampleItem({
    id: 'line-curr',
    referenceNumber: 'ORD-CURR',
    basketNumber: 'GB-10',
    qty: 2
  });
  const packingOrder = sampleItem({
    id: 'line-pack',
    referenceNumber: 'ORD-PACKING',
    basketNumber: 'A1',
    sortedAt: '2026-11-15T09:00:00.000Z',
    sortedBy: 'Packer A'
  });
  const completedOrder = sampleItem({
    id: 'line-done',
    referenceNumber: 'ORD-DONE',
    status: 'Completed',
    shipped: true,
    basketNumber: 'B1',
    sortedAt: '2026-11-14T09:00:00.000Z',
    sortedBy: 'Packer A'
  });

  // Saving with A1 fails because ORD-PACKING still holds A1 in Packing queue
  assert.throws(
    () =>
      prepareSortingUpdates(
        [activeOrder, packingOrder],
        [{ referenceNumber: 'ORD-CURR', masterBasket: 'GB-10', basketCode: 'A1', items: [activeOrder], counts: { 'line-curr': 2 } }],
        'Packer B'
      ),
    /Kode keranjang masih aktif digunakan order lain.*A1 \(ORD-PACKING - Packing\)/
  );

  // Saving with B1 succeeds because ORD-DONE is Completed & shipped
  const updates = prepareSortingUpdates(
    [activeOrder, packingOrder, completedOrder],
    [{ referenceNumber: 'ORD-CURR', masterBasket: 'GB-10', basketCode: 'B1', items: [activeOrder], counts: { 'line-curr': 2 } }],
    'Packer B'
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].basketNumber, 'B1');
});

test('selectSortLoadCandidates excludes already-sorted and unpicked orders when loading master basket', () => {
  const sortedOld = {
    referenceNumber: 'ORD-OLD-1',
    basketNumber: 'K1',
    masterBasketNumber: '121',
    isPicked: true,
    isSorted: true,
  };
  const pickingOnly = {
    referenceNumber: 'ORD-PICK-2',
    basketNumber: '121',
    masterBasketNumber: '121',
    isPicked: false,
    isSorted: false,
  };
  const newReady = {
    referenceNumber: 'ORD-NEW-3',
    basketNumber: '121',
    masterBasketNumber: '121',
    isPicked: true,
    isSorted: false,
  };

  // Already sorted batch in 121 waiting in Packing -> returns 0 readyOrders + alreadySortedCount=1
  const doneSel = selectSortLoadCandidates([sortedOld], '121');
  assert.equal(doneSel.readyOrders.length, 0);
  assert.equal(doneSel.alreadySortedCount, 1);
  assert.equal(doneSel.unpickedCount, 0);

  // Still in Picking -> blocked with unpickedCount=1
  const pickingSel = selectSortLoadCandidates([pickingOnly], '121');
  assert.equal(pickingSel.readyOrders.length, 0);
  assert.equal(pickingSel.unpickedCount, 1);

  // Reused master basket 121 with new picked wave alongside old sorted orders -> ONLY newReady loads
  const mixedSel = selectSortLoadCandidates([sortedOld, pickingOnly, newReady], '121');
  assert.deepEqual(mixedSel.readyOrders.map(o => o.referenceNumber), ['ORD-NEW-3']);
});
