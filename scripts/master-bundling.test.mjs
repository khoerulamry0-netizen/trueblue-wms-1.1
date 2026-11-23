import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildBundleMap,
  computeBundleAvailablePacks,
  expandManualEntriesForBundles,
  isBundleCatalogItem,
  normalizeBundleComponents,
} from '../src/utils/bundleExplode.ts';
import { parseOrderTable, planOrderImport } from '../src/utils/orderImport.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

const sampleCatalog = [
  { id: 'SKU-A', skuId: 'SKU-A', skuName: 'Serum A', brand: 'TRUEBLUE', barcode: '8990001', qtyCtnSize: 24, qtyInnerSize: 6 },
  { id: 'SKU-B', skuId: 'SKU-B', skuName: 'Toner B', brand: 'TRUEBLUE', barcode: '8990002', qtyCtnSize: 24, qtyInnerSize: 6 },
  { id: 'SKU-C', skuId: 'SKU-C', skuName: 'Cream C', brand: 'TRUEBLUE', barcode: '8990003', qtyCtnSize: 24, qtyInnerSize: 6 },
  {
    id: 'BUNDLE-3IN1',
    skuId: 'BUNDLE-3IN1',
    skuName: 'Paket Glowing 3in1',
    brand: 'TRUEBLUE',
    barcode: '8999999',
    qtyCtnSize: 1,
    qtyInnerSize: 1,
    isBundle: true,
    bundleComponents: [
      { skuId: 'SKU-A', skuName: 'Serum A', qty: 1 },
      { skuId: 'SKU-B', skuName: 'Toner B', qty: 2 },
      { skuId: 'SKU-C', skuName: 'Cream C', qty: 1 },
    ],
  },
];

const sampleStock = [
  {
    id: 'STK-A',
    skuId: 'SKU-A',
    skuName: 'Serum A',
    location: 'A-01-01',
    expiredDate: '12/12/2027',
    qty: 10,
    status: 'Normal',
    warehouseId: 'WH-CENTRAL',
  },
  {
    id: 'STK-B',
    skuId: 'SKU-B',
    skuName: 'Toner B',
    location: 'A-01-02',
    expiredDate: '12/12/2027',
    qty: 11,
    status: 'Normal',
    warehouseId: 'WH-CENTRAL',
  },
  {
    id: 'STK-C',
    skuId: 'SKU-C',
    skuName: 'Cream C',
    location: 'A-01-03',
    expiredDate: '12/12/2027',
    qty: 8,
    status: 'Normal',
    warehouseId: 'WH-CENTRAL',
  },
];

test('normalizeBundleComponents validates self-ref, nested bundle, invalid qty, and merges duplicates', () => {
  const selfRef = normalizeBundleComponents([{ skuId: 'BUNDLE-X', qty: 1 }], 'BUNDLE-X', sampleCatalog);
  assert.equal(selfRef.ok, false);

  const nested = normalizeBundleComponents([{ skuId: 'BUNDLE-3IN1', qty: 1 }], 'BUNDLE-NEW', sampleCatalog);
  assert.equal(nested.ok, false);

  const invalidQty = normalizeBundleComponents([{ skuId: 'SKU-A', qty: 0 }], 'BUNDLE-NEW', sampleCatalog);
  assert.equal(invalidQty.ok, false);

  const merged = normalizeBundleComponents(
    [
      { skuId: 'sku-a', qty: 1 },
      { skuId: 'SKU-A', qty: 2 },
      { skuId: 'sku-b', qty: 1 },
    ],
    'BUNDLE-NEW',
    sampleCatalog
  );
  assert.equal(merged.ok, true);
  assert.deepEqual(
    merged.components.map((c) => ({ skuId: c.skuId, qty: c.qty })),
    [
      { skuId: 'SKU-A', qty: 3 },
      { skuId: 'SKU-B', qty: 1 },
    ]
  );
});

