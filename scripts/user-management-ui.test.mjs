import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

test('UserManagement filters operators by branch, role, and search query', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5183/',
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
        name: 'virtual-user-management-ui-entry',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === 'virtual:user-management-ui-entry') return '\0virtual:user-management-ui-entry';
          if (id === '../supabase' && importer?.includes('UserManagement.tsx')) {
            return '\0virtual:mock-supabase-users';
          }
        },
        load(id) {
          if (id === '\0virtual:mock-supabase-users') {
            return `
              export const getActiveBranch = () => 'CENTER';
              export const supabase = {
                from: () => ({
                  select: () => ({
                    order: async () => ({
                      data: [
                        { id: 'CENTER', name: 'OFFLINE B2B' },
                        { id: 'JKT', name: 'JKT' },
                        { id: 'KOL', name: 'KOL' }
                      ]
                    })
                  })
                })
              };
            `;
          }
          if (id === '\0virtual:user-management-ui-entry') {
            return `
              import React, { act } from 'react';
              import { createRoot } from 'react-dom/client';
              import { LanguageProvider } from './src/i18n/LanguageContext.tsx';
              import UserManagement from './src/components/UserManagement.tsx';
              export { React, act, createRoot, LanguageProvider, UserManagement };
            `;
          }
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'silent',
  });

  try {
    const mod = await server.ssrLoadModule('virtual:user-management-ui-entry');
    const React = mod.React.default || mod.React;
    const act = mod.act || React.act;
    const { createRoot, LanguageProvider, UserManagement } = mod;

    const users = [
      { id: 'u1', username: 'admin1', fullName: 'MARSHANDA', role: 'Admin', branch_id: 'KOL', is_active: true },
      { id: 'u2', username: 'agun', fullName: 'AGUN', role: 'Picker', branch_id: 'KOL', is_active: true },
      { id: 'u3', username: 'agil', fullName: 'AGIL', role: 'Packer', branch_id: 'KOL', is_active: true },
      { id: 'u4', username: 'admin4', fullName: 'FADIL', role: 'Admin', branch_id: 'CENTER', is_active: true },
      { id: 'u5', username: 'picker1', fullName: 'RUDI', role: 'Picker', branch_id: 'CENTER', is_active: true },
      { id: 'u6', username: 'amri', fullName: 'AMRI', role: 'Administrator', branch_id: 'JKT', is_active: true },
    ];

    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    const flush = async (fn) => {
      await act(async () => {
        if (fn) await fn();
        await new Promise((res) => setTimeout(res, 20));
      });
    };

    await flush(() => {
      root.render(
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(UserManagement, {
            users,
            currentUser: users[5],
            onAddUser: async () => {},
            onUpdateUser: async () => {},
            onDeleteUser: async () => {},
          })
        )
      );
    });

    const branchSelect = container.querySelector('select[aria-label="Filter cabang operator"]');
    const roleSelect = container.querySelector('select[aria-label="Filter role operator"]');
    assert.ok(branchSelect, 'Branch filter select must exist');
    assert.ok(roleSelect, 'Role filter select must exist');
    assert.match(branchSelect.textContent, /Semua Cabang \(6\)/);
    assert.match(branchSelect.textContent, /KOL \(3\)/);
    assert.match(branchSelect.textContent, /CENTER — OFFLINE B2B \(2\)/);

    const setSelect = async (el, val) => {
      await flush(() => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
    };

    // 1) Filter to branch KOL
    await setSelect(branchSelect, 'KOL');
    assert.ok(container.textContent.includes('MARSHANDA'));
    assert.ok(container.textContent.includes('AGUN'));
    assert.ok(container.textContent.includes('AGIL'));
    assert.equal(container.textContent.includes('FADIL'), false);
    assert.match(roleSelect.textContent, /Semua Role \(3\)/);
    assert.match(roleSelect.textContent, /Picker \(1\)/);

    // 2) Combine branch KOL + role Picker
    await setSelect(roleSelect, 'Picker');
    assert.ok(container.textContent.includes('AGUN'));
    assert.equal(container.textContent.includes('MARSHANDA'), false);
    assert.equal(container.textContent.includes('AGIL'), false);
    assert.match(container.textContent, /Menampilkan 1 dari 6 operator/);

    // 3) Reset brings all 6 operators back
    const resetBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reset');
    assert.ok(resetBtn);
    await flush(() => resetBtn.click());
    assert.ok(container.textContent.includes('MARSHANDA'));
    assert.ok(container.textContent.includes('FADIL'));
    assert.ok(container.textContent.includes('AMRI'));

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
