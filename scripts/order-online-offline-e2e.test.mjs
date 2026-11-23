import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareOutboundCreation, prepareOrderEdits } from '../src/utils/outboundTransactions.ts';
import { prepareOrderCompletion } from '../src/utils/orderCompletion.ts';
import { prepareSortingUpdates, selectSortLoadCandidates, findActiveBasketConflicts } from '../src/utils/orderSorting.ts';
import { hasSavedSorting } from '../src/utils/packingValidation.ts';
import { getAvailableStockPool, getLockedStockSummary } from '../src/utils/calculations.ts';
import { planOrderImport } from '../src/utils/orderImport.ts';
import { resolveOrderType } from '../src/utils/orderType.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

function makeStock(overrides = {}) {
  return {
    id: 'WH-CENTRAL__SKU-001__A1-01-01__31/12/2027',
    skuId: 'SKU-001',
    skuName: 'Produk Uji 1',
    brand: 'TRUEBLUE',
    barcode: '8991234567001',
    expiredDate: '31/12/2027',
    location: 'A1-01-01',
    qty: 20,
    totalQtySku: 20,
    qtyCtnSize: 24,
    qtyCtn: 0,
    qtyInnerSize: 6,
    qtyInner: 3,
    qtyLoose: 2,
    status: 'AMAN',
    warehouseId: 'WH-CENTRAL',
    warehouseName: 'Gudang Pusat',
    ...overrides,
  };
}

test('E2E Offline (B2B) order lifecycle preserves orderType, reserves stock before picking, and deducts stock exactly once', () => {
  const initialStock = [makeStock({ qty: 20, totalQtySku: 20 })];
  let stock = initialStock.map((s) => ({ ...s }));
  let history = [];

  // 1) Create draft B2B order (qty 6)
  const created = prepareOutboundCreation(stock, history, [
    {
      referenceNumber: 'B2B-001',
      orderNumber: 'B2B-001',
      noPo: 'PO-2026-001',
      customerName: 'PT Toko Offline',
      skuId: 'SKU-001',
      skuName: 'Produk Uji 1',
      expiredDate: '31/12/2027',
      location: 'A1-01-01',
      qty: 6,
      warehouseId: 'WH-CENTRAL',
      status: 'Pending',
      scanned: false,
      picked: false,
      stockDeducted: false,
      orderType: 'B2B',
      orderSource: 'MANUAL_B2B',
    },
  ]);

  assert.equal(created.draft, true);
  assert.equal(created.orders.length, 1);
  assert.equal(created.orders[0].orderType, 'B2B');
  assert.equal(created.orders[0].orderSource, 'MANUAL_B2B');
  assert.equal(created.orders[0].stockDeducted, false);
  // Physical stock must NOT be deducted on draft creation
  assert.equal(created.stock[0].qty, 20);

  history = [...created.orders];
  // Free stock pool reflects 6 pcs reserved (14 free)
  const locked = getLockedStockSummary(history);
  assert.equal(locked.byCanonicalId.size, 1);
  const freePool = getAvailableStockPool(stock, history);
  assert.equal(freePool[0].qty, 14);

  // 2) Edit B2B order before picking (change qty 6 -> 8): orderType must remain B2B
  const edited = prepareOrderEdits(stock, history, [
    {
      original: history[0],
      updated: { ...history[0], qty: 8 },
    },
  ]);
  assert.equal(edited[0].qty, 8);
  assert.equal(edited[0].orderType, 'B2B');
  history = edited;

  // 3) Picking B2B completes: stock deducted once (20 -> 12), orderType preserved
  const picked = prepareOrderCompletion(stock, history, [
    { refNum: 'B2B-001', updatedItems: history, isPicking: true },
  ]);
  assert.equal(picked.orders[0].status, 'Pending');
  assert.equal(picked.orders[0].picked, true);
  assert.equal(picked.orders[0].stockDeducted, true);
  assert.equal(picked.orders[0].orderType, 'B2B');
  assert.equal(picked.changedStock.length, 1);
  assert.equal(picked.changedStock[0].qty, 12);

  stock = picked.changedStock;
  history = picked.orders;

  // 4) Editing qty after picking (stockDeducted=true) must be rejected
  assert.throws(
    () =>
      prepareOrderEdits(stock, history, [
        { original: history[0], updated: { ...history[0], qty: 5 } },
      ]),
    /Stok order sudah dipotong/
  );

  // 5) Packing B2B validation completes: stock must NOT be deducted again
  const packed = prepareOrderCompletion(stock, history, [
    {
      refNum: 'B2B-001',
      updatedItems: history.map((o) => ({ ...o, status: 'Completed', scanned: true })),
      isPicking: false,
    },
  ]);
  assert.equal(packed.orders[0].status, 'Completed');
  assert.equal(packed.orders[0].scanned, true);
  assert.equal(packed.orders[0].orderType, 'B2B');
  assert.equal(packed.changedStock.length, 0, 'Packing must not double-deduct stock');
});

