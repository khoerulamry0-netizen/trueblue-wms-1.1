import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

test('HistoryOrder paginates 4,000 rows (1,000 orders x 4 SKUs) cleanly across batch, order & flat views', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5181/',
  });

  const savedGlobals = new Map();
  const setGlobal = (key, value) => {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Event', 'Node', 'NodeFilter', 'MutationObserver']) {
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
        name: 'virtual-history-order-ui-entry',
        resolveId(id) {
          if (id === 'virtual:history-order-ui-entry') return '\0virtual:history-order-ui-entry';
        },
        load(id) {
          if (id === '\0virtual:history-order-ui-entry') {
            return `
              import React, { act } from 'react';
              import { createRoot } from 'react-dom/client';
              import { LanguageProvider } from './src/i18n/LanguageContext.tsx';
              import HistoryOrder from './src/components/HistoryOrder.tsx';
              export { React, act, createRoot, LanguageProvider, HistoryOrder };
            `;
          }
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'silent',
  });

  try {
    const mod = await server.ssrLoadModule('virtual:history-order-ui-entry');
    const React = mod.React.default || mod.React;
    const act = mod.act || React.act;
    const { createRoot, LanguageProvider, HistoryOrder } = mod;

    // 1,000 orders x 4 SKUs = 4,000 rows across 40 batches with distinct timestamps
    const baseMs = Date.parse('2026-11-15T01:00:00Z');
    const rows = [];
    for (let ord = 1; ord <= 1000; ord++) {
      const batchNo = `WAVE-${String(Math.floor((ord - 1) / 25) + 1).padStart(2, '0')}`;
      const orderNo = `ORD-HIST-${String(ord).padStart(4, '0')}`;
      for (let line = 0; line < 4; line++) {
        const idx = (ord - 1) * 4 + line;
        rows.push({
          id: `hist-${ord}-${line + 1}`,
          referenceNumber: orderNo,
          orderNumber: orderNo,
          batchNumber: batchNo,
          skuId: `SKU-${String(((ord + line) % 40) + 1).padStart(3, '0')}`,
          skuName: `Produk Uji ${line + 1}`,
          expiredDate: '31/12/2027',
          location: `R-${String((line % 5) + 1).padStart(2, '0')}`,
          qty: (line % 3) + 1,
          warehouseId: 'WH-CENTRAL',
          customerName: `Pelanggan ${ord}`,
          customerAddress: `Jl. Uji No. ${ord}`,
          timestamp: new Date(baseMs + idx * 1000).toISOString(),
          createdAt: new Date(baseMs + idx * 1000).toISOString(),
          pickedAt: new Date(baseMs + idx * 1000 + 60000).toISOString(),
          sortedAt: new Date(baseMs + idx * 1000 + 120000).toISOString(),
          packedAt: new Date(baseMs + idx * 1000 + 180000).toISOString(),
          createdBy: 'Admin 1',
          pickedBy: 'Picker 1',
          sortedBy: 'Sorter 1',
          packedBy: 'Packer 1',
          scanned: true,
          status: 'Completed',
          picked: true,
          stockDeducted: true,
        });
      }
    }
    assert.equal(rows.length, 4000);

    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    const flush = async (fn) => {
      await act(async () => {
        if (fn) await fn();
        await new Promise((res) => setTimeout(res, 10));
      });
    };

    const tMount0 = performance.now();
    await flush(() => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(HistoryOrder, {
            orderHistory: rows,
            currentUser: { username: 'admin1', role: 'Administrator', fullName: 'Admin 1' },
          })
        )
      );
    });
    const mountMs = Math.round(performance.now() - tMount0);

    const clickBtnText = async (textPart) => {
      const btn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes(textPart));
      assert.ok(btn, `Button containing "${textPart}" not found`);
      await flush(() => btn.click());
    };

    // 1) Batch view defaults to 25 of 40 batches on page 1 and prioritizes Order before BATCH
    assert.match(container.textContent, /Menampilkan\s+1–25\s+dari\s+40\s+Batch/);
    assert.match(container.textContent, /Hal 1 \/ 2/);
    const batchText = container.textContent;
    const firstOrderPos = batchText.indexOf('Order: ORD-HIST-');
    const firstBatchMatch = /BATCH:\s*WAVE-/.exec(batchText);
    assert.ok(firstOrderPos !== -1 && firstBatchMatch && firstOrderPos < firstBatchMatch.index, 'Batch card header must show Order before BATCH');
    assert.match(batchText, /\+24 order/);
    await clickBtnText('Berikutnya');
    assert.match(container.textContent, /Menampilkan\s+26–40\s+dari\s+40\s+Batch/);

    // 2) Switch to Per Order view -> defaults to 50 of 1.000 orders and shows No Order before Batch
    const tOrder0 = performance.now();
    await clickBtnText('(1000)');
    const switchToOrderMs = Math.round(performance.now() - tOrder0);
    assert.match(container.textContent, /Menampilkan\s+1–50\s+dari\s+1\.000\s+Order/);
    assert.match(container.textContent, /Hal 1 \/ 20/);
    const orderCardText = container.textContent;
    const cardNoOrderPos = orderCardText.indexOf('No Order: ORD-HIST-');
    const cardBatchPos = orderCardText.indexOf('Batch: WAVE-');
    assert.ok(cardNoOrderPos !== -1 && cardBatchPos !== -1 && cardNoOrderPos < cardBatchPos, 'Order card must show No Order before Batch');

    await clickBtnText('Berikutnya');
    assert.match(container.textContent, /Menampilkan\s+51–100\s+dari\s+1\.000\s+Order/);

    // Change page size dropdown to 100
    const pageSelect = container.querySelector('select[aria-label*="per halaman"]');
    assert.ok(pageSelect);
    await flush(() => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
      setter.call(pageSelect, '100');
      pageSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.match(container.textContent, /Menampilkan\s+1–100\s+dari\s+1\.000\s+Order/);
    assert.match(container.textContent, /Hal 1 \/ 10/);

    // 3) Select All across all 4.000 filtered rows must stay fast and update export label
    const tSel0 = performance.now();
    await clickBtnText('Pilih Semua');
    const selectAllMs = Math.round(performance.now() - tSel0);
    assert.match(container.textContent, /\(4000 Terpilih\)/);

    // 4) Switch to Flat Table view -> renders ONLY current page rows in DOM (<= pageSize = 100)
    // Reset custom page size to 25 to verify flat table honors selector cleanly or default 100
    const tFlat0 = performance.now();
    await clickBtnText('(4000)');
    const switchToFlatMs = Math.round(performance.now() - tFlat0);
    const renderedFlatRows = container.querySelectorAll('tbody tr').length;
    assert.equal(renderedFlatRows, 100, 'Flat table must cap rendered DOM rows to active page size');
    const flatHeaders = [...container.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    assert.ok(flatHeaders.indexOf('Order / No PO') !== -1 && flatHeaders.indexOf('Batch Number') !== -1);
    assert.ok(flatHeaders.indexOf('Order / No PO') < flatHeaders.indexOf('Batch Number'), 'Flat table must show Order / No PO before Batch Number');
    assert.match(container.textContent, /Menampilkan\s+1–100\s+dari\s+4\.000\s+Baris/);
    assert.match(container.textContent, /Hal 1 \/ 40/);

    // 5) Navigate to page 2 then type search -> auto-resets to page 1 and isolates matching order
    await clickBtnText('Berikutnya');
    assert.match(container.textContent, /Hal 2 \/ 40/);

    const searchInput = [...container.querySelectorAll('input[type="text"]')].find((inp) =>
      (inp.placeholder || '').length > 0
    );
    assert.ok(searchInput);
    const tSearch0 = performance.now();
    await flush(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(searchInput, 'ORD-HIST-0999');
      searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 25));
    });
    const searchMs = Math.round(performance.now() - tSearch0);
    assert.equal(container.querySelectorAll('tbody tr').length, 4);
    assert.match(container.textContent, /Menampilkan\s+1–4\s+dari\s+4\s+Baris/);

    await flush(() => root.unmount());

    console.log(
      JSON.stringify({
        summary: 'HISTORY_ORDER_4000_ROWS_UI_PAGINATION_METRICS',
        totalOrders: 1000,
        totalRows: 4000,
        mountMs,
        switchToOrderMs,
        selectAllMs,
        switchToFlatMs,
        searchMs,
        renderedFlatDomRowsPerPage: renderedFlatRows,
      })
    );
  } finally {
    await server.close();
    dom.window.close();
    for (const [key, desc] of savedGlobals.entries()) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
});
