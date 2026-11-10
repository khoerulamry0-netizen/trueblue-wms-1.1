import assert from 'node:assert/strict';
import { branchId, buildSeedDocuments, operators, warehouses } from './local-seed-data.mjs';

const docs = buildSeedDocuments('2026-01-01T00:00:00.000Z');
const byCollection = (collection) => docs.filter((document) => document.collection_name === collection);
const skuIds = byCollection('catalog').map((document) => document.document_id);
const stock = byCollection('stock');
const orders = byCollection('orders');
const knownWarehouses = new Set(warehouses.map((warehouse) => warehouse.id));

assert.equal(branchId, 'DEV_LOCAL');
assert.equal(warehouses.length, 2);
assert.equal(operators.length, 2);
assert.deepEqual(operators.map((operator) => operator.role), ['Picker', 'Packer']);
assert.equal(skuIds.length, 100);
assert.equal(new Set(skuIds).size, 100);
assert.equal(stock.length, 200);
assert.equal(orders.length, 100);
assert.equal(docs.length, 402);
assert(stock.every((document) => skuIds.includes(document.payload.skuId)));
for (const warehouseId of knownWarehouses) {
  assert.equal(stock.filter((document) => document.payload.warehouseId === warehouseId).length, 100);
}
assert(stock.every((document) => knownWarehouses.has(document.payload.warehouseId)));
assert(orders.every((document) => knownWarehouses.has(document.payload.warehouseId)));
assert(orders.every((document) => document.payload.status === 'Pending' && document.payload.stockDeducted === false));
assert(orders.every((document) => skuIds.includes(document.payload.skuId)));

console.log('Synthetic seed checks passed: 1 branch, 2 warehouses, 2 operators, 100 SKUs, 100 orders.');