test('E2E Online order lifecycle (input -> picking -> sorting -> packing) preserves orderType and enforces sorting before packing', () => {
  let stock = [makeStock({ qty: 10, totalQtySku: 10 })];
  let history = [];

  // 1) Import / create Online draft order (qty 4)
  const created = prepareOutboundCreation(stock, history, [
    {
      referenceNumber: 'ONL-001',
      orderNumber: 'ONL-001',
      customerName: 'Buyer Online',
      skuId: 'SKU-001',
      skuName: 'Produk Uji 1',
      expiredDate: '31/12/2027',
      location: 'A1-01-01',
      qty: 4,
      warehouseId: 'WH-CENTRAL',
      status: 'Pending',
      scanned: false,
      picked: false,
      stockDeducted: false,
      orderType: 'ONLINE',
      orderSource: 'IMPORT_ONLINE',
    },
  ]);
  history = created.orders;
  assert.equal(history[0].orderType, 'ONLINE');
  assert.equal(hasSavedSorting(history), false);

  // 2) Picking Online with master basket GB-01
  const picked = prepareOrderCompletion(stock, history, [
    {
      refNum: 'ONL-001',
      updatedItems: history.map((o) => ({ ...o, basketNumber: 'GB-01', masterBasketNumber: 'GB-01' })),
      isPicking: true,
    },
  ]);
  stock = picked.changedStock;
  history = picked.orders;
  assert.equal(stock[0].qty, 6);
  assert.equal(history[0].basketNumber, 'GB-01');
  assert.equal(history[0].masterBasketNumber, 'GB-01');
  assert.equal(history[0].orderType, 'ONLINE');
  assert.equal(hasSavedSorting(history), false, 'Picked online order must not pass packing gate before sorting');

  // 3) Sorting Basket: load candidate via GB-01, decompose into child basket A1
  const sortSelection = selectSortLoadCandidates(
    [
      {
        referenceNumber: 'ONL-001',
        orderNumber: 'ONL-001',
        basketNumber: history[0].basketNumber,
        masterBasketNumber: history[0].masterBasketNumber,
        isPicked: true,
        isSorted: false,
      },
    ],
    'GB-01'
  );
  assert.equal(sortSelection.readyOrders.length, 1);

  const sorted = prepareSortingUpdates(
    history,
    [
      {
        referenceNumber: 'ONL-001',
        masterBasket: 'GB-01',
        basketCode: 'A1',
        items: history,
        counts: { [history[0].id]: 4 },
      },
    ],
    'Packer Online'
  );
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].basketNumber, 'A1');
  assert.equal(sorted[0].masterBasketNumber, 'GB-01');
  assert.equal(sorted[0].orderType, 'ONLINE');
  assert.equal(hasSavedSorting(sorted), true);

  // Basket A1 must now be detected as active conflict for other orders
  const conflicts = findActiveBasketConflicts(sorted, ['A1'], ['ONL-002']);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].stage, 'Packing');

  // 4) Packing Online completes: stock not deducted again, orderType remains ONLINE
  const packed = prepareOrderCompletion(stock, sorted, [
    {
      refNum: 'ONL-001',
      updatedItems: sorted.map((o) => ({ ...o, status: 'Completed', scanned: true })),
      isPicking: false,
    },
  ]);
  assert.equal(packed.orders[0].status, 'Completed');
  assert.equal(packed.orders[0].orderType, 'ONLINE');
  assert.equal(packed.changedStock.length, 0);
});

