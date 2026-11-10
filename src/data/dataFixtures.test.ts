import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BARCODE_MAP,
  findSkuId,
  getBarcodeForSku,
  REVERSE_BARCODE_MAP,
  updateDynamicBarcodeRegistry,
} from './barcodeMap';
import {
  ALL_WAREHOUSE_SKUS,
  DCC_DAYS,
  DCC_SCHEDULE,
  generateBalancedDccSchedule,
  getDccScheduleByDay,
} from './dccSchedule';

test('barcode fixtures keep the static mapping API with synthetic unique values', () => {
  const entries = Object.entries(BARCODE_MAP);

  assert.equal(entries.length, 236);
  assert.equal(new Set(entries.map(([, barcode]) => barcode)).size, entries.length);

  for (const [sku, barcode] of entries) {
    assert.match(sku, /^DEV-SKU-\d{3}$/);
    assert.match(barcode, /^DEV-BC-\d{3}$/);
    assert.equal(REVERSE_BARCODE_MAP[barcode], sku);
    assert.equal(findSkuId(barcode), sku);
    assert.equal(getBarcodeForSku(sku), barcode);
  }
});

test('dynamic barcode registry still takes precedence over synthetic defaults', () => {
  updateDynamicBarcodeRegistry([{ skuId: 'DEV-SKU-001', barcode: 'DEV-BC-CUSTOM-001' }]);

  try {
    assert.equal(getBarcodeForSku('DEV-SKU-001'), 'DEV-BC-CUSTOM-001');
    assert.equal(findSkuId('DEV-BC-CUSTOM-001'), 'DEV-SKU-001');
  } finally {
    updateDynamicBarcodeRegistry([]);
  }
});

test('DCC fixture preserves 260 unique SKUs and a balanced five-day schedule', () => {
  assert.equal(ALL_WAREHOUSE_SKUS.length, 260);
  assert.equal(new Set(ALL_WAREHOUSE_SKUS).size, 260);
  assert.ok(ALL_WAREHOUSE_SKUS.every((sku) => /^DEV-SKU-\d{3}$/.test(sku)));
  assert.equal(DCC_SCHEDULE.length, DCC_DAYS.length);

  const scheduledSkus = DCC_SCHEDULE.flatMap(({ skus }) => skus);
  assert.equal(scheduledSkus.length, 260);
  assert.deepEqual(new Set(scheduledSkus), new Set(ALL_WAREHOUSE_SKUS));
  assert.ok(DCC_SCHEDULE.every(({ skus }) => skus.length === 52));
  assert.deepEqual(getDccScheduleByDay('senin'), DCC_SCHEDULE[0].skus);
  assert.deepEqual(generateBalancedDccSchedule().map(({ skus }) => skus.length), [52, 52, 52, 52, 52]);
});
