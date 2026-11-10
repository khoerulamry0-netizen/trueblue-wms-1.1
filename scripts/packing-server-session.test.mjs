import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createServerScanRpc } from '../src/utils/serverScanRpc.ts';
import { createScanServerSession } from '../src/utils/sortingServerSession.ts';

function fixture() {
  const saved = new Map(), calls = [], events = [];
  const storage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  };
  let id = 0, session = null, state = 'open', finishRequest = null, lose = false, offline = false;
  let loseBefore = false, loseFinish = false, gate, finishGate, sorting = true;
  const rpc = async (name, args) => {
    calls.push({name, args});
    if (name === 'get_order_scan_status') {
      if (offline) throw Error('disconnected');
      if (!session) return {data:null,error:{code:'P0001',message:'Sesi scan tidak ditemukan'}};
      return {data:{session,branch:'BRANCH',reference:'ORDER',phase:'packing',basket:'A1',state,current:true,
        finish_request:finishRequest,counts:[{document_id:'line',sku:'SKU',required:1,scanned:events.length}],
        events:events.map(e => ({request_id:e.id,input_code:e.code,document_id:'line',sku:'SKU'}))},error:null};
    }
    if (name === 'start_order_scan') {
      if (!sorting) return {data:null,error:{code:'P0001',message:'sorting incomplete'}};
      session = args.p_session;
      return {data:{session,state},error:null};
    }
    if (name === 'record_order_scan') {
      if (gate) await gate;
      if (loseBefore) {loseBefore=false;offline=true;throw Error('response lost');}
      if (args.p_code !== 'SKU' || (events.length && events[0].id !== args.p_request))
        return {data:null,error:{code:'P0001',message:'rejected'}};
      if (!events.length) events.push({id:args.p_request,code:args.p_code});
      if (lose) {lose=false;offline=true;throw Error('response lost');}
      return {data:{document_id:'line',sku:'SKU'},error:null};
    }
    if (name === 'finish_order_scan') {
      if (finishGate) await finishGate;
      if (!events.length) return {data:null,error:{code:'P0001',message:'incomplete'}};
      if (state !== 'open' && finishRequest !== args.p_request) return {data:null,error:{code:'P0001',message:'finished'}};
      state='finished';finishRequest=args.p_request;
      if (loseFinish) {loseFinish=false;offline=true;throw Error('response lost');}
      return {data:{session,phase:'packing',state},error:null};
    }
    if (name === 'get_verified_order_receipt') {
      return {data:{branch:'BRANCH',reference:'ORDER',source:'packing',operation_id:finishRequest,
        documents:[{id:'line',referenceNumber:'ORDER',status:'Completed',skuId:'SKU',qty:1,revision:'1'}]},error:null};
    }
    throw Error('unexpected RPC');
  };
  const api = createServerScanRpc(rpc, () => 'BRANCH');
  const create = () => createScanServerSession(api, storage, () => `id-${++id}`, 'BRANCH', 'ACTOR', 'ORDER', 'packing');
  return {create,calls,events,api,lose:()=>{lose=true;},loseBefore:()=>{loseBefore=true;},
    loseFinish:()=>{loseFinish=true;}, block:p=>{gate=p;}, blockFinish:p=>{finishGate=p;},
    denySorting:()=>{sorting=false;}, reconnect:()=>{offline=false;}};
}

test('packing session uses packing RPC and server quantities, rejecting wrong and extra scans', async () => {
  const h=fixture(), c=h.create();
  await assert.rejects(c.scan('A1','WRONG'),/menolak/);
  assert.equal((await c.scan('A1','SKU')).counts[0].scanned,1);
  await assert.rejects(c.scan('A1','SKU'),/menolak/);
  assert.equal((await c.finish('A1')).state,'finished');
  await assert.rejects(c.finish('A1'),/siap/);
  assert.equal(h.calls.find(x=>x.name==='start_order_scan').args.p_phase,'packing');
});

test('packing refresh resolves unknown committed scan without sending twice', async () => {
  const h=fixture(), c=h.create();
  await c.open('A1'); h.lose();
  await assert.rejects(c.scan('A1','SKU'),/belum diketahui/);
  h.reconnect();
  const fresh=h.create();
  assert.equal((await fresh.retry()).counts[0].scanned,1);
  assert.equal(h.calls.filter(x=>x.name==='record_order_scan').length,1);
  assert.equal(fresh.hasPending(),false);
});

