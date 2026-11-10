import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createServer as createHttpServer } from 'node:http';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

test('baseline sorting routes scans automatically and keeps completion and errors safe', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:3000/' });
  const originals = new Map();
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'CustomEvent', 'HTMLElement', 'Event']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  originals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const env = {
    VITE_DEV_BASELINE_SORTING: process.env.VITE_DEV_BASELINE_SORTING,
    VITE_SERVER_SCAN_ENABLED: process.env.VITE_SERVER_SCAN_ENABLED,
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
  };
  Object.assign(process.env, {
    VITE_DEV_BASELINE_SORTING: 'true',
    VITE_SERVER_SCAN_ENABLED: 'false',
    VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
    VITE_SUPABASE_ANON_KEY: 'synthetic-test-key',
  });
  let server;
  let root;
  let supabase;
  const viteCacheDir = mkdtempSync(join(tmpdir(), 'wms-vite-test-'));
  const flush = async fn => act(async () => { await fn(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const button = text => {
    const element = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
    assert.ok(element, `missing button: ${text}`);
    return element;
  };
  const setInput = (placeholder, value) => {
    const field = document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.ok(field, `missing input: ${placeholder}`);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    return field;
  };
  const row = (id, referenceNumber, skuId, qty) => ({
    id, referenceNumber, skuId, skuName: skuId, qty, expiredDate: '01/01/2030', location: 'A',
    timestamp: '2026-01-01T00:00:00.000Z', scanned: false, status: 'Pending',
    picked: true, stockDeducted: true, basketNumber: 'MASTER',
  });
  const orderHistory = [row('one', 'ORDER-1', 'TEST-SKU', 2), row('two', 'ORDER-2', 'TEST-SKU', 1), row('three', 'ORDER-3', 'OTHER-SKU', 1)];
  const attempts = [];
  let saves = false;
  try {
    server = await createServer({
      configFile: false, root: process.cwd(), cacheDir: viteCacheDir, plugins: [react()],
      server: { middlewareMode: true, hmr: {server:createHttpServer()}, watch: {ignored:['**/*']} },
      optimizeDeps: { noDiscovery: true, include: [] },
      appType: 'custom',
    });
    const { default: MabangWmsOutbound } = await server.ssrLoadModule('/src/components/MabangWmsOutbound.tsx');
    ({ supabase } = await server.ssrLoadModule('/src/supabase.ts'));
    const { createRoot } = await import('react-dom/client');
    root = createRoot(document.getElementById('root'));
    await flush(() => root.render(createElement(MabangWmsOutbound, {
      stock: [], orderHistory, currentUser: { username: 'test', role: 'Packer', fullName: 'Test' },
      onCompleteSorting: async tasks => { attempts.push(structuredClone(tasks)); return saves; },
    })));
    await flush(() => setInput('Pindai keranjang induk (contoh GB-01)...', 'MASTER'));
    await flush(() => button('Muat Order').click());
    const placeholder = 'Tembak barcode SKU untuk sortir...';
    const input = () => document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.equal(document.activeElement, input());
    assert.equal(button('Selesaikan sortir').disabled, true);
    await flush(() => button('BIG BASKET OFF').click());
    assert.equal(document.activeElement, input());
    const scan = async code => {
      await flush(() => setInput(placeholder, code));
      await flush(() => input().form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(document.activeElement, input());
    };
    const display = () => [...document.querySelectorAll('[role="status"]')].find(el => /MASUKKAN KE KERANJANG|SCAN GAGAL/.test(el.textContent));
    await scan('TEST-SKU');
    assert.match(display().textContent, /MASUKKAN KE KERANJANGA1/);
    await scan('WRONG');
    assert.match(display().textContent, /SCAN GAGAL/);
    assert.doesNotMatch(document.body.textContent, /Masukkan ke Keranjang:|MASUKKAN KE KERANJANG/);
    await scan('TEST-SKU');
    assert.match(display().textContent, /MASUKKAN KE KERANJANGA1/);
    await scan('TEST-SKU');
    assert.match(display().textContent, /MASUKKAN KE KERANJANGA2/);
    await scan('TEST-SKU');
    assert.match(display().textContent, /SCAN GAGAL/);
    assert.doesNotMatch(document.body.textContent, /Masukkan ke Keranjang:|MASUKKAN KE KERANJANG/);
    await scan('OTHER-SKU');
    assert.match(display().textContent, /MASUKKAN KE KERANJANGA3/);
    assert.equal(button('Selesaikan sortir').disabled, false);
    await flush(() => button('Selesaikan sortir').click());
    assert.match(document.body.textContent, /Sortir belum tersimpan/);
    assert.deepEqual(attempts[0].map(task => [task.referenceNumber, task.masterBasket, task.basketCode, task.counts]), [
      ['ORDER-1', 'MASTER', 'A1', { one: 2 }],
      ['ORDER-2', 'MASTER', 'A2', { two: 1 }],
      ['ORDER-3', 'MASTER', 'A3', { three: 1 }],
    ]);
    saves = true;
    await flush(() => button('Selesaikan sortir').click());
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.match(document.body.textContent, /Menunggu keranjang untuk dikemas/);
  } finally {
    if (root) await flush(() => root.unmount());
    if (supabase) {
      await supabase.auth.dispose();
      await supabase.removeAllChannels();
    }
    if (server) await server.close();
    rmSync(viteCacheDir, { recursive: true, force: true });
    dom.window.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
