import type { RequestHandler } from 'express';

export function createFrontendRedirect(configuredUrl = ''): RequestHandler {
  const value = configuredUrl.trim();
  if (!value) return (_req, _res, next) => next();

  let destination: URL;
  try {
    destination = new URL(value);
  } catch {
    throw new Error('WMS_FRONTEND_URL harus berupa origin HTTPS tanpa path atau kredensial.');
  }
  if (destination.protocol !== 'https:' || destination.username || destination.password
      || destination.pathname !== '/' || destination.search || destination.hash) {
    throw new Error('WMS_FRONTEND_URL harus berupa origin HTTPS tanpa path atau kredensial.');
  }

  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD')
        || (req.path !== '/' && req.path !== '/index.html')
        || req.get('host')?.toLowerCase() === destination.host.toLowerCase()) {
      next();
      return;
    }

    const target = new URL('/', destination);
    target.search = new URL(req.originalUrl, 'https://legacy-wms.invalid').search;
    // Generic shared links may be cached; auth/query links must not be.
    res.set('Cache-Control', target.search ? 'private, no-store' : 'public, max-age=86400');
    res.redirect(301, target.href);
  };
}
