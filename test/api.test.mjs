import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createApiHandler } from '../server/api.mjs';

let upstream;
let proxy;
let upstreamUrl;
let proxyUrl;
const upstreamRequests = [];

before(async () => {
  upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    upstreamRequests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : undefined,
    });
    if (request.url === '/nodes' || request.url === '/hsm/v2/Inventory/ComponentEndpoints') {
      response.setHeader('Content-Type', 'application/json');
      response.end(request.url === '/nodes' ? '[{"metadata":{"uid":"node-uid"},"spec":{"xname":"node-0"}}]' : '{"ComponentEndpoints":[]}');
      return;
    }
    response.setHeader('Content-Type', request.url.startsWith('/boot/v1/bootscript') ? 'text/plain' : 'application/json');
    response.end(request.url.startsWith('/boot/v1/bootscript') ? '#!ipxe\nboot\n' : '{"accepted":true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  proxy = createServer(createApiHandler({ discovery: async (body) => ({ inventory: [], target: body.target, xname: body.xname }) }));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => {
  proxy.close();
  upstream.close();
});

async function post(path, body, headers = {}) {
  return fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('reads SMD endpoints and forwards the HSM bearer token', async () => {
  const response = await post('/api/service', { operation: 'smd.components', smdUrl: upstreamUrl, token: 'hsm-token' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/hsm/v2/Inventory/ComponentEndpoints', method: 'GET', authorization: 'Bearer hsm-token', body: undefined,
  });
});

test('posts a reviewed Magellan endpoint to SMD only on explicit import', async () => {
  const endpoint = { ID: 'bmc-0', Systems: [{ uuid: 'sys-0' }] };
  const response = await post('/api/service', { operation: 'smd.import', smdUrl: upstreamUrl, token: 'hsm-token', payload: endpoint });
  assert.equal(response.status, 200);
  assert.equal(upstreamRequests.at(-1).method, 'POST');
  assert.equal(upstreamRequests.at(-1).url, '/hsm/v2/Inventory/RedfishEndpoints');
  assert.deepEqual(upstreamRequests.at(-1).body, endpoint);
});

test('reads nodes and supports create and update with authenticated JSON bodies', async () => {
  const read = await post('/api/service', { operation: 'bss.nodes', bssUrl: upstreamUrl, token: 'bss-token' });
  assert.equal(read.status, 200);
  assert.equal(upstreamRequests.at(-1).url, '/nodes');

  const node = { apiVersion: 'boot.openchami.io/v1', kind: 'Node', metadata: { name: 'node-0' }, spec: { xname: 'node-0', bootMac: '02:00:00:00:00:01' } };
  await post('/api/service', { operation: 'bss.node.create', bssUrl: upstreamUrl, token: 'bss-token', payload: node });
  assert.equal(upstreamRequests.at(-1).method, 'POST');
  assert.deepEqual(upstreamRequests.at(-1).body, node);

  await post('/api/service', { operation: 'bss.node.update', bssUrl: upstreamUrl, token: 'bss-token', uid: 'uid / 1', payload: node });
  assert.equal(upstreamRequests.at(-1).method, 'PUT');
  assert.equal(upstreamRequests.at(-1).url, '/nodes/uid%20%2F%201');
});

test('writes boot parameters and looks up iPXE without authentication', async () => {
  const parameters = { hosts: ['node-0'], macs: ['02:00:00:00:00:01'], kernel: 'https://example.test/kernel', initrd: 'https://example.test/initrd', params: 'ip=dhcp' };
  await post('/api/service', { operation: 'bss.bootparameters', bssUrl: upstreamUrl, token: 'bss-token', payload: parameters });
  assert.equal(upstreamRequests.at(-1).method, 'POST');
  assert.equal(upstreamRequests.at(-1).url, '/boot/v1/bootparameters');
  assert.deepEqual(upstreamRequests.at(-1).body, parameters);

  const response = await post('/api/service', { operation: 'bss.bootscript', bssUrl: upstreamUrl, identifier: 'node / 0', identifierType: 'host' });
  assert.equal((await response.json()).payload, '#!ipxe\nboot\n');
  assert.equal(upstreamRequests.at(-1).url, '/boot/v1/bootscript?host=node+%2F+0');
  assert.equal(upstreamRequests.at(-1).authorization, undefined);
});

test('keeps Magellan discovery separate from SMD and rejects invalid targets', async () => {
  const result = await post('/api/discover', { target: '192.0.2.4', xname: 'x1000c0s0b0', username: 'operator', password: 'secret' });
  assert.deepEqual(await result.json(), { inventory: [], target: '192.0.2.4', xname: 'x1000c0s0b0' });
  assert.equal(upstreamRequests.length, 7);

  const invalid = await post('/api/discover', { target: '192.0.2.1/24', xname: 'x1000c0s0b0' });
  assert.equal(invalid.status, 400);
});

test('runs Magellan with temporary credentials that are not passed in argv', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'openchami-magellan-test-'));
  const binary = join(testDir, 'fake-magellan');
  const trace = join(testDir, 'trace.txt');
  const fixture = '[{"ID":"x1000c0s0b0","Systems":[{"uuid":"fixture-uuid"}]}]';
  const fakeCommand = `#!/bin/sh
printf '%s\\n' "$@" >> '${trace}'
printf 'NO_PROXY=%s\\n' "$NO_PROXY" >> '${trace}'
if [ "$1" = "secrets" ] && [ "$2" = "generatekey" ]; then printf 'ephemeral-key\\n'; exit 0; fi
if [ "$1" = "secrets" ] && [ "$2" = "store" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--file" ]; then shift; : > "$1"; fi
    shift
  done
  exit 0
fi
if [ "$1" = "collect" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output-file" ]; then shift; printf '%s\\n' '${fixture}' > "$1"; fi
    shift
  done
fi
exit 0
`;
  await writeFile(binary, fakeCommand, { mode: 0o700 });
  await chmod(binary, 0o700);
  const discoveryProxy = createServer(createApiHandler({ magellanBin: binary }));
  await new Promise((resolve) => discoveryProxy.listen(0, '127.0.0.1', resolve));
  const discoveryUrl = `http://127.0.0.1:${discoveryProxy.address().port}/api/discover`;

  try {
    const response = await fetch(discoveryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: '192.0.2.4', xname: 'x1000c0s0b0', username: 'test-user', password: 'never-on-command-line', insecure: true }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).inventory, JSON.parse(fixture));
    const args = await readFile(trace, 'utf8');
    assert.match(args, /scan\nhttps:\/\/192\.0\.2\.4:443/);
    assert.match(args, /--secrets-file/);
    assert.match(args, /--bmc-id-map/);
    assert.match(args, /NO_PROXY=.*192\.0\.2\.4/);
    assert.doesNotMatch(args, /never-on-command-line|test-user/);
    const credentialArgIndex = args.split('\n').indexOf('--input-file');
    const credentialsPath = args.split('\n')[credentialArgIndex + 1];
    assert.ok(credentialsPath);
    await assert.rejects(readFile(credentialsPath));
  } finally {
    await new Promise((resolve) => discoveryProxy.close(resolve));
    await rm(testDir, { recursive: true, force: true });
  }
});

test('rejects unsupported operations, external targets, cross-origin and non-JSON requests', async () => {
  const unsupported = await post('/api/service', { operation: 'bss.write', bssUrl: upstreamUrl });
  assert.equal(unsupported.status, 400);
  const publicTarget = await post('/api/service', { operation: 'bss.nodes', bssUrl: 'https://example.com' });
  assert.equal(publicTarget.status, 400);
  const crossOrigin = await post('/api/service', {}, { Origin: 'https://example.com' });
  assert.equal(crossOrigin.status, 403);
  const formRequest = await fetch(`${proxyUrl}/api/service`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(formRequest.status, 415);
});
