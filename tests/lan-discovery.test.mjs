// Local dashboard path of Add Device → Pi Name → Find IP (discovery/piDiscovery.js):
// UDP broadcast on port 50500 first, mDNS fallback second; the Pi Name matches
// the Pi's Linux username OR hostname; every match is confirmed by the Pi's own
// /api/status (a local HTTP stand-in here). The UDP/mDNS network steps are
// injected so the test does not depend on this PC's LAN; the reply parser is
// checked against a reply produced by the real Pi responder
// (N-Signage/app/discovery_responder.py). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findPi, verifyMdnsCandidate, parseAnnounce, UDP_DISCOVERY_PORT, discoveryRequestHandler,
} from '../discovery/piDiscovery.js';
import { piNameMatch, isValidPiName } from '../shared/piName.js';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
let statusServer; let port;
let statusPayload = null;

before(async () => {
  statusServer = http.createServer((req, res) => {
    if (req.url !== '/api/status' || !statusPayload) { res.statusCode = 404; res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(statusPayload));
  });
  await new Promise((r) => statusServer.listen(0, '127.0.0.1', r));
  port = statusServer.address().port;
});
after(() => statusServer?.close());

const PI = { ip: '127.0.0.1', username: 'nsignage', hostname: 'ns001', deviceId: '0123456789abcdef', protocolVersion: 1 };
const announce = (over = {}) => ({ ...PI, port, ...over });
const status = (over = {}) => ({ status: 'online', pi_username: 'nsignage', hostname: 'ns001', device_id: '0123456789abcdef', ...over });
const noMdns = async () => { throw new Error('mDNS must not run when UDP answered'); };

test('UDP discovery stays on port 50500', () => {
  assert.equal(UDP_DISCOVERY_PORT, 50500);
});

test('Pi Name rules shared by the website and the helper', () => {
  for (const ok of ['ns001', 'NS001', 'nsignage', 'shop-pi.local', 'pi_2']) assert.ok(isValidPiName(ok), ok);
  for (const bad of ['', ' ', '-pi', 'a b', '../x', 'x'.repeat(64)]) assert.ok(!isValidPiName(bad), bad);
  assert.equal(piNameMatch('ns001', PI), 'hostname');
  assert.equal(piNameMatch('NS001.local', PI), 'hostname');
  assert.equal(piNameMatch('ns001', { username: 'x', hostname: 'ns001.shop.example' }), 'hostname');
  assert.equal(piNameMatch('NSignage', PI), 'username');
  assert.equal(piNameMatch('Main Lobby', PI), null, 'a nickname is not a key');
  assert.equal(piNameMatch('ns00', PI), null, 'no partial matches');
});

test('Find IP by hostname or username over UDP; IP filled from the Pi; nickname finds nothing', async () => {
  statusPayload = status();
  const discover = async () => [announce()];
  const byHost = await findPi('ns001', { discover, mdnsFallback: noMdns });
  assert.equal(byHost.found, true);
  assert.equal(byHost.ip, '127.0.0.1');
  assert.equal(byHost.hostname, 'ns001');
  assert.equal(byHost.username, 'nsignage');
  assert.equal(byHost.online, true);
  assert.equal(byHost.method, 'udp-broadcast');
  assert.equal((await findPi('NSIGNAGE', { discover, mdnsFallback: noMdns })).found, true);
  const miss = await findPi('Lobby', { discover, mdnsFallback: noMdns });
  assert.equal(miss.found, false);
  assert.equal(miss.reason, 'username-mismatch'); // other Pis answered, none with this name
  assert.equal(miss.otherCount, 1);
  assert.equal((await findPi('../x', { discover })).reason, 'invalid-identifier');
});

test('a Pi whose /api/status disagrees with its broadcast is rejected', async () => {
  statusPayload = status({ pi_username: 'someoneelse' });
  const r = await findPi('ns001', { discover: async () => [announce()], mdnsFallback: noMdns });
  assert.equal(r.found, false);
});

test('several Pis share a username: the customer chooses by hostname', async () => {
  statusPayload = status();
  const r = await findPi('nsignage', {
    discover: async () => [announce(), announce({ hostname: 'ns002', deviceId: 'fedcba9876543210' })],
    mdnsFallback: noMdns,
  });
  assert.equal(r.found, true);
  assert.equal(r.multiple, true);
  assert.deepEqual(r.devices.map((d) => d.hostname).sort(), ['ns001', 'ns002']);
  const one = await findPi('ns002', { discover: async () => [announce(), announce({ hostname: 'ns002', deviceId: 'fedcba9876543210' })], mdnsFallback: noMdns });
  assert.equal(one.devices.length, 1);
  assert.equal(one.deviceId, 'fedcba9876543210');
});

test('mDNS fallback runs only when no Pi answers UDP; its candidate is confirmed by the Pi (username or hostname)', async () => {
  let fallbackCalls = 0;
  statusPayload = status();
  const viaMdns = await findPi('ns001', {
    discover: async () => [],
    mdnsFallback: async (name, log) => {
      fallbackCalls += 1;
      const v = await verifyMdnsCandidate({ ip: '127.0.0.1', port, method: 'mdns-hostname', hostname: 'ns001.local' }, name, log);
      return v ? [v] : [];
    },
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(viaMdns.found, true);
  assert.equal(viaMdns.hostname, 'ns001');
  assert.equal((await verifyMdnsCandidate({ ip: '127.0.0.1', port, method: 'mdns-hostname' }, 'ns001')).hostname, 'ns001');
  assert.equal((await verifyMdnsCandidate({ ip: '127.0.0.1', port, method: 'mdns-hostname' }, 'nsignage')).username, 'nsignage');
  assert.equal(await verifyMdnsCandidate({ ip: '127.0.0.1', port, method: 'mdns-hostname' }, 'ns999'), null, 'name not confirmed by the Pi');
  statusPayload = null; // Pi not answering
  assert.equal(await verifyMdnsCandidate({ ip: '127.0.0.1', port, method: 'mdns-hostname' }, 'ns001'), null);
});

test('helper HTTP endpoint rejects an invalid Pi Name', async () => {
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
  await discoveryRequestHandler({ method: 'GET', url: '/find?identifier=a%20b', headers: {} }, res, () => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.reason, 'invalid-identifier');
});

test('a reply from the real Pi responder parses, including its hostname', { skip: !python && 'Python not installed' }, () => {
  const code = [
    'import sys, types, os, json',
    `sys.path.insert(0, ${JSON.stringify(path.resolve('N-Signage/app'))})`,
    "fake = types.ModuleType('pwd'); fake.getpwuid = lambda uid: types.SimpleNamespace(pw_name='nsignage')",
    "sys.modules.setdefault('pwd', fake); os.geteuid = getattr(os, 'geteuid', lambda: 1000)",
    'import device_identity',
    "device_identity.get_hostname = lambda: 'ns001'",
    "device_identity.get_local_ip_for = lambda ip, port=9: '192.168.1.50'",
    'import discovery_responder as d',
    "sys.stdout.write(d.build_response('a' * 32, '192.168.1.10', 40000).decode())",
  ].join('\n');
  const r = spawnSync(python, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pi = parseAnnounce(Buffer.from(r.stdout), { address: '192.168.1.50' }, 'a'.repeat(32), []);
  assert.ok(pi, r.stdout);
  assert.equal(pi.hostname, 'ns001');
  assert.equal(pi.username, 'nsignage');
  assert.equal(piNameMatch('ns001', pi), 'hostname');
});
