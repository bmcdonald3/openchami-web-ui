import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';

const serviceOperations = {
  'smd.components': { service: 'smd', method: 'GET', path: '/hsm/v2/Inventory/ComponentEndpoints', token: true },
  'smd.import': { service: 'smd', method: 'POST', path: '/hsm/v2/Inventory/RedfishEndpoints', token: true },
  'bss.nodes': { service: 'bss', method: 'GET', path: '/nodes', token: true },
  'bss.node.create': { service: 'bss', method: 'POST', path: '/nodes', token: true },
  'bss.node.update': { service: 'bss', method: 'PUT', path: '/nodes/:uid', token: true },
  'bss.bootparameters': { service: 'bss', method: 'POST', path: '/boot/v1/bootparameters', token: true },
  'bss.bootscript': { service: 'bss', method: 'GET', path: '/boot/v1/bootscript', token: false },
};

function localServiceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid service URL.');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || isIP(host) === 4 && host.startsWith('127.');
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Service URLs must be loopback addresses with no path or embedded credentials. Use kubectl port-forward for cluster services.');
  }
  return url;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let content = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      content += chunk;
      if (content.length > 1_048_576) {
        reject(new Error('Request is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(content || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function assertOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: 'Invalid request origin.' }));
    return false;
  }
  if (originHost !== request.headers.host) {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: 'Cross-origin requests are not allowed.' }));
    return false;
  }
  return true;
}

function responseJson(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function environmentForBmc(target, masterKey) {
  const bypass = new Set([...(process.env.NO_PROXY || process.env.no_proxy || '').split(','), target].map((host) => host.trim()).filter(Boolean));
  const noProxy = [...bypass].join(',');
  return { ...process.env, MASTER_KEY: masterKey, NO_PROXY: noProxy, no_proxy: noProxy };
}

function runCommand(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 120_000, ...spawnOptions } = options;
    const child = spawn(binary, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-200_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${binary} exceeded the ${Math.round(timeoutMs / 1000)} second time limit.`));
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${binary} exited with code ${code}`));
    });
  });
}

function validateDiscovery(body) {
  if (typeof body.target !== 'string' || isIP(body.target.trim()) === 0) {
    throw new Error('Enter a single BMC IP address. Subnet scans are not enabled in this console.');
  }
  if (typeof body.xname !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(body.xname.trim())) {
    throw new Error('Enter a valid BMC xname for the Magellan ID map.');
  }
  if (typeof body.username !== 'string' || !body.username.trim() || typeof body.password !== 'string' || !body.password) {
    throw new Error('BMC username and password are required for collection.');
  }
  return {
    target: body.target.trim(),
    xname: body.xname.trim(),
    username: body.username,
    password: body.password,
    insecure: body.insecure === true,
  };
}

async function runDiscovery(body, binary = process.env.MAGELLAN_BIN || 'magellan') {
  const input = validateDiscovery(body);
  const workingDir = await mkdtemp(join(tmpdir(), 'openchami-discovery-'));
  const cachePath = join(workingDir, 'assets.db');
  const secretsPath = join(workingDir, 'secrets.json');
  const credentialsPath = join(workingDir, 'credentials.json');
  const inventoryPath = join(workingDir, 'inventory.json');
  try {
    const masterKey = await runCommand(binary, ['secrets', 'generatekey'], { cwd: workingDir });
    await writeFile(credentialsPath, JSON.stringify({ username: input.username, password: input.password }), { mode: 0o600 });
    await runCommand(binary, [
      'secrets', 'store', input.target, '--format', 'json', '--input-file', credentialsPath,
      '--file', secretsPath,
    ], { cwd: workingDir, env: { ...process.env, MASTER_KEY: masterKey } });
    const scanHost = isIP(input.target) === 6 ? `[${input.target}]` : input.target;
    const scanArgs = ['scan', `https://${scanHost}:443`, '--cache', cachePath, '--output-format', 'json'];
    if (input.insecure) scanArgs.push('--insecure');
    const bmcEnvironment = environmentForBmc(input.target, masterKey);
    await runCommand(binary, scanArgs, { cwd: workingDir, env: bmcEnvironment });
    const idMap = JSON.stringify({ map_key: 'bmc-ip-addr', id_map: { [input.target]: input.xname } });
    const collectArgs = [
      'collect', '--cache', cachePath, '--secrets-file', secretsPath,
      '--bmc-id-map', idMap, '--output-format', 'json', '--output-file', inventoryPath,
    ];
    if (input.insecure) collectArgs.push('--insecure');
    await runCommand(binary, collectArgs, { cwd: workingDir, env: bmcEnvironment });
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
    if (!Array.isArray(inventory)) throw new Error('Magellan returned an unexpected inventory format.');
    return { inventory, target: input.target, xname: input.xname, discoveredAt: new Date().toISOString() };
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

async function handleService(body) {
  const operation = serviceOperations[body.operation];
  if (!operation) throw new Error('That service operation is not supported.');
  const baseUrl = localServiceUrl(body[operation.service === 'smd' ? 'smdUrl' : 'bssUrl']);
  const endpoint = operation.path === '/nodes/:uid'
    ? `/nodes/${encodeURIComponent(String(body.uid || ''))}`
    : operation.path;
  if (operation.path === '/nodes/:uid' && !body.uid) throw new Error('A BSS node UID is required for updates.');
  const target = new URL(endpoint, baseUrl);
  if (body.operation === 'bss.bootscript') {
    if (typeof body.identifier !== 'string' || !body.identifier.trim()) throw new Error('A node name or MAC address is required.');
    const queryKey = body.identifierType === 'mac' ? 'mac' : 'host';
    target.searchParams.set(queryKey, body.identifier.trim());
  }
  const headers = { Accept: 'application/json, text/plain' };
  if (operation.token && typeof body.token === 'string' && body.token.trim()) headers.Authorization = `Bearer ${body.token.trim()}`;
  let payload;
  if (operation.method !== 'GET') {
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) throw new Error('A JSON payload is required for this operation.');
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body.payload);
  }
  const upstream = await fetch(target, {
    method: operation.method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await upstream.text();
  return { status: upstream.status, payload: text, contentType: upstream.headers.get('content-type') || '' };
}

export function createApiHandler(options = {}) {
  const discovery = options.discovery || runDiscovery;
  return async (request, response, next) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/api/')) return next();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!assertOrigin(request, response)) return;
    if (request.method !== 'POST') return responseJson(response, 405, { error: 'Use POST for console operations.' });
    if (!request.headers['content-type']?.startsWith('application/json')) return responseJson(response, 415, { error: 'Requests must use application/json.' });

    try {
      const body = await readJson(request);
      if (pathname === '/api/discover') {
        const result = await discovery(validateDiscovery(body), options.magellanBin);
        return responseJson(response, 200, result);
      }
      if (pathname !== '/api/service') return responseJson(response, 404, { error: 'Unknown local API route.' });
      const result = await handleService(body);
      return responseJson(response, 200, result);
    } catch (error) {
      const status = error.name === 'TimeoutError' ? 504 : error.name === 'TypeError' ? 502 : 400;
      return responseJson(response, status, { error: error.message || 'The local operation failed.' });
    }
  };
}
