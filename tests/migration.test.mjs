// Redis → Supabase migration: export (read-only) → import → verify, then prove
// the migrated data works through the real API (Pi keeps its secret, old
// browser devices can be linked, migrated accounts can log in).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { startMockUpstash } from './helpers/mockUpstash.js';
import { setupEnv, memoryBlob, Client } from './helpers/harness.js';

let upstash; let database; let db; let mig; let blobStore;
let auth; let devices; let sync;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

before(async () => {
  upstash = await startMockUpstash();
  process.env.KV_REST_API_URL = upstash.url;
  process.env.KV_REST_API_READ_ONLY_TOKEN = 'read-only-token';
  process.env.UPSTASH_DISABLE_TELEMETRY = '1';
  database = await setupEnv();
  db = await import('../api/_lib/db.js');
  mig = await import('../scripts/lib/redisMigration.mjs');
  blobStore = await import('../api/_lib/blobStore.js');
  blobStore.setBlobBackend(memoryBlob().backend);
  ({ default: auth } = await import('../api/auth.js'));
  ({ default: devices } = await import('../api/devices.js'));
  ({ default: sync } = await import('../api/pi/sync.js'));
});
after(async () => {
  await db.closeDb();
  await database.close();
  upstash.close();
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_READ_ONLY_TOKEN;
});

test('empty Redis: inspect reports that no migration is necessary', async () => {
  const { redis, readOnly } = mig.redisFromEnv(Redis);
  assert.equal(readOnly, true, 'uses the read-only token');
  const counts = await mig.inspectRedis(redis);
  assert.equal(counts.totalNsKeys, 0);
});

