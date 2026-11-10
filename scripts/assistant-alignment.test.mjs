import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import test from 'node:test';
import express from 'express';
import { createAssistantCors } from '../server/assistantCors.ts';
import { createFrontendRedirect } from '../server/frontendRedirect.ts';
import { listenHost } from '../server/listenHost.ts';
import { assistantApiUrl, assistantConnectionError } from '../src/utils/assistantConnection.ts';

function invoke(handler, { method = 'GET', path = '/', originalUrl = path, headers = {} } = {}) {
  const requestHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const req = { method, path, originalUrl, get: name => requestHeaders[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    vary(name) {
      const current = this.headers.vary ? this.headers.vary.split(', ') : [];
      if (!current.includes(name)) current.push(name);
      return this.set('Vary', current.join(', '));
    },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    redirect(code, location) { this.status(code).set('Location', location); this.ended = true; return this; },
  };
  let nextCalls = 0;
  handler(req, res, () => { nextCalls++; });
  return { res, nextCalls };
}

async function dispatchExpress(app, { method = 'GET', path = '/', headers = {} } = {}) {
  class MemorySocket extends Duplex {
    _read() {}
    _write(_chunk, _encoding, callback) { callback(); }
  }
  const socket = new MemorySocket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('In-memory Express request timed out')), 1000);
    res.once('finish', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    app(req, res);
  });
  return { statusCode: res.statusCode, headers: res.getHeaders() };
}