const source = readFileSync(new URL('../src/components/MabangWmsOutbound.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('MabangWmsOutbound.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const bulkSource = readFileSync(new URL('../src/components/BulkOutbound.tsx', import.meta.url), 'utf8');
const bulkTree = ts.createSourceFile('BulkOutbound.tsx', bulkSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, bindings, parsed = tree) {
  let initializer;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(initializer, name);
  const compiled = ts.transpileModule(`return (${initializer.getText(parsed)});`, {
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}
  }).outputText;
  return Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
}

function ui(h, controller = h.create(), pending = true) {
  const task = {branch:'BRANCH',actor:'ACTOR',reference:'ORDER',basket:'A1'};
  const result = {counts:{},ready:true,finished:false,notification:null};
  const b = {
    deliveryBusyRef:{current:false}, SERVER_SCAN_ENABLED:true, deliveryTask:task, deliveryReady:true,
    deliveryProductInput:'SKU', scanServerUnavailable:'unavailable',
    pendingOrders:pending ? [{referenceNumber:'ORDER',items:[{id:'line',skuId:'SKU',qty:1}]}] : [],
    deliveryController:async () => controller,
    serverScanRpc:h.api, setDeliveryBusy:()=>{}, setDeliveryProductInput:()=>{},
    setDeliveryReady:value=>{result.ready=value; b.deliveryReady=value;},
    setDeliveryFinished:value=>{result.finished=value;},
    setDeliveryScannedCounts:value=>{result.counts=value;},
    setDeliveryNotification:value=>{result.notification=value;}, playBuzzer:()=>{}
  };
  b.applyDeliveryProgress = handler('applyDeliveryProgress', b);
  b.verifyDeliveryCompletion = handler('verifyDeliveryCompletion', b);
  b.recoverDeliveryTask = handler('recoverDeliveryTask', b);
  return {b,result, scan:()=>handler('handleDeliveryScanProduct',b)(),
    finish:()=>handler('handleCompleteDelivery',b)(), recover:()=>handler('handleRecoverDelivery',b)()};
}

test('real Mabang handler sends scan to RPC; wrong SKU and overscan do not alter server progress', async () => {
  const h=fixture(), u=ui(h);
  await u.scan();
  assert.equal(u.result.counts.line,1);
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,1);
  u.b.deliveryProductInput='WRONG';
  await u.scan();
  assert.equal(u.result.counts.line,1);
  assert.equal(u.result.notification.type,'error');
  await u.recover();
  u.b.deliveryProductInput='SKU';
  await u.scan();
  assert.equal(u.result.counts.line,1);
  assert.equal(u.result.notification.type,'error');
});

test('real Mabang scan handler prevents concurrent double submit', async () => {
  const h=fixture(), u=ui(h);
  let release; h.block(new Promise(resolve=>{release=resolve;}));
  const first=u.scan();
  await new Promise(resolve=>setTimeout(resolve,0));
  await u.scan();
  release(); await first;
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,1);
  assert.equal(u.result.counts.line,1);
});

test('real Mabang recovery reads status and retries the same request after refresh', async () => {
  const h=fixture(), u=ui(h);
  await h.create().open('A1'); h.loseBefore();
  await u.scan();
  assert.equal(u.result.notification.type,'error');
  const original=h.calls.find(c=>c.name==='record_order_scan').args.p_request;
  h.reconnect();
  const refreshed=ui(h,h.create());
  await refreshed.recover();
  const records=h.calls.filter(c=>c.name==='record_order_scan');
  assert.equal(records.length,2);
  assert.equal(records[1].args.p_request,original);
  assert.equal(h.calls[h.calls.indexOf(records[1])-1].name,'get_order_scan_status');
  assert.equal(refreshed.result.counts.line,1);
});

test('lost committed completion is recovered after refresh without pending order or double completion', async () => {
  const h=fixture(), u=ui(h);
  await u.scan(); h.loseFinish();
  await u.finish();
  assert.equal(u.result.notification.type,'error');
  h.reconnect();
  const refreshed=ui(h,h.create(),false);
  await refreshed.recover();
  assert.equal(refreshed.result.finished,true);
  assert.equal(h.calls.filter(c=>c.name==='finish_order_scan').length,1);
  assert.equal(h.calls.filter(c=>c.name==='get_verified_order_receipt').length,1);
  await refreshed.finish();
  assert.equal(h.calls.filter(c=>c.name==='finish_order_scan').length,1);
});

test('packing start rejects missing server sorting proof', async () => {
  const h=fixture(); h.denySorting();
  await assert.rejects(h.create().open('A1'),/menolak/);
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,0);
});

