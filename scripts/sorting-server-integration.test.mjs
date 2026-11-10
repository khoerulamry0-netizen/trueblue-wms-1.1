import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createServerScanRpc } from '../src/utils/serverScanRpc.ts';
import { createSortingServerSession } from '../src/utils/sortingServerSession.ts';

function harness() {
  const entries = new Map();
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
  let sequence = 0;
  const events = [];
  let session;
  let state = 'open';
  let finishRequest = null;
  let lostResponse = false;
  let loseBeforeCommit = false;
  let offlineAfterLoss = false;
  let loseFinish = false;
  let offlineStatus = false;
  let gate;
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_order_scan_status') {
      if (offlineStatus) throw Error('offline');
      if (!session) return { data: null, error: { code: 'P0001', message: 'Sesi scan tidak ditemukan' } };
      return { data: {
        session, branch: 'BRANCH', reference: 'ORDER', phase: 'sorting', basket: 'A1', state,
        current: true, finish_request: finishRequest,
        counts: [{ document_id: 'line', sku: 'SKU', required: 2, scanned: events.length }],
        events: events.map(event => ({ request_id: event.id, input_code: event.code, document_id: 'line', sku: 'SKU' }))
      }, error: null };
    }
    if (name === 'start_order_scan') {
      session = args.p_session;
      return { data: { session, state }, error: null };
    }
    if (name === 'record_order_scan') {
      if (gate) await gate;
      if (loseBeforeCommit) { loseBeforeCommit = false; if (offlineAfterLoss) offlineStatus = true; throw Error('lost'); }
      if (args.p_code !== 'SKU' || (events.length === 2 && !events.some(e => e.id === args.p_request))) {
        return { data: null, error: { code: 'P0001', message: 'rejected' } };
      }
      if (!events.some(e => e.id === args.p_request)) events.push({ id: args.p_request, code: args.p_code });
      if (lostResponse) { lostResponse = false; if (offlineAfterLoss) offlineStatus = true; throw Error('lost'); }
      return { data: { document_id: 'line', sku: 'SKU' }, error: null };
    }
    if (name === 'finish_order_scan') {
      if (events.length !== 2) return { data: null, error: { code: 'P0001', message: 'incomplete' } };
      state = 'finished'; finishRequest = args.p_request;
      if (loseFinish) { loseFinish = false; offlineStatus = true; throw Error('lost'); }
      return { data: { session, phase: 'sorting', state }, error: null };
    }
    throw Error('unexpected RPC');
  };
  const api = createServerScanRpc(rpc, () => 'BRANCH');
  const controller = () => createSortingServerSession(api, storage, () => `id-${++sequence}`, 'BRANCH', 'actor', 'ORDER');
  return { controller, events, calls,
    lose: (offline = false) => { lostResponse = true; offlineAfterLoss = offline; },
    loseBefore: () => { loseBeforeCommit = true; offlineAfterLoss = true; },
    loseFinish: () => { loseFinish = true; },
    offline: value => { offlineStatus = value; },
    block: promise => { gate = promise; } };
}

test('valid scans use server progress; wrong SKU and excess leave counts unchanged', async () => {
  const h = harness(); const c = h.controller();
  assert.equal((await c.scan('A1', 'SKU')).counts[0].scanned, 1);
  await assert.rejects(c.scan('A1', 'BAD'), /menolak/);
  assert.equal((await c.scan('A1', 'SKU')).counts[0].scanned, 2);
  await assert.rejects(c.scan('A1', 'SKU'), /menolak/);
  assert.equal(h.events.length, 2);
  assert.equal((await c.finish('A1')).state, 'finished');
});

test('lost response checks server and refresh recovers pending request without duplicate', async () => {
  const h = harness(); let c = h.controller();
  await c.open('A1');
  h.lose();
  const original = h.events.length;
  assert.equal((await c.scan('A1', 'SKU')).counts[0].scanned, original + 1);
  assert.equal(h.events.length, 1);
  h.lose(true);
  await assert.rejects(c.scan('A1', 'SKU'), /belum diketahui/);
  assert.equal(h.events.length, 2);
  assert.equal(h.controller().hasPending(), true);
  h.offline(false);
  await assert.rejects(h.controller().scan('A1', 'SKU'), /Pulihkan sesi/);
  assert.equal(h.events.length, 2);
  assert.equal((await h.controller().open('A1')).counts[0].scanned, 2);
  assert.equal(h.controller().hasPending(), true);
  assert.equal((await h.controller().retry()).counts[0].scanned, 2);
  assert.equal(h.controller().hasPending(), false);
  assert.equal(h.calls.filter(call => call.name === 'record_order_scan').length, 2);
});

test('retry checks server first and reuses pending request ID after refresh', async () => {
  const h = harness(); const c = h.controller();
  await c.open('A1'); h.loseBefore();
  await assert.rejects(c.scan('A1', 'SKU'), /belum diketahui/);
  const first = h.calls.filter(call => call.name === 'record_order_scan')[0];
  h.offline(false);
  const restored = h.controller();
  assert.equal((await restored.retry()).counts[0].scanned, 1);
  const records = h.calls.filter(call => call.name === 'record_order_scan');
  assert.equal(records.length, 2);
  assert.equal(records[1].args.p_request, first.args.p_request);
  const retryIndex = h.calls.lastIndexOf(records[1]);
  assert.equal(h.calls[retryIndex - 1].name, 'get_order_scan_status');
});

test('parallel scan is refused before another request is sent', async () => {
  const h = harness(); const c = h.controller(); await c.open('A1');
  let release;
  h.block(new Promise(resolve => { release = resolve; }));
  const first = c.scan('A1', 'SKU');
  await assert.rejects(c.scan('A1', 'SKU'), /masih berjalan/);
  release(); await first;
  assert.equal(h.calls.filter(call => call.name === 'record_order_scan').length, 1);
});

