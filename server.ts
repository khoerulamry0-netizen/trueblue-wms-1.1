import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { listenHost } from './server/listenHost';
import { createFrontendRedirect } from './server/frontendRedirect';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const developmentCommand = process.argv.includes('--wms-development');
const productionRuntime = process.env.NODE_ENV === 'production' && !developmentCommand;

function assertDevelopmentSupabaseConfiguration() {
  const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Development startup blocked. Set ${missing.join(', ')} in .env using values from Supabase lokal.`);
  }
  if ([process.env.VITE_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY].some((key) => key!.trim().startsWith('REPLACE_'))) {
    throw new Error('Development startup blocked. Replace the anon-key placeholder with the local Supabase anon/publishable key.');
  }

  const parseLocalUrl = (value: string, name: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} is invalid. Development only accepts http://127.0.0.1:54321.`);
    }

    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.port !== '54321' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${name} must point to local Supabase at http://127.0.0.1:54321; hosted projects are blocked in development.`);
    }

    return url.origin;
  };

  const frontendOrigin = parseLocalUrl(process.env.VITE_SUPABASE_URL!.trim(), 'VITE_SUPABASE_URL');
  const backendOrigin = parseLocalUrl(process.env.SUPABASE_URL!.trim(), 'SUPABASE_URL');
  if (frontendOrigin !== backendOrigin) {
    throw new Error('Development startup blocked. VITE_SUPABASE_URL and SUPABASE_URL must point to the same local project.');
  }
  if (process.env.VITE_SUPABASE_ANON_KEY!.trim() !== process.env.SUPABASE_ANON_KEY!.trim()) {
    throw new Error('Development startup blocked. VITE_SUPABASE_ANON_KEY and SUPABASE_ANON_KEY must match.');
  }
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

async function start() {
  if (developmentCommand && process.env.NODE_ENV === 'production') {
    throw new Error('Development startup blocked because NODE_ENV is production. Remove that setting before running npm run dev.');
  }

  if (productionRuntime) {
    app.use(createFrontendRedirect(process.env.WMS_FRONTEND_URL));
  }
  if (!productionRuntime) {
    assertDevelopmentSupabaseConfiguration();
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(here, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(port, listenHost(productionRuntime), () => console.log(`BLUES WMS listening on ${port}`));
}

void start();
