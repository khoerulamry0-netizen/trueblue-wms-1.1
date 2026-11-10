import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';

const script = readFileSync(new URL('./isolated-supabase-preflight.ps1', import.meta.url), 'utf8');

test('preflight is read-only and uses a separate fixed project and port range', () => {
  assert.match(script, /trueblue-http-isolated-test/);
  assert.match(script, /55420, 55421, 55422, 55423, 55424, 55425, 55426, 55427, 55428, 55429, 55430, 3300/);
  assert.match(script, /DOCKER_HOST/);
  assert.match(script, /DOCKER_CONTEXT/);
  assert.match(script, /npipe:/);
  assert.match(script, /ExclusiveAddressUse/);
  assert.match(script, /ReparsePoint/);
  assert.match(script, /Get-FileHash/);
  assert.doesNotMatch(script, /(?:docker\s+(?:run|exec|start|stop|rm|pull)|supabase\s+(?:start|stop|db)|psql)/i);
  assert.doesNotMatch(script, /54321|54322|trueblue-packing-test-pg/);
});

test('review-only configuration disables automatic migrations and seed', () => {
  const config = readFileSync(new URL('./isolated-supabase/supabase/config.toml', import.meta.url), 'utf8');
  const expected = script.match(/\$expectedConfigHash = '([0-9A-F]{64})'/)?.[1];
  assert.equal(createHash('sha256').update(config).digest('hex').toUpperCase(), expected);
  const verifier = readFileSync(new URL('./isolated-supabase-verify.ps1', import.meta.url), 'utf8');
  assert.equal(verifier.match(/\$expectedConfigHash = '([0-9A-F]{64})'/)?.[1], expected);
  assert.match(config, /project_id = "trueblue-http-isolated-test"/);
  assert.match(config, /\[api\]\s*enabled = true\s*port = 55421/);
  assert.match(config, /\[db\]\s*port = 55422\s*shadow_port = 55420/);
  assert.match(config, /\[db\.migrations\]\s*enabled = false/);
  assert.match(config, /\[db\.seed\]\s*enabled = false/);
  assert.match(config, /\[local_smtp\]\s*enabled = false\s*port = 55424\s*smtp_port = 55425\s*pop3_port = 55426/);
  assert.doesNotMatch(config, /^\s*\[inbucket\]/m);
  assert.match(config, /smtp_port = 55425/);
  assert.match(config, /pop3_port = 55426/);
  assert.match(config, /vector_port = 55430/);
});

test('startup uses the project CLI and invokes checked preflight in both phases', () => {
  const start = readFileSync(new URL('./isolated-supabase-start.ps1', import.meta.url), 'utf8');
  assert.match(start, /node_modules\\\.bin\\supabase\.cmd/);
  assert.doesNotMatch(start, /Get-Command supabase/);
  assert.equal((start.match(/^Invoke-RequiredPreflight \$shell \$preflight$/gm) ?? []).length, 2);
  assert.match(start, /Assert-LocalCliExists \$cli/);
  assert.match(start, /Assert-CliVersion \$version \$LASTEXITCODE/);
  assert.match(start, /Preflight failed; startup blocked/);
});

test('startup is blocked before preflight or any resource creation until network isolation is proven', () => {
  const start = readFileSync(new URL('./isolated-supabase-start.ps1', import.meta.url), 'utf8');
  const guard = start.indexOf("throw 'Startup blocked: loopback-only publishing");
  assert.ok(guard > 0);
  assert.ok(guard < start.indexOf('Invoke-RequiredPreflight $shell $preflight'));
  assert.ok(guard < start.indexOf('New-Item -ItemType Directory'));
  assert.ok(guard < start.indexOf('& $cli start'));
});