test('real Mabang finish handler rejects incomplete order and concurrent double click', async () => {
  const h=fixture(), u=ui(h);
  await u.finish();
  assert.equal(u.result.notification.type,'error');
  await u.recover();
  await u.scan();
  let release; h.blockFinish(new Promise(resolve=>{release=resolve;}));
  const first=u.finish();
  await new Promise(resolve=>setTimeout(resolve,0));
  await u.finish();
  release(); await first;
  assert.equal(h.calls.filter(c=>c.name==='finish_order_scan').length,2);
  assert.equal(u.result.finished,true);
});

test('lost committed scan is recovered through the real Mabang handler without replay', async () => {
  const h=fixture(), u=ui(h); h.lose();
  await u.scan();
  assert.equal(u.result.notification.type,'error');
  h.reconnect();
  const refreshed=ui(h,h.create());
  await refreshed.recover();
  assert.equal(refreshed.result.counts.line,1);
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,1);
});

test('Mabang does not mark completion verified when receipt proof is missing', async () => {
  const h=fixture(), u=ui(h);
  await u.scan();
  u.b.serverScanRpc = {receipt:async () => {throw Error('bukti tidak tersedia');}};
  u.b.verifyDeliveryCompletion = handler('verifyDeliveryCompletion',u.b);
  await u.finish();
  assert.equal(u.result.finished,false);
  assert.equal(u.result.ready,false);
  assert.equal(u.result.notification.message,'bukti tidak tersedia');
});

function bulkUi(h, controller = h.create(), pending = true) {
  const task = {branch:'BRANCH',actor:'ACTOR',reference:'ORDER',basket:'A1'};
  const result = {counts:{},ready:true,finished:false,error:null,success:null};
  const b = {
    packingBusyRef:{current:false}, SERVER_SCAN_ENABLED:true, packingTask:task, packingReady:true,
    pendingOrders:pending ? [{referenceNumber:'ORDER',items:[{id:'line',skuId:'SKU',qty:1,basketNumber:'A1'}]}] : [],
    scanServerUnavailable:'unavailable', packingController:async () => controller,
    serverScanRpc:h.api, setPackingBusy:()=>{}, setPackingManualCode:()=>{}, setActivePackingRef:()=>{},
    setPackingReady:value=>{result.ready=value; b.packingReady=value;},
    setPackingFinished:value=>{result.finished=value;},
    setPackingScannedQty:value=>{result.counts=value;},
    setPackingScanError:value=>{result.error=value;}, setPackingScanSuccess:value=>{result.success=value;},
    triggerBeep:()=>{}, triggerErrorSound:()=>{}
  };
  b.applyPackingProgress=handler('applyPackingProgress',b,bulkTree);
  b.verifyPackingCompletion=handler('verifyPackingCompletion',b,bulkTree);
  b.recoverPackingTask=handler('recoverPackingTask',b,bulkTree);
  return {b,result,scan:code=>handler('handlePackingScan',b,bulkTree)(code),
    finish:()=>handler('confirmPackingCompleted',b,bulkTree)(),
    recover:()=>handler('handleRecoverPacking',b,bulkTree)()};
}

test('Bulk real scan handler uses server counts and rejects foreign SKU and excess', async () => {
  const h=fixture(), u=bulkUi(h);
  await u.scan('WRONG');
  assert.match(u.result.error,/menolak/);
  assert.deepEqual(u.result.counts,{});
  await u.recover();
  await u.scan('SKU');
  assert.equal(u.result.counts.line,1);
  await u.scan('SKU');
  assert.match(u.result.error,/menolak/);
  assert.equal(u.result.counts.line,1);
  assert.equal(h.events.length,1);
});

test('Bulk real scan handler blocks double click while RPC is pending', async () => {
  const h=fixture(), u=bulkUi(h);
  let release; h.block(new Promise(resolve=>{release=resolve;}));
  const first=u.scan('SKU');
  await new Promise(resolve=>setTimeout(resolve,0));
  await u.scan('SKU');
  release(); await first;
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,1);
});

test('Bulk real recovery after refresh checks status and retries original scan request', async () => {
  const h=fixture(), u=bulkUi(h);
  h.loseBefore(); await u.scan('SKU');
  assert.match(u.result.error,/belum diketahui/);
  const request=h.calls.find(c=>c.name==='record_order_scan').args.p_request;
  h.reconnect();
  const refreshed=bulkUi(h,h.create());
  await refreshed.recover();
  const records=h.calls.filter(c=>c.name==='record_order_scan');
  assert.equal(records.length,2);
  assert.equal(records[1].args.p_request,request);
  assert.equal(h.calls[h.calls.indexOf(records[1])-1].name,'get_order_scan_status');
  assert.equal(refreshed.result.counts.line,1);
});

