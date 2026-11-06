// Pi agent 1.1 pairing, end to end: the REAL cloud_agent.py (N-Signage/app)
// syncs with the API, fetches a one-time pairing code, writes it for the local
// player; a customer adds the display with that code; the agent learns it is
// registered and removes the code. Also checks the player's /api/pairing route
// (loopback only, no CORS) with Flask's test client.
// Database: in-process PostgreSQL (npm test) or a real Supabase TEST project
// (npm run test:supabase). Needs Python 3 (+ Flask for the route check).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setupEnv, Client, footprint, deleteFootprint } from './helpers/harness.js';

const IP = '198.51.100.91';
footprint.ips.add(IP);
const REMOTE = Boolean(process.env.TEST_DATABASE_URL);
const AGENT_SECONDS = REMOTE ? 150 : 40;
const WAIT_MS = REMOTE ? 90000 : 20000;
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const flask = python && spawnSync(python, ['-c', 'import flask']).status === 0;

let database; let server; let db; let baseUrl; let work;
let auth; let devices; let device; let sync; let pairing;
const deviceId = crypto.randomBytes(8).toString('hex');
const users = [];

before(async () => {
  database = await setupEnv();
  db = await import('../api/_lib/db.js');
  ({ default: auth } = await import('../api/auth.js'));
  ({ default: devices } = await import('../api/devices.js'));
  ({ default: device } = await import('../api/device.js'));
  ({ default: sync } = await import('../api/pi/sync.js'));
  ({ default: pairing } = await import('../api/pi/pairing.js'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nsignage-pairing-'));
  fs.writeFileSync(path.join(work, 'blobmap.json'), '{}');
  // Real HTTP endpoint for the Python agent (Vercel handler shape)
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      const handler = { '/api/pi/sync': sync, '/api/pi/pairing': pairing }[u.pathname];
      if (!handler) { res.statusCode = 404; res.end(); return; }
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = JSON.parse(raw || '{}'); } catch { req.body = raw; }
      req.headers['x-real-ip'] = IP;
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
const pairingFile = () => path.join(work, 'data', 'pairing.json');
const readPairing = () => { try { return JSON.parse(fs.readFileSync(pairingFile(), 'utf8')); } catch { return null; } };

async function customer(name) {
  const c = new Client(name, IP);
  const r = await c.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: name, password: 'pairing test password' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return c;
}

test('agent 1.1: shows a pairing code until a customer adds the display, then removes it', { timeout: (AGENT_SECONDS + 90) * 1000, skip: !python && 'Python not installed' }, async () => {
  const proc = spawn(python, [path.resolve('tests/helpers/run_legacy_agent.py')], {
    env: { ...process.env, CLOUD_URL: baseUrl, WORKDIR: work, BLOB_MAP: path.join(work, 'blobmap.json'), DURATION: String(AGENT_SECONDS), DEVICE_ID: deviceId, PYTHONUNBUFFERED: '1' },
  });
  let out = ''; let stderr = ''; const events = [];
  proc.stdout.on('data', (d) => {
    out += d;
    for (const line of out.split('\n').slice(0, -1)) { try { events.push(JSON.parse(line)); } catch { /* log line */ } }
    out = out.split('\n').pop();
  });
  proc.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => proc.on('exit', r));
  try {
    const start = await waitFor(() => events.find((e) => e.event === 'start'));
    assert.equal(start.agentVersion, '1.1');
    assert.equal(start.deviceId, deviceId);

    // 1. Unregistered Pi: a code appears for the screen, the agent announced 'pairing'
    const shown = await waitFor(() => { const p = readPairing(); return p?.state === 'code' && p; });
    assert.match(shown.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(shown.expiresAt > Date.now() + 8 * 60_000, 'valid ~10 minutes');
    const [row] = await db.asSystem((t) => t`select capabilities, agent_version, owner_id from nsignage.devices where id = ${deviceId}`);
    assert.deepEqual(row.capabilities, ['pairing']);
    assert.equal(row.agent_version, '1.1');
    assert.equal(row.owner_id, null);
    assert.ok(!stderr.includes(shown.code) && !events.some((e) => JSON.stringify(e).includes(shown.code)), 'code is never logged');

    // 2. Wrong code and someone else's attempt with a wrong code do nothing
    const alice = await customer(`pair-alice-${deviceId.slice(0, 6)}`);
    const bad = await alice.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: 'ZZZZ-ZZZZ' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.reason, 'bad-pair-code');

    // 3. Customer adds the display with the code read from the screen
    const ok = await alice.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: shown.code, name: 'Shop Display 01' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.device.deviceId, deviceId);
    const list = await alice.call(devices);
    assert.deepEqual(list.body.devices.map((d) => [d.deviceId, d.name, d.registration]), [[deviceId, 'Shop Display 01', 'verified']]);

    // 4. The agent learns it is registered: code removed from the file (and the screen)
    await waitFor(() => readPairing()?.state === 'registered');
    assert.ok(!fs.readFileSync(pairingFile(), 'utf8').includes(shown.code));

    // 5. The used code cannot be reused by anyone; the Pi gets no new code while owned
    const bob = await customer(`pair-bob-${deviceId.slice(0, 6)}`);
    const reuse = await bob.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: shown.code } });
    assert.equal(reuse.status, 400);
    const secret = fs.readFileSync(path.join(work, 'data', 'cloud_secret'), 'utf8').trim();
    const pi = new Client('pi', IP);
    const again = await pi.call(pairing, { method: 'POST', body: { deviceId }, headers: { authorization: `Bearer ${secret}` }, origin: null });
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, 'already-registered');

    // 6. Bob can neither see nor change Alice's display
    assert.deepEqual((await bob.call(devices)).body.devices, []);
    assert.equal((await bob.call(device, { query: { deviceId, action: 'status' } })).status, 404);
    assert.equal((await bob.call(devices, { method: 'PATCH', query: { deviceId }, body: { name: 'hijack' } })).status, 404);
    assert.equal((await bob.call(devices, { method: 'DELETE', query: { deviceId } })).status, 404);
    const [still] = await db.asSystem((t) => t`select nickname, owner_id from nsignage.devices where id = ${deviceId}`);
    assert.equal(still.nickname, 'Shop Display 01');
    assert.equal(still.owner_id, users[0]);

    // 7. Removal from the account → the agent shows a fresh code again
    assert.equal((await alice.call(devices, { method: 'DELETE', query: { deviceId } })).status, 200);
    const fresh = await waitFor(() => { const p = readPairing(); return p?.state === 'code' && p; });
    assert.notEqual(fresh.code, shown.code);

    // 8. The player's local route
    if (flask) {
      const r = spawnSync(python, [path.resolve('tests/helpers/pairing_route_check.py')], { env: { ...process.env, DATA_DIR: path.join(work, 'data') }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const c = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.equal(c.agentFile.status, 200);
      assert.equal(c.agentFile.body.state, 'code');
      assert.equal(c.agentFile.body.code, fresh.code, 'player shows the code the agent fetched');
      assert.equal(c.agentFile.cors, null, 'no CORS on /api/pairing');
      assert.equal(c.agentFile.cache, 'no-store');
      assert.equal(c.lan.status, 403, 'other machines on the LAN cannot read the code');
      assert.ok(!JSON.stringify(c.lan.body).includes(fresh.code));
      assert.equal(c.ipv6Loopback.status, 200);
      assert.equal(c.expired.body.state, 'none', 'an expired code is never shown');
      assert.equal(c.valid.body.state, 'code');
      assert.equal(c.missing.body.state, 'none');
      assert.equal(c.statusCors, '*', 'other routes keep their CORS headers');
    }
  } finally {
    proc.kill();
    await exited;
    if (process.env.DEBUG_AGENT) console.log(stderr);
  }
});
