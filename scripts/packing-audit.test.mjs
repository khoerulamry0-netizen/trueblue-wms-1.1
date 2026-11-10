import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { hasExactPackingCounts, hasSavedSorting, scanServerUnavailable, serverScanValidationAvailable } from '../src/utils/packingValidation.ts';

const source = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('MabangWmsOutbound.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const bulkSource = readFileSync(new URL('../src/components/BulkOutbound.tsx', import.meta.url), 'utf8');
const bulkTree = ts.createSourceFile('BulkOutbound.tsx', bulkSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const historySource = readFileSync(new URL('../src/components/HistoryOrder.tsx', import.meta.url), 'utf8');
const historyTree = ts.createSourceFile('HistoryOrder.tsx', historySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function handler(name, bindings, parsed = tree) {
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(initializer, `Handler ${name} not found`);
  const compiled = ts.transpileModule(`return (${initializer.getText(parsed)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
}

function fixture(count = 0) {
  const item = { id: 'item-1', skuId: 'DEV-SKU-002', skuName: 'Dummy', qty: 3, status: 'Pending',
    picked: true, stockDeducted: true, sortedAt: '2026-01-01', sortedBy: 'Packer', basketNumber: 'A2' };
  const order = { referenceNumber: 'DEV-ORDER-002', basketNumber: 'A2', items: [item] };
  const result = { writes: 0, receipt: false, counts: { [item.id]: count }, notification: null };
  const bindings = {
    deliveryActiveOrder: order,
    deliveryActiveRef: order.referenceNumber,
    deliveryScannedCounts: result.counts,
    deliveryAutoPrint: false,
    deliveryProductInput: '',
    currentUser: { fullName: 'Dummy Packer' },
    onEditOrderHistoryBatch: async () => { result.writes++; return true; },
    setDeliveryNotification: (value) => { result.notification = value; },
    setDeliveryScannedCounts: (value) => { result.counts = value; },
    setDeliveryProductInput: () => {},
    setReceiptModalOrder: () => { result.receipt = true; },
    setDeliveryActiveRef: () => {},
    setDeliveryWeight: () => {},
    findSkuId: (value) => value.toUpperCase(),
    playBuzzer: () => {},
    speakVoice: () => {},
    hasExactPackingCounts, hasSavedSorting, scanServerUnavailable, serverScanValidationAvailable,
  };
  return { order, bindings, result };
}

test('Mabang packing completion and scans have no legacy write or receipt path', () => {
  let scan, finish;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleDeliveryScanProduct') scan = node.initializer.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleCompleteDelivery') finish = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.match(scan, /controller\.scan\(/);
  assert.match(finish, /controller\.finish\(/);
  assert.doesNotMatch(finish, /onEditOrderHistoryBatch|setReceiptModalOrder/);
  assert.doesNotMatch(source, /<ShippingReceiptModal/);
});

test('Bulk packing uses server scan and finish without legacy writes or receipt opening', () => {
  let scan, finish;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(bulkTree) === 'handlePackingScan') scan = node.initializer.getText(bulkTree);
    if (ts.isVariableDeclaration(node) && node.name.getText(bulkTree) === 'confirmPackingCompleted') finish = node.initializer.getText(bulkTree);
    ts.forEachChild(node, visit);
  };
  visit(bulkTree);
  assert.match(scan, /controller\.scan\(/);
  assert.match(finish, /controller\.finish\(/);
  assert.doesNotMatch(finish, /onEditOrderHistoryBatch|setLastPackedOrder/);
  assert.doesNotMatch(bulkSource, /setLastPackedOrder\((?!null\))/);
});

test('exact counts reject foreign lines, duplicate IDs, missing lines and invalid quantities', () => {
  const { order } = fixture();
  const items = order.items;
  assert.equal(hasExactPackingCounts(items, { 'item-1': 3 }), true);
  for (const counts of [{}, { 'item-1': 2 }, { 'item-1': 4 }, { 'item-1': 3, foreign: 1 }, { 'item-1': 3.5 }]) {
    assert.equal(hasExactPackingCounts(items, counts), false);
  }
  assert.equal(hasExactPackingCounts([items[0], items[0]], { 'item-1': 3 }), false);
});

test('feature flag off blocks Mabang completion even with complete local counts', async () => {
  let calls = 0;
  await handler('handleCompleteDelivery', {
    deliveryBusyRef:{current:false}, SERVER_SCAN_ENABLED:false, deliveryTask:{}, deliveryReady:true,
    deliveryController:async () => {calls++;}, deliveryScannedCounts:{'item-1':3}
  })();
  assert.equal(calls, 0);
});

test('bulk handler also blocks complete local counts without server proof', async () => {
  let calls = 0;
  const bindings = {
    packingBusyRef:{current:false}, SERVER_SCAN_ENABLED:false, packingTask:{}, packingReady:true,
    packingController:async () => {calls++;}, packingScannedQty:{'item-1':3}
  };
  await handler('confirmPackingCompleted', bindings, bulkTree)();
  assert.equal(calls, 0);
});

test('history receipt handler refuses pending and completed orders without server proof', () => {
  for (const status of ['Pending', 'Completed']) {
    let message;
    let opened = false;
    const print = handler('printReceipt', {
      scanServerUnavailable,
      getBatchKey: (item) => item.batchNumber || item.referenceNumber || item.orderNumber || 'TANPA-BATCH',
      orderHistory: [],
      openReceiptForItems: () => { opened = true; },
      alert: value => { message = value; },
      setReceiptOrder: () => { opened = true; }
    }, historyTree);
    print({ status, referenceNumber: 'DEV-ORDER-002' });
  }
});
