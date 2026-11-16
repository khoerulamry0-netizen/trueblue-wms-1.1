import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

test('Stock Opname (DCC) hides Jadwal DCC Harian submenu and falls back from stale SCHEDULE storage', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5182/',
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
  dom.window.localStorage.setItem('wms_dcc_active_subtab', 'SCHEDULE');

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
        name: 'virtual-stock-opname-ui-entry',
        resolveId(id) {
          if (id === 'virtual:stock-opname-ui-entry') return '\0virtual:stock-opname-ui-entry';
        },
        load(id) {
          if (id === '\0virtual:stock-opname-ui-entry') {
            return `
              import React, { act } from 'react';
              import { createRoot } from 'react-dom/client';
              import { LanguageProvider } from './src/i18n/LanguageContext.tsx';
              import CekFisik from './src/components/CekFisik.tsx';
              export { React, act, createRoot, LanguageProvider, CekFisik };
            `;
          }
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'silent',
  });

  try {
    const mod = await server.ssrLoadModule('virtual:stock-opname-ui-entry');
    const React = mod.React.default || mod.React;
    const act = mod.act || React.act;
    const { createRoot, LanguageProvider, CekFisik } = mod;

    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(CekFisik, {
            mode: 'daily-cycle-count',
            stock: [
              {
                id: 'stk-1',
                skuId: '1019',
                skuName: 'Produk Uji Opname',
                location: 'E10-01-01',
                expiredDate: '31/12/2027',
                qty: 50,
                warehouseId: 'WH-CENTRAL',
              },
            ],
            audits: [],
            saveAuditsState: () => {},
            currentUser: {
              id: 'u-1',
              username: 'admin1',
              role: 'Administrator',
              fullName: 'Admin 1',
            },
            onAdjustStockCount: () => true,
          })
        )
      );
      await new Promise((res) => setTimeout(res, 15));
    });

    assert.equal(container.querySelector('#dcc-schedule-tab-btn'), null, 'Jadwal DCC Harian tab must not exist');
    const countTabBtn = container.querySelector('#daily-cycle-count-tab-btn');
    const opnameLokasiTabBtn = container.querySelector('#dcc-opname-lokasi-tab-btn');
    assert.ok(countTabBtn, 'Input Daily Cycle Count tab must remain visible');
    assert.ok(opnameLokasiTabBtn, 'Opname per Lokasi tab must remain visible');
    const subtabButtons = [...countTabBtn.parentElement.querySelectorAll('button')];
    assert.equal(subtabButtons.length, 2, 'Stock Opname (DCC) must expose only 2 submenus');
    assert.equal(subtabButtons.some((btn) => btn.textContent.includes('Jadwal DCC Harian')), false, 'Submenu label Jadwal DCC Harian must not exist in tab bar');
    assert.equal(container.textContent.includes('Jadwal Daily Cycle Count (DCC) Harian'), false, 'Schedule view banner must not be rendered');
    assert.equal(container.textContent.includes('Lihat Detail Jadwal'), false, 'Lihat Detail Jadwal button must not be rendered');
    assert.match(container.textContent, /Daily Cycle Count/, 'Stale SCHEDULE storage must fall back cleanly to Input Daily Cycle Count');

    await act(async () => {
      root.unmount();
    });
  } finally {
    await server.close();
    dom.window.close();
    for (const [key, desc] of savedGlobals.entries()) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
});
