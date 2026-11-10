import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerScanRpc } from '../src/utils/serverScanRpc.ts';
import { isServerScanEnabled } from '../src/utils/serverScanFeature.ts';

const session = { id: 'session-1', branch: 'DEV_LOCAL', phase: 'packing' };

test('scan RPC uses server-assigned line and requires exact finish confirmation', async () => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'start_order_scan') return { data: { session: session.id, state: 'open' }, error: null };
    if (name === 'record_order_scan') return { data: { document_id: 'line-server', sku: 'SKU-A' }, error: null };
    return { data: { session: session.id, phase: 'packing', state: 'finished' }, error: null };
  };
  const api = createServerScanRpc(rpc, () => 'DEV_LOCAL');
  await api.start(session, 'ORDER-A', 'A1');
  assert.deepEqual(await api.record(session, 'request-1', 'BARCODE'), { documentId: 'line-server', sku: 'SKU-A' });
  await api.finish(session, 'finish-1');
  assert.deepEqual(calls.map(c => c.name), ['start_order_scan', 'record_order_scan', 'finish_order_scan']);
  assert.deepEqual(calls[1].args, { p_session: session.id, p_request: 'request-1', p_code: 'BARCODE' });
});

test('RPC error, missing or forged confirmation never authorizes completion', async () => {
  for (const response of [
    { data: null, error: { message: 'secret from server' } },
    { data: null, error: null },
    { data: { session: 'other', phase: 'packing', state: 'finished' }, error: null },
    { data: { session: session.id, phase: 'sorting', state: 'finished' }, error: null },
    { data: { session: session.id, phase: 'packing', state: 'open' }, error: null }
  ]) {
    const api = createServerScanRpc(async () => response, () => 'DEV_LOCAL');
    await assert.rejects(api.finish(session, 'finish-1'), error => !error.message.includes('secret'));
  }
});

test('branch change or failed transport refuses confirmation and does not leak errors', async () => {
  let branch = 'DEV_LOCAL';
  let calls = 0;
  const api = createServerScanRpc(async () => {
    calls++;
    branch = 'OTHER';
    return { data: { session: session.id, state: 'open' }, error: null };
  }, () => branch);
  await assert.rejects(api.start(session, 'ORDER-A', 'A1'), /Cabang berubah/);
  await assert.rejects(api.record(session, 'request-1', 'SKU-A'), /Cabang berubah/);
  assert.equal(calls, 1);
  const disconnected = createServerScanRpc(async () => { throw Error('secret'); }, () => 'DEV_LOCAL');
  await assert.rejects(disconnected.record(session, 'request-1', 'SKU-A'), error => !error.message.includes('secret'));
});

test('scan confirmation requires server document and SKU', async () => {
  for (const data of [{}, { document_id: 'line', sku: '' }, { document_id: 1, sku: 'SKU-A' }]) {
    const api = createServerScanRpc(async () => ({ data, error: null }), () => 'DEV_LOCAL');
    await assert.rejects(api.record(session, 'request-1', 'SKU-A'));
  }
});

test('flag is off unless explicitly enabled', () => {
  for (const value of [undefined, '', false, true, 'TRUE', '1']) assert.equal(isServerScanEnabled(value), false);
  assert.equal(isServerScanEnabled('true'), true);
});

test('status restores authoritative counts and events and rejects inconsistent responses', async () => {
  const status = {
    session: session.id, branch: session.branch, reference: 'ORDER-A', phase: 'packing',
    basket: 'A1', state: 'open', current: true, finish_request: null,
    counts: [{ document_id: 'line', sku: 'SKU-A', required: 3, scanned: 1 }],
    events: [{ request_id: 'request-1', input_code: 'BARCODE', document_id: 'line', sku: 'SKU-A' }]
  };
  const api = createServerScanRpc(async () => ({ data: status, error: null }), () => session.branch);
  const result = await api.status(session.branch, 'ORDER-A', 'packing');
  assert.equal(result.counts[0].scanned, 1);
  assert.equal(result.events[0].requestId, 'request-1');
  for (const bad of [
    { ...status, branch: 'OTHER' },
    { ...status, counts: [{ ...status.counts[0], scanned: 3 }] },
    { ...status, events: [status.events[0], status.events[0]] },
    { ...status, state: 'finished' }
  ]) {
    const invalid = createServerScanRpc(async () => ({ data: bad, error: null }), () => session.branch);
    await assert.rejects(invalid.status(session.branch, 'ORDER-A', 'packing'));
  }
});

test('receipt is accepted only from verified RPC for the requested completed order', async () => {
  const receipt = {
    branch: session.branch, reference: 'ORDER-A', source: 'packing', operation_id: 'op',
    documents: [{ id: 'line', referenceNumber: 'ORDER-A', status: 'Completed', skuId: 'SKU-A', qty: 3 }]
  };
  const api = createServerScanRpc(async (name) => {
    assert.equal(name, 'get_verified_order_receipt');
    return { data: receipt, error: null };
  }, () => session.branch);
  assert.equal((await api.receipt(session.branch, 'ORDER-A')).operationId, 'op');
  for (const data of [
    { ...receipt, documents: [{ ...receipt.documents[0], status: 'Pending' }] },
    { ...receipt, branch: 'OTHER' }, { ...receipt, documents: [] },
    { ...receipt, documents: [receipt.documents[0], receipt.documents[0]] }
  ]) {
    const invalid = createServerScanRpc(async () => ({ data, error: null }), () => session.branch);
    await assert.rejects(invalid.receipt(session.branch, 'ORDER-A'));
  }
  const denied = createServerScanRpc(async () => ({ data: null, error: { code: '42501' } }), () => session.branch);
  await assert.rejects(denied.receipt(session.branch, 'ORDER-A'));
});
