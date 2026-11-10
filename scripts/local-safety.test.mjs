import assert from 'node:assert/strict';
import test from 'node:test';
import { getCanonicalStockId } from '../src/utils/calculations.ts';
import { bootstrapLocalAdmin } from './local-admin-runner.mjs';
import { branchId, buildSeedDocuments, operators } from './local-seed-data.mjs';
import { createSeedStore, recoverSeedDocuments, runSeed } from './local-seed-runner.mjs';
import { checkCommandResult, inspectGatewayRoutes, inspectGatewayServices, localApiFetch, parseInspection, parseLocalStatusEnv, selectProjectNetwork, verifyGatewayServices, verifyLocalTarget, verifyNetworkEnvironment } from './local-supabase.mjs';
import { runPreflight, verifyBranchMetadataGit } from './local-preflight.mjs';
import { setupLocalEnv, updateEnv, verifyEnvGit } from './setup-local-env.mjs';
import { listenHost } from '../server/listenHost.ts';

const passwords = ['synthetic-password-one', 'synthetic-password-two'];
const timestamp = '2026-01-01T00:00:00.000Z';

function targetFixture(networkName = 'supabase_network_unified-wms-dev') {
  const project = 'unified-wms-dev';
  const networkId = 'network-id';
  const containers = ['kong', 'db', 'auth', 'rest'].map((service) => {
    const name = `supabase_${service}_${project}`;
    const env = service === 'auth' ? ['GOTRUE_DB_DATABASE_URL=postgres://x:x@db:5432/postgres']
      : service === 'rest' ? ['PGRST_DB_URI=postgres://x:x@db:5432/postgres'] : [];
    return {
      Id: service, Name: `/${name}`, State: { Running: true }, Config: { Env: env },
      NetworkSettings: { Ports: service === 'kong' ? { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }] } : {},
        Networks: { [networkName]: { NetworkID: networkId, Aliases: service === 'db' ? [name, 'db'] : [name] } } },
    };
  });
  return {
    config: `project_id = "${project}"`,
    status: { API_URL: 'http://127.0.0.1:54321', ANON_KEY: 'test', SERVICE_ROLE_KEY: 'test' },
    context: { Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } },
    containers,
    network: { Name: networkName, Id: networkId, Containers: Object.fromEntries(containers.map(({ Id }) => [Id, {}])) },
  };
}
const verify = (f) => verifyLocalTarget(f.config, f.status, f.context, f.containers, f.network);

test('inspection diagnostics distinguish allowed warnings from failures without leaking output', () => {
  const result = { status: 0, stdout: '{"ok":true}', stderr: 'WARNING: daemon is not using the default seccomp profile\n' };
  assert.equal(checkCommandResult('Docker context inspection', result), result.stdout);
  for (const bad of [
    { status: 1, stderr: 'secret', stdout: 'secret' },
    { status: 0, stderr: 'WARNING: Error loading config file: access denied secret', stdout: '' },
    { status: 0, stderr: 'unexpected secret', stdout: '' },
    { status: null, error: new Error('secret'), stderr: '', stdout: '' },
  ]) {
    assert.throws(() => checkCommandResult('Docker context inspection', bad), (error) =>
      error.message.includes('Docker context inspection') && !error.message.includes('secret'));
  }
  assert.throws(() => parseInspection('Docker network inspection', 'secret{'), (error) =>
    error.message.includes('Docker network inspection') && !error.message.includes('secret'));
});

test('CLI status allows only the exact upgrade notice and reports safe failure categories', () => {
  const notice = 'A new version of Supabase CLI is available: \x1b[33mv3.1.0\x1b[0m (currently installed v3.0.0)\n' +
    'We recommend updating regularly for new features and bug fixes: \x1b[1mhttps://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli\x1b[0m\n';
  const result = { status: 0, stdout: 'synthetic-key', stderr: notice };
  assert.equal(checkCommandResult('Supabase CLI status', result), result.stdout);
  const failures = [
    { status: 1, stderr: notice, category: 'CLI update notice', exit: '1' },
    { status: 0, stderr: `${notice}Stopped services: [sensitive-token]\n`, category: 'stopped services', exit: '0' },
    { status: 0, stderr: 'WARNING: password=secret\n', category: 'warning', exit: '0' },
    { status: 0, stderr: 'Error: postgres://user:secret@remote/db\n', category: 'CLI error', exit: '0' },
    { status: 0, stderr: 'A new version of Supabase CLI is available: secret\n', category: 'unrecognized update notice', exit: '0' },
    { status: 0, stderr: `${notice}eyJsecret\n`, category: 'unrecognized stderr', exit: '0' },
    { status: null, error: new Error('secret'), stderr: '', category: 'no stderr', exit: 'unavailable' },
  ];
  for (const item of failures) {
    assert.throws(() => checkCommandResult('Supabase CLI status', { ...item, stdout: 'secret' }), (error) => {
      assert(error.message.includes(`exit ${item.exit}`));
      assert(error.message.includes(item.category));
      assert(!/secret|sensitive-token|postgres:|eyJ/.test(error.message));
      return true;
    });
  }
  assert.throws(() => checkCommandResult('Docker context inspection', result), /unrecognized/);
});

