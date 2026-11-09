// Add Device → Pi Name → Find IP, end to end on the HOSTED path, with the REAL
// Pi agent (N-Signage/app/cloud_agent.py) checking in over HTTP:
//   - the customer finds the Pi by its hostname or its Linux username (not by
//     nickname), the IP shown is the one the Pi reports, Add Device claims it;
//   - the agent shows no pairing code and never calls the pairing endpoint;
//   - a second customer can neither claim nor see the display;
//   - a Wi-Fi change (new public network) needs no new registration.
// Database: in-process PostgreSQL (npm test) or a real Supabase TEST project
// (npm run test:supabase). Needs Python 3.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setupEnv, Client, footprint, deleteFootprint } from './helpers/harness.js';

const NET_A = '198.51.100.91';
const NET_B = '203.0.113.45';
footprint.ips.add(NET_A);
footprint.ips.add(NET_B);
const REMOTE = Boolean(process.env.TEST_DATABASE_URL);
const AGENT_SECONDS = REMOTE ? 150 : 40;
const WAIT_MS = REMOTE ? 90000 : 20000;
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

let database; let server; let db; let baseUrl; let work;
let auth; let devices; let device; let find; let sync; let pairing; let transfer;
let piNetwork = NET_A;      // public address the simulated Pi's requests come from
let pairingCalls = 0;
const deviceId = crypto.randomBytes(8).toString('hex');
const users = [];

