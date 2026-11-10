import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createMockEngine } from './sorting-mock/mock-engine.mjs';
import { createMockServer } from './sorting-mock-server.mjs';

test('real React sorting component completes batch and refuses reload without refresh', async () => {
  const dom = new JSDOM('<div id="root"></div>', {url:'http://127.0.0.1:3347/'});
  const engine = createMockEngine();
  const server = await createMockServer({middlewareMode:true});
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {configurable:true, writable:true, value});
  };
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'CustomEvent', 'HTMLElement', 'Event']) {
    setGlobal(key, dom.window[key]);
  }
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let releaseTaskLock;
  const taskLockGate = new Promise(resolve => { releaseTaskLock = resolve; });
  dom.window.navigator.locks = {request: async (name, _options, callback) => {
    if (name.startsWith('wms-sorting-task-v1:') && engine.orders().every(row => row.sortingState === 'finished')) {
      await taskLockGate;
    }
    return callback({});
  }};
  setGlobal('fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/__sorting_mock/orders') return {ok:true, json:async () => ({orders:engine.orders()})};
    if (url === '/__sorting_mock/target') {
      try { const target = engine.target(body.code, body.candidates); return {ok:true, json:async () => target}; }
      catch { return {ok:false}; }
    }
    if (url === '/__sorting_mock/rpc') {
      const result = await engine.rpc(body.name, body.args);
      return {ok:true, json:async () => ({...result, orders:engine.orders()})};
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const flush = async fn => { await act(async () => { await fn(); await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const button = text => {
    const found = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
    assert.ok(found, `missing button: ${text}`);
    return found;
  };
  const input = (placeholder, value) => {
    const field = document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.ok(field, `missing input: ${placeholder}`);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', {bubbles:true}));
    field.dispatchEvent(new dom.window.Event('change', {bubbles:true}));
    return field;
  };
  try {
    let app;
    await flush(async () => { app = await server.ssrLoadModule('/main.tsx'); });
    await flush(() => input('Pindai keranjang induk (contoh GB-01)...', 'MOCK-BATCH'));
    await flush(() => button('Muat Order').click());
    await flush(() => button('BIG BASKET OFF').click());
    const scan = async code => {
      await flush(() => input('Tembak barcode SKU untuk sortir...', code));
      await flush(() => document.querySelector('input[placeholder="Tembak barcode SKU untuk sortir..."]').form.dispatchEvent(
        new dom.window.Event('submit', {bubbles:true, cancelable:true})));
    };
    await scan('DEV-BC-001');
    assert.match(document.body.textContent, /MASUKKAN KE KERANJANGA1/);
    assert.equal(document.activeElement?.getAttribute('placeholder'), 'Tembak barcode SKU untuk sortir...');
    engine.control('lose-after');
    await scan('DEV-BC-001');
    assert.match(document.body.textContent, /SCAN GAGAL \/ BELUM TERKONFIRMASI/);
    engine.control('reconnect');
    await flush(() => app.mockRoot.render(null));
    await flush(() => app.mockRoot.render(createElement(app.MockPage)));
    assert.match(document.body.textContent, /2\/2 pcs/);
    await flush(() => button('Pulihkan sesi').click());
    await flush(() => button('BIG BASKET OFF').click());
    await scan('DEV-BC-002');
    assert.match(document.body.textContent, /Masukkan ke Keranjang: A2/);
    assert.match(document.body.textContent, /Terpilih: A2/);
    await scan('DEV-BC-001');
    assert.match(document.body.textContent, /MASUKKAN KE KERANJANGA3/);
    await scan('SALAH');
    assert.match(document.body.textContent, /SCAN GAGAL \/ BELUM TERKONFIRMASI/);
    await scan('DEV-BC-001');
    assert.match(document.body.textContent, /Barcode tidak cocok, jumlah penuh/);
    assert.equal(document.activeElement?.getAttribute('placeholder'), 'Tembak barcode SKU untuk sortir...');
    const basketA1 = [...document.querySelectorAll('div')].find(item => item.textContent.trim() === 'A1')?.closest('.cursor-pointer');
    assert.ok(basketA1);
    await flush(() => basketA1.click());
    assert.doesNotMatch(document.body.textContent, /Masukkan ke Keranjang: A2/);
    await flush(() => button('Pulihkan sesi').click());
    assert.equal(button('Selesaikan sortir').disabled, false);
    await flush(() => button('Selesaikan sortir').click());
    assert.deepEqual(engine.orders().map(row => row.sortingState), ['finished', 'finished', 'finished']);
    await flush(() => releaseTaskLock());
    assert.match(document.body.textContent, /Seluruh sortir dikonfirmasi server/);
    assert.deepEqual(engine.orders().map(row => row.sortingState), ['finished', 'finished', 'finished']);
    const taskKey = `wms-sorting-task-v1:${JSON.stringify(['MOCK-BRANCH', 'mock-packer'])}`;
    localStorage.setItem(taskKey, JSON.stringify([{reference:'MOCK-ORDER-001',basket:'A1'}, {reference:'MOCK-ORDER-002',basket:'A2'}]));
    await flush(() => window.dispatchEvent(new CustomEvent('sorting-mock-orders', {detail:engine.orders()})));
    localStorage.removeItem(taskKey);
    await flush(() => input('Pindai keranjang induk (contoh GB-01)...', 'MOCK-BATCH'));
    await flush(() => button('Muat Order').click());
    assert.match(document.body.textContent, /Tidak ada pesanan aktif/);
    assert.doesNotMatch(document.body.textContent, /0\/2 pcs|0\/1 pcs/);
    await flush(() => app.mockRoot.render(null));
    await flush(() => app.mockRoot.render(createElement(app.MockPage)));
    await flush(() => input('Pindai keranjang induk (contoh GB-01)...', 'MOCK-BATCH'));
    await flush(() => button('Muat Order').click());
    assert.match(document.body.textContent, /Tidak ada pesanan aktif/);
    await flush(() => app.mockRoot.unmount());
  } finally {
    await server.close();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
