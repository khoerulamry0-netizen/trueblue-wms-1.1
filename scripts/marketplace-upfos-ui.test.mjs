import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(requireFromRoot.resolve('vite')).href);
const { JSDOM } = requireFromRoot('jsdom');

const tiktokMigration = fs.readFileSync(
  new URL('../supabase/migrations/20261124000000_tiktok_shop_live_oauth.sql', import.meta.url),
  'utf8'
);
const tiktokFn = fs.readFileSync(
  new URL('../supabase/functions/tiktok-live/index.ts', import.meta.url),
  'utf8'
);

test('TikTok Shop migration allows SHOPEE and TIKTOK and locks credential tables to service_role', () => {
  assert.match(tiktokMigration, /check \(marketplace in \('SHOPEE', 'TIKTOK'\)\)/);
  assert.match(tiktokMigration, /create table if not exists public\.marketplace_tiktok_credentials/);
  assert.match(tiktokMigration, /revoke all on public\.marketplace_tiktok_credentials from anon, authenticated, public/);
  assert.match(tiktokMigration, /grant all on public\.marketplace_tiktok_credentials to service_role/);
  assert.match(tiktokMigration, /create table if not exists public\.marketplace_tiktok_oauth_states/);
});

test('TikTok Live Edge Function enforces admin guard and supports authorize, callback, status, and sync', () => {
  assert.match(tiktokFn, /action === 'authorize'/);
  assert.match(tiktokFn, /action === 'status'/);
  assert.match(tiktokFn, /action === 'sync'/);
  assert.match(tiktokFn, /if \(request\.method === 'GET'\) return callback\(request\)/);
  assert.match(tiktokFn, /\['Admin', 'Administrator'\]\.includes\(actor\.role\)/);
});

test('MarketplaceStoreDropdown renders Upfos-style Daftar Toko popover with Manual Order, Shopee, and TikTok Shop', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5186/',
  });
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'Node', 'NodeFilter', 'MutationObserver']) {
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
            return `
              export const supabase = {
                from: () => ({
                  select: () => ({
                    eq: () => ({
                      order: async () => ({
                        data: [
                          { id: '1', marketplace: 'SHOPEE', store_key: 'SHOPEE-LIVE-1', store_name: 'SHOPEE - TRUEBLUE OFFICIAL', mode: 'LIVE', connection_status: 'CONNECTED' },
                          { id: '2', marketplace: 'TIKTOK', store_key: 'TIKTOK-LIVE-1', store_name: 'TIKTOK - TRUEBLUE OFFICIAL', mode: 'LIVE', connection_status: 'CONNECTED' }
                        ],
                        error: null
                      })
                    })
                  })
                })
              };
            `;
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
    const { default: MarketplaceStoreDropdown } = await server.ssrLoadModule('/src/components/MarketplaceStoreDropdown.tsx');

    const container = document.getElementById('root');
    const root = createRoot(container);
    let openedMarketplace = false;

    await act(async () => {
      root.render(
        React.createElement(MarketplaceStoreDropdown, {
          currentUser: { username: 'admin', role: 'Administrator', fullName: 'Admin WMS' },
          onOpenMarketplace: () => {
            openedMarketplace = true;
          },
        })
      );
    });

    const btn = container.querySelector('#header-daftar-toko-btn');
    assert.ok(btn, 'Daftar Toko header button should render for Administrator');
    assert.match(btn.textContent || '', /Daftar Toko/);
    assert.match(btn.textContent || '', /3/); // 1 Manual Order + 2 connected stores

    await act(async () => {
      btn.click();
    });

    const text = container.textContent || '';
    assert.match(text, /MANUAL ORDER/);
    assert.match(text, /SHOPEE - TRUEBLUE OFFICIAL/);
    assert.match(text, /TIKTOK - TRUEBLUE OFFICIAL/);
    assert.match(text, /Terhubung/);

    const lihatBtn = Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').includes('Lihat'));
    assert.ok(lihatBtn, 'Lihat button should exist inside popover');
    await act(async () => {
      lihatBtn.click();
    });
    assert.equal(openedMarketplace, true);

    await act(async () => {
      root.unmount();
    });
  } finally {
    await server.close();
    dom.window.close();
  }
});
