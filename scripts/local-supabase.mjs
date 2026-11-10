import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = 'unified-wms-dev';
const apiUrl = 'http://127.0.0.1:54321';
const containerName = (service) => `supabase_${service}_${project}`;
const requiredServices = ['kong', 'db', 'auth', 'rest'];
const allowedNetworks = [`supabase_network_${project}`, 'trueblue-local-only'];

export function verifyNetworkEnvironment(env) {
  const forbidden = ['NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
  if (Object.entries(env).some(([name, value]) => value && forbidden.includes(name.toUpperCase()))) {
    throw new Error('Unset Node options and proxy environment variables before local operations.');
  }
}

export async function localApiFetch(input, init) {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (target.origin !== apiUrl || target.username || target.password) throw new Error('Refusing a non-local API request.');
  return fetch(input, { ...init, redirect: 'error' });
}

function verifyDockerContext(context) {
  const endpoint = context?.Endpoints?.docker?.Host;
  if (!/^npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/i.test(endpoint ?? '')) {
    throw new Error('Docker must use a local Windows named-pipe endpoint.');
  }
}

function imgproxyDisabled(containers, network) {
  if (!Array.isArray(containers) || !network?.Id) return false;
  const storage = containers.filter((container) => container.Name === `/${containerName('storage')}`);
  const imgproxy = containers.filter((container) => container.Name === `/${containerName('imgproxy')}`);
  if (storage.length !== 1 || imgproxy.length > 1 || imgproxy.some((container) => container.State?.Running)) return false;
  const container = storage[0];
  if (!container.Id || !container.State?.Running ||
      container.NetworkSettings?.Networks?.[network.Name]?.NetworkID !== network.Id ||
      !network.Containers?.[container.Id] || !Array.isArray(container.Config?.Env)) return false;
  return ['ENABLE_IMAGE_TRANSFORMATION', 'IMAGE_TRANSFORMATION_ENABLED'].every((name) => {
    const entries = container.Config.Env.filter((entry) => entry.startsWith(`${name}=`));
    return entries.length === 1 && entries[0] === `${name}=false`;
  });
}

export function checkCommandResult(stage, result, context) {
  const status = Number.isInteger(result.status) ? String(result.status) : 'unavailable';
  const lines = (result.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const upgradeFirst = /^A new version of Supabase CLI is available: v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? \(currently installed v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\)$/;
  const upgradeSecond = 'We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli';
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  const ignored = new Set();
  let updateNotice = false;
  let optionalStopped = false;
  if (stage === 'Supabase CLI status') {
    for (let i = 0; i + 1 < plain.length; i++) {
      if (upgradeFirst.test(plain[i]) && plain[i + 1] === upgradeSecond) {
        ignored.add(i);
        ignored.add(i + 1);
        updateNotice = true;
        i++;
      }
    }
    if (imgproxyDisabled(context?.containers, context?.network)) {
      for (let i = 0; i < plain.length; i++) {
        if (plain[i] === `Stopped services: [${containerName('imgproxy')}]`) {
          ignored.add(i);
          optionalStopped = true;
        }
      }
    }
  }
  const benign = /^WARNING: (?:the )?daemon is not using the default seccomp profile\.?$/i;
  const rejected = plain.filter((line, index) => !ignored.has(index) && !benign.test(line));
  const categories = new Set();
  for (const line of rejected) {
    if (/^Stopped services:/.test(line)) categories.add('stopped services');
    else if (/^(?:error|fatal)\b/i.test(line)) categories.add('CLI error');
    else if (/^warn(?:ing)?\b/i.test(line)) categories.add('warning');
    else if (/^A new version of Supabase CLI is available:/.test(line) ||
      /^We recommend updating regularly for new features and bug fixes:/.test(line)) categories.add('unrecognized update notice');
    else categories.add('unrecognized stderr');
  }
  if (!lines.length) categories.add('no stderr');
  if (updateNotice) categories.add('CLI update notice');
  if (optionalStopped) categories.add('disabled optional imgproxy');
  if (lines.length && !rejected.length && !ignored.size) categories.add('Docker seccomp warning');
  const diagnostic = `exit ${status}; category: ${[...categories].join(', ') || 'unrecognized stderr'}; output withheld`;
  if (result.error || result.status !== 0) {
    throw new Error(`${stage}: command failed (${diagnostic}).`);
  }
  if (rejected.length) {
    throw new Error(`${stage}: unrecognized warning or error on stderr (${diagnostic}).`);
  }
  return result.stdout;
}

function command(stage, program, args, context) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return checkCommandResult(stage, result, context);
}

export function inspectGatewayServices(runDocker) {
  return inspectGatewayCollection(runDocker, 'services');
}

export function inspectGatewayRoutes(runDocker) {
  return inspectGatewayCollection(runDocker, 'routes');
}

function inspectGatewayCollection(runDocker, collection) {
  const stage = `Docker gateway ${collection === 'services' ? 'service' : 'route'} inspection (nc)`;
  const request = `GET /${collection}?size=1000 HTTP/1.1\r\nHost: 127.0.0.1:8001\r\nConnection: close\r\nAccept: application/json\r\nAccept-Encoding: identity\r\n\r\n`;
  const result = runDocker(['exec', '-i', containerName('kong'), 'nc', '127.0.0.1', '8001'], request);
  const output = checkCommandResult(stage, result);
  const response = Buffer.isBuffer(output) ? output : Buffer.from(output, 'utf8');
  const headerEnd = response.indexOf('\r\n\r\n');
  if (headerEnd < 0 || headerEnd > 16384) throw new Error(`${stage}: invalid HTTP headers.`);
  const lines = response.subarray(0, headerEnd).toString('latin1').split('\r\n');
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(lines.shift())) throw new Error(`${stage}: expected HTTP 200 response.`);
  const headers = new Map();
  for (const line of lines) {
    const match = line.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/);
    if (!match) throw new Error(`${stage}: invalid HTTP header.`);
    const name = match[1].toLowerCase();
    if (headers.has(name)) throw new Error(`${stage}: duplicate HTTP header.`);
    headers.set(name, match[2].trim());
  }
  if (headers.has('transfer-encoding') || headers.has('content-encoding') || headers.has('location')) {
    throw new Error(`${stage}: unsupported HTTP response encoding or redirect.`);
  }
  const length = headers.get('content-length');
  const body = response.subarray(headerEnd + 4);
  if (!/^(0|[1-9]\d*)$/.test(length ?? '') || Number(length) !== body.length) {
    throw new Error(`${stage}: invalid or incomplete HTTP response body.`);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new Error(`${stage}: invalid UTF-8 response body.`); }
  return parseInspection(stage, text);
}

