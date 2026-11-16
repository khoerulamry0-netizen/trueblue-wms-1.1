import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFrontendRedirect } from '../server/frontendRedirect.ts';

test('server keeps health available and rejects removed chat endpoints', { timeout: 30000 }, async () => {
  const port = await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts', '--wms-development'], {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'synthetic-test-key',
      SUPABASE_ANON_KEY: 'synthetic-test-key',
    },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited early: ${child.exitCode}`);
      try { health = await fetch(`${base}/api/health`); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(health, 'Server did not start');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    for (const [path, method] of [['/api/chat', 'GET'], ['/api/chat', 'POST'], ['/api/chat/status', 'GET'], ['/api/unknown', 'GET']]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'Endpoint tidak ditemukan.' });
    }
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});

test('legacy frontend redirects preserve query and avoid caching it', () => {
  const handler = createFrontendRedirect('https://ui.example.test');
  const req = { method: 'GET', path: '/', originalUrl: '/?next=a%2Fb', get: () => 'old.example.test' };
  const res = {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    redirect(status, location) { this.statusCode = status; this.location = location; return this; },
  };
  handler(req, res, () => { throw new Error('Redirect was skipped'); });
  assert.equal(res.statusCode, 301);
  assert.equal(res.location, 'https://ui.example.test/?next=a%2Fb');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