test('CLI status accepts stopped imgproxy only when verified Storage disables transformation', () => {
  const f = targetFixture('trueblue-local-only');
  const storage = structuredClone(f.containers[2]);
  storage.Id = 'storage';
  storage.Name = '/supabase_storage_unified-wms-dev';
  storage.Config.Env = ['ENABLE_IMAGE_TRANSFORMATION=false', 'IMAGE_TRANSFORMATION_ENABLED=false'];
  f.containers.push(storage);
  f.network.Containers.storage = {};
  const context = { containers: f.containers, network: f.network };
  const result = { status: 0, stdout: 'safe', stderr: 'Stopped services: [supabase_imgproxy_unified-wms-dev]\n' };
  assert.equal(checkCommandResult('Supabase CLI status', result, context), 'safe');
  const stopped = structuredClone(context);
  stopped.containers.push({ Name: '/supabase_imgproxy_unified-wms-dev', State: { Running: false } });
  assert.equal(checkCommandResult('Supabase CLI status', result, stopped), 'safe');
  const cases = [
    undefined,
    { ...context, containers: f.containers.filter((container) => container.Id !== 'storage') },
    { ...context, network: { ...f.network, Containers: {} } },
    { ...context, containers: f.containers.map((container) => container.Id === 'storage' ? { ...container, State: { Running: false } } : container) },
    { ...context, containers: f.containers.map((container) => container.Id === 'storage' ? { ...container, Config: { Env: ['ENABLE_IMAGE_TRANSFORMATION=true', 'IMAGE_TRANSFORMATION_ENABLED=true'] } } : container) },
    { ...context, containers: f.containers.map((container) => container.Id === 'storage' ? { ...container, Config: { Env: ['ENABLE_IMAGE_TRANSFORMATION=false'] } } : container) },
    { ...context, containers: f.containers.map((container) => container.Id === 'storage' ? { ...container, Config: { Env: [...storage.Config.Env, 'IMAGE_TRANSFORMATION_ENABLED=true'] } } : container) },
    { ...context, containers: [...f.containers, { Name: '/supabase_imgproxy_unified-wms-dev', State: { Running: true } }] },
    { ...context, network: { ...f.network, Id: 'different' } },
  ];
  for (const invalid of cases) assert.throws(() => checkCommandResult('Supabase CLI status', result, invalid), /stopped services/);
  for (const stderr of [
    'Stopped services: [supabase_imgproxy_unified-wms-dev supabase_auth_unified-wms-dev]',
    'Stopped services: [supabase_auth_unified-wms-dev]',
    'Stopped services: [supabase_imgproxy_unified-wms-dev foreign-secret]',
    'Stopped services: [supabase_imgproxy_unified-wms-dev]\nWARNING: secret',
  ]) {
    assert.throws(() => checkCommandResult('Supabase CLI status', { ...result, stderr }, context), (error) => !error.message.includes('secret'));
  }
  assert.throws(() => checkCommandResult('Supabase CLI status', { ...result, status: 1 }, context), /command failed/);
  assert.throws(() => checkCommandResult('Docker inspection', result, context), /stopped services/);
});

test('CLI status parsing requires unambiguous fields without disclosing output', () => {
  const stdout = 'API_URL="http://127.0.0.1:54321"\nANON_KEY="anon-test"\nSERVICE_ROLE_KEY=service-test\nOTHER="secret"\n';
  assert.deepEqual(parseLocalStatusEnv(stdout), {
    API_URL: 'http://127.0.0.1:54321', ANON_KEY: 'anon-test', SERVICE_ROLE_KEY: 'service-test',
  });
  for (const invalid of [
    stdout + 'ANON_KEY="secret"\n',
    stdout.replace('ANON_KEY="anon-test"', 'ANON_KEY="secret'),
    stdout.replace('SERVICE_ROLE_KEY=service-test\n', ''),
    stdout.replace('API_URL="http://127.0.0.1:54321"', 'API_URL="http://127.0.0.1:54321\''),
  ]) {
    assert.throws(() => parseLocalStatusEnv(invalid), (error) => !error.message.includes('secret') && !error.message.includes('anon-test'));
  }
});

test('gateway inspection uses a single raw local request and validates HTTP, JSON and upstreams', () => {
  const f = targetFixture('trueblue-local-only');
  const services = { data: [
    { host: 'supabase_auth_unified-wms-dev', protocol: 'http', port: 9999 },
    { host: 'supabase_rest_unified-wms-dev', protocol: 'http', port: 3000 },
  ], next: null };
  const body = JSON.stringify(services);
  const calls = [];
  const http = (content, headers = '', status = '200 OK') =>
    Buffer.from(`HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(content)}\r\n${headers}\r\n${content}`);
  const runner = (args, input) => {
    calls.push({ args, input });
    return { status: 0, stderr: '', stdout: http(body) };
  };
  const result = inspectGatewayServices(runner);
  assert.doesNotThrow(() => verifyGatewayServices(result, f.containers, f.network));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['exec', '-i', 'supabase_kong_unified-wms-dev', 'nc', '127.0.0.1', '8001']);
  assert.match(calls[0].input, /^GET \/services\?size=1000 HTTP\/1\.1\r\n/);
  assert.match(calls[0].input, /Connection: close\r\n/);
  const remoteBody = JSON.stringify({ data: [{ host: 'hosted.example', protocol: 'http', port: 3000 }] });
  const remoteResult = inspectGatewayServices(() => ({ status: 0, stderr: '', stdout: http(remoteBody) }));
  assert.throws(() => verifyGatewayServices(remoteResult, f.containers, f.network), /unverified/);
  for (const bad of [
    { status: 127, stderr: 'secret', stdout: '' },
    { status: 1, stderr: 'network error', stdout: http(body) },
    { status: null, error: new Error('timeout secret'), stderr: '', stdout: '' },
    { status: 0, stderr: '', stdout: http(body, '', '503 Service Unavailable') },
    { status: 0, stderr: '', stdout: http(body, 'Location: http://remote.example/\r\n', '302 Found') },
    { status: 0, stderr: '', stdout: http(body, 'Location: http://remote.example/\r\n') },
    { status: 0, stderr: '', stdout: Buffer.from(`HTTP/1.1 200 OK\r\n\r\n${body}`) },
    { status: 0, stderr: '', stdout: http(body).subarray(0, -1) },
    { status: 0, stderr: '', stdout: http(body, 'Content-Length: 1\r\n') },
    { status: 0, stderr: '', stdout: http(body, 'Transfer-Encoding: chunked\r\n') },
    { status: 0, stderr: '', stdout: http('secret') },
    { status: 0, stderr: '', stdout: Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n'), Buffer.from([255])]) },
    { status: 0, stderr: 'unexpected error', stdout: http(body) },
  ]) {
    assert.throws(() => inspectGatewayServices(() => bad), (error) => !error.message.includes('secret'));
  }
  const unicode = JSON.stringify({ data: [], label: 'gudang-é' });
  assert.deepEqual(inspectGatewayServices(() => ({ status: 0, stderr: '', stdout: http(unicode) })), JSON.parse(unicode));
});