test('assistant uses relative URLs by default and supports valid API origins', () => {
  assert.equal(assistantApiUrl('/api/chat'), '/api/chat');
  assert.equal(assistantApiUrl('/api/chat/status', '  https://assistant.example.test/  '), 'https://assistant.example.test/api/chat/status');
  assert.equal(assistantApiUrl('/api/chat', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000/api/chat');
  assert.equal(assistantApiUrl('/api/chat', 'http://[::1]:3000'), 'http://[::1]:3000/api/chat');
});

test('assistant rejects invalid origins with a clear configuration error', () => {
  for (const origin of [
    'not a URL',
    'http://assistant.example.test',
    'https://user:password@assistant.example.test',
    'https://assistant.example.test/path',
    'https://assistant.example.test/?query=1',
    'https://assistant.example.test/#fragment',
  ]) {
    assert.throws(() => assistantApiUrl('/api/chat', origin), /Alamat layanan Asisten AI tidak valid/);
  }
});

test('assistant reports timeouts and preserves actionable errors', () => {
  const timeout = new Error('timeout');
  timeout.name = 'TimeoutError';
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  for (const error of [timeout, aborted, new TypeError('network')]) {
    assert.match(assistantConnectionError(error, 'fallback'), /belum merespons/);
  }
  assert.equal(assistantConnectionError(new Error('Silakan login ulang.'), 'fallback'), 'Silakan login ulang.');
  assert.equal(assistantConnectionError(null, 'fallback'), 'fallback');
});

test('assistant CORS permits same-origin, configured origin, and requests without Origin', () => {
  const cors = createAssistantCors(' https://ui.example.test, http://127.0.0.1:3000 ');
  const noOrigin = invoke(cors, { headers: { Host: 'api.example.test' } });
  assert.equal(noOrigin.nextCalls, 1);
  assert.equal(noOrigin.res.headers.vary, 'Origin');
  assert.equal(noOrigin.res.headers['access-control-allow-origin'], undefined);

  for (const [origin, host] of [
    ['https://api.example.test', 'api.example.test'],
    ['https://ui.example.test', 'api.example.test'],
    ['http://127.0.0.1:3000', '127.0.0.1:4000'],
  ]) {
    const result = invoke(cors, { headers: { Origin: origin, Host: host } });
    assert.equal(result.nextCalls, 1);
    assert.equal(result.res.headers['access-control-allow-origin'], origin);
  }
});

test('assistant CORS allows only supported preflight methods and headers', () => {
  const cors = createAssistantCors('https://ui.example.test');
  const headers = {
    Origin: 'https://ui.example.test',
    Host: 'api.example.test',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Authorization, Content-Type',
  };
  const allowed = invoke(cors, { method: 'OPTIONS', headers });
  assert.equal(allowed.nextCalls, 0);
  assert.equal(allowed.res.statusCode, 204);
  assert.equal(allowed.res.ended, true);
  assert.equal(allowed.res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
  assert.equal(allowed.res.headers['access-control-allow-headers'], 'Authorization, Content-Type');
  assert.match(allowed.res.headers.vary, /Access-Control-Request-Method/);
  assert.match(allowed.res.headers.vary, /Access-Control-Request-Headers/);
  for (const changed of [
    { 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Headers': 'Authorization, X-Custom' },
  ]) {
    const denied = invoke(cors, { method: 'OPTIONS', headers: { ...headers, ...changed } });
    assert.equal(denied.nextCalls, 0);
    assert.equal(denied.res.statusCode, 400);
    assert.match(denied.res.body.error, /tidak didukung/);
  }
});

test('assistant CORS denies unconfigured and malformed origins, including development defaults', () => {
  for (const origin of ['https://other.example.test', 'null', 'not-an-origin']) {
    const result = invoke(createAssistantCors(), { headers: { Origin: origin, Host: 'localhost:3000' } });
    assert.equal(result.nextCalls, 0);
    assert.equal(result.res.statusCode, 403);
    assert.equal(result.res.headers['access-control-allow-origin'], undefined);
  }
  for (const origin of ['*', 'http://ui.example.test', 'https://ui.example.test/path', 'https://user:password@ui.example.test', 'not-a-url']) {
    assert.throws(() => createAssistantCors(origin), /WMS_ALLOWED_ORIGINS/);
  }
});

test('legacy redirect preserves queries and does not cache query-bearing links', () => {
  const redirect = createFrontendRedirect('https://ui.example.test');
  const plain = invoke(redirect, { headers: { Host: 'old.example.test' } });
  assert.equal(plain.nextCalls, 0);
  assert.equal(plain.res.statusCode, 301);
  assert.equal(plain.res.headers.location, 'https://ui.example.test/');
  assert.equal(plain.res.headers['cache-control'], 'public, max-age=86400');

  const query = invoke(redirect, {
    method: 'HEAD',
    path: '/index.html',
    originalUrl: '/index.html?next=a%2Fb&token=example',
    headers: { Host: 'old.example.test' },
  });
  assert.equal(query.res.statusCode, 301);
  assert.equal(query.res.headers.location, 'https://ui.example.test/?next=a%2Fb&token=example');
  assert.equal(query.res.headers['cache-control'], 'private, no-store');
});

test('legacy redirect bypasses API, non-GET methods, and the destination host', () => {
  const redirect = createFrontendRedirect('https://ui.example.test');
  for (const options of [
    { path: '/api/chat', headers: { Host: 'old.example.test' } },
    { path: '/assets/main.js', headers: { Host: 'old.example.test' } },
    { method: 'POST', headers: { Host: 'old.example.test' } },
    { headers: { Host: 'UI.EXAMPLE.TEST' } },
  ]) {
    assert.equal(invoke(redirect, options).nextCalls, 1);
  }
  assert.equal(invoke(createFrontendRedirect(), {}).nextCalls, 1);
  for (const url of ['invalid', 'http://localhost:3000', 'https://ui.example.test/path', 'https://ui.example.test/?a=1', 'https://user:password@ui.example.test']) {
    assert.throws(() => createFrontendRedirect(url), /WMS_FRONTEND_URL/);
  }
});

test('Express handles AI CORS and legacy routing without listening on a port', async () => {
  const app = express();
  app.use('/api/chat', createAssistantCors('https://ui.example.test'));
  app.get('/api/chat/status', (_req, res) => res.json({ configured: false }));
  app.use(createFrontendRedirect('https://ui.example.test'));
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint layanan Asisten tidak ditemukan.' }));

  const preflight = await dispatchExpress(app, {
    method: 'OPTIONS',
    path: '/api/chat/status',
    headers: {
      Host: 'api.example.test',
      Origin: 'https://ui.example.test',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization',
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://ui.example.test');

  const local = await dispatchExpress(app, {
    path: '/api/chat/status',
    headers: { Host: 'localhost:3000', Origin: 'http://localhost:3000' },
  });
  assert.equal(local.statusCode, 200);
  const denied = await dispatchExpress(app, {
    path: '/api/chat/status',
    headers: { Host: 'api.example.test', Origin: 'https://other.example.test' },
  });
  assert.equal(denied.statusCode, 403);
  const legacy = await dispatchExpress(app, {
    path: '/?next=example',
    headers: { Host: 'old.example.test' },
  });
  assert.equal(legacy.statusCode, 301);
  assert.equal(legacy.headers.location, 'https://ui.example.test/?next=example');
  assert.equal(legacy.headers['cache-control'], 'private, no-store');
  const missing = await dispatchExpress(app, { path: '/unknown', headers: { Host: 'api.example.test' } });
  assert.equal(missing.statusCode, 404);
});

test('development wiring keeps AI relative and preserves local server guards', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const chatbot = readFileSync(new URL('../src/components/AiChatbot.tsx', import.meta.url), 'utf8');
  assert.match(chatbot, /const assistantServerOrigin = import\.meta\.env\.DEV \? undefined : import\.meta\.env\.VITE_ASSISTANT_API_URL/);
  assert.match(chatbot, /assistantApiUrl\('\/api\/chat\/status', assistantServerOrigin\)/);
  assert.match(chatbot, /assistantApiUrl\('\/api\/chat', assistantServerOrigin\)/);
  assert.match(server, /createAssistantCors\(productionRuntime \? process\.env\.WMS_ALLOWED_ORIGINS : ''\)/);
  assert.match(server, /if \(productionRuntime\)\s*\{\s*app\.use\(createFrontendRedirect\(process\.env\.WMS_FRONTEND_URL\)\)/);
  assert.match(server, /if \(!productionRuntime\)\s*\{\s*assertDevelopmentSupabaseConfiguration\(\)/);
  assert.match(server, /app\.listen\(port, listenHost\(productionRuntime\)/);
  assert.match(server, /process\.env\.WMS_API_ONLY !== 'true'/);
  assert.ok(server.indexOf("app.get('/api/chat/status'") < server.indexOf('app.use(createFrontendRedirect'));
  assert.equal(listenHost(false), '127.0.0.1');
  assert.equal(listenHost(true), '0.0.0.0');
});
