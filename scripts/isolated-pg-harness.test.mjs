import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('./isolated-pg-test.ps1', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('./isolated-pg/bootstrap.sql', import.meta.url), 'utf8');
const sequential = readFileSync(new URL('./isolated-pg/sequential.sql', import.meta.url), 'utf8');
const concurrency = readFileSync(new URL('./isolated-pg/concurrency.sql', import.meta.url), 'utf8');

test('harness declares dedicated resources and no Docker host or published ports', () => {
  for (const name of ['trueblue-packing-test-pg', 'trueblue-packing-test-network', 'trueblue-packing-test-volume']) {
    assert.ok(script.includes(name));
  }
  assert.match(script, /--internal/);
  assert.match(script, /--pull','never'/);
  assert.match(script, /Published port detected/);
  assert.match(script, /\$env:DOCKER_HOST -or \$env:DOCKER_CONTEXT/);
  assert.match(script, /-h \/var\/run\/postgresql -U postgres -d wms_isolated_test/);
  assert.match(bootstrap, /inet_server_addr\(\) is not null/);
});

test('cleanup and SQL execution check resource identities instead of broad deletion', () => {
  assert.match(script, /function Assert-IsolatedContainer/);
  assert.match(script, /function Invoke-TestSql[\s\S]*Assert-IsolatedContainer/);
  assert.match(script, /Assert-Label \$c\.Config\.Labels \$container/);
  assert.match(script, /Assert-Label \$n\.Labels \$network/);
  assert.match(script, /Assert-Label \$v\.Labels \$volume/);
  assert.match(script, /foreign container; cleanup refused/);
  assert.doesNotMatch(script, /(?:system|volume|network)\s+prune/i);
});

test('test scripts cover concurrent requests and rejected unauthorised actions', () => {
  assert.match(sequential, /FAIL: browser completion bypass/);
  assert.match(sequential, /FAIL: forged sorting metadata/);
  assert.match(sequential, /FAIL: another packer used session/);
  assert.match(sequential, /FAIL: packing before sorting/);
  assert.match(sequential, /FAIL: stale sorting snapshot authorized packing/);
  assert.match(sequential, /start_order_scan\(pack_id,'TEST_LOCAL','REF-A','packing','A1'\)/);
  assert.match(sequential, /FAIL: RLS exposed other branch/);
  assert.match(concurrency, /dblink_send_query\('race1'/);
  assert.match(concurrency, /dblink_send_query\('race2'/);
  assert.match(concurrency, /FAIL: concurrent retry was not idempotent/);
  assert.match(concurrency, /FAIL: concurrent finish replay/);
  assert.match(sequential, /FAIL: sorting recovery or duplicate scan/);
  assert.match(sequential, /FAIL: packing finish recovery/);
  assert.match(sequential, /FAIL: stale receipt proof/);
  assert.match(sequential, /FAIL: pending receipt proof/);
});
