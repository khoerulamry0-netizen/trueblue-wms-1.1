import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

test('ProductCatalog supports single, selected, and full catalog deletion via confirmation modal', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5184/',
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
        name: 'virtual-catalog-delete-ui-entry',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === 'virtual:catalog-delete-ui-entry') return '\0virtual:catalog-delete-ui-entry';
          if (id === '../supabase' && importer?.includes('ProductCatalog.tsx')) {
            return '\0virtual:mock-supabase-catalog';
          }
        },
        load(id) {
          if (id === '\0virtual:mock-supabase-catalog') {
            return `export const getActiveBranch = () => 'CENTER';`;
          }
          if (id === '\0virtual:catalog-delete-ui-entry') {
            return `
              import React, { act } from 'react';
              import { createRoot } from 'react-dom/client';
              import { LanguageProvider } from './src/i18n/LanguageContext.tsx';
              import ProductCatalog from './src/components/ProductCatalog.tsx';
              export { React, act, createRoot, LanguageProvider, ProductCatalog };
            `;
          }
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'silent',
  });

  try {
    const mod = await server.ssrLoadModule('virtual:catalog-delete-ui-entry');
    const React = mod.React.default || mod.React;
    const act = mod.act || React.act;
    const { createRoot, LanguageProvider, ProductCatalog } = mod;

    let catalogState = [
      { id: 'SKU-A', skuId: 'SKU-A', skuName: 'Produk A', brand: 'TB', barcode: '111', qtyCtnSize: 24, qtyInnerSize: 6 },
      { id: 'SKU-B', skuId: 'SKU-B', skuName: 'Produk B', brand: 'TB', barcode: '222', qtyCtnSize: 24, qtyInnerSize: 6 },
      { id: 'SKU-C', skuId: 'SKU-C', skuName: 'Produk C', brand: 'TB', barcode: '333', qtyCtnSize: 24, qtyInnerSize: 6 },
      { id: 'SKU-D', skuId: 'SKU-D', skuName: 'Produk D', brand: 'TB', barcode: '444', qtyCtnSize: 24, qtyInnerSize: 6 },
    ];
    const batchCalls = [];

    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    const flush = async (fn) => {
      await act(async () => {
        if (fn) await fn();
        await new Promise((res) => setTimeout(res, 20));
      });
    };

    const renderCatalog = async () => {
      await flush(() => {
        root.render(
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(ProductCatalog, {
              catalog: catalogState,
              stock: [],
              userRole: 'Administrator',
              onAddCatalogItem: async () => true,
              onUpdateCatalogItem: async () => true,
              onDeleteCatalogItem: async (skuId) => {
                catalogState = catalogState.filter((c) => c.skuId !== skuId);
                return true;
              },
              onBatchDeleteCatalogItems: async (skuIds) => {
                batchCalls.push([...skuIds]);
                const rm = new Set(skuIds.map((s) => s.toUpperCase()));
                const before = catalogState.length;
                catalogState = catalogState.filter((c) => !rm.has(c.skuId.toUpperCase()));
                return { success: true, deletedCount: before - catalogState.length };
              },
              onBatchImportCatalog: async () => ({ success: true, catalogSavedCount: 0, stockSyncedCount: 0 }),
              onSyncStockToCatalog: async () => ({ addedCount: 0, updatedCatalogCount: 0, syncedStockCount: 0 }),
            })
          )
        );
      });
    };

    await renderCatalog();

    // 1) Delete a single row via its row Trash button confirmation modal
    const singleDeleteBtn = container.querySelector('button[title="Hapus Item"]');
    assert.ok(singleDeleteBtn, 'Single-row delete button must exist');
    await flush(() => singleDeleteBtn.click());
    const confirmSingleBtn = [...container.querySelectorAll('button')].find((b) =>
      /Ya, Hapus SKU/i.test(b.textContent || '')
    );
    assert.ok(confirmSingleBtn, 'Single-row confirmation button must appear');
    await flush(() => confirmSingleBtn.click());
    await renderCatalog();
    assert.deepEqual(batchCalls[0], ['SKU-A']);
    assert.deepEqual(catalogState.map((c) => c.skuId), ['SKU-B', 'SKU-C', 'SKU-D']);

    // 2) Select 2 rows and delete selected
    const cbB = container.querySelector('input[aria-label="Pilih SKU SKU-B"]');
    const cbC = container.querySelector('input[aria-label="Pilih SKU SKU-C"]');
    assert.ok(cbB && cbC, 'Row checkboxes must exist for Admin');
    await flush(() => cbB.click());
    await flush(() => cbC.click());

    const deleteSelectedBtn = [...container.querySelectorAll('button')].find((b) =>
      /Hapus Terpilih \(2\)/i.test(b.textContent || '')
    );
    assert.ok(deleteSelectedBtn, 'Hapus Terpilih (2) button must appear');
    await flush(() => deleteSelectedBtn.click());

    const confirmBtn1 = [...container.querySelectorAll('button')].find((b) =>
      /Ya, Hapus Terpilih/i.test(b.textContent || '')
    );
    assert.ok(confirmBtn1, 'Confirmation modal button must appear for selected delete');
    await flush(() => confirmBtn1.click());
    await renderCatalog();

    assert.equal(batchCalls.length, 2);
    assert.deepEqual(batchCalls[1].sort(), ['SKU-B', 'SKU-C']);
    assert.deepEqual(catalogState.map((c) => c.skuId), ['SKU-D']);

    // 3) Delete remaining catalog with "Hapus Katalog" button
    const deleteAllBtn = container.querySelector('#btn-delete-all-catalog');
    assert.ok(deleteAllBtn, 'Hapus Katalog button must exist');
    await flush(() => deleteAllBtn.click());

    const confirmBtn2 = [...container.querySelectorAll('button')].find((b) =>
      /Ya, Hapus Semua/i.test(b.textContent || '')
    );
    assert.ok(confirmBtn2, 'Confirmation modal button must appear for full delete');
    await flush(() => confirmBtn2.click());
    await renderCatalog();

    assert.equal(batchCalls.length, 3);
    assert.deepEqual(batchCalls[2], ['SKU-D']);
    assert.equal(catalogState.length, 0);

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
