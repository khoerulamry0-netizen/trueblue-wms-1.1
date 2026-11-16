import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createMockEngine } from './sorting-mock/mock-engine.mjs';
import { createMockServer } from './sorting-mock-server.mjs';

test('Mabang sorting UI preserves server workflow and renders 4-col Task list, Hero strip, and Dual-Mode panel', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:3347/' });
  const engine = createMockEngine();
  const server = await createMockServer({ middlewareMode: true });
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'CustomEvent', 'HTMLElement', 'Event']) {
    setGlobal(key, dom.window[key]);
  }
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.navigator.locks = {
    request: async (_name, _options, callback) => callback({})
  };
  setGlobal('fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/__sorting_mock/orders') return { ok: true, json: async () => ({ orders: engine.orders() }) };
    if (url === '/__sorting_mock/target') {
      try {
        const target = engine.target(body.code, body.candidates);
        return { ok: true, json: async () => target };
      } catch {
        return { ok: false };
      }
    }
    if (url === '/__sorting_mock/rpc') {
      const result = await engine.rpc(body.name, body.args);
      return { ok: true, json: async () => ({ ...result, orders: engine.orders() }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const flush = async fn => {
    await act(async () => {
      await fn();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  const button = text => {
    const found = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
    assert.ok(found, `missing button: ${text}`);
    return found;
  };
  const input = (placeholder, value) => {
    const field = document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.ok(field, `missing input: ${placeholder}`);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    return field;
  };
  const scan = async code => {
    await flush(() => input('Tembak barcode SKU untuk sortir...', code));
    await flush(() =>
      document
        .querySelector('input[placeholder="Tembak barcode SKU untuk sortir..."]')
        .form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    );
  };

  let app;
  try {
    await flush(async () => {
      app = await server.ssrLoadModule('/main.tsx');
    });

    await flush(() => input('Pindai keranjang induk (contoh GB-01)...', 'MOCK-BATCH'));
    await flush(() => button('Muat Order').click());

    // Pre-bind checks: Unbound Mabang red state + 4-col grid + Initialize! right panel (no BIG BASKET button)
    assert.equal(
      [...document.querySelectorAll('button')].some(item => /BIG BASKET/i.test(item.textContent || '')),
      false,
      'BIG BASKET toggle should be removed'
    );
    assert.match(document.body.textContent, /Induk:\s*MOCK-BATCH/);
    assert.match(document.body.textContent, /Menunggu Pengikatan Keranjang \(0\/3\)/);
    assert.match(document.body.textContent, /Task list/);
    assert.match(document.body.textContent, /Initialize!/);
    assert.ok(document.querySelector('.sm\\:grid-cols-4'), 'expected 4-column desktop Task list grid');
    const unboundSlotCard = [...document.querySelectorAll('div')]
      .find(item => item.textContent.trim() === 'Slot #1')
      ?.closest('.cursor-pointer');
    assert.ok(unboundSlotCard, 'missing Slot #1 unbound card');
    assert.match(unboundSlotCard.className, /bg-\[#FFF1F0\]/);

    // Bind child baskets via Kode Packer "A" -> A1..A3 -> Hero displays Siap Sortir
    await flush(() => input('Kosong (Manual)', 'A'));
    await flush(() => button('Setel (A1-A3)').click());
    assert.match(document.body.textContent, /Siap Sortir/);

    // Scan 1: DEV-BC-001 routes to A1 (DEV-SKU-001 is present in A1 and A3)
    await scan('DEV-BC-001');
    assert.doesNotMatch(document.body.textContent, /MASUKKAN KE KERANJANG/);
    assert.match(document.body.textContent, /Masukkan ke Keranjang: A1/);
    assert.match(document.body.textContent, /DEV-SKU-001/);
    assert.match(document.body.textContent, /1\/2/);
    assert.match(document.body.textContent, /0\/1/);

    // Scan 2: DEV-BC-001 completes A1 -> lime-green card + OK badge in table
    await scan('DEV-BC-001');
    assert.match(document.body.textContent, /2\/2 pcs/);
    const cardA1 = [...document.querySelectorAll('div')]
      .find(item => item.textContent.trim() === 'A1')
      ?.closest('.cursor-pointer');
    assert.ok(cardA1, 'missing A1 card');
    assert.match(cardA1.className, /bg-\[#B7EB34\]/);

    // Wrong scan clears active "Masukkan ke Keranjang:" and displays visual error banner
    await scan('SALAH');
    assert.match(document.body.textContent, /PERINGATAN SALAH SCAN PRODUK/);
    assert.doesNotMatch(document.body.textContent, /Masukkan ke Keranjang:|MASUKKAN KE KERANJANG/);

    // Clicking card A2 switches Right panel to Isi Basket (A2) with disabled manual bypass
    const cardA2 = [...document.querySelectorAll('div')]
      .find(item => item.textContent.trim() === 'A2')
      ?.closest('.cursor-pointer');
    assert.ok(cardA2, 'missing A2 card');
    await flush(() => cardA2.click());
    assert.match(document.body.textContent, /Anak Keranjang:\s*A2/);
    assert.match(document.body.textContent, /DEV-SKU-002/);
    const disabledManualBtn = button('Wajib Scan Barcode (Manual Dinonaktifkan)');
    assert.equal(disabledManualBtn.disabled, true);

    // Finish remaining items -> auto-switches back to SKU Ter-scan, then Hero completed banner
    await scan('DEV-BC-002');
    assert.match(document.body.textContent, /Masukkan ke Keranjang: A2/);
    await scan('DEV-BC-001');
    assert.match(document.body.textContent, /Sortir Batch Selesai/);
    assert.match(document.body.textContent, /3\/3 Keranjang Lengkap/);

    // Complete batch against mock server
    assert.equal(button('Selesaikan sortir').disabled, false);
    await flush(() => button('Selesaikan sortir').click());
    assert.deepEqual(
      engine.orders().map(row => row.sortingState),
      ['finished', 'finished', 'finished']
    );
    assert.match(document.body.textContent, /Seluruh sortir dikonfirmasi server/);

    await flush(() => app.mockRoot.unmount());

    // Direct MabangWmsOutbound conflict guard check: block Kode Packer & manual bind if active in Packing queue
    const { createRoot } = await import('react-dom/client');
    const { default: MabangWmsOutbound } = await server.ssrLoadModule('/../../src/components/MabangWmsOutbound.tsx');
    const directRoot = createRoot(document.getElementById('root'));
    try {
      const makeLine = (id, ref, basket, extra = {}) => ({
        id,
        referenceNumber: ref,
        skuId: 'SKU-X',
        skuName: 'Produk X',
        qty: 1,
        expiredDate: '01/01/2030',
        location: 'A1',
        timestamp: '2026-11-15T00:00:00.000Z',
        scanned: false,
        status: 'Pending',
        picked: true,
        stockDeducted: true,
        shipped: false,
        basketNumber: basket,
        ...extra
      });
      await flush(() =>
        directRoot.render(
          createElement(MabangWmsOutbound, {
            stock: [],
            currentUser: { username: 'packer', role: 'Packer', fullName: 'Packer 1' },
            orderHistory: [
              makeLine('sort-1', 'ORD-SORT-1', 'GB-NEW'),
              makeLine('sort-2', 'ORD-SORT-2', 'GB-NEW'),
              makeLine('pack-active', 'ORD-IN-PACKING', 'A2', {
                sortedAt: '2026-11-15T08:00:00.000Z',
                sortedBy: 'Packer Old'
              }),
              makeLine('pack-done', 'ORD-COMPLETED', 'B1', {
                status: 'Completed',
                shipped: true,
                sortedAt: '2026-11-14T08:00:00.000Z',
                sortedBy: 'Packer Old'
              })
            ]
          })
        )
      );

      localStorage.clear();
      await flush(() => input('Pindai keranjang induk (contoh GB-01)...', 'GB-NEW'));
      await flush(() => button('Muat Order').click());

      // Kode Packer "A" conflicts with A2 in Packing queue -> rejected, slots remain unbound
      await flush(() => input('Kosong (Manual)', 'A'));
      await flush(() => button('Setel (A1-A2)').click());
      assert.match(document.body.textContent, /DITOLAK: Kode Packer "A" bentrok/);
      assert.match(document.body.textContent, /A2 \(ORD-IN-PACKING - Packing\)/);
      assert.match(document.body.textContent, /Menunggu Pengikatan Keranjang \(0\/2\)/);

      // Manual slot bind to A2 also rejected
      await flush(() => input('Kode anak keranjang Slot #1...', 'A2'));
      await flush(() => button('Ikat Slot #1').click());
      assert.match(document.body.textContent, /DITOLAK: Kode keranjang "A2" masih aktif/);
      assert.match(document.body.textContent, /Menunggu Pengikatan Keranjang \(0\/2\)/);

      // Kode Packer "B" reuses freed B1 (Completed order) -> accepted!
      await flush(() => input('Kosong (Manual)', 'B'));
      await flush(() => button('Setel (B1-B2)').click());
      assert.match(document.body.textContent, /Siap Sortir/);
      assert.match(document.body.textContent, /Berhasil mengatur keranjang Packer "B": B1 s\/d B2/);
    } finally {
      await flush(() => directRoot.unmount());
    }

    // Admin Monitor & Koreksi Keranjang Induk UI verification (non-Admin vs Admin + search + rename)
    const adminRoot = createRoot(document.getElementById('root'));
    try {
      const sessionCalls = [];
      const makeMonitorLine = (id, ref, orderNumber, basket, extra = {}) => ({
        id,
        referenceNumber: ref,
        orderNumber,
        customerName: 'Pelanggan Uji',
        skuId: 'SKU-MON',
        skuName: 'Produk Monitor',
        qty: 2,
        expiredDate: '01/01/2030',
        location: 'A1',
        timestamp: '2026-11-15T10:00:00.000Z',
        scanned: false,
        status: 'Pending',
        picked: true,
        pickedBy: 'Picker Ani',
        stockDeducted: true,
        shipped: false,
        basketNumber: basket,
        masterBasketNumber: basket,
        ...extra
      });

      const baseHistory = [
        makeMonitorLine('mon-1', 'REF-MON-1', 'ORD-MON-1', 'GB-10'),
        makeMonitorLine('mon-2', 'REF-MON-2', 'ORD-MON-2', 'A3', {
          masterBasketNumber: 'GB-20',
          sortedAt: '2026-11-15T10:05:00.000Z',
          sortedBy: 'Sorter Santi'
        })
      ];

      // Non-Admin (Picker) must NOT see the Monitor Keranjang utility button
      await flush(() =>
        adminRoot.render(
          createElement(MabangWmsOutbound, {
            stock: [],
            currentUser: { username: 'picker1', role: 'Picker', fullName: 'Picker Ani' },
            orderHistory: baseHistory
          })
        )
      );
      const pickerMonitorBtn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.includes('Monitor Keranjang')
      );
      assert.equal(pickerMonitorBtn, undefined);

      // Admin sees Monitor Keranjang button, searches order, and renames Keranjang Induk GB-10 -> JJ2
      await flush(() =>
        adminRoot.render(
          createElement(MabangWmsOutbound, {
            stock: [],
            currentUser: { username: 'admin', role: 'Administrator', fullName: 'Admin Utama' },
            orderHistory: baseHistory,
            onUpdateOrderSession: async (refs, sessionData) => {
              sessionCalls.push({ refs, sessionData });
              return { ok: true, count: Array.isArray(refs) ? refs.length : 1 };
            }
          })
        )
      );

      const adminMonitorBtn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.includes('Monitor Keranjang')
      );
      assert.ok(adminMonitorBtn);
      await flush(() => adminMonitorBtn.click());
      assert.match(document.body.textContent, /Monitor & Koreksi Keranjang Induk/);

      // Search post-sorting order ORD-MON-2 -> still shows parent Induk GB-20 and Sortir child A3
      await flush(() =>
        input('Cari No. Order, Ref, Kode Keranjang, atau Nama Picker...', 'ORD-MON-2')
      );
      assert.match(document.body.textContent, /Induk: GB-20/);
      assert.match(document.body.textContent, /A3/);

      // Clear search and rename unsorted batch GB-10 -> JJ2
      await flush(() =>
        input('Cari No. Order, Ref, Kode Keranjang, atau Nama Picker...', 'GB-10')
      );
      const renameBtn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.includes('Ubah Kode Induk')
      );
      assert.ok(renameBtn);
      await flush(() => renameBtn.click());
      await flush(() => input('Masukkan kode baru (mis. JJ2)...', 'jj2'));
      const saveBtn = Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.trim() === 'Simpan'
      );
      assert.ok(saveBtn);
      await flush(() => saveBtn.click());

      assert.equal(sessionCalls.length, 1);
      assert.deepEqual(sessionCalls[0].refs, ['REF-MON-1']);
      assert.deepEqual(sessionCalls[0].sessionData, {
        basketNumber: 'JJ2',
        masterBasketNumber: 'JJ2'
      });
      assert.match(document.body.textContent, /berhasil diubah menjadi "JJ2"/);
    } finally {
      await flush(() => adminRoot.unmount());
    }

    // Regression check: loading master basket "121" that already finished sorting (in Packing) MUST be blocked!
    const guardRoot = createRoot(document.getElementById('root'));
    try {
      const sortedIn121 = [
        {
          id: 'done-sort-1',
          referenceNumber: 'SGD-121-1',
          orderNumber: 'ORD-121-1',
          customerName: 'Cust 121',
          skuId: 'SKU-121',
          skuName: 'Produk 121',
          qty: 2,
          expiredDate: '01/01/2030',
          location: 'A1',
          timestamp: '2026-11-15T10:00:00.000Z',
          scanned: false,
          status: 'Pending',
          picked: true,
          pickedBy: 'Picker 1',
          stockDeducted: true,
          shipped: false,
          basketNumber: 'K1',
          masterBasketNumber: '121',
          sortedAt: '2026-11-15T11:00:00.000Z',
          sortedBy: 'Packer Sortir 1'
        }
      ];
      localStorage.clear();
      await flush(() =>
        guardRoot.render(
          createElement(MabangWmsOutbound, {
            stock: [],
            currentUser: { username: 'packer', role: 'Packer', fullName: 'Packer 1' },
            orderHistory: sortedIn121
          })
        )
      );
      await flush(() => input('Pindai keranjang induk (contoh GB-01)...', '121'));
      await flush(() => button('Muat Order').click());
      assert.match(document.body.textContent, /sudah selesai disortir dan menunggu di 3\. Packing/);
      assert.match(document.body.textContent, /Keranjang Induk Belum Dimuat/);
    } finally {
      await flush(() => guardRoot.unmount());
    }
  } finally {
    await server.close();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