test('Redis data is exported read-only, imported, verified, and works through the API', async () => {
  const s = upstash.store;
  const now = Date.now();
  // ---- Redis exactly as the previous versions stored it ----
  const piSecret = crypto.randomBytes(32).toString('base64url');
  const devA = crypto.randomBytes(8).toString('hex');   // legacy (anonymous browser) device
  const devB = crypto.randomBytes(8).toString('hex');   // owned by a Phase-2 Redis account
  const ip = '198.51.100.77';
  for (const [id, secret] of [[devA, piSecret], [devB, crypto.randomBytes(32).toString('base64url')]]) {
    s.exec(['set', `ns:dev:${id}`, JSON.stringify({
      deviceId: id, secretHash: sha(secret), username: 'nsignage', hostname: `pi-${id.slice(0, 4)}`, localIp: '192.168.1.20',
      port: 5000, media: [{ name: 'menu.jpg', size: 10, type: 'image' }], agentVersion: '1.0', firstSeen: now - 86400000, lastSeen: now - 1000,
    })]);
  }
  s.exec(['zadd', `ns:net:${ip}`, String(now - 1000), devA]);
  const legacyToken = crypto.randomBytes(32).toString('base64url');
  const browserId = crypto.randomUUID();
  s.exec(['set', `ns:sess:${sha(legacyToken)}`, JSON.stringify({ id: browserId, createdAt: now - 5000 })]);
  s.exec(['sadd', `ns:owners:${devA}`, browserId]);
  s.exec(['hset', `ns:browser-devs:${browserId}`, devA, JSON.stringify({ name: 'Reception', location: 'Lobby', addedAt: now - 4000 })]);
  // a pair the browser had removed (not in the owner set) must not be imported
  s.exec(['hset', `ns:browser-devs:${browserId}`, devB, JSON.stringify({ name: 'Removed', addedAt: now - 4000 })]);
  const cmdId = crypto.randomUUID();
  const oldCopy = 'https://store1.public.blob.vercel-storage.com/media/x/menu-abc.jpg';
  s.exec(['hset', `ns:blob:${devA}`, cmdId, JSON.stringify({ url: oldCopy, filename: 'menu.jpg' })]);
  s.exec(['hset', `ns:res:${devA}`, cmdId, JSON.stringify({ state: 'done', filename: 'menu.jpg' })]);
  s.exec(['rpush', `ns:cmd:${devA}`, JSON.stringify({ id: crypto.randomUUID(), type: 'delete', filename: 'old.jpg', createdAt: now })]);
  // Phase-2 Redis account (if that build had ever run)
  const { hashPassword } = await import('../api/_lib/password.js');
  const userId = crypto.randomUUID();
  s.exec(['set', `ns:user:${userId}`, JSON.stringify({
    id: userId, username: 'redis.customer', passwordHash: await hashPassword('migrated password 1'), recoveryHash: sha('x'), createdAt: now - 10000,
  })]);
  s.exec(['set', 'ns:username:redis.customer', userId]);
  s.exec(['set', `ns:dev-owner:${devB}`, userId]);
  s.exec(['hset', `ns:user-devs:${userId}`, devB, JSON.stringify({ name: 'Shop Display', location: 'Branch 02', addedAt: now - 3000 })]);
  s.exec(['set', 'ns:acct:old-email-account', JSON.stringify({ id: 'x', email: 'a@b.c' })]);
  s.exec(['set', 'ns:dev:not-a-valid-id', JSON.stringify({ username: 'x' })]);

  const before = s.snapshot();
  const issued = s.seen.length;
  const { redis } = mig.redisFromEnv(Redis);

  // ---- inspect / export ----
  const counts = await mig.inspectRedis(redis);
  assert.ok(counts.totalNsKeys > 0);
  assert.equal(counts.emailAccounts, 1);
  const snap = await mig.exportRedis(redis, { now });
  assert.equal(snap.devices.length, 2);
  assert.equal(snap.legacySessions.length, 1);
  assert.equal(snap.legacyBrowserDevices.length, 1, 'removed pair not exported');
  assert.equal(snap.users.length, 1);
  assert.equal(snap.ownership.length, 1);
  assert.equal(snap.legacyRelayCopies.length, 1);
  assert.equal(snap.pendingCommands.length, 1);
  assert.equal(snap.emailAccountsNotMigrated, 1);
  assert.ok(snap.skipped.some((x) => x.key === 'ns:dev:not-a-valid-id'));

  // ---- Redis untouched, only read commands used ----
  assert.equal(s.snapshot(), before, 'Redis data unchanged');
  const used = new Set(s.seen.slice(issued));
  const READ_ONLY = new Set(['scan', 'get', 'hget', 'hgetall', 'smembers', 'lrange', 'zrange']);
  assert.deepEqual([...used].filter((c) => !READ_ONLY.has(c)), [], `only read commands, got ${[...used]}`);

  // ---- import, verify, idempotent re-import ----
  const n1 = await mig.importSnapshot(db.asSystem, snap);
  assert.deepEqual(
    { users: n1.users, devices: n1.devices, ownership: n1.ownership, legacySessions: n1.legacySessions, legacyBrowserDevices: n1.legacyBrowserDevices, pendingCommands: n1.pendingCommands },
    { users: 1, devices: 2, ownership: 1, legacySessions: 1, legacyBrowserDevices: 1, pendingCommands: 1 },
  );
  const v = await mig.verifySnapshot(db.asSystem, snap);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  const n2 = await mig.importSnapshot(db.asSystem, snap);
  assert.ok(Object.values(n2).every((x) => x === 0), `re-import adds nothing: ${JSON.stringify(n2)}`);
  assert.equal((await mig.verifySnapshot(db.asSystem, snap)).ok, true);

  // ---- the migrated data works ----
  // 1. The Pi keeps authenticating with its existing secret (no Pi change needed) and gets its pending command
  const pi = new Client('pi', ip);
  const synced = await pi.call(sync, { method: 'POST', origin: null, headers: { authorization: `Bearer ${piSecret}` },
    body: { deviceId: devA, username: 'nsignage', hostname: 'pi-a', localIp: '192.168.1.20', port: 5000, media: [], agentVersion: '1.0', results: [] } });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.ok(synced.body.commands.some((c) => c.type === 'delete' && c.filename === 'old.jpg'));
  const wrong = await pi.call(sync, { method: 'POST', origin: null, headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` },
    body: { deviceId: devA, username: 'nsignage', results: [] } });
  assert.equal(wrong.status, 401, 'a different secret is still refused (device is claimed by a legacy browser)');

  // 2. The migrated Phase-2 account logs in with its ORIGINAL password and owns its Pi
  const cust = new Client('cust');
  assert.equal((await cust.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'redis.customer', password: 'migrated password 1' } })).status, 200);
  const list = await cust.call(devices);
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].deviceId, devB);
  assert.equal(list.body.devices[0].name, 'Shop Display');

  // 3. The old browser can link its device after verification (same network)
  const owner = new Client('owner', ip);
  await owner.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: 'new.customer', password: 'a brand new password' } });
  owner.cookies.ns_session = legacyToken;
  const legacy = await owner.call(devices, { query: { action: 'legacy' } });
  assert.equal(legacy.body.devices.length, 1);
  assert.equal(legacy.body.devices[0].status, 'linkable');
  assert.equal(legacy.body.devices[0].sameNetwork, true);
  const linked = await owner.call(devices, { method: 'POST', query: { action: 'link-legacy' }, body: { deviceId: devA } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.device.name, 'Reception');

  // Redis is still exactly as before the whole migration
  assert.equal(s.snapshot(), before);
});
