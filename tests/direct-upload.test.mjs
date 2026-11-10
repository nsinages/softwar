// Direct, end-to-end encrypted upload, end to end:
//   browser code (shared/e2eCrypto.js + shared/directUpload.js, WebCrypto in Node)
//   → the REAL receiver (N-Signage/upload-receiver/receiver.py, separate process)
//   ← website API handlers (tickets, receiver heartbeat/check/result) on PostgreSQL.
// The Cloudflare Tunnel is replaced by a plain local connection (fetch is pointed at
// 127.0.0.1); everything else is the production code path.
// Proves: the website never receives media bytes; only ciphertext is on the wire; size +
// SHA-256 verified on the Pi; resume after a cut connection and a receiver restart (new key);
// cancel stops the Pi from saving; offline and key-change states refuse up front; customers
// are isolated. Needs Python 3 with the "cryptography" package.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setupEnv, Client, footprint, deleteFootprint } from './helpers/harness.js';
import { createUploadSession, deriveChunkKey } from '../shared/e2eCrypto.js';
import { uploadChunks, probeReceiver, TransferError } from '../shared/directUpload.js';

const IP = '198.51.100.160';
footprint.ips.add(IP);
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import cryptography']).status === 0);
const DEV = crypto.randomBytes(8).toString('hex');
const SECRET = crypto.randomBytes(32).toString('base64url');
const HOST = `p-${crypto.randomBytes(8).toString('hex')}.nsinages.in`;
const ORIGIN = 'https://software.nsinages.in';
const MiB = 1024 * 1024;

let database; let db; let api; let apiUrl; let home; let syncTimer;
let auth; let devices; let find; let sync; let receiverApi; let transfer;
let receiver = null; let receiverPort = 0; let receiverOut = '';
const apiBytes = { pi: 0, browser: 0 };
const users = [];