test('Bulk lost committed scan recovers without duplicate request', async () => {
  const h=fixture(), u=bulkUi(h); h.lose();
  await u.scan('SKU'); h.reconnect();
  const refreshed=bulkUi(h,h.create());
  await refreshed.recover();
  assert.equal(refreshed.result.counts.line,1);
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,1);
});

test('Bulk double completion and recovery of lost commit after leaving pending', async () => {
  const h=fixture(), u=bulkUi(h);
  await u.scan('SKU'); h.loseFinish();
  await u.finish(); assert.match(u.result.error,/belum diketahui/);
  h.reconnect();
  const refreshed=bulkUi(h,h.create(),false);
  await refreshed.recover();
  assert.equal(refreshed.result.finished,true);
  assert.equal(h.calls.filter(c=>c.name==='get_verified_order_receipt').length,1);
  await refreshed.finish();
  assert.equal(h.calls.filter(c=>c.name==='finish_order_scan').length,1);
});

test('Bulk incomplete finish and double click are handled by server and busy guard', async () => {
  const h=fixture(), u=bulkUi(h);
  await u.finish(); assert.match(u.result.error,/menolak/);
  await u.recover(); await u.scan('SKU');
  let release; h.blockFinish(new Promise(resolve=>{release=resolve;}));
  const first=u.finish();
  await new Promise(resolve=>setTimeout(resolve,0));
  await u.finish(); release(); await first;
  assert.equal(h.calls.filter(c=>c.name==='finish_order_scan').length,2);
  assert.equal(u.result.finished,true);
});

test('Bulk rejects invalid or missing receipt proof and keeps print disabled', async () => {
  const h=fixture(), u=bulkUi(h);
  await u.scan('SKU');
  u.b.serverScanRpc={receipt:async () => ({source:'packing',operationId:'different'})};
  u.b.verifyPackingCompletion=handler('verifyPackingCompletion',u.b,bulkTree);
  await u.finish();
  assert.equal(u.result.finished,false);
  assert.equal(u.result.ready,false);
  assert.match(u.result.error,/tidak cocok/);
});

test('Bulk start handler invokes server session and rejects missing sorting proof', async () => {
  const h=fixture(); h.denySorting();
  const u=bulkUi(h); u.b.packingTask=null; u.b.packingFinished=false;
  const storage=new Map();
  Object.assign(u.b, {
    packingIdentity:async()=>({branch:'BRANCH',actor:'ACTOR'}),
    packingTaskKey:(branch,actor)=>JSON.stringify([branch,actor]),
    packingLock:async (_key,fn)=>fn(),
    localStorage:{getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,value)},
    setPackingTask:()=>{},setPackingFinished:()=>{},setPackingScanSuccess:()=>{}
  });
  await handler('startPacking',u.b,bulkTree)('ORDER');
  assert.match(u.result.error,/menolak/);
  assert.equal(h.calls.filter(c=>c.name==='start_order_scan').length,1);
  assert.equal(h.calls.filter(c=>c.name==='record_order_scan').length,0);
});

test('Bulk rejects wrong basket, stale snapshots and foreign branch progress', () => {
  const h=fixture(), u=bulkUi(h);
  const progress={reference:'ORDER',basket:'A1',session:{branch:'BRANCH',phase:'packing'},current:true,
    state:'open',counts:[{documentId:'line',sku:'SKU',required:1,scanned:0}]};
  for (const invalid of [{...progress,basket:'B1'}, {...progress,current:false},
    {...progress,session:{branch:'OTHER',phase:'packing'}}]) {
    assert.throws(()=>u.b.applyPackingProgress(u.b.packingTask,invalid),/tidak cocok|berubah/);
    assert.deepEqual(u.result.counts,{});
  }
});

test('Bulk controller refuses a changed operator or branch before using the session', async () => {
  for (const identity of [{branch:'BRANCH',actor:'OTHER'}, {branch:'OTHER',actor:'ACTOR'}]) {
    const b={
      packingIdentity:async()=>identity,
      packingControllers:{current:new Map()},
      createScanServerSession:()=>{throw Error('must not create session');}
    };
    const getController=handler('packingController',b,bulkTree);
    await assert.rejects(getController({branch:'BRANCH',actor:'ACTOR',reference:'ORDER',basket:'A1'}),/berubah/);
  }
});