test('refresh reads a committed finish after the response is lost', async () => {
  const h = harness(); const c = h.controller();
  await c.scan('A1', 'SKU'); await c.scan('A1', 'SKU');
  h.loseFinish();
  await assert.rejects(c.finish('A1'), /belum diketahui/);
  assert.equal(h.controller().hasPending(), true);
  h.offline(false);
  assert.equal((await h.controller().open('A1')).state, 'finished');
  assert.equal(h.controller().hasPending(), true);
  assert.equal((await h.controller().retry()).state, 'finished');
  assert.equal(h.controller().hasPending(), false);
  assert.equal(h.calls.filter(call => call.name === 'finish_order_scan').length, 1);
});

test('unauthorized status does not start a new session or make a scan', async () => {
  const calls = [];
  const api = createServerScanRpc(async (name) => {
    calls.push(name);
    return { data: null, error: { code: 'P0001', message: 'Akses scan ditolak' } };
  }, () => 'BRANCH');
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const c = createSortingServerSession(api, storage, () => 'id', 'BRANCH', 'actor', 'ORDER');
  await assert.rejects(c.scan('A1', 'SKU'), /menolak/);
  assert.deepEqual(calls, ['get_order_scan_status']);
});

test('inter-tab lock refusal prevents session and scan calls', async () => {
  let called = false;
  const api = createServerScanRpc(async () => { called = true; return {data: null, error: null}; }, () => 'BRANCH');
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const c = createSortingServerSession(api, storage, () => 'id', 'BRANCH', 'actor', 'ORDER',
    async () => { throw Error('Sesi sortir sedang digunakan di tab lain.'); });
  await assert.rejects(c.scan('A1', 'SKU'), /tab lain/);
  assert.equal(called, false);
});

test('sorting component handlers call the server controller and never legacy completion', () => {
  const source = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.match(declarations.get('handleSortScanProduct'), /controller\.scan\(/);
  assert.match(declarations.get('handleSortScanProduct'), /applySortingProgress/);
  assert.match(declarations.get('handleEndSorting'), /controller\.finish\(/);
  assert.doesNotMatch(declarations.get('handleEndSorting'), /onCompleteSorting|onEditOrderHistoryBatch/);
  assert.match(source, /onClick=\{DEV_BASELINE_SORTING \? handleBaselineEndSorting : handleEndSorting\}/);
  assert.match(source, /disabled=\{DEV_BASELINE_SORTING[\s\S]*?: !SERVER_SCAN_ENABLED \|\| !sortServerReady \|\| savingSort \|\| sortSlots\.length === 0/);
});

test('real sorting scan handler awaits RPC progress and blocks double submit and disabled flag', async () => {
  const source = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleSortScanProduct') initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(initializer);
  const code = ts.transpileModule(`return (${initializer.getText(tree)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  const slot = { slotNumber: 1, basketCode: 'A1', order: { referenceNumber: 'ORDER' } };
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let scans = 0, applied = 0, notifications = [];
  const bindings = {
    sortSaveBusy: { current: false }, sortProductInput: 'SKU', sortSlots: [slot], sortSelectedSlotNumber: 1,
    resolveSortingTarget: undefined,
    SERVER_SCAN_ENABLED: true, allBasketsBound: true, scanServerUnavailable: 'unavailable',
    setSortNotification: value => notifications.push(value), setSavingSort: () => {}, setSortStarted: () => {},
    setSortServerReady: () => {},
    persistSortingTask: async () => {},
    sortingController: async () => ({ scan: async (basket, code) => {
      scans++; assert.equal(basket, 'A1'); assert.equal(code, 'SKU'); await wait;
      return { basket: 'A1', counts: [{ scanned: 1 }] };
    } }),
    applySortingProgress: (_slot, progress) => { assert.equal(progress.counts[0].scanned, 1); applied++; },
    setSortProductInput: () => {}, setSortLastAssignedSlot: () => {}, setBigBasketResult: () => {}, playBuzzer: () => {}, speakVoice: () => {}
  };
  const invoke = () => Function(...Object.keys(bindings), code)(...Object.values(bindings));
  const first = invoke()();
  await Promise.resolve();
  await invoke()();
  assert.equal(applied, 0);
  release(); await first;
  assert.equal(scans, 1); assert.equal(applied, 1);
  bindings.SERVER_SCAN_ENABLED = false;
  await invoke()();
  assert.equal(scans, 1);
  assert.equal(notifications.at(-1).message, 'unavailable');
});

test('real sorting finish handler requires finished server status and keeps task on failure', async () => {
  const source = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleEndSorting') initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(initializer);
  const code = ts.transpileModule(`return (${initializer.getText(tree)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  let finishes = 0, cleared = false, notification;
  const bindings = {
    sortSaveBusy: {current:false}, SERVER_SCAN_ENABLED: true, sortServerReady: true,
    sortSlots: [{basketCode:'A1',order:{referenceNumber:'ORDER'}}], allBasketsBound: true,
    setSavingSort: () => {}, setSortStarted: () => {}, setSortServerReady: () => {},
    sortingController: async () => ({
      open: async () => ({state:'open'}), hasPending: () => false,
      finish: async () => { finishes++; throw Error('belum diketahui'); }
    }),
    applySortingProgress: () => {}, setSortNotification: value => { notification = value; },
    setSortSlots: () => { cleared = true; }
  };
  await Function(...Object.keys(bindings), code)(...Object.values(bindings))();
  assert.equal(finishes, 1);
  assert.equal(cleared, false);
  assert.equal(notification.type, 'error');
});