test('Cross-channel stock reservation prevents overselling between B2B and Online orders', () => {
  const stock = [makeStock({ qty: 10, totalQtySku: 10 })];
  const b2bDraft = prepareOutboundCreation(stock, [], [
    {
      referenceNumber: 'B2B-RES-1',
      orderNumber: 'B2B-RES-1',
      skuId: 'SKU-001',
      skuName: 'Produk Uji 1',
      expiredDate: '31/12/2027',
      location: 'A1-01-01',
      qty: 6,
      warehouseId: 'WH-CENTRAL',
      status: 'Pending',
      scanned: false,
      picked: false,
      stockDeducted: false,
      orderType: 'B2B',
      orderSource: 'MANUAL_B2B',
    },
  ]);

  // Online import requesting 5 pcs when only 4 pcs remain free must fail
  const overImport = planOrderImport(
    [{ row: 2, orderNumber: 'ONL-RES-2', skuId: 'SKU-001', qty: 5, customerName: 'Buyer', customerAddress: '', customerPhone: '', batchNumber: '', noPo: '', errors: [] }],
    stock,
    b2bDraft.orders,
    'WH-CENTRAL'
  );
  assert.ok(overImport[0].errors.length > 0, 'Online order must not oversell stock reserved by Pending B2B order');

  // Online import requesting 4 pcs must succeed
  const exactImport = planOrderImport(
    [{ row: 2, orderNumber: 'ONL-RES-3', skuId: 'SKU-001', qty: 4, customerName: 'Buyer', customerAddress: '', customerPhone: '', batchNumber: '', noPo: '', errors: [] }],
    stock,
    b2bDraft.orders,
    'WH-CENTRAL'
  );
  assert.equal(exactImport[0].errors.length, 0);
  assert.equal(exactImport[0].allocations[0].qty, 4);
});