test('custom project network requires every expected container and a matching inspected network', () => {
  const f = targetFixture('trueblue-local-only');
  assert.equal(selectProjectNetwork(f.containers), 'trueblue-local-only');
  assert.doesNotThrow(() => verify(f));
  assert.doesNotThrow(() => verifyGatewayServices({ data: [
    { host: 'supabase_auth_unified-wms-dev', protocol: 'http', port: 9999 },
    { host: 'supabase_rest_unified-wms-dev', protocol: 'http', port: 3000 },
  ] }, f.containers, f.network));
  const missing = structuredClone(f);
  delete missing.containers[1].NetworkSettings.Networks['trueblue-local-only'];
  assert.throws(() => verify(missing), /Network selection/);
  const unapproved = targetFixture('untrusted-network');
  assert.throws(() => verify(unapproved), /Network selection/);
  const wrongId = structuredClone(f); wrongId.containers[1].NetworkSettings.Networks['trueblue-local-only'].NetworkID = 'wrong';
  assert.throws(() => verify(wrongId), /not attached/);
  const foreign = structuredClone(f); foreign.network.Containers.foreign = {};
  assert.throws(() => verify(foreign), /Unexpected container/);
  const both = structuredClone(f);
  for (const container of both.containers) {
    container.NetworkSettings.Networks['supabase_network_unified-wms-dev'] = { NetworkID: 'other' };
  }
  assert.throws(() => verify(both), /exactly one/);
});

test('preflight refuses tracked or non-ignored branch metadata and Git failures', () => {
  const success = () => ({ status: 0, stdout: '' });
  assert.doesNotThrow(() => verifyBranchMetadataGit(success));
  assert.throws(() => verifyBranchMetadataGit(() => ({ status: 0, stdout: 'tracked\n' })), /already tracked/);
  assert.throws(() => verifyBranchMetadataGit((args) => ({ status: args[0] === 'check-ignore' ? 1 : 0, stdout: '' })), /not confirmed ignored/);
  assert.throws(() => verifyBranchMetadataGit(() => ({ status: 1, stdout: '' })), /Cannot verify/);
});

