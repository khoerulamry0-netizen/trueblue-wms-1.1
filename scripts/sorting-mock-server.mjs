import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createMockEngine } from './sorting-mock/mock-engine.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, 'scripts', 'sorting-mock');
const mockModule = resolve(root, 'supabase.ts');
const realModule = resolve(project, 'src', 'supabase.ts');
const port = 3347;

function isolationPlugin(mock) { return {
  name:'sorting-only-isolation',
  enforce:'pre',
  resolveId(source, importer) {
    if (source === realModule || (importer && resolve(dirname(importer), source.replace(/\?.*$/, '')) === realModule.replace(/\.ts$/, ''))) {
      return mockModule;
    }
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      if (!req.url?.startsWith('/__sorting_mock/')) {
        if (decodeURIComponent(req.url || '').replaceAll('\\', '/').includes('/src/supabase.ts')) {
          res.statusCode = 403; res.end('Blocked'); return;
        }
        return next();
      }
      if (req.method !== 'POST' || req.headers.origin !== `http://127.0.0.1:${port}` ||
          req.headers['content-type'] !== 'application/json') {
        res.statusCode = 403; res.end('Forbidden'); return;
      }
      let raw = '';
      try {
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 4096) throw new Error('Request too large');
        }
        const body = JSON.parse(raw);
        const result = req.url === '/__sorting_mock/control'
          ? (mock.control(body.action), {ok:true, orders:mock.orders()})
          : req.url === '/__sorting_mock/orders'
            ? {orders:mock.orders()}
          : req.url === '/__sorting_mock/target'
            ? mock.target(body.code, body.candidates)
          : req.url === '/__sorting_mock/rpc'
            ? {...await mock.rpc(body.name, body.args), orders:mock.orders()}
            : null;
        if (!result) { res.statusCode = 404; res.end('Not found'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 503;
        res.end('Mock request unavailable');
      }
    });
  }
}; }

export function createMockServer({middlewareMode = false, open = false} = {}) {
  const hmr = middlewareMode ? {server:createHttpServer()} : false;
  return createServer({
    configFile:false, envFile:false, root, publicDir:false,
    plugins:[isolationPlugin(createMockEngine()), react(), tailwindcss()],
    optimizeDeps: middlewareMode ? {noDiscovery:true, include:[]} : undefined,
    server:{host:'127.0.0.1', port, strictPort:true, open, middlewareMode, hmr,
      watch:{ignored:['**/*']}, fs:{strict:true, allow:[project]}}
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createMockServer({open:process.argv.includes('--open')});
  await server.listen();
  console.log(`MOCK ONLY — http://127.0.0.1:${port}/ — no Supabase connection`);
}