test('UI isolation: BulkOutbound B2B vs MabangWmsOutbound Online vs OutboundManager HYBRID', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5185/',
  });

  const savedGlobals = new Map();
  const setGlobal = (key, value) => {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'Event', 'Node', 'NodeFilter', 'MutationObserver']) {
    setGlobal(key, dom.window[key]);
  }
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  process.env.DISABLE_HMR = 'true';
  const server = await createViteServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true },
    resolve: { dedupe: ['react', 'react-dom'] },
    plugins: [
      {
        name: 'virtual-outbound-e2e-ui',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === 'virtual:outbound-e2e-ui') return '\0virtual:outbound-e2e-ui';
          if (id === '../supabase' && importer?.includes('src/components/')) {
            return '\0virtual:mock-supabase-outbound';
          }
        },
        load(id) {
          if (id === '\0virtual:mock-supabase-outbound') {
            return `
              export const getActiveBranch = () => 'CENTER';
              export const SERVER_SCAN_ENABLED = false;
              export const DEV_BASELINE_SORTING = false;
              export const serverScanRpc = null;
              export const supabase = null;
            `;
          }
          if (id === '\0virtual:outbound-e2e-ui') {
            return `
              import React, { act } from 'react';
              import { createRoot } from 'react-dom/client';
              import { LanguageProvider } from './src/i18n/LanguageContext.tsx';
              import BulkOutbound from './src/components/BulkOutbound.tsx';
              import MabangWmsOutbound from './src/components/MabangWmsOutbound.tsx';
              import OutboundManager from './src/components/OutboundManager.tsx';
              export { React, act, createRoot, LanguageProvider, BulkOutbound, MabangWmsOutbound, OutboundManager };
            `;
          }
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'silent',
  });

  try {
    const mod = await server.ssrLoadModule('virtual:outbound-e2e-ui');
    const React = mod.React.default || mod.React;
    const act = mod.act || React.act;
    const { createRoot, LanguageProvider, BulkOutbound, MabangWmsOutbound, OutboundManager } = mod;

    const stock = [makeStock({ qty: 50, totalQtySku: 50 })];
    const mixedOrders = [
      {
        id: 'ord-b2b-1',
        referenceNumber: 'REF-B2B-ONLY',
        orderNumber: 'REF-B2B-ONLY',
        customerName: 'Toko Offline B2B',
        skuId: 'SKU-001',
        skuName: 'Produk Uji 1',
        expiredDate: '31/12/2027',
        location: 'A1-01-01',
        qty: 3,
        timestamp: '2026-11-23T01:00:00Z',
        warehouseId: 'WH-CENTRAL',
        status: 'Pending',
        scanned: false,
        picked: false,
        stockDeducted: false,
        orderType: 'B2B',
      },
      {
        id: 'ord-onl-1',
        referenceNumber: 'REF-ONLINE-ONLY',
        orderNumber: 'REF-ONLINE-ONLY',
        customerName: 'Buyer Shopee Online',
        skuId: 'SKU-001',
        skuName: 'Produk Uji 1',
        expiredDate: '31/12/2027',
        location: 'A1-01-01',
        qty: 2,
        timestamp: '2026-11-23T01:05:00Z',
        warehouseId: 'WH-CENTRAL',
        status: 'Pending',
        scanned: false,
        picked: false,
        stockDeducted: false,
        orderType: 'ONLINE',
      },
      {
        id: 'ord-legacy-1',
        referenceNumber: 'REF-LEGACY-UNASSIGNED',
        orderNumber: 'REF-LEGACY-UNASSIGNED',
        customerName: 'Legacy Customer',
        skuId: 'SKU-001',
        skuName: 'Produk Uji 1',
        expiredDate: '31/12/2027',
        location: 'A1-01-01',
        qty: 1,
        timestamp: '2026-11-23T01:10:00Z',
        warehouseId: 'WH-CENTRAL',
        status: 'Pending',
        scanned: false,
        picked: false,
        stockDeducted: false,
      },
    ];

    assert.equal(resolveOrderType(mixedOrders[2]), 'UNASSIGNED');

    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    const flush = async (fn) => {
      await act(async () => {
        if (fn) await fn();
        await new Promise((res) => setTimeout(res, 25));
      });
    };

    // A) BulkOutbound Picking B2B must show ONLY REF-B2B-ONLY
    await flush(() => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(BulkOutbound, {
            channelMode: 'B2B',
            allowedModes: ['pick'],
            initialMode: 'pick',
            stock,
            orderHistory: mixedOrders,
            currentUser: { username: 'picker1', role: 'Picker', fullName: 'Picker 1' },
            onProcessOutbound: async () => true,
          })
        )
      );
    });
    assert.ok(container.textContent.includes('REF-B2B-ONLY'), 'B2B picking queue must include B2B order');
    assert.equal(container.textContent.includes('REF-ONLINE-ONLY'), false, 'B2B picking queue must exclude ONLINE order');
    assert.equal(container.textContent.includes('REF-LEGACY-UNASSIGNED'), false, 'B2B picking queue must exclude UNASSIGNED order');

    // B) MabangWmsOutbound Picking Online must claim ONLY REF-ONLINE-ONLY (excluding B2B and UNASSIGNED)
    await flush(() => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(MabangWmsOutbound, {
            stock,
            orderHistory: mixedOrders,
            currentUser: { username: 'picker1', role: 'Picker', fullName: 'Picker 1' },
            requestedScreen: 'distribution',
            requireExplicitOnlineType: true,
          })
        )
      );
    });
    const getTaskBtn = [...container.querySelectorAll('button')].find((b) =>
      /Ambil Tugas/i.test(b.textContent || '')
    );
    assert.ok(getTaskBtn, 'Ambil Tugas button must exist on Online Picking screen');
    await flush(() => getTaskBtn.click());
    assert.ok(container.textContent.includes('REF-ONLINE-ONLY'), 'Online picking queue must include ONLINE order after Ambil Tugas');
    assert.equal(container.textContent.includes('REF-B2B-ONLY'), false, 'Online picking queue must exclude B2B order');
    assert.equal(container.textContent.includes('REF-LEGACY-UNASSIGNED'), false, 'Online picking queue must exclude UNASSIGNED order');

    // C) OutboundManager on HYBRID must require explicit B2B/ONLINE selection before adding to queue
    await flush(() => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(OutboundManager, {
            stock,
            orderHistory: mixedOrders,
            currentUser: { username: 'admin1', role: 'Administrator', fullName: 'Admin 1' },
            branchOperationType: 'HYBRID',
            onProcessOutbound: async () => true,
          })
        )
      );
    });
    assert.match(container.textContent, /Pilih wajib jenis order B2B atau ONLINE/i);

    await flush(() => root.unmount());
  } finally {
    await server.close();
    dom.window.close();
    for (const [key, desc] of savedGlobals.entries()) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
});