export function parseInspection(stage, text) {
  try { return JSON.parse(text); } catch { throw new Error(`${stage}: invalid JSON response; output withheld.`); }
}

export function parseLocalStatusEnv(stdout) {
  const values = {};
  for (const line of stdout.split(/\r?\n/)) {
    const key = line.match(/^\s*(API_URL|ANON_KEY|SERVICE_ROLE_KEY)\s*=/)?.[1];
    if (!key) continue;
    const match = line.match(/^\s*(API_URL|ANON_KEY|SERVICE_ROLE_KEY)\s*=\s*(?:"([^"'\s]+)"|'([^"'\s]+)'|([^"'\s]+))\s*$/);
    if (!match || Object.hasOwn(values, key)) {
      throw new Error('Supabase CLI status: malformed or duplicate required field; output withheld.');
    }
    values[key] = match[2] ?? match[3] ?? match[4];
  }
  if (!values.API_URL || !values.ANON_KEY || !values.SERVICE_ROLE_KEY) {
    throw new Error('Supabase CLI status: missing required output field; output withheld.');
  }
  return values;
}

export function selectProjectNetwork(containers) {
  const byName = new Map(containers.map((container) => [container.Name?.replace(/^\//, ''), container]));
  const selected = requiredServices.map((service) => {
    const container = byName.get(containerName(service));
    if (!container || !container.State?.Running || !container.Id) {
      throw new Error(`Container inspection: expected running ${service} project container is missing.`);
    }
    return container;
  });
  const candidates = allowedNetworks.filter((name) =>
    selected.every((container) => container.NetworkSettings?.Networks?.[name]));
  if (candidates.length !== 1) {
    throw new Error('Network selection: expected exactly one approved network shared by kong, db, auth and rest.');
  }
  return candidates[0];
}

export function verifyLocalTarget(config, status, context, containers, network) {
  if (!/^\s*project_id\s*=\s*"unified-wms-dev"\s*$/m.test(config)) throw new Error('Unexpected Supabase project configuration.');
  if (status.API_URL !== apiUrl) throw new Error('Supabase API URL is not the exact permitted local URL.');
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Local Supabase status is missing required keys.');
  verifyDockerContext(context);
  const byName = new Map(containers.map((container) => [container.Name?.replace(/^\//, ''), container]));
  for (const service of requiredServices) {
    const container = byName.get(containerName(service));
    if (!container || !container.State?.Running) throw new Error(`Expected running local ${service} container is missing.`);
  }
  const projectIds = new Set(containers.map((container) => container.Id));
  if (Object.keys(network.Containers ?? {}).some((id) => !projectIds.has(id))) {
    throw new Error('Unexpected container attached to the local project network.');
  }
  if (!containers.length || containers.some((container) => !container.Name?.replace(/^\//, '').endsWith(`_${project}`))) {
    throw new Error('Unexpected Docker project container.');
  }
  for (const container of containers) {
    for (const bindings of Object.values(container.NetworkSettings?.Ports ?? {})) {
      for (const binding of bindings ?? []) {
        if (!['127.0.0.1', '::1'].includes(binding.HostIp)) throw new Error('A project container publishes a port outside loopback.');
      }
    }
  }
  const kong = byName.get(containerName('kong'));
  const apiBindings = kong.NetworkSettings?.Ports?.['8000/tcp'] ?? [];
  if (!apiBindings.some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === '54321') ||
      apiBindings.some((binding) => binding.HostPort !== '54321')) {
    throw new Error('Expected local API Docker port binding is missing or ambiguous.');
  }
  const networkName = selectProjectNetwork(containers);
  if (network?.Name !== networkName || !network.Id) throw new Error('Expected Supabase project network is missing.');
  for (const service of requiredServices) {
    const container = byName.get(containerName(service));
    if (container.NetworkSettings?.Networks?.[networkName]?.NetworkID !== network.Id || !network.Containers?.[container.Id]) {
      throw new Error(`Local ${service} container is not attached to the expected project network.`);
    }
  }
  const db = byName.get(containerName('db'));
  const dbNetwork = db.NetworkSettings.Networks[networkName];
  const dbHosts = new Set([containerName('db'), ...(dbNetwork.Aliases ?? [])]);
  for (const [service, envName] of [['auth', 'GOTRUE_DB_DATABASE_URL'], ['rest', 'PGRST_DB_URI']]) {
    const container = byName.get(containerName(service));
    const entries = (container.Config?.Env ?? []).filter((entry) => entry.startsWith(`${envName}=`));
    if (entries.length !== 1) throw new Error(`Cannot verify the local ${service} database target.`);
    let target;
    try { target = new URL(entries[0].slice(envName.length + 1)); } catch { throw new Error(`Invalid local ${service} database target.`); }
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || !dbHosts.has(target.hostname) ||
        (target.port && target.port !== '5432') || target.pathname !== '/postgres') {
      throw new Error(`The ${service} database target is not the expected local project database.`);
    }
  }
}

export function verifyGatewayServices(response, containers, network, routes) {
  if (!Array.isArray(response?.data) || response.next) throw new Error('Cannot fully inspect the local gateway services.');
  const hosts = new Map();
  for (const container of containers) {
    const networkData = container.NetworkSettings?.Networks?.[network.Name];
    if (!networkData || networkData.NetworkID !== network.Id || !network.Containers?.[container.Id] ||
        !container.State?.Running || !container.Name?.replace(/^\//, '').startsWith('supabase_') ||
        !container.Name?.endsWith(`_${project}`)) continue;
    for (const host of [container.Name.replace(/^\//, ''), ...(networkData.Aliases ?? []), networkData.IPAddress, networkData.GlobalIPv6Address].filter(Boolean)) {
      const key = host.toLowerCase();
      if (!hosts.has(key)) hosts.set(key, container.Id);
      else if (hosts.get(key) !== container.Id) hosts.set(key, null);
    }
  }
  const expected = new Map(containers.map((container) => [container.Name.replace(/^\//, ''), container.Id]));
  const rest = containers.find((container) => container.Name === `/${containerName('rest')}`);
  const adminPortSettings = (rest?.Config?.Env ?? []).filter((entry) => entry.startsWith('PGRST_ADMIN_SERVER_PORT='));
  const reached = new Set();
  const knownNames = new Set([
    'auth-v1', 'auth-v1-open', 'auth-v1-verify', 'auth-v1-callback', 'auth-v1-authorize',
    'rest-v1', 'rest-admin-v1', 'graphql-v1', 'realtime-v1', 'storage-v1', 'functions-v1', 'meta', 'pg',
    'analytics-v1', 'studio', 'pooler-v2-ws',
  ]);
  const diagnostics = [];
  let failures = 0;
  for (const [index, service] of response.data.entries()) {
    const name = knownNames.has(service?.name) ? service.name : `#${index + 1} (name withheld)`;
    const host = typeof service?.host === 'string' ? service.host.toLowerCase() : '';
    const ip = isIP(host);
    const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
      (ip === 4 && host.startsWith('127.'));
    const category = !host ? 'missing host' : loopback ? 'loopback' : ip === 4 ? 'IPv4' : ip === 6 ? 'IPv6' : 'hostname';
    const id = hosts.get(host);
    let reason = 'verified project container';
    const isPooler = service?.name === 'pooler-v2-ws';
    if (!['http', 'https'].includes(service?.protocol)) reason = 'unsupported protocol';
    else if (!Number.isInteger(service?.port) || service.port < 1 || service.port > 65535) reason = 'invalid port';
    else if (!host) reason = 'missing or invalid host';
    else if (loopback) reason = 'loopback does not establish a project container upstream';
    else if (id === null) reason = 'ambiguous project network alias or IP';
    else if (!id) reason = 'host not mapped to a running project container on the approved network';
    else if (!isPooler && id === expected.get(containerName('pooler'))) reason = 'Unexpected service targeting the Pooler container';
    else if (isPooler &&
      (service.protocol !== 'http' || service.enabled !== true || network.Name !== 'trueblue-local-only' ||
       id !== expected.get(containerName('pooler')) || host !== containerName('pooler') ||
       service.port !== 4000 || service.path !== '/v2')) {
      reason = 'Pooler service or target configuration mismatch';
    }
    else if (isPooler && !verifiedPoolerRoutes(service, routes)) reason = 'Pooler route configuration not verified';
    else if (service.name === 'rest-admin-v1' &&
      (id !== expected.get(containerName('rest')) || service.port !== 3001 ||
       adminPortSettings.length !== 1 || adminPortSettings[0] !== 'PGRST_ADMIN_SERVER_PORT=3001')) {
      reason = 'REST Admin target or configured port mismatch';
    }
    else if (id === expected.get(containerName('auth')) && service.port !== 9999) reason = 'Auth container port mismatch';
    else if (id === expected.get(containerName('rest')) && service.port !== 3000 &&
      !(service.name === 'rest-admin-v1' && service.port === 3001)) reason = 'REST container port mismatch';
    if (reason !== 'verified project container') {
      failures++;
    } else {
      if (id === expected.get(containerName('auth'))) reached.add('auth');
      if (id === expected.get(containerName('rest')) && service.port === 3000 && service.name !== 'rest-admin-v1') reached.add('rest');
    }
    diagnostics.push(`  ${name}: ${category}; ${reason}`);
  }
  if (!reached.has('auth') || !reached.has('rest')) {
    diagnostics.push(`  Required targets: Auth ${reached.has('auth') ? 'verified' : 'missing'}, REST ${reached.has('rest') ? 'verified' : 'missing'}.`);
    failures++;
  }
  if (failures) throw new Error(`The local gateway has unverified upstream services (${response.data.length} inspected):\n${diagnostics.join('\n')}`);
}

function verifiedPoolerRoutes(service, routes) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(service.id ?? '') ||
      !Array.isArray(routes?.data) || routes.next) return false;
  const matching = routes.data.filter((route) => route?.service?.id === service.id);
  if (matching.length !== 1) return false;
  const route = matching[0];
  return route.name === 'pooler-v2-ws' && route.strip_path === true &&
    Array.isArray(route.paths) && route.paths.length === 1 && route.paths[0] === '/pooler/v2/' &&
    Array.isArray(route.protocols) && route.protocols.length > 0 &&
    route.protocols.every((protocol) => ['http', 'https'].includes(protocol));
}

export function readLocalSupabaseStatus() {
  verifyNetworkEnvironment(process.env);
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) throw new Error('Unset DOCKER_HOST and DOCKER_CONTEXT before local inspection.');
  const config = readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8');
  const contexts = parseInspection('Docker context inspection', command('Docker context inspection', 'docker', ['context', 'inspect']));
  if (!Array.isArray(contexts) || contexts.length !== 1) throw new Error('Cannot identify the Docker context.');
  verifyDockerContext(contexts[0]);
  const names = command('Docker project container listing', 'docker', ['ps', '-a', '--format', '{{.Names}}'])
    .split(/\r?\n/).filter((name) => name.startsWith('supabase_') && name.endsWith(`_${project}`));
  if (!names.length) throw new Error('No expected local project containers found.');
  const containers = parseInspection('Docker project container inspection',
    command('Docker project container inspection', 'docker', ['inspect', ...names]));
  if (!Array.isArray(containers)) throw new Error('Docker project container inspection: expected a container list.');
  const networkName = selectProjectNetwork(containers);
  const networks = parseInspection('Docker project network inspection',
    command('Docker project network inspection', 'docker', ['network', 'inspect', networkName]));
  if (!Array.isArray(networks) || networks.length !== 1) throw new Error('Cannot identify the local project network.');
  verifyLocalTarget(config, { API_URL: apiUrl, ANON_KEY: 'pending', SERVICE_ROLE_KEY: 'pending' }, contexts[0], containers, networks[0]);
  const runGatewayDocker = (args, input) => {
    const result = spawnSync('docker', args, { cwd: root, input, windowsHide: true, timeout: 15000 });
    return { ...result, stderr: result.stderr?.toString('utf8') };
  };
  const gatewayServices = inspectGatewayServices(runGatewayDocker);
  const gatewayRoutes = gatewayServices?.data?.some((service) => service?.name === 'pooler-v2-ws')
    ? inspectGatewayRoutes(runGatewayDocker) : undefined;
  verifyGatewayServices(gatewayServices, containers, networks[0], gatewayRoutes);
  const stdout = command('Supabase CLI status', process.execPath, [path.join(root, 'node_modules', 'supabase', 'dist', 'supabase.js'), 'status', '--output', 'env'], { containers, network: networks[0] });
  const values = parseLocalStatusEnv(stdout);
  verifyLocalTarget(config, values, contexts[0], containers, networks[0]);
  return { apiUrl, anonKey: values.ANON_KEY, serviceRoleKey: values.SERVICE_ROLE_KEY };
}
