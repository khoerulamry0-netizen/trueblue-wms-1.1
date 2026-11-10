import type { RequestHandler } from 'express';

export function createAssistantCors(configuredOrigins = ''): RequestHandler {
  const allowed = new Set(configuredOrigins.split(',').map(origin => origin.trim()).filter(Boolean).map(origin => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('WMS_ALLOWED_ORIGINS must contain explicit HTTPS origins.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('WMS_ALLOWED_ORIGINS must contain explicit HTTPS origins.');
    }
    return parsed.origin;
  }));
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.get('Origin');
    if (!origin) { next(); return; }
    let sameHost = false;
    try {
      const parsed = new URL(origin);
      sameHost = parsed.origin === origin && ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.get('Host');
    } catch {
      // Invalid origins stay denied.
    }
    if (!sameHost && !allowed.has(origin)) { res.status(403).json({ error: 'Asal aplikasi tidak diizinkan.' }); return; }
    res.set('Access-Control-Allow-Origin', origin);
    if (req.method !== 'OPTIONS') { next(); return; }
    const requestedMethod = req.get('Access-Control-Request-Method') || '';
    const requestedHeaders = (req.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(h => h.trim()).filter(Boolean);
    if (!['GET', 'POST'].includes(requestedMethod) || requestedHeaders.some(h => !['authorization', 'content-type'].includes(h))) {
      res.status(400).json({ error: 'Permintaan lintas asal tidak didukung.' }); return;
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '600');
    res.vary('Access-Control-Request-Method');
    res.vary('Access-Control-Request-Headers');
    res.status(204).end();
  };
}