test('computeBundleAvailablePacks calculates max packs and respects pending order reservations', () => {
  const bundle = sampleCatalog[3];
  assert.equal(isBundleCatalogItem(bundle), true);

  // SKU-A: 10/1=10, SKU-B: 11/2=5, SKU-C: 8/1=8 -> max 5 packs limited by SKU-B
  const avail = computeBundleAvailablePacks(bundle, sampleStock, [], 'WH-CENTRAL', sampleCatalog);
  assert.equal(avail.maxPacks, 5);
  assert.equal(avail.limitingSku, 'SKU-B');

  // With 3 pcs of SKU-B reserved by a pending order -> SKU-B free = 8 -> max 4 packs
  const pendingOrder = [
    {
      id: 'ORD-1',
      referenceNumber: 'REF-1',
      skuId: 'SKU-B',
      skuName: 'Toner B',
      expiredDate: '12/12/2027',
      qty: 3,
      location: 'A-01-02',
      status: 'Pending',
      scanned: false,
      picked: false,
      warehouseId: 'WH-CENTRAL',
    },
  ];
  const availAfterReserve = computeBundleAvailablePacks(bundle, sampleStock, pendingOrder, 'WH-CENTRAL', sampleCatalog);
  assert.equal(availAfterReserve.maxPacks, 4);
  assert.equal(availAfterReserve.limitingSku, 'SKU-B');
});

test('expandManualEntriesForBundles explodes 1 bundle SKU (qty 2) into 3 component entries', () => {
  const bundleMap = buildBundleMap(sampleCatalog);
  const expanded = expandManualEntriesForBundles(
    [{ skuId: 'BUNDLE-3IN1', qty: 2, originalText: 'BUNDLE-3IN1\t2' }],
    bundleMap
  );
  assert.equal(expanded.length, 3);
  assert.deepEqual(
    expanded.map((e) => ({ skuId: e.skuId, qty: e.qty, bundleSku: e.bundleSku, bundleQty: e.bundleQty })),
    [
      { skuId: 'SKU-A', qty: 2, bundleSku: 'BUNDLE-3IN1', bundleQty: 2 },
      { skuId: 'SKU-B', qty: 4, bundleSku: 'BUNDLE-3IN1', bundleQty: 2 },
      { skuId: 'SKU-C', qty: 2, bundleSku: 'BUNDLE-3IN1', bundleQty: 2 },
    ]
  );
});

test('planOrderImport auto-explodes bundle SKU into 3 components and merges overlapping standalone SKU', () => {
  const table = [
    ['No Order', 'SKU', 'Qty (pcs)', 'Pelanggan'],
    ['ORD-BND-001', 'BUNDLE-3IN1', '2', 'Toko Mawar'],
    ['ORD-BND-001', 'SKU-A', '1', 'Toko Mawar'],
  ];
  const lines = parseOrderTable(table);
  const plan = planOrderImport(lines, sampleStock, [], 'WH-CENTRAL', sampleCatalog);

  assert.equal(plan.length, 3);
  assert.equal(plan.every((p) => p.errors.length === 0), true);

  const bySku = new Map(plan.map((p) => [p.skuId, p]));
  assert.equal(bySku.get('SKU-A')?.qty, 3); // 2 from bundle + 1 standalone
  assert.equal(bySku.get('SKU-B')?.qty, 4); // 2 * 2 from bundle
  assert.equal(bySku.get('SKU-C')?.qty, 2); // 2 * 1 from bundle
  assert.equal(bySku.get('SKU-B')?.bundleSource, 'BUNDLE-3IN1 x2');
});

test('planOrderImport flags component shortage when 1 of 3 bundle components lacks stock', () => {
  const table = [
    ['No Order', 'SKU', 'Qty (pcs)'],
    ['ORD-BND-SHORT', 'BUNDLE-3IN1', '6'], // needs 12 SKU-B, only 11 available
  ];
  const lines = parseOrderTable(table);
  const plan = planOrderImport(lines, sampleStock, [], 'WH-CENTRAL', sampleCatalog);

  const skuB = plan.find((p) => p.skuId === 'SKU-B');
  assert.ok(skuB);
  assert.equal(skuB.errors.length > 0, true);
  assert.match(skuB.errors[0], /Stok bebas rak aktif kurang/);
});