before(async () => {
  database = await setupEnv();
  db = await import('../api/_lib/db.js');
  ({ default: auth } = await import('../api/auth.js'));
  ({ default: devices } = await import('../api/devices.js'));
  ({ default: device } = await import('../api/device.js'));
  ({ default: find } = await import('../api/find.js'));
  ({ default: sync } = await import('../api/pi/sync.js'));
  ({ default: pairing } = await import('../api/pi/pairing.js'));
  ({ default: transfer } = await import('../api/transfer.js'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nsignage-findip-'));
  fs.writeFileSync(path.join(work, 'blobmap.json'), '{}');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/pi/pairing') pairingCalls += 1;
      const handler = { '/api/pi/sync': sync, '/api/pi/pairing': pairing }[u.pathname];
      if (!handler) { res.statusCode = 404; res.end(); return; }
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = JSON.parse(raw || '{}'); } catch { req.body = raw; }
      req.headers['x-real-ip'] = piNetwork;
      await handler(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (database?.external) {
    await db.asSystem(async (t) => {
      const ids = users.filter(Boolean);
      await t`delete from nsignage.transfers where device_id = ${deviceId}`;
      await t`delete from nsignage.devices where id = ${deviceId}`;
      await t`delete from nsignage.users where id = any(${ids}::uuid[])`;
      await deleteFootprint(t, { userIds: ids, deviceIds: [deviceId] });
    });
  }
  await db?.closeDb();
  await database?.close();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = WAIT_MS) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout');
    await sleep(300);
  }
}

async function customer(name, ip) {
  const c = new Client(name, ip);
  const r = await c.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: name, password: 'find ip test password' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return c;
}

function startAgent() {
  const proc = spawn(python, [path.resolve('tests/helpers/run_legacy_agent.py')], {
    env: { ...process.env, CLOUD_URL: baseUrl, WORKDIR: work, BLOB_MAP: path.join(work, 'blobmap.json'), DURATION: String(AGENT_SECONDS), DEVICE_ID: deviceId, PI_HOSTNAME: 'ns001', PYTHONUNBUFFERED: '1' },
  });
  const events = [];
  let out = '';
  proc.stdout.on('data', (d) => {
    out += d;
    for (const line of out.split('\n').slice(0, -1)) { try { events.push(JSON.parse(line)); } catch { /* log line */ } }
    out = out.split('\n').pop();
  });
  const exited = new Promise((r) => proc.on('exit', r));
  return { proc, events, stop: async () => { proc.kill(); await exited; } };
}

const findIp = (c, piName) => c.call(find, { query: { identifier: piName } });

test('Add Device → Pi Name → Find IP with the real agent: hostname or username, nickname only a label, one owner, no pairing code, survives a Wi-Fi change', {
  timeout: (AGENT_SECONDS * 2 + 120) * 1000, skip: !python && 'Python not installed',
}, async () => {
  let agent = startAgent();
  try {
    const start = await waitFor(() => agent.events.find((e) => e.event === 'start'));
    assert.equal(start.deviceId, deviceId);
    const alice = await customer(`findip-alice-${deviceId.slice(0, 6)}`, NET_A);

    // Find IP by hostname (and by username, case-insensitive); the IP is the Pi's own report
    const byHost = await waitFor(async () => (await findIp(alice, 'ns001')).body.devices?.find((d) => d.deviceId === deviceId));
    assert.equal(byHost.matchedBy, 'hostname');
    assert.equal(byHost.hostname, 'ns001');
    assert.equal(byHost.username, 'nsignage');
    assert.equal(byHost.online, true);
    assert.equal(byHost.ownership, 'available');
    assert.ok(byHost.claimNonce);
    const [row] = await db.asSystem((t) => t`select host(local_ip) as ip, capabilities from nsignage.devices where id = ${deviceId}`);
    assert.equal(byHost.ip, row.ip, 'IP detected from the Pi, not typed');
    const byUser = (await findIp(alice, 'NSignage')).body.devices.find((d) => d.deviceId === deviceId);
    assert.equal(byUser.matchedBy, 'username');
    // The nickname is never a search key; an unknown name finds nothing and says so
    const miss = await findIp(alice, 'Main-Lobby');
    assert.equal(miss.body.found, false);
    assert.equal(miss.body.reason, 'not-found');
    assert.ok(miss.body.otherCount >= 1, 'the not-found answer tells that other Pis are on this network');
    assert.equal((await findIp(alice, '../etc')).status, 400);

    // No pairing code anywhere on the Pi
    assert.ok(!row.capabilities.includes('pairing'));
    assert.ok(!fs.existsSync(path.join(work, 'data', 'pairing.json')));

    // Add Device with the optional nickname
    const ok = await alice.call(devices, { method: 'POST', body: { claimNonce: byHost.claimNonce, name: 'Main Lobby Display' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.device.deviceId, deviceId);
    assert.equal(ok.body.device.name, 'Main Lobby Display');
    assert.equal(ok.body.device.registration, 'verified');
    // The search token was single use
    assert.equal((await alice.call(devices, { method: 'POST', body: { claimNonce: byHost.claimNonce } })).status, 410);

    // Bob on the same Wi-Fi sees the display only as "another account": no IP, no token, no access
    const bob = await customer(`findip-bob-${deviceId.slice(0, 6)}`, NET_A);
    const seen = (await findIp(bob, 'ns001')).body.devices.find((d) => d.deviceId === deviceId);
    assert.equal(seen.ownership, 'other');
    assert.equal(seen.claimNonce, undefined);
    assert.equal(seen.ip, undefined);
    assert.deepEqual((await bob.call(devices)).body.devices, []);
    assert.equal((await bob.call(device, { query: { deviceId, action: 'status' } })).status, 404);
    assert.equal((await bob.call(devices, { method: 'DELETE', query: { deviceId } })).status, 404);

    // Wi-Fi change: the same Pi (same identity + secret) now checks in from another network
    await agent.stop();
    piNetwork = NET_B;
    agent = startAgent();
    await waitFor(async () => {
      const [r] = await db.asSystem((t) => t`select count(*)::int as n from nsignage.device_network_sightings where device_id = ${deviceId} and net_key = ${NET_B}`);
      return r.n > 0;
    });
    const list = (await alice.call(devices)).body.devices;
    assert.equal(list.length, 1);
    assert.equal(list[0].deviceId, deviceId);
    assert.equal(list[0].name, 'Main Lobby Display', 'still registered, nickname kept: no new registration');
    assert.equal(list[0].online, true);
    // Sending files needs the separate upload receiver (not installed on this simulated Pi): a clear answer, still the owner
    const sha = crypto.createHash('sha256').update('x').digest('hex');
    const epk = Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url');
    const tr = await alice.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId, filename: 'menu.jpg', size: 10, sha256: sha, epk } });
    assert.equal(tr.status, 409); assert.equal(tr.body.reason, 'no-receiver');
    assert.equal(pairingCalls, 0, 'the agent never requested a pairing code');
  } finally {
    await agent.stop();
  }
});
