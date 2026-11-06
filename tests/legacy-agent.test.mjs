// Backward compatibility: the unmodified Pi agent 1.0 (cloud_agent.py) syncs
// with the new API (Supabase/PostgreSQL storage), receives a relay transfer, saves the file, and the website
// marks it completed (saved, not checksum-verified) and deletes the relay copy.
// Needs Python 3 on PATH ("python" or "python3"). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setupEnv, memoryBlob, Client, footprint, deleteFootprint } from './helpers/harness.js';

const IP = '198.51.100.77';
footprint.ips.add(IP); // the agent's own requests (not sent through Client) use this IP
// A remote database (real Supabase) is far slower than in-process PGlite: give the agent and the polls more time.
const REMOTE = Boolean(process.env.TEST_DATABASE_URL);
const AGENT_SECONDS = REMOTE ? 150 : 25;
const WAIT_MS = REMOTE ? 120000 : 20000;
let database; let server; let db; let baseUrl; let blob; let work;
let auth; let devices; let find; let sync; let transfer; let blobStore;

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

before(async () => {
  database = await setupEnv();
  db = await import('../api/_lib/db.js');
  ({ default: auth } = await import('../api/auth.js'));
  ({ default: devices } = await import('../api/devices.js'));
  ({ default: find } = await import('../api/find.js'));
  ({ default: sync } = await import('../api/pi/sync.js'));
  ({ default: transfer } = await import('../api/transfer.js'));
  blobStore = await import('../api/_lib/blobStore.js');
  blob = memoryBlob();
  blobStore.setBlobBackend(blob.backend);
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nsignage-agent-'));
  // Real HTTP endpoint for the Python agent, adapted to the Vercel handler shape
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/api/pi/sync') { res.statusCode = 404; res.end(); return; }
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = JSON.parse(raw || '{}'); } catch { req.body = raw; }
      req.headers['x-real-ip'] = IP;
      await sync(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (database?.external) {
    await db.asSystem(async (t) => {
      const [u] = await t`select id from nsignage.users where username = 'legacy.owner'`;
      if (u) {
        await t`delete from nsignage.transfers where user_id = ${u.id}`;
        await t`update nsignage.devices set owner_id = null, added_at = null, added_via = null where owner_id = ${u.id}`;
        await t`delete from nsignage.devices where id = ${agentDeviceId || ''}`;
        await t`delete from nsignage.users where id = ${u.id}`;
      }
      await deleteFootprint(t, { userIds: u ? [u.id] : [], deviceIds: agentDeviceId ? [agentDeviceId] : [] });
    });
  }
  await db?.closeDb();
  await database?.close();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});
let agentDeviceId = null;

const waitFor = async (fn, ms = WAIT_MS) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};

test('unmodified agent 1.0: find, claim, relay transfer, completion, copy deleted', { timeout: (AGENT_SECONDS + 60) * 1000, skip: !python && 'Python not installed' }, async () => {
  const mapFile = path.join(work, 'blobmap.json');
  fs.writeFileSync(mapFile, '{}');
  const proc = spawn(python, [path.resolve('tests/helpers/run_legacy_agent.py')], {
    env: { ...process.env, CLOUD_URL: baseUrl, WORKDIR: work, BLOB_MAP: mapFile, DURATION: String(AGENT_SECONDS), PYTHONUNBUFFERED: '1' },
  });
  const events = [];
  let out = '';
  proc.stdout.on('data', (d) => {
    out += d;
    for (const line of out.split('\n').slice(0, -1)) { try { events.push(JSON.parse(line)); } catch { /* agent log line */ } }
    out = out.split('\n').pop();
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => proc.on('exit', r));

  try {
    const start = await waitFor(() => events.find((e) => e.event === 'start'));
    assert.equal(start.agentVersion, '1.0');
    agentDeviceId = start.deviceId;

    const owner = new Client('owner', IP);
    const reg = await owner.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: 'legacy.owner', password: 'legacy owner password' } });
    assert.equal(reg.status, 200);
    const found = await waitFor(async () => (await owner.call(find)).body.devices?.find((d) => d.deviceId === start.deviceId));
    assert.equal(found.username, 'nsignage');
    assert.equal((await owner.call(devices, { method: 'POST', body: { claimNonce: found.claimNonce } })).status, 200);

    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300_000)]);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const c = await owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: start.deviceId, filename: 'Menu Board.jpg', size: bytes.length, sha256: sha } });
    assert.equal(c.status, 200);
    const url = blob.put(c.body.uploadPathname, bytes);
    const local = path.join(work, 'relay.bin');
    fs.writeFileSync(local, bytes);
    fs.writeFileSync(mapFile, JSON.stringify({ [url]: local }));
    const commit = await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: c.body.transfer.id, url } });
    assert.equal(commit.body.transfer.state, 'queued');

    const done = await waitFor(async () => {
      const s = await owner.call(transfer, { query: { action: 'status', id: c.body.transfer.id } });
      return ['completed', 'failed'].includes(s.body.transfer.state) && s.body.transfer;
    });
    assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.equal(done.verified, false, 'agent 1.0 cannot verify checksums');
    assert.equal(done.savedAs, 'Menu Board.jpg');
    assert.ok(!blob.blobs.has(url), 'relay copy deleted');
    const saved = fs.readFileSync(path.join(work, 'media', 'Menu Board.jpg'));
    assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), sha, 'bytes on the "Pi" match the original');
    assert.deepEqual(fs.readdirSync(path.join(work, 'media')).filter((f) => f.startsWith('.')), [], 'no temp files left');
  } finally {
    proc.kill();
    await exited;
    if (process.env.DEBUG_AGENT) console.log(stderr);
  }
});