before(async () => {
  database = await setupEnv();
  db = await import('../api/_lib/db.js');
  ({ default: auth } = await import('../api/auth.js'));
  ({ default: devices } = await import('../api/devices.js'));
  ({ default: find } = await import('../api/find.js'));
  ({ default: sync } = await import('../api/pi/sync.js'));
  ({ default: receiverApi } = await import('../api/pi/receiver.js'));
  ({ default: transfer } = await import('../api/transfer.js'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-direct-'));
  fs.mkdirSync(path.join(home, 'media'));
  fs.mkdirSync(path.join(home, 'data'));
  fs.writeFileSync(path.join(home, 'data', 'device_identity.json'), JSON.stringify({ device_id: DEV }));
  fs.writeFileSync(path.join(home, 'data', 'cloud_secret'), SECRET);
  // The website, as the Pi sees it (sync from the V2.1 agent, receiver calls)
  api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; apiBytes.pi += c.length; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      const handler = { '/api/pi/sync': sync, '/api/pi/receiver': receiverApi }[u.pathname];
      if (!handler) { res.statusCode = 404; res.end(); return; }
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = JSON.parse(raw || '{}'); } catch { req.body = raw; }
      req.headers['x-real-ip'] = IP;
      await handler(req, res);
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

after(async () => {
  clearInterval(syncTimer);
  await stopReceiver();
  api?.close();
  if (database?.external) {
    await db.asSystem(async (t) => {
      await t`delete from nsignage.transfers where device_id = ${DEV}`;
      await t`delete from nsignage.devices where id = ${DEV}`;
      await t`delete from nsignage.users where id = any(${users}::uuid[])`;
      await deleteFootprint(t, { userIds: users, deviceIds: [DEV] });
    });
  }
  await db?.closeDb();
  await database?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

// The installed V2.1 agent's check-in (only what the website needs)
const piSync = () => fetch(`${apiUrl}/api/pi/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ deviceId: DEV, username: 'ns', hostname: 'ns', localIp: '192.168.137.98', port: 5000, media: [], agentVersion: '2.0-ns1', protocol: 2, capabilities: ['sha256', 'range-resume', 'progress', 'storage'], results: [] }),
});

async function startReceiver() {
  receiverOut = '';
  receiver = spawn(python, [path.resolve('N-Signage/upload-receiver/receiver.py')], {
    env: { ...process.env, NSIGNAGE_HOME: home, NSIGNAGE_CLOUD_URL: apiUrl, NSIGNAGE_UPLOAD_ALLOW_HTTP_CLOUD: '1', NSIGNAGE_UPLOAD_HOSTNAME: HOST, NSIGNAGE_UPLOAD_PORT: '0', PYTHONUNBUFFERED: '1' },
  });
  receiver.stdout.on('data', (d) => { receiverOut += d; });
  receiver.stderr.on('data', (d) => { receiverOut += d; });
  const until = Date.now() + 20000;
  for (;;) {
    const m = /"event": "listening", "port": (\d+), "fingerprint": "([0-9a-f]{64})"/.exec(receiverOut);
    if (m) { receiverPort = Number(m[1]); return m[2]; }
    if (Date.now() > until) throw new Error(`receiver did not start\n${receiverOut}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stopReceiver() {
  if (!receiver) return;
  const p = receiver; receiver = null;
  p.kill();
  await new Promise((r) => (p.exitCode !== null ? r() : p.on('exit', r)));
}

/** The browser's fetch, with https://<HOST> sent to the local receiver (the tunnel's job in production). */
function tunnelFetch({ cutAfterPuts = Infinity, wire = [] } = {}) {
  let puts = 0;
  return async (url, init) => {
    const target = url.replace(`https://${HOST}`, `http://127.0.0.1:${receiverPort}`);
    if (target === url) throw new Error(`unexpected upload URL ${url}`);
    if (init.method === 'PUT') {
      if (puts >= cutAfterPuts) throw new TypeError('network connection lost');
      puts += 1;
      wire.push({ index: Number(url.split('/').pop()), body: Buffer.from(init.body) });
    }
    return fetch(target, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  };
}

const call = (client, action, body, method = 'POST') => {
  if (body) apiBytes.browser += JSON.stringify(body).length;
  return client.call(transfer, method === 'GET' ? { query: { action, ...body } } : { method, query: { action }, body });
};

async function customer(name) {
  const c = new Client(name, IP);
  const r = await c.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: name, password: 'direct upload test pw' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return c;
}

/** Browser flow: target → one-time key → create (or ticket) → encrypt + upload. */
async function browserSend(owner, bytes, filename, { fetchImpl = tunnelFetch(), transferId = null } = {}) {
  const target = (await call(owner, 'target', { deviceId: DEV }, 'GET')).body.receiver;
  const session = await createUploadSession({ receiverPublicKey: target.publicKey, deviceId: DEV });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const started = transferId
    ? await call(owner, 'ticket', { transferId, epk: session.epk })
    : await call(owner, 'create', { deviceId: DEV, filename, size: bytes.length, sha256, epk: session.epk });
  if (started.status !== 200) return { started };
  const tr = started.body.transfer;
  const keyed = await deriveChunkKey(session, tr.id);
  const renew = async () => (await call(owner, 'ticket', { transferId: tr.id, epk: session.epk })).body.ticket;
  try {
    const result = await uploadChunks({
      file: new Blob([bytes]), transfer: { id: tr.id, size: tr.size, sha256: tr.sha256 }, ticket: started.body.ticket,
      uploadUrl: started.body.uploadUrl, chunkBytes: started.body.chunkBytes, keyed, renew, fetchImpl, delays: [],
    });
    return { started, tr, result };
  } catch (error) {
    return { started, tr, error };
  }
}

const status = async (owner, id) => (await call(owner, 'status', { id }, 'GET')).body.transfer;
const mediaFiles = () => fs.readdirSync(path.join(home, 'media')).sort();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let alice;

test('setup: V2.1 check-in, Find IP claim, receiver heartbeat pins its public key', { skip: !python && 'Python + cryptography not installed', timeout: 60000 }, async () => {
  assert.equal((await piSync()).status, 200);
  syncTimer = setInterval(() => { piSync().catch(() => {}); }, 5000);
  alice = await customer(`direct-a-${DEV.slice(0, 6)}`);
  const found = (await alice.call(find, { query: { identifier: 'ns' } })).body.devices.find((d) => d.deviceId === DEV);
  assert.equal((await alice.call(devices, { method: 'POST', body: { claimNonce: found.claimNonce } })).status, 200);
  const fingerprint = await startReceiver();
  const target = await (async () => {
    for (let i = 0; i < 50; i += 1) {
      const t = (await call(alice, 'target', { deviceId: DEV }, 'GET')).body.receiver;
      if (t?.online) return t;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`receiver never came online\n${receiverOut}`);
  })();
  assert.equal(target.url, `https://${HOST}`);
  assert.equal(target.fingerprint, fingerprint, 'the website pinned exactly the key the Pi generated');
  assert.equal(target.keyChangePending, false);
  assert.equal(target.status, 'ready');
  // the browser's own check through the "tunnel" against the REAL receiver
  assert.equal((await probeReceiver(target, { fetchImpl: tunnelFetch() })).ok, true);
  const foreign = (url, init) => fetch(url.replace(`https://${HOST}`, `http://127.0.0.1:${receiverPort}`), { ...init, headers: { Origin: 'https://evil.example' } });
  assert.equal((await probeReceiver(target, { fetchImpl: foreign })).reason, 'origin-mismatch');
  assert.equal((await probeReceiver({ ...target, fingerprint: 'f'.repeat(64) }, { fetchImpl: tunnelFetch() })).reason, 'wrong-receiver');
});

test('a 10 MB video goes browser → Pi encrypted; the website and the wire never carry the plaintext', { skip: !python && 'no python', timeout: 120000 }, async () => {
  const bytes = crypto.randomBytes(10 * MiB + 4321);
  const wire = [];
  const before = { ...apiBytes };
  const { result, tr, error } = await browserSend(alice, bytes, 'Promo Video.mp4', { fetchImpl: tunnelFetch({ wire }) });
  assert.ifError(error);
  assert.equal(result.done, true);
  assert.equal(result.savedAs, 'Promo Video.mp4');
  assert.equal(sha(fs.readFileSync(path.join(home, 'media', 'Promo Video.mp4'))), sha(bytes), 'identical bytes on the Pi');
  assert.deepEqual(mediaFiles().filter((f) => f.startsWith('.')), [], 'no partial file left');
  const t = await status(alice, tr.id);
  assert.equal(t.state, 'completed'); assert.equal(t.verified, true); assert.equal(t.method, 'direct'); assert.equal(t.savedAs, 'Promo Video.mp4');
  // only ciphertext on the wire: no 64-byte window of the file appears in any chunk body
  assert.deepEqual(wire.map((w) => w.index), [0, 1, 2]);
  for (const off of [0, 5 * MiB, bytes.length - 64]) {
    const sample = bytes.subarray(off, off + 64);
    assert.ok(!wire.some((w) => w.body.includes(sample)), `plaintext at ${off} not visible on the wire`);
  }
  // the website received only small JSON (tickets, metadata, receiver reports)
  const toWebsite = (apiBytes.pi - before.pi) + (apiBytes.browser - before.browser);
  assert.ok(toWebsite < 64 * 1024, `website received ${toWebsite} bytes for a ${bytes.length}-byte file`);
  const [{ n }] = await db.asSystem((t2) => t2`select count(*)::int as n from information_schema.columns where table_schema = 'nsignage' and data_type = 'bytea'`);
  assert.equal(n, 0, 'no binary column anywhere in the website database');
});

test('resume: connection cut after chunk 0, receiver restarted, page reloaded (new browser key) → continues at chunk 1', { skip: !python && 'no python', timeout: 120000 }, async () => {
  const bytes = crypto.randomBytes(9 * MiB);
  const first = await browserSend(alice, bytes, 'resume.mp4', { fetchImpl: tunnelFetch({ cutAfterPuts: 1 }) });
  assert.ok(first.error instanceof TransferError); assert.equal(first.error.reason, 'network');
  assert.equal((await status(alice, first.tr.id)).state, 'created');
  await stopReceiver();
  await startReceiver();
  const wire = [];
  const again = await browserSend(alice, bytes, 'resume.mp4', { transferId: first.tr.id, fetchImpl: tunnelFetch({ wire }) });
  assert.ifError(again.error);
  assert.deepEqual(wire.map((w) => w.index), [1, 2], 'chunk 0 was not sent again');
  assert.equal(sha(fs.readFileSync(path.join(home, 'media', again.result.savedAs))), sha(bytes));
  assert.equal((await status(alice, first.tr.id)).state, 'completed');
});

test('cancel: the Pi asks the website before saving and discards the file', { skip: !python && 'no python', timeout: 120000 }, async () => {
  const bytes = crypto.randomBytes(5 * MiB);
  const before = mediaFiles();
  const target = (await call(alice, 'target', { deviceId: DEV }, 'GET')).body.receiver;
  const session = await createUploadSession({ receiverPublicKey: target.publicKey, deviceId: DEV });
  const c = await call(alice, 'create', { deviceId: DEV, filename: 'cancelled.mp4', size: bytes.length, sha256: sha(bytes), epk: session.epk });
  const keyed = await deriveChunkKey(session, c.body.transfer.id);
  const tr = { id: c.body.transfer.id, size: bytes.length, sha256: sha(bytes) };
  const common = { file: new Blob([bytes]), transfer: tr, ticket: c.body.ticket, uploadUrl: c.body.uploadUrl, chunkBytes: c.body.chunkBytes, keyed, renew: async () => c.body.ticket, delays: [] };
  await assert.rejects(uploadChunks({ ...common, fetchImpl: tunnelFetch({ cutAfterPuts: 1 }) }));
  assert.equal((await call(alice, 'cancel', { transferId: tr.id })).body.transfer.state, 'cancelled');
  const err = await uploadChunks({ ...common, fetchImpl: tunnelFetch() }).catch((e) => e);
  assert.equal(err.reason, 'not-allowed', 'the still-valid ticket is not enough: the website said no');
  assert.deepEqual(mediaFiles(), before, 'nothing saved, partial file removed');
  assert.equal((await call(alice, 'ticket', { transferId: tr.id, epk: session.epk })).status, 409, 'a cancelled transfer cannot be resumed');
});

test('isolation: another customer cannot see the receiver, start, resume or read a transfer', { skip: !python && 'no python', timeout: 60000 }, async () => {
  const bob = await customer(`direct-b-${DEV.slice(0, 6)}`);
  const session = await createUploadSession({ receiverPublicKey: (await call(alice, 'target', { deviceId: DEV }, 'GET')).body.receiver.publicKey, deviceId: DEV });
  assert.equal((await call(bob, 'target', { deviceId: DEV }, 'GET')).status, 404);
  assert.equal((await call(bob, 'create', { deviceId: DEV, filename: 'x.mp4', size: 10, sha256: sha('x'), epk: session.epk })).status, 404);
  const list = (await call(alice, 'list', {}, 'GET')).body.transfers;
  assert.equal((await call(bob, 'ticket', { transferId: list[0].id, epk: session.epk })).status, 404);
  assert.equal((await call(bob, 'status', { id: list[0].id }, 'GET')).status, 404);
  assert.ok(!JSON.stringify(list).includes(HOST) && !JSON.stringify(list).includes('nst1.'), 'lists carry no hostnames or tickets');
});

test('offline display: refused up front, nothing created; key change: refused until the owner confirms the fingerprint', { skip: !python && 'no python', timeout: 120000 }, async () => {
  await stopReceiver();
  const stopped = await probeReceiver({ url: `https://${HOST}`, fingerprint: 'f'.repeat(64) }, { fetchImpl: tunnelFetch(), timeoutMs: 3000 });
  assert.equal(stopped.ok, false); assert.equal(stopped.reason, 'tunnel-unreachable', 'a stopped receiver is never reported as "not installed"');
  await db.asSystem((t) => t`update nsignage.device_receivers set last_seen_at = now() - interval '10 minutes' where device_id = ${DEV}`);
  const session = await createUploadSession({ receiverPublicKey: (await call(alice, 'target', { deviceId: DEV }, 'GET')).body.receiver.publicKey, deviceId: DEV });
  const off = await call(alice, 'create', { deviceId: DEV, filename: 'offline.mp4', size: 100, sha256: sha('o'), epk: session.epk });
  assert.equal(off.status, 409); assert.ok(['receiver-offline', 'display-offline'].includes(off.body.reason), off.body.reason);
  assert.ok(!(await call(alice, 'list', {}, 'GET')).body.transfers.some((t) => t.filename === 'offline.mp4'), 'no transfer record, nothing uploaded');

  fs.rmSync(path.join(home, 'data', 'upload', 'receiver_key.pem'));       // e.g. SD card restored without the key
  const newFingerprint = await startReceiver();
  let target;
  for (let i = 0; i < 50; i += 1) {
    target = (await call(alice, 'target', { deviceId: DEV }, 'GET')).body.receiver;
    if (target.keyChangePending) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(target.keyChangePending, true);
  assert.equal(target.pendingFingerprint, newFingerprint);
  const s2 = await createUploadSession({ receiverPublicKey: target.publicKey, deviceId: DEV });
  const blocked = await call(alice, 'create', { deviceId: DEV, filename: 'k.mp4', size: 100, sha256: sha('k'), epk: s2.epk });
  assert.equal(blocked.body.reason, 'key-change-pending');
  assert.equal((await call(alice, 'confirm-key', { deviceId: DEV, fingerprint: '0'.repeat(64) })).status, 409);
  assert.equal((await call(alice, 'confirm-key', { deviceId: DEV, fingerprint: newFingerprint })).status, 200);
  const bytes = crypto.randomBytes(300_000);
  const sent = await browserSend(alice, bytes, 'after-key-change.jpg');
  assert.ifError(sent.error);
  assert.equal(sha(fs.readFileSync(path.join(home, 'media', sent.result.savedAs))), sha(bytes));
});
