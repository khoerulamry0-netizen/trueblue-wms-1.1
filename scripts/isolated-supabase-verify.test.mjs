import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./isolated-supabase-verify.ps1', import.meta.url), 'utf8');

test('partial identity inspection always fails closed and cannot mutate resources', () => {
  for (const required of ['trueblue-http-isolated-test', 'GOTRUE_DB_DATABASE_URL',
    'PGRST_DB_URI', '55421', 'supabase_network_', 'foreign container',
    'unexpected port mapping', 'volume is shared', 'Verification INCOMPLETE']) {
    assert.ok(source.includes(required));
  }
  assert.match(source, /throw 'Verification INCOMPLETE:/);
  assert.doesNotMatch(source, /(?:docker\s+(?:exec|run|start|stop|rm|network\s+rm|volume\s+rm)|supabase\s+(?:start|stop|db)|psql)/i);
});

test('preflight and verifier pass docker argument arrays explicitly', () => {
  const preflight = readFileSync(new URL('./isolated-supabase-preflight.ps1', import.meta.url), 'utf8');
  for (const script of [preflight, source]) {
    assert.doesNotMatch(script, /Read-Docker\s+@\(/);
    assert.match(script, /Read-Docker -Arguments @\('context'\s*,\s*'inspect'\)/);
  }
});