test('ProductCatalog UI renders Master Bundling tab, max packs, and creates bundle via modal', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5185/',
  });
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'InputEvent', 'Node', 'NodeFilter', 'MutationObserver']) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
        name: 'stub-supabase',
        enforce: 'pre',
        resolveId(id) {
          if (id === '../supabase' || /[\\/]supabase(\.ts)?$/.test(id)) return '\0stub-supabase';
          return null;
        },
        load(id) {
          if (id === '\0stub-supabase') {
            return 'export const getActiveBranch = () => "CENTER";';
          }
          return null;
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'error',
  });

  try {
    const React = requireFromRoot('react');
    const { act } = React;
    const { createRoot } = requireFromRoot('react-dom/client');
    const { default: ProductCatalog } = await server.ssrLoadModule('/src/components/ProductCatalog.tsx');
    const { LanguageProvider } = await server.ssrLoadModule('/src/i18n/LanguageContext.tsx');

    const container = document.getElementById('root');
    const root = createRoot(container);
    let addedPayload = null;

    await act(async () => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(ProductCatalog, {
            catalog: sampleCatalog,
            stock: sampleStock,
            userRole: 'Administrator',
            onAddCatalogItem: async (item) => {
              addedPayload = item;
              return true;
            },
            onUpdateCatalogItem: async () => true,
            onDeleteCatalogItem: async () => true,
            onBatchImportCatalog: async () => ({ success: true, catalogSavedCount: 0, stockSyncedCount: 0 }),
            onSyncStockToCatalog: async () => ({ addedCount: 0, updatedCatalogCount: 0, syncedStockCount: 0 }),
          })
        )
      );
    });

    // Verify Master Bundling tab and Maks. 5 Paket render
    assert.match(container.textContent || '', /Master Bundling \(1\)/);
    assert.match(container.textContent || '', /Maks\. 5 Paket/);

    // Open Tambah Bundling modal
    const addBundleBtn = container.querySelector('#btn-add-bundle-item');
    assert.ok(addBundleBtn, 'Tambah Bundling button should exist');
    await act(async () => {
      addBundleBtn.click();
    });

    const modalTitle = container.textContent || '';
    assert.match(modalTitle, /Tambah Master Bundling/);

    // Fill SKU Bundling, Nama Paket, and 2 component rows
    const setInputVal = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    };

    const skuInput = container.querySelector('input[placeholder="e.g. BUNDLE-HEMAT-3"]');
    const nameInput = container.querySelector('input[placeholder="e.g. Paket Glowing 3in1"]');
    const compInputs = container.querySelectorAll('input[list="wms-bundle-component-skus"]');
    assert.ok(skuInput && nameInput && compInputs.length >= 2);

    await act(async () => {
      setInputVal(skuInput, 'BUNDLE-TEST-2');
      setInputVal(nameInput, 'Paket Duo Test');
      setInputVal(compInputs[0], 'SKU-A');
      setInputVal(compInputs[1], 'SKU-C');
    });

    const form = skuInput.closest('form');
    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });

    assert.ok(addedPayload, 'onAddCatalogItem should be called');
    assert.equal(addedPayload.skuId, 'BUNDLE-TEST-2');
    assert.equal(addedPayload.isBundle, true);
    assert.equal(addedPayload.bundleComponents.length, 2);
    assert.deepEqual(
      addedPayload.bundleComponents.map((c) => ({ skuId: c.skuId, qty: c.qty })),
      [
        { skuId: 'SKU-A', qty: 1 },
        { skuId: 'SKU-C', qty: 1 },
      ]
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    await server.close();
    dom.window.close();
  }
});
