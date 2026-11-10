import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockEngine } from './sorting-mock/mock-engine.mjs';
import { createServerScanRpc } from '../src/utils/serverScanRpc.ts';
import { createSortingServerSession } from '../src/utils/sortingServerSession.ts';
import { createMockServer } from './sorting-mock-server.mjs';
import { resolve } from 'node:path';
import { selectSortingOrders } from './sorting-mock/orders.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness() {
  const engine = createMockEngine();
  const calls = [];
  const api = createServerScanRpc((name, args) => { calls.push({name, args}); return engine.rpc(name, args); }, () => 'MOCK-BRANCH');
  const values = new Map();
  const storage = { getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value), removeItem:key => values.delete(key) };
  let id = 0;
  const create = (ref = 'MOCK-ORDER-001') => createSortingServerSession(api, storage, () => `id-${++id}`, 'MOCK-BRANCH', 'mock-packer', ref);
  return {engine, calls, create, api};
}

test('mock sorting validates barcode, basket and overscan and returns authoritative progress', async () => {
  const h = harness(), c = h.create();
  await assert.rejects(c.open('B1'), /menolak/);
  const fresh = h.create('MOCK-ORDER-002');
  await assert.rejects(fresh.scan('A2', 'SALAH'), /menolak/);
  assert.equal((await fresh.scan('A2', 'DEV-BC-002')).counts[0].scanned, 1);
  await assert.rejects(fresh.scan('A2', 'DEV-BC-002'), /menolak/);
  assert.equal((await fresh.finish('A2')).state, 'finished');
  await assert.rejects(h.api.start({id:'invalid',branch:'MOCK-BRANCH',phase:'packing'}, 'MOCK-ORDER-001', 'A1'), /menolak/);
});

test('mock server routes barcode to available basket and rejects wrong or completed targets', async () => {
  const h = harness();
  const candidates = [{reference:'MOCK-ORDER-001',basket:'A1'}, {reference:'MOCK-ORDER-002',basket:'A2'}, {reference:'MOCK-ORDER-003',basket:'A3'}];
  assert.equal(h.engine.target('DEV-BC-002', candidates).reference, 'MOCK-ORDER-002');
  assert.throws(() => h.engine.target('SALAH', candidates), /tidak cocok/);
  const a = h.create();
  await a.scan('A1', 'DEV-BC-001'); await a.scan('A1', 'DEV-BC-001');
  assert.equal(h.engine.target('DEV-BC-001', [...candidates].reverse()).reference, 'MOCK-ORDER-003');
  await a.finish('A1');
  const c = h.create('MOCK-ORDER-003'); await c.scan('A3', 'DEV-BC-001');
  assert.throws(() => h.engine.target('DEV-BC-001', candidates), /penuh/);
  assert.throws(() => h.engine.target('DEV-BC-002', [{reference:'MOCK-ORDER-002',basket:'wrong'}]), /basket/);
});

for (const mode of ['lose-before', 'lose-after']) {
  test(`refresh and retry after ${mode} use the original request id`, async () => {
    const h = harness(), c = h.create();
    await c.open('A1'); h.engine.control(mode);
    await assert.rejects(c.scan('A1', 'DEV-BC-001'), /belum diketahui/);
    const original = h.calls.filter(call => call.name === 'record_order_scan')[0].args.p_request;
    h.engine.control('reconnect');
    const restored = h.create();
    const progress = await restored.retry();
    assert.equal(progress.counts[0].scanned, 1);
    const attempts = h.calls.filter(call => call.name === 'record_order_scan');
    assert.equal(attempts.length, mode === 'lose-before' ? 2 : 1);
    assert.ok(attempts.every(call => call.args.p_request === original));
    assert.equal(restored.hasPending(), false);
  });
}

test('real Mabang component is transformed with mock Supabase dependency only', async () => {
  const server = await createMockServer({middlewareMode:true});
  try {
    const component = await server.transformRequest('/@fs/' + resolve('src/components/MabangWmsOutbound.tsx').replaceAll('\\', '/'));
    assert.ok(component);
    assert.match(component.code, /from "\/supabase\.ts"/);
    assert.doesNotMatch(component.code, /from "[^"]*src\/supabase/);
    const mock = await server.transformRequest('/supabase.ts');
    assert.match(mock.code, /__sorting_mock\/rpc/);
    assert.doesNotMatch(mock.code, /createClient|VITE_SUPABASE/);
  } finally { await server.close(); }
});

