import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { verifyWmsUser } from './server/wmsAuth';
import { listenHost } from './server/listenHost';
import { createAssistantCors } from './server/assistantCors';
import { createFrontendRedirect } from './server/frontendRedirect';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const developmentCommand = process.argv.includes('--wms-development');
const productionRuntime = process.env.NODE_ENV === 'production' && !developmentCommand;
app.use('/api/chat', createAssistantCors(productionRuntime ? process.env.WMS_ALLOWED_ORIGINS : ''));
app.use(express.json({ limit: '1mb' }));

function assertDevelopmentSupabaseConfiguration() {
  const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Development startup blocked. Set ${missing.join(', ')} in .env using values from Supabase lokal.`);
  }
  if ([process.env.VITE_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY].some((key) => key!.trim().startsWith('REPLACE_'))) {
    throw new Error('Development startup blocked. Replace the anon-key placeholder with the local Supabase anon/publishable key.');
  }

  const parseUrl = (value: string, name: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} is invalid.`);
    }
    return url.origin;
  };

  const frontendOrigin = parseUrl(process.env.VITE_SUPABASE_URL!.trim(), 'VITE_SUPABASE_URL');
  const backendOrigin = parseUrl(process.env.SUPABASE_URL!.trim(), 'SUPABASE_URL');
  if (frontendOrigin !== backendOrigin) {
    throw new Error('Development startup blocked. VITE_SUPABASE_URL and SUPABASE_URL must point to the same local project.');
  }
  if (process.env.VITE_SUPABASE_ANON_KEY!.trim() !== process.env.SUPABASE_ANON_KEY!.trim()) {
    throw new Error('Development startup blocked. VITE_SUPABASE_ANON_KEY and SUPABASE_ANON_KEY must match.');
  }
}

type AuthenticatedRequest = Request & { wmsUserId?: string };

async function requireWmsUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const url = process.env.SUPABASE_URL || (productionRuntime ? process.env.VITE_SUPABASE_URL : undefined);
  const anonKey = process.env.SUPABASE_ANON_KEY || (productionRuntime ? process.env.VITE_SUPABASE_ANON_KEY : undefined);
  try {
    const result = await verifyWmsUser(token, url, anonKey);
    if (result.status !== 200) {
      res.status(result.status).json({ error: result.status === 403 ? 'Akun WMS belum diaktifkan.' : result.status === 503 ? 'Pemeriksaan akun sedang terganggu. Coba lagi.' : 'Sesi WMS tidak valid. Silakan login ulang.' });
      return;
    }
    req.wmsUserId = result.userId;
    next();
  } catch {
    res.status(503).json({ error: 'Pemeriksaan akun sedang terganggu. Coba lagi.' });
  }
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/chat/status', requireWmsUser, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ configured: Boolean(process.env.GEMINI_API_KEY?.trim()), provider: 'Gemini' });
});

app.post('/api/chat', requireWmsUser, async (req: AuthenticatedRequest, res: Response) => {
  const { messages, model, systemInstruction, warehouseContext } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12) {
    res.status(400).json({ error: 'Riwayat percakapan tidak valid.' });
    return;
  }
  if (typeof process.env.GEMINI_API_KEY !== 'string' || !process.env.GEMINI_API_KEY.trim()) {
    res.status(503).json({ error: 'Kunci Gemini belum dipasang. Administrator perlu menambahkan GEMINI_API_KEY pada hosting WMS.' });
    return;
  }

  try {
    const allowedModels = new Set(['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview']);
    const selectedModel = allowedModels.has(model) ? model : 'gemini-3.5-flash';
    const defaultInstruction = 'Anda adalah asisten operasional gudang. Jawab dalam Bahasa Indonesia dengan ringkas dan jelas.';
    const context = typeof warehouseContext === 'string' ? warehouseContext.slice(0, 30000) : '';
    const instruction = `${typeof systemInstruction === 'string' ? systemInstruction.slice(0, 10000) : defaultInstruction}${context ? `\n\nKonteks stok gudang:\n${context}` : ''}`;
    const contents = messages.map((message: { role?: string; content?: string }) => ({
      role: message.role === 'assistant' || message.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(message.content ?? '').slice(0, 8000) }]
    }));
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 30000 } });
    const result = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config: { systemInstruction: instruction }
    });
    res.json({ text: result.text || 'Tidak ada jawaban yang diterima.', model: selectedModel });
  } catch (error) {
    console.error('WMS assistant request failed');
    res.status(502).json({ error: 'Asisten AI sedang tidak dapat digunakan.' });
  }
});

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
  } else if (process.env.WMS_API_ONLY !== 'true') {
    const distPath = path.join(here, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    app.use((_req, res) => res.status(404).json({ error: 'Endpoint layanan Asisten tidak ditemukan.' }));
  }
  app.listen(port, listenHost(productionRuntime), () => console.log(`BLUES WMS listening on ${port}`));
}

void start();