test('preflight checks local Auth health without exposing credentials on failure', async () => {
  let requested;
  const options = {
    checkMetadata() {},
    getStatus: () => ({ apiUrl: 'http://127.0.0.1:54321', anonKey: 'sensitive-test-key' }),
    fetchApi: async (url, init) => { requested = { url, init }; return { ok: true, status: 200 }; },
  };
  await runPreflight(options);
  assert.equal(requested.url, 'http://127.0.0.1:54321/auth/v1/health');
  assert.equal(requested.init.headers.apikey, 'sensitive-test-key');
  await assert.rejects(runPreflight({ ...options, fetchApi: async () => { throw new Error('sensitive-test-key'); } }), (error) => {
    assert.match(error.message, /health check failed/);
    assert(!error.message.includes('sensitive-test-key'));
    return true;
  });
  await assert.rejects(runPreflight({ ...options, fetchApi: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(runPreflight({ ...options, getStatus: () => ({ apiUrl: 'https://remote', anonKey: 'test' }) }), /target/);
});

test('local env setup requires untracked ignored file and successful preflight before writing', async () => {
    const operations = [];
    const local = { apiUrl: 'http://127.0.0.1:54321', anonKey: 'synthetic-key' };
    const options = {
      runGit: (args) => { operations.push(args[0]); return { status: 0, stdout: '' }; },
      preflight: async () => { operations.push('preflight'); return local; },
      readEnv: () => { operations.push('read'); return 'PORT=3000\nSUPABASE_ANON_KEY=\n'; },
      writeEnv: (value) => { operations.push('write'); assert.match(value, /PORT=3000/); assert.match(value, /VITE_SUPABASE_ANON_KEY=synthetic-key/); },
    };
    await setupLocalEnv(options);
    assert.deepEqual(operations, ['ls-files', 'check-ignore', 'preflight', 'read', 'write']);
    operations.length = 0;
    await assert.rejects(setupLocalEnv({ ...options, preflight: async () => { throw new Error('secret'); } }), /preflight failed/);
    assert.deepEqual(operations, ['ls-files', 'check-ignore']);
    assert.throws(() => verifyEnvGit(() => ({ status: 0, stdout: '.env\n' })), /tracked/);
    assert.throws(() => verifyEnvGit((args) => ({ status: args[0] === 'check-ignore' ? 1 : 0, stdout: '' })), /ignored/);
    assert.throws(() => verifyEnvGit(() => ({ status: 1, stdout: '' })), /Cannot verify/);
    assert.throws(() => updateEnv('', 'https://remote', 'key'), /invalid/);
    assert.throws(() => updateEnv('', local.apiUrl, 'key\nsecret'), /invalid/);
    assert.throws(() => updateEnv('SUPABASE_URL=a\nSUPABASE_URL=b\n', local.apiUrl, local.anonKey), /duplicate/);
    assert.throws(() => updateEnv('OTHER="multi\nSUPABASE_URL=remote\nline"\n', local.apiUrl, local.anonKey), /multiline/);
    assert.equal(listenHost(false), '127.0.0.1');
    assert.equal(listenHost(true), '0.0.0.0');
});

test('rejects proxy settings and refuses remote requests or redirects', async () => {
  assert.doesNotThrow(() => verifyNetworkEnvironment({}));
  assert.throws(() => verifyNetworkEnvironment({ https_proxy: 'http://remote' }), /proxy/);
  assert.throws(() => verifyNetworkEnvironment({ NODE_OPTIONS: '--use-env-proxy' }), /Node options/);
  await assert.rejects(localApiFetch('http://remote.example/auth/v1'), /non-local/);
  const original = globalThis.fetch;
  let redirect;
  try {
    globalThis.fetch = async (_url, options) => { redirect = options.redirect; return { ok: true }; };
    await localApiFetch('http://127.0.0.1:54321/auth/v1', { redirect: 'follow' });
  } finally { globalThis.fetch = original; }
  assert.equal(redirect, 'error');
});

test('only accepts the exact local API and expected local Docker project and database', () => {
  const f = targetFixture();
  assert.doesNotThrow(() => verify(f));
  for (const url of ['http://localhost:54321', 'http://[::1]:54321', 'https://127.0.0.1:54321',
    'http://127.0.0.1:54321/path', 'http://remote.example:54321', 'http://127.0.0.1:54322']) {
    const changed = structuredClone(f); changed.status.API_URL = url;
    assert.throws(() => verify(changed), /API URL/);
  }
  const wrongContext = structuredClone(f); wrongContext.context.Endpoints.docker.Host = 'tcp://remote:2375';
  assert.throws(() => verify(wrongContext), /named-pipe/);
  const wrongProject = structuredClone(f); wrongProject.config = 'project_id = "another"';
  assert.throws(() => verify(wrongProject), /configuration/);
  const wrongContainer = structuredClone(f); wrongContainer.containers[0].Name = '/supabase_kong_another';
  assert.throws(() => verify(wrongContainer), /container/);
  const wrongNetwork = structuredClone(f); wrongNetwork.network.Containers = {};
  assert.throws(() => verify(wrongNetwork), /network/);
  const remoteDb = structuredClone(f); remoteDb.containers[3].Config.Env[0] = 'PGRST_DB_URI=postgres://u:p@remote:5432/postgres';
  assert.throws(() => verify(remoteDb), /database target/);
  const publicPort = structuredClone(f); publicPort.containers[1].NetworkSettings.Ports['5432/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '54322' }];
  assert.throws(() => verify(publicPort), /outside loopback/);
  const wrongApiPort = structuredClone(f); wrongApiPort.containers[0].NetworkSettings.Ports['8000/tcp'][0].HostPort = '54320';
  assert.throws(() => verify(wrongApiPort), /port binding/);
});

test('gateway inspection rejects external or ambiguous upstreams and incomplete service lists', () => {
  const f = targetFixture();
  const services = { next: null, data: [
    { host: 'supabase_auth_unified-wms-dev', protocol: 'http', port: 9999 },
    { host: 'supabase_rest_unified-wms-dev', protocol: 'http', port: 3000 },
  ] };
  assert.doesNotThrow(() => verifyGatewayServices(services, f.containers, f.network));
  const remote = structuredClone(services); remote.data[0].host = 'hosted.example';
  assert.throws(() => verifyGatewayServices(remote, f.containers, f.network), /unverified/);
  const wrongPort = structuredClone(services); wrongPort.data[1].port = 4000;
  assert.throws(() => verifyGatewayServices(wrongPort, f.containers, f.network), /REST container port mismatch/);
  const paginated = structuredClone(services); paginated.next = '/services?page=2';
  assert.throws(() => verifyGatewayServices(paginated, f.containers, f.network), /fully inspect/);
  const ambiguous = structuredClone(f); ambiguous.containers[1].NetworkSettings.Networks[ambiguous.network.Name].Aliases.push('supabase_auth_unified-wms-dev');
  assert.throws(() => verifyGatewayServices(services, ambiguous.containers, ambiguous.network), /ambiguous project network/);
});

test('REST Admin requires the exact service, REST container, network and configured admin port', () => {
  const f = targetFixture('trueblue-local-only');
  const rest = f.containers[3];
  rest.Config.Env.push('PGRST_ADMIN_SERVER_PORT=3001');
  const services = { data: [
    { name: 'auth-v1', host: 'supabase_auth_unified-wms-dev', protocol: 'http', port: 9999 },
    { name: 'rest-v1', host: 'supabase_rest_unified-wms-dev', protocol: 'http', port: 3000 },
    { name: 'rest-admin-v1', host: 'supabase_rest_unified-wms-dev', protocol: 'http', port: 3001 },
  ] };
  assert.doesNotThrow(() => verifyGatewayServices(services, f.containers, f.network));
  for (const settings of [[], ['PGRST_ADMIN_SERVER_PORT=3002'], ['PGRST_ADMIN_SERVER_PORT=3001', 'PGRST_ADMIN_SERVER_PORT=3001']]) {
    const invalid = structuredClone(f);
    invalid.containers[3].Config.Env = settings;
    assert.throws(() => verifyGatewayServices(services, invalid.containers, invalid.network), /REST Admin target or configured port mismatch/);
  }
  const otherName = structuredClone(services); otherName.data[2].name = 'rest-v1';
  assert.throws(() => verifyGatewayServices(otherName, f.containers, f.network), /REST container port mismatch/);
  const wrongPort = structuredClone(services); wrongPort.data[2].port = 3000;
  assert.throws(() => verifyGatewayServices(wrongPort, f.containers, f.network), /REST Admin target or configured port mismatch/);
  const wrongHost = structuredClone(services); wrongHost.data[2].host = 'supabase_auth_unified-wms-dev';
  assert.throws(() => verifyGatewayServices(wrongHost, f.containers, f.network), /REST Admin target or configured port mismatch/);
  const noRestApi = structuredClone(services); noRestApi.data.splice(1, 1);
  assert.throws(() => verifyGatewayServices(noRestApi, f.containers, f.network), /REST missing/);
  const detached = structuredClone(f); delete detached.network.Containers.rest;
  assert.throws(() => verifyGatewayServices(services, detached.containers, detached.network), /host not mapped/);
  const badNetwork = structuredClone(f); badNetwork.containers[3].NetworkSettings.Networks[badNetwork.network.Name].NetworkID = 'wrong';
  assert.throws(() => verifyGatewayServices(services, badNetwork.containers, badNetwork.network), /host not mapped/);
  const stopped = structuredClone(f); stopped.containers[3].State.Running = false;
  assert.throws(() => verifyGatewayServices(services, stopped.containers, stopped.network), /host not mapped/);
  const pooler = structuredClone(services);
  pooler.data.push({ name: 'pooler-v2-ws', host: 'supabase_pooler_unified-wms-dev', protocol: 'http', port: 4000, enabled: true });
  assert.throws(() => verifyGatewayServices(pooler, f.containers, f.network), /host not mapped/);
});

test('Pooler HTTP upstream requires the exact running local target and verified Kong route', () => {
  const f = targetFixture('trueblue-local-only');
  const pooler = structuredClone(f.containers[2]);
  pooler.Id = 'pooler';
  pooler.Name = '/supabase_pooler_unified-wms-dev';
  pooler.NetworkSettings.Networks[f.network.Name].Aliases = ['pooler', pooler.Name.slice(1)];
  f.containers.push(pooler);
  f.network.Containers.pooler = {};
  const id = '12345678-1234-1234-1234-123456789abc';
  const services = { data: [
    { name: 'auth-v1', host: 'supabase_auth_unified-wms-dev', protocol: 'http', port: 9999 },
    { name: 'rest-v1', host: 'supabase_rest_unified-wms-dev', protocol: 'http', port: 3000 },
    { name: 'pooler-v2-ws', id, host: 'supabase_pooler_unified-wms-dev', protocol: 'http', port: 4000, path: '/v2', enabled: true },
  ], next: null };
  const routes = { data: [
    { name: 'pooler-v2-ws', service: { id }, strip_path: true, paths: ['/pooler/v2/'], protocols: ['http', 'https'] },
  ], next: null };
  assert.doesNotThrow(() => verifyGatewayServices(services, f.containers, f.network, routes));
  const variants = [
    { host: 'foreign.example' }, { host: 'pooler' }, { port: 4001 }, { protocol: 'wss' },
    { protocol: 'ws' }, { protocol: 'https' }, { path: '/other' }, { enabled: false },
    { name: 'other' }, { id: 'invalid' },
  ];
  for (const variant of variants) {
    const invalid = structuredClone(services);
    Object.assign(invalid.data[2], variant);
    assert.throws(() => verifyGatewayServices(invalid, f.containers, f.network, routes));
  }
  for (const invalidRoutes of [
    undefined, { ...routes, next: 'more' }, { data: [] },
    { data: [routes.data[0], routes.data[0]] },
    { data: [{ ...routes.data[0], service: { id: 'other' } }] },
    { data: [{ ...routes.data[0], name: 'other' }] },
    { data: [{ ...routes.data[0], paths: ['/elsewhere'] }] },
    { data: [{ ...routes.data[0], strip_path: false }] },
    { data: [{ ...routes.data[0], protocols: ['tcp'] }] },
  ]) {
    assert.throws(() => verifyGatewayServices(services, f.containers, f.network, invalidRoutes), /route configuration not verified/);
  }
  const missing = structuredClone(f); missing.containers.pop(); delete missing.network.Containers.pooler;
  assert.throws(() => verifyGatewayServices(services, missing.containers, missing.network, routes), /host not mapped/);
  const stopped = structuredClone(f); stopped.containers[4].State.Running = false;
  assert.throws(() => verifyGatewayServices(services, stopped.containers, stopped.network, routes), /host not mapped/);
  const wrongNetwork = structuredClone(f); wrongNetwork.containers[4].NetworkSettings.Networks[wrongNetwork.network.Name].NetworkID = 'wrong';
  assert.throws(() => verifyGatewayServices(services, wrongNetwork.containers, wrongNetwork.network, routes), /host not mapped/);
  const detached = structuredClone(f); delete detached.network.Containers.pooler;
  assert.throws(() => verifyGatewayServices(services, detached.containers, detached.network, routes), /host not mapped/);
  const unapproved = structuredClone(f); unapproved.network.Name = 'supabase_network_unified-wms-dev';
  for (const container of unapproved.containers) {
    container.NetworkSettings.Networks[unapproved.network.Name] = container.NetworkSettings.Networks['trueblue-local-only'];
  }
  assert.throws(() => verifyGatewayServices(services, unapproved.containers, unapproved.network, routes), /Pooler service or target configuration mismatch/);
});

test('Kong route inspection uses the same validated local HTTP transport', () => {
  const data = JSON.stringify({ data: [], next: null });
  let request;
  const run = (args, input) => {
    request = input;
    return { status: 0, stderr: '', stdout: Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`) };
  };
  assert.deepEqual(inspectGatewayRoutes(run), { data: [], next: null });
  assert.match(request, /^GET \/routes\?size=1000 HTTP\/1\.1\r\n/);
  assert.throws(() => inspectGatewayRoutes(() => ({ status: 1, stderr: 'secret', stdout: '' })), /route inspection/);
});

test('gateway diagnostics identify all services without disclosing arbitrary names, hosts or values', () => {
  const f = targetFixture('trueblue-local-only');
  const network = f.network.Name;
  f.containers[1].NetworkSettings.Networks[network].IPAddress = '172.20.0.2';
  f.containers[2].NetworkSettings.Networks[network].Aliases.push('auth-local');
  f.containers[3].NetworkSettings.Networks[network].IPAddress = '172.20.0.4';
  const valid = [
    { name: 'auth-v1', host: 'auth-local', protocol: 'http', port: 9999 },
    { name: 'rest-v1', host: '172.20.0.4', protocol: 'http', port: 3000 },
  ];
  assert.doesNotThrow(() => verifyGatewayServices({ data: valid }, f.containers, f.network));
  const services = [...valid,
    { name: 'storage-v1', host: 'private-secret.invalid', protocol: 'http', port: 5000 },
    { name: 'secret-token', host: '203.0.113.1', protocol: 'http', port: 443 },
    { name: 'functions-v1', host: 'auth-local', protocol: 'ftp', port: 9999 },
    { name: 'graphql-v1', host: '172.20.0.4', protocol: 'http', port: 5000 },
    { name: 'realtime-v1', host: '127.0.0.1', protocol: 'http', port: 4000 },
    { name: 'studio', host: 'auth-local', protocol: 'http', port: 0 },
    null,
  ];
  assert.throws(() => verifyGatewayServices({ data: services }, f.containers, f.network), (error) => {
    assert.match(error.message, /9 inspected/);
    assert.match(error.message, /auth-v1: hostname; verified project container/);
    assert.match(error.message, /storage-v1: hostname; host not mapped/);
    assert.match(error.message, /#4 \(name withheld\): IPv4; host not mapped/);
    assert.match(error.message, /functions-v1: hostname; unsupported protocol/);
    assert.match(error.message, /graphql-v1: IPv4; REST container port mismatch/);
    assert.match(error.message, /realtime-v1: loopback; loopback does not establish/);
    assert.match(error.message, /studio: hostname; invalid port/);
    assert.match(error.message, /#9 \(name withheld\): missing host; unsupported protocol/);
    assert(!error.message.includes('private-secret'));
    assert(!error.message.includes('secret-token'));
    assert(!error.message.includes('203.0.113.1'));
    assert(!error.message.includes('172.20.0.4'));
    return true;
  });
  const foreign = structuredClone(f);
  foreign.containers[2].State.Running = false;
  assert.throws(() => verifyGatewayServices({ data: valid }, foreign.containers, foreign.network), /host not mapped/);
  const detached = structuredClone(f);
  delete detached.network.Containers[detached.containers[2].Id];
  assert.throws(() => verifyGatewayServices({ data: valid }, detached.containers, detached.network), /host not mapped/);
  const wrongNetwork = structuredClone(f);
  wrongNetwork.containers[2].NetworkSettings.Networks[network].NetworkID = 'other';
  assert.throws(() => verifyGatewayServices({ data: valid }, wrongNetwork.containers, wrongNetwork.network), /host not mapped/);
  const extra = structuredClone(f);
  const localService = structuredClone(extra.containers[2]);
  localService.Id = 'storage';
  localService.Name = '/supabase_storage_unified-wms-dev';
  localService.NetworkSettings.Networks[network].Aliases = ['storage'];
  extra.containers.push(localService);
  extra.network.Containers.storage = {};
  const withStorage = { data: [...valid, { name: 'storage-v1', host: 'storage', protocol: 'http', port: 5000 }] };
  assert.doesNotThrow(() => verifyGatewayServices(withStorage, extra.containers, extra.network));
  localService.Name = '/foreign_storage';
  assert.throws(() => verifyGatewayServices(withStorage, extra.containers, extra.network), /storage-v1: hostname; host not mapped/);
});

test('all generated stock IDs match application canonical IDs and order relations', () => {
  const docs = buildSeedDocuments(timestamp);
  const stock = docs.filter((doc) => doc.collection_name === 'stock');
  const orders = docs.filter((doc) => doc.collection_name === 'orders');
  assert.equal(stock.length, 200);
  for (const doc of stock) {
    const p = doc.payload;
    assert.equal(doc.document_id, getCanonicalStockId(p.skuId, p.expiredDate, p.location, p.warehouseId));
    assert.match(doc.document_id, /_No_Expired_RACK_A$/);
    assert.equal(doc.document_id, p.id);
  }
  for (const { payload: order } of orders) {
    const key = getCanonicalStockId(order.skuId, order.expiredDate, order.location, order.warehouseId);
    assert.equal(stock.filter((doc) => doc.document_id === key).length, 1);
  }
  assert(docs.every((doc) => doc.branch_id === branchId));
});

function memoryStore(initialCollision = false) {
  const state = { exists: initialCollision, writes: [], fail: '' };
  return {
    state,
    async findCollisions() { return state.exists ? ['existing fixture'] : []; },
    async createBranch() { state.writes.push('branch'); state.exists = true; if (state.fail === 'branch') throw new Error('secret'); },
    async createUser(operator) { state.writes.push(`user:${operator.role}`); if (state.fail === operator.role) throw new Error('secret'); return { id: operator.role }; },
    async assignProfile(user) { state.writes.push(`profile:${user.id}`); },
    async insertDocuments(docs) { state.writes.push(`documents:${docs.length}`); if (state.fail === 'documents') throw new Error('secret'); },
  };
}

test('collision blocks every write; subsequent execution never overwrites fixtures', async () => {
  const collided = memoryStore(true);
  await assert.rejects(runSeed(collided, passwords, timestamp), /Fixture collision/);
  assert.deepEqual(collided.state.writes, []);
  const store = memoryStore();
  await runSeed(store, passwords, timestamp);
  const before = [...store.state.writes];
  await assert.rejects(runSeed(store, passwords, timestamp), /Fixture collision/);
  assert.deepEqual(store.state.writes, before);
  assert.deepEqual(before, ['branch', 'user:Picker', 'profile:Picker', 'user:Packer', 'profile:Packer', 'documents:402']);
});

test('partial failure reports confirmed and uncertain objects without leaking errors or credentials', async () => {
  const store = memoryStore(); store.state.fail = 'Packer';
  await assert.rejects(runSeed(store, passwords, timestamp), (error) => {
    assert.match(error.message, /Confirmed completed: branch DEV_LOCAL/);
    assert.match(error.message, /profile .*Picker/);
    assert.match(error.message, /may have committed/);
    assert(!error.message.includes('secret'));
    assert(!error.message.includes(passwords[0]));
    return true;
  });
  assert(!store.state.writes.some((entry) => entry.startsWith('documents:')));
});

test('seed reports only allowlisted database error categories without sensitive details', async () => {
  for (const [code, category, expected] of [
    ['42501', 'insufficient privilege', '42501'],
    ['23514', 'check constraint', '23514'],
    ['PGRST204', 'schema cache column', 'PGRST204'],
    ['secret-code', 'unclassified', 'withheld'],
  ]) {
    const client = { from: () => ({ insert: async () => ({
      status: 403, error: { code, message: 'secret-password', details: 'token-secret', hint: 'private-url' },
    }) }) };
    const adapter = createSeedStore(client);
    await assert.rejects(adapter.insertDocuments([]), (error) => {
      assert.match(error.message, new RegExp(`category: ${category}`));
      assert.match(error.message, new RegExp(`code: ${expected}`));
      assert.match(error.message, /HTTP status: 403/);
      assert(!error.message.includes('secret'));
      assert(!error.message.includes('private-url'));
      return true;
    });
  }
});

test('permission diagnostics recognize only exact allowlisted PostgreSQL messages', async () => {
  for (const [code, message, expected] of [
    ['42501', 'permission denied for function order_deducted', 'function order_deducted (schema not reported)'],
    ['42501', 'permission denied for table profiles', 'table profiles (schema not reported)'],
    ['42501', 'permission denied for sequence document_revision_seq', 'sequence document_revision_seq (schema not reported)'],
    ['42501', 'new row violates row-level security policy for table "wms_documents"', 'row-level security on table wms_documents (schema not reported)'],
    ['42501', 'permission denied for function order_deducted secret-token', null],
    ['42501', 'permission denied for table secret-token', null],
    ['23514', 'permission denied for function order_deducted', null],
  ]) {
    const client = { from: () => ({ insert: async () => ({
      status: 403, error: { code, message, details: 'secret-detail', hint: 'secret-hint' },
    }) }) };
    await assert.rejects(createSeedStore(client).insertDocuments([]), (error) => {
      if (expected) assert(error.message.includes(`reported object/category: ${expected}`));
      else assert(!error.message.includes('reported object/category'));
      assert(!error.message.includes('secret'));
      return true;
    });
  }
});

test('collision lookup checks branch, both user emails, profiles and every document ID', async () => {
  const seen = [];
  function query(table) {
    let adminLookup = false;
    const q = {
      select() { return q; }, eq(key, value) { seen.push([table, key, value]); if (key === 'role') adminLookup = true; return q; },
      in(key, values) { seen.push([table, key, values]); return q; },
      ilike(key, value) { seen.push([table, key, value]); return q; },
      limit() { return Promise.resolve({ data: adminLookup ? [{ id: 'admin' }] : [], error: null }); },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(resolve) { return resolve({ data: [], error: null }); },
    };
    return q;
  }
  const client = { from: query, auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } };
  const docs = buildSeedDocuments(timestamp);
  assert.deepEqual(await createSeedStore(client).findCollisions(branchId, operators, docs), []);
  assert.equal(seen.filter(([table, key]) => table === 'profiles' && key === 'email').length, 2);
  assert.equal(seen.filter(([table, key]) => table === 'wms_documents' && key === 'document_id')
    .reduce((sum, entry) => sum + entry[2].length, 0), 402);
});

function fakeSupabase() {
  const tables = { branches: [], profiles: [{ id: 'admin', email: 'admin@example.invalid', role: 'Administrator', is_active: true, branch_id: 'CENTER' }], wms_documents: [], stock_movements: [], activity_events: [] };
  const users = [];
  let writes = 0;
  const from = (table) => {
    let rows = tables[table];
    let operation = 'read';
    let values;
    const q = {
      select() { return q; },
      eq(key, value) { rows = rows.filter((row) => row[key] === value); return q; },
      ilike(key, value) { rows = rows.filter((row) => row[key]?.toLowerCase() === value.toLowerCase()); return q; },
      in(key, list) { rows = rows.filter((row) => list.includes(row[key])); return q; },
      insert(value) { operation = 'insert'; values = Array.isArray(value) ? value : [value]; return q; },
      update(value) { operation = 'update'; values = value; return q; },
      async limit(n) { return { data: rows.slice(0, n), error: null }; },
      async maybeSingle() { return execute(true); },
      then(resolve) { return Promise.resolve(execute(false)).then(resolve); },
    };
    function execute(single) {
      if (operation === 'insert') { writes++; tables[table].push(...structuredClone(values)); return { data: null, error: null }; }
      if (operation === 'update') { writes++; rows.forEach((row) => Object.assign(row, values)); }
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    return q;
  };
  const client = { from, auth: { admin: {
    async listUsers() { return { data: { users }, error: null }; },
    async createUser({ email }) {
      writes++;
      const user = { id: `user-${users.length + 1}`, email };
      users.push(user);
      tables.profiles.push({ id: user.id, email, role: 'Viewer', is_active: false, branch_id: 'CENTER' });
      return { data: { user }, error: null };
    },
  } } };
  return { client, tables, users, get writes() { return writes; } };
}

test('document-only recovery verifies identities and history, inserts once, and never modifies accounts', async () => {
  function setup() {
    const fake = fakeSupabase();
    fake.tables.branches.push({ id: branchId });
    for (const [index, operator] of operators.entries()) {
      const id = `operator-${index}`;
      fake.users.push({ id, email: operator.email });
      fake.tables.profiles.push({ id, email: operator.email, role: operator.role, branch_id: branchId, is_active: true });
    }
    return fake;
  }
  const fake = setup();
  const identities = JSON.stringify({ users: fake.users, profiles: fake.tables.profiles, branches: fake.tables.branches });
  await recoverSeedDocuments(createSeedStore(fake.client), timestamp);
  assert.equal(fake.tables.wms_documents.length, 402);
  assert.equal(fake.writes, 1);
  assert.equal(JSON.stringify({ users: fake.users, profiles: fake.tables.profiles, branches: fake.tables.branches }), identities);
  await assert.rejects(recoverSeedDocuments(createSeedStore(fake.client), timestamp), /existing branch documents/);
  assert.equal(fake.writes, 1);
  for (const mutate of [
    (f) => { f.tables.branches.length = 0; },
    (f) => { f.users.pop(); },
    (f) => { f.users[0].id = 'different'; },
    (f) => { f.tables.profiles[1].role = 'Administrator'; },
    (f) => { f.tables.profiles[1].is_active = false; },
    (f) => { f.tables.profiles[1].branch_id = 'CENTER'; },
    (f) => { f.tables.stock_movements.push({ id: 1, branch_id: branchId }); },
    (f) => { f.tables.activity_events.push({ id: 1, branch_id: branchId, entity_type: 'orders' }); },
    (f) => { f.tables.wms_documents.push({ document_id: 'unrelated', branch_id: branchId }); },
  ]) {
    const invalid = setup();
    mutate(invalid);
    await assert.rejects(recoverSeedDocuments(createSeedStore(invalid.client), timestamp));
    assert.equal(invalid.writes, 0);
  }
});

test('real seed adapter inserts once and a retry or any fixture collision performs no writes', async () => {
  const docs = buildSeedDocuments(timestamp);
  for (const kind of ['branch', 'profile', 'auth', 'document']) {
    const fake = fakeSupabase();
    if (kind === 'branch') fake.tables.branches.push({ id: branchId });
    if (kind === 'profile') fake.tables.profiles.push({ email: operators[0].email.toUpperCase() });
    if (kind === 'auth') fake.users.push({ email: operators[1].email });
    if (kind === 'document') fake.tables.wms_documents.push(docs[50]);
    await assert.rejects(runSeed(createSeedStore(fake.client), passwords, timestamp), /Fixture collision/);
    assert.equal(fake.writes, 0, kind);
  }
  const fake = fakeSupabase();
  await runSeed(createSeedStore(fake.client), passwords, timestamp);
  assert.equal(fake.tables.wms_documents.length, 402);
  assert.deepEqual(fake.tables.profiles.slice(1).map((profile) => [profile.branch_id, profile.role]), [[branchId, 'Picker'], [branchId, 'Packer']]);
  const snapshot = JSON.stringify({ tables: fake.tables, users: fake.users, writes: fake.writes });
  await assert.rejects(runSeed(createSeedStore(fake.client), passwords, timestamp), /Fixture collision/);
  assert.equal(JSON.stringify({ tables: fake.tables, users: fake.users, writes: fake.writes }), snapshot);
  const missingAdmin = fakeSupabase();
  missingAdmin.tables.profiles.length = 0;
  await assert.rejects(runSeed(createSeedStore(missingAdmin.client), passwords, timestamp), /active CENTER administrator/);
  assert.equal(missingAdmin.writes, 0);
});

test('administrator service client is created only after verified user identity', async () => {
  let created = 0;
  let marker;
  const auth = { auth: {
    signUp: async ({ options }) => {
      marker = options.data.wms_local_bootstrap_nonce;
      return { data: { user: { id: 'id', identities: [{}] }, session: { access_token: 'test', user: { id: 'id' } } } };
    },
    getUser: async () => ({ data: { user: { id: 'other', email: 'admin@example.invalid' } } }),
  } };
  await assert.rejects(bootstrapLocalAdmin(auth, () => { created++; }, 'admin@example.invalid', 'test'), /verify/);
  assert.equal(created, 0);
  auth.auth.getUser = async () => ({ data: { user: { id: 'id', email: 'admin@example.invalid', user_metadata: { wms_local_bootstrap_nonce: marker } } } });
  let updated = false;
  const admin = { from: () => {
    const q = { select: () => q, eq: () => q, update: () => { updated = true; return q; },
      maybeSingle: async () => ({ data: updated ? { id: 'id', role: 'Administrator', is_active: true, branch_id: 'CENTER' }
        : { id: 'id', email: 'admin@example.invalid', role: 'Viewer', is_active: false, branch_id: 'CENTER' }, error: null }) };
    return q;
  } };
  await bootstrapLocalAdmin(auth, () => { created++; return admin; }, 'admin@example.invalid', 'test');
  assert.equal(created, 1);
  assert.equal(updated, true);
});

test('administrator signup fails closed without login, old-account promotion or secret leakage', async () => {
  const email = 'admin@example.invalid';
  let adminCalls = 0;
  let loginCalls = 0;
  const admin = () => { adminCalls++; throw new Error('must not create admin client'); };
  const auth = { auth: {
    signInWithPassword: async () => { loginCalls++; throw new Error('must not sign in'); },
    signUp: async () => ({ error: { code: 'email_address_invalid', status: 422, message: 'secret-password' } }),
  } };
  await assert.rejects(bootstrapLocalAdmin(auth, admin, email, 'secret-password'), (error) =>
    /email_address_invalid/.test(error.message) && /422/.test(error.message) && !error.message.includes('secret-password'));
  auth.auth.signUp = async () => { throw new Error('token-secret'); };
  await assert.rejects(bootstrapLocalAdmin(auth, admin, email, 'secret-password'), (error) =>
    /unrecognized/.test(error.message) && !error.message.includes('token-secret'));
  auth.auth.signUp = async () => ({ data: { user: { id: 'id' }, session: null }, error: null });
  await assert.rejects(bootstrapLocalAdmin(auth, admin, email, 'secret-password'), /confirmation required or existing account/);
  for (const variant of ['old-marker', 'no-identities', 'different-id', 'different-email']) {
    let marker;
    auth.auth.signUp = async ({ options }) => {
      marker = options.data.wms_local_bootstrap_nonce;
      return { data: { user: { id: 'id', identities: variant === 'no-identities' ? [] : [{}] },
        session: { access_token: 'token-secret', user: { id: 'id' } } } };
    };
    auth.auth.getUser = async () => ({ data: { user: {
      id: variant === 'different-id' ? 'other' : 'id',
      email: variant === 'different-email' ? 'other@example.invalid' : email,
      user_metadata: { wms_local_bootstrap_nonce: variant === 'old-marker' ? 'old' : marker },
    } } });
    await assert.rejects(bootstrapLocalAdmin(auth, admin, email, 'secret-password'), /verify/);
  }
  await assert.rejects(bootstrapLocalAdmin(auth, admin, 'admin@company.com', 'secret-password'), /dummy administrator email/);
  assert.equal(adminCalls, 0);
  assert.equal(loginCalls, 0);
});

test('administrator bootstrap refuses changed or existing profiles and redacts storage errors', async () => {
  let marker;
  let updated = false;
  let profile = { id: 'id', email: 'admin@example.invalid', role: 'Administrator', is_active: true, branch_id: 'CENTER' };
  const auth = { auth: {
    signUp: async ({ options }) => {
      marker = options.data.wms_local_bootstrap_nonce;
      return { data: { user: { id: 'id', identities: [{}] }, session: { user: { id: 'id' }, access_token: 'token' } } };
    },
    getUser: async () => ({ data: { user: { id: 'id', email: 'admin@example.invalid', user_metadata: { wms_local_bootstrap_nonce: marker } } } }),
  } };
  const admin = { from: () => {
    const q = { select: () => q, eq: () => q, update: () => { updated = true; return q; },
      maybeSingle: async () => ({ data: profile }) };
    return q;
  } };
  await assert.rejects(bootstrapLocalAdmin(auth, () => admin, 'admin@example.invalid', 'password'), /inactive CENTER Viewer/);
  assert.equal(updated, false);
  profile = { id: 'other', email: 'admin@example.invalid', role: 'Viewer', is_active: false, branch_id: 'CENTER' };
  await assert.rejects(bootstrapLocalAdmin(auth, () => admin, 'admin@example.invalid', 'password'), /matching readable profile/);
  await assert.rejects(bootstrapLocalAdmin(auth, () => { throw new Error('secret'); }, 'admin@example.invalid', 'password'),
    (error) => !error.message.includes('secret') && /lookup failed/.test(error.message));
});