test('mock entry compiles global WMS styles and Tailwind utilities used by Mabang', async () => {
  const server = await createMockServer({middlewareMode:true});
  try {
    const entry = await server.transformRequest('/main.tsx');
    assert.ok(entry);
    assert.match(entry.code, /\/global\.css/);
    const compiled = await server.transformRequest('/global.css');
    assert.ok(compiled);
    const cssLiteral = compiled.code.match(/const __vite__css = ("(?:[^"\\]|\\.)*")/);
    assert.ok(cssLiteral, 'Vite must produce an injectable stylesheet');
    const css = JSON.parse(cssLiteral[1]);
    for (const selector of ['.flex {', '.grid {', '.p-3 {', '.bg-white {', '.rounded-xl {',
      '.wms-stage-tabs', '.wms-scan-field']) {
      assert.ok(css.includes(selector), `missing WMS style ${selector}`);
    }
    assert.match(css, /\.flex\s*\{\s*display:\s*flex/);
    assert.match(css, /\.grid\s*\{\s*display:\s*grid/);
  } finally { await server.close(); }
});

test('reset removes only mock server sessions', async () => {
  const h = harness();
  await h.create().open('A1');
  h.engine.control('reset');
  await assert.rejects(h.api.status('MOCK-BRANCH', 'MOCK-ORDER-001', 'sorting'), /belum tersedia/);
});

test('completed batch stays excluded on reload and refresh; retry only replays the original request', async () => {
  const h = harness();
  const a = h.create(), b = h.create('MOCK-ORDER-002'), c = h.create('MOCK-ORDER-003');
  await a.scan('A1', 'DEV-BC-001');
  await a.scan('A1', 'DEV-BC-001');
  await b.scan('A2', 'DEV-BC-002');
  await c.scan('A3', 'DEV-BC-001');
  const aFinished = await a.finish('A1');
  const savedTask = JSON.stringify([{reference:'MOCK-ORDER-001',basket:'A1'}, {reference:'MOCK-ORDER-002',basket:'A2'}]);
  assert.equal(selectSortingOrders(h.engine.orders(), savedTask).length, 3, 'partial completion remains recoverable');
  const bFinished = await b.finish('A2');
  await c.finish('A3');
  const snapshot = h.engine.orders();
  assert.deepEqual(snapshot.map(row => row.sortingState), ['finished', 'finished', 'finished']);
  const pendingOrders = selectSortingOrders(snapshot, null);
  assert.equal(pendingOrders.length, 0, 'completed batch cannot be loaded as pending');
  const source = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('MabangWmsOutbound.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleLoadSortTask') handler = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(handler);
  let notification;
  const compiled = ts.transpileModule(`return (${handler.getText(tree)});`, {
    compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None}
  }).outputText;
  const load = Function('pendingOrders', 'sortTaskInput', 'sortSaveBusy', 'sortStarted', 'loadSortingReferences',
    'setSortNotification', 'playBuzzer', 'speakVoice', compiled)(
    pendingOrders, 'MOCK-BATCH', {current:false}, false, undefined, value => { notification = value; }, () => {}, () => {});
  await load();
  assert.match(notification.message, /Tidak ada pesanan aktif/);
  assert.equal(selectSortingOrders(h.engine.orders(), null).length, 0, 'fresh page reads completed server snapshot');
  assert.equal((await h.create().open('A1')).counts[0].scanned, 2);
  assert.equal((await h.create('MOCK-ORDER-002').retry()).counts[0].scanned, 1);
  const replay = await h.engine.rpc('finish_order_scan', {p_session:aFinished.session.id, p_request:aFinished.finishRequest});
  assert.equal(replay.data.state, 'finished');
  const duplicate = await h.engine.rpc('finish_order_scan', {p_session:bFinished.session.id, p_request:'new-finish'});
  assert.ok(duplicate.error, 'new completion request rejected');
  const scan = await h.engine.rpc('record_order_scan', {p_session:aFinished.session.id, p_request:'new-scan', p_code:'DEV-BC-001'});
  assert.ok(scan.error, 'new scan on completed sorting rejected');
  assert.equal((await h.api.status('MOCK-BRANCH', 'MOCK-ORDER-001', 'sorting')).counts[0].scanned, 2);
});

test('saved task can recover when all mock sessions finished before client confirmation', async () => {
  const h = harness();
  const a = h.create(), b = h.create('MOCK-ORDER-002'), c = h.create('MOCK-ORDER-003');
  await a.scan('A1', 'DEV-BC-001'); await a.scan('A1', 'DEV-BC-001'); await a.finish('A1');
  await b.scan('A2', 'DEV-BC-002'); await b.finish('A2');
  await c.scan('A3', 'DEV-BC-001'); await c.finish('A3');
  const task = JSON.stringify([{reference:'MOCK-ORDER-001',basket:'A1'}, {reference:'MOCK-ORDER-002',basket:'A2'}]);
  assert.equal(selectSortingOrders(h.engine.orders(), task).length, 2);
  assert.equal((await h.create().retry()).state, 'finished');
  assert.equal((await h.create('MOCK-ORDER-002').retry()).state, 'finished');
  assert.equal(selectSortingOrders(h.engine.orders(), null).length, 0);
});
