// End-to-end tests of the cloud API handlers against real PostgreSQL (in-process
// PGlite with the Supabase migration, or a real Supabase TEST project when
// TEST_DATABASE_URL is set) and an in-memory Blob backend. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setupEnv, memoryBlob, Client, ORIGIN, deleteFootprint } from './helpers/harness.js';

let database; let blob; let db;
let auth; let devices; let device; let find; let sync; let pairing; let transfer; let cron; let health;
let blobStore;

// Everything a run creates, so it can be removed again from a real Supabase test project
const created = { users: new Set(), devices: new Set(), legacyBrowsers: new Set(), usernames: new Set() };

async function cleanup() {
  const users = [...created.users];
  const devs = [...created.devices];
  const { keyHash } = await import('../api/_lib/cloud.js');
  await db.asSystem(async (t) => {
    const named = await t`select id from nsignage.users where username = any(${[...created.usernames]}::text[])`;
    const ids = [...new Set([...users, ...named.map((r) => r.id)])];
    await t`delete from nsignage.transfers where user_id = any(${ids}::uuid[]) or device_id = any(${devs}::text[])`;
    await t`update nsignage.devices set owner_id = null, added_at = null, added_via = null
            where owner_id = any(${ids}::uuid[]) or id = any(${devs}::text[])`;
    await t`delete from nsignage.devices where id = any(${devs}::text[])`;
    await t`delete from nsignage.users where id = any(${ids}::uuid[])`;
    await t`delete from nsignage.legacy_browser_sessions where browser_id = any(${[...created.legacyBrowsers]}::uuid[])`;
    await t`delete from nsignage.rate_limits where key_hash = any(${[...created.usernames].map(keyHash)}::text[])`;
    await deleteFootprint(t, { userIds: ids, deviceIds: devs });
  });
}

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
  ({ default: cron } = await import('../api/cron/cleanup.js'));
  ({ default: health } = await import('../api/health.js'));
  blobStore = await import('../api/_lib/blobStore.js');
  blob = memoryBlob();
  blobStore.setBlobBackend(blob.backend);
});
after(async () => {
  if (database.external) await cleanup();
  await db.closeDb();
  await database.close();
});
const sql = (fn) => db.asSystem(fn);

// ---- helpers -------------------------------------------------------------------

const PASSWORD = 'correct horse battery';
const devId = () => crypto.randomBytes(8).toString('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(4000)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), crypto.randomBytes(5000)]);

async function register(client, username, password = PASSWORD) {
  created.usernames.add(String(username).toLowerCase());
  const r = await client.call(auth, { method: 'POST', query: { action: 'register' }, body: { username, password } });
  if (r.body?.user?.id) created.users.add(r.body.user.id);
  return r;
}

class Pi extends Client {
  constructor(ip, extra = {}) {
    super('pi', ip);
    this.deviceId = devId();
    created.devices.add(this.deviceId);
    this.secret = secret();
    this.extra = extra;
    this.results = [];
  }
  sync(extra = {}) {
    const body = {
      deviceId: this.deviceId, username: 'nsignage', hostname: 'shop-display', localIp: '192.168.1.50', port: 5000,
      media: [], agentVersion: '1.0', results: this.results, ...this.extra, ...extra,
    };
    this.results = [];
    return this.call(sync, { method: 'POST', body, headers: { authorization: `Bearer ${this.secret}` }, origin: null });
  }
  requestCode(secretOverride) {
    return this.call(pairing, {
      method: 'POST', body: { deviceId: this.deviceId }, headers: { authorization: `Bearer ${secretOverride || this.secret}` }, origin: null,
    });
  }
}

async function claimViaFind(client, pi) {
  const f = await client.call(find);
  const found = f.body.devices.find((d) => d.deviceId === pi.deviceId);
  assert.ok(found?.claimNonce, `nonce for ${pi.deviceId}`);
  return client.call(devices, { method: 'POST', body: { claimNonce: found.claimNonce, name: 'Shop Display' } });
}

/** Account + online Pi registered to it (via Find Pi on the same network). */
async function ownerWithPi(name, piExtra = {}) {
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const owner = new Client(name, ip);
  assert.equal((await register(owner, name)).status, 200);
  const pi = new Pi(ip, piExtra);
  assert.equal((await pi.sync()).status, 200);
  assert.equal((await claimViaFind(owner, pi)).status, 200);
  return { owner, pi };
}

/** Browser part of a transfer: create, "upload" to the relay, commit. */
async function sendFile(client, pi, bytes = JPEG, filename = 'promo.jpg') {
  const c = await client.call(transfer, {
    method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename, size: bytes.length, sha256: sha(bytes) },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const url = blob.put(c.body.uploadPathname, bytes);
  const commit = await client.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: c.body.transfer.id, url } });
  return { id: c.body.transfer.id, url, commit, uploadPathname: c.body.uploadPathname };
}

const status = (client, id) => client.call(transfer, { query: { action: 'status', id } });

// ---- accounts ---------------------------------------------------------------------

test('register validates username and password', async () => {
  const c = () => new Client('v'); // fresh IP each time: invalid attempts also count toward the rate limit
  assert.equal((await register(c(), 'ab')).status, 400);                    // too short
  assert.equal((await register(c(), 'Bad Name!')).status, 400);             // invalid chars
  assert.equal((await register(c(), 'admin')).status, 400);                 // reserved
  assert.equal((await register(c(), 'validuser', 'short')).status, 400);    // short password
  assert.equal((await register(c(), 'validuser', 'password123')).status, 400); // common
  assert.equal((await register(c(), 'validuser', 'xxvaliduserxx')).status, 400); // contains username
});

test('register → session cookie, recovery key, unique usernames, no plaintext password stored', async () => {
  const c = new Client('reg');
  const r = await register(c, 'Shop.Owner');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'shop.owner');
  assert.match(r.body.recoveryKey, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.ok(c.cookies['__Host-ns_acct'], 'secure __Host- cookie set');
  const cookieHeader = (await register(new Client('x'), 'other.owner')).headers['set-cookie'];
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /Secure/); assert.match(cookieHeader, /SameSite=Strict/);
  assert.equal((await register(new Client('dup'), 'shop.owner')).status, 409);
  const me = await c.call(auth, { query: { action: 'me' } });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.passwordHash, undefined);
  assert.equal(me.body.user.recoveryHash, undefined);
  const [row] = await sql((t) => t`select row_to_json(u)::text as j, password_hash from nsignage.users u where id = ${r.body.user.id}`);
  const sessions = await sql((t) => t`select row_to_json(s)::text as j from nsignage.user_sessions s where user_id = ${r.body.user.id}`);
  for (const text of [row.j, ...sessions.map((x) => x.j)]) {
    assert.ok(!text.includes(PASSWORD), 'password never stored in clear');
    assert.ok(!text.includes(r.body.recoveryKey), 'recovery key never stored in clear');
    assert.ok(!text.includes(c.cookies['__Host-ns_acct']), 'session token never stored in clear');
  }
  assert.match(row.password_hash, /^scrypt\$v1\$65536\$8\$2\$/);
});

test('registration is rate limited per IP', async () => {
  const c = new Client('spammer'); // random IP: re-runnable against a persistent database
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await register(c, `spam${i}user`)).status);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[5], 429);
});

test('state-changing requests from another origin are rejected (CSRF)', async () => {
  const c = new Client('csrf');
  const r = await c.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: 'csrfuser', password: PASSWORD }, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const r2 = await c.call(auth, { method: 'POST', query: { action: 'register' }, body: { username: 'csrfuser', password: PASSWORD }, origin: null });
  assert.equal(r2.status, 403);
});

test('login, logout, wrong password, brute-force lockout', async () => {
  await register(new Client('setup'), 'locktest');
  const c = new Client('login', '192.0.2.77');
  assert.equal((await c.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'locktest', password: 'wrong password 1' } })).status, 401);
  const unknown = await c.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'nobody-here', password: 'wrong password 1' } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'Incorrect username or password.'); // no user enumeration
  const ok = await c.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'LockTest', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal((await c.call(auth, { query: { action: 'me' } })).status, 200);
  assert.equal((await c.call(auth, { method: 'POST', query: { action: 'logout' } })).status, 200);
  assert.equal((await c.call(auth, { query: { action: 'me' } })).status, 401);

  const attacker = new Client('attacker', '192.0.2.88');
  for (let i = 0; i < 10; i += 1) {
    const guess = await attacker.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'locktest', password: `guess-number-${i}` } });
    // every guess must be a counted failure; a 503 here is a database/network problem, not a lockout bug
    assert.equal(guess.status, 401, `guess ${i + 1}: ${JSON.stringify(guess.body)}`);
  }
  const locked = await attacker.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'locktest', password: PASSWORD } });
  assert.equal(locked.status, 429, 'correct password refused while locked');
  assert.equal(locked.body.reason, 'locked');
});

test('session revocation: change password signs out other sessions; logout-others', async () => {
  const a = new Client('a'); const b = new Client('b');
  await register(a, 'revoker');
  await b.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'revoker', password: PASSWORD } });
  assert.equal((await b.call(auth, { query: { action: 'me' } })).status, 200);
  const bad = await a.call(auth, { method: 'POST', query: { action: 'change-password' }, body: { currentPassword: 'nope nope nope', newPassword: 'another long pass' } });
  assert.equal(bad.status, 400);
  const ch = await a.call(auth, { method: 'POST', query: { action: 'change-password' }, body: { currentPassword: PASSWORD, newPassword: 'another long pass' } });
  assert.equal(ch.status, 200);
  assert.equal(ch.body.revokedSessions, 1);
  assert.equal((await a.call(auth, { query: { action: 'me' } })).status, 200, 'own session kept');
  assert.equal((await b.call(auth, { query: { action: 'me' } })).status, 401, 'other session revoked');
  const old = await new Client('o').call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'revoker', password: PASSWORD } });
  assert.equal(old.status, 401, 'old password no longer works');

  const c = new Client('c');
  await c.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'revoker', password: 'another long pass' } });
  const lo = await a.call(auth, { method: 'POST', query: { action: 'logout-others' } });
  assert.equal(lo.body.revokedSessions, 1);
  assert.equal((await c.call(auth, { query: { action: 'me' } })).status, 401);
});

test('password recovery with recovery key (no email), single use', async () => {
  const a = new Client('rec');
  const reg = await register(a, 'forgetful');
  const key = reg.body.recoveryKey;
  const other = new Client('rec2');
  const wrong = await other.call(auth, { method: 'POST', query: { action: 'recover' }, body: { username: 'forgetful', recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE', newPassword: 'brand new password' } });
  assert.equal(wrong.status, 400);
  const ok = await other.call(auth, { method: 'POST', query: { action: 'recover' }, body: { username: 'forgetful', recoveryKey: key.toLowerCase(), newPassword: 'brand new password' } });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.body.recoveryKey, key, 'a new key is issued');
  assert.equal((await a.call(auth, { query: { action: 'me' } })).status, 401, 'old sessions revoked');
  const reuse = await new Client('r3').call(auth, { method: 'POST', query: { action: 'recover' }, body: { username: 'forgetful', recoveryKey: key, newPassword: 'third new password' } });
  assert.equal(reuse.status, 400, 'used key is invalid');
  const regen = await other.call(auth, { method: 'POST', query: { action: 'regenerate-recovery' }, body: { password: 'brand new password' } });
  assert.equal(regen.status, 200);
  assert.ok(regen.body.recoveryKey);
});

test('staff-assisted recovery: admin script issues a new key and signs out sessions', async () => {
  const c = new Client('staffcase');
  await register(c, 'lost.key.user');
  // The local test database accepts one connection: release ours while the script runs
  const run = async (...args) => { await db.closeDb(); return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/nsignage-admin.mjs', ...args], { env: process.env });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (status) => resolve({ status, stdout, stderr }));
  }); };
  const info = await run('account', 'lost.key.user');
  assert.equal(info.status, 0, info.stderr);
  assert.ok(!info.stdout.includes('scrypt'), 'no password hash printed');
  const out = await run('reset-recovery', 'Lost.Key.User');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /\[audit\].*reset-recovery/);
  const key = /([A-Z2-9]{4}(?:-[A-Z2-9]{4}){4})/.exec(out.stdout)[1];
  assert.equal((await c.call(auth, { query: { action: 'me' } })).status, 401, 'sessions revoked');
  const r = await new Client('staffcase2').call(auth, { method: 'POST', query: { action: 'recover' }, body: { username: 'lost.key.user', recoveryKey: key, newPassword: 'set by the customer' } });
  assert.equal(r.status, 200);
  assert.equal((await run('account', 'nobody-at-all')).status, 1);
});

test('anonymous session endpoint is retired', async () => {
  const r = await new Client('anon').call(auth, { method: 'POST', query: { action: 'session' } });
  assert.equal(r.status, 410);
});

// ---- devices ----------------------------------------------------------------------

test('unauthenticated requests are rejected everywhere', async () => {
  const anon = new Client('anon');
  for (const [h, opts] of [
    [devices, {}], [find, {}], [device, { query: { deviceId: devId(), action: 'status' } }],
    [transfer, { query: { action: 'list' } }],
    [transfer, { method: 'POST', query: { action: 'create' }, body: {} }],
  ]) {
    assert.equal((await anon.call(h, opts)).status, 401);
  }
});

test('Find Pi claim is bound to account + network; customer A cannot see or use customer B’s Pi', async () => {
  const { owner, pi } = await ownerWithPi('alice');
  const list = await owner.call(devices);
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].name, 'Shop Display');
  assert.equal(list.body.devices[0].online, true);

  const bob = new Client('bob', owner.ip); // same Wi-Fi as Alice's Pi
  await register(bob, 'bob');
  const f = await bob.call(find);
  const seen = f.body.devices.find((d) => d.deviceId === pi.deviceId);
  assert.equal(seen.ownership, 'other');
  assert.equal(seen.claimNonce, undefined, 'no nonce for a Pi owned by another account');
  assert.equal(seen.ip, undefined);
  assert.equal((await bob.call(devices)).body.devices.length, 0);
  assert.equal((await bob.call(device, { query: { deviceId: pi.deviceId, action: 'status' } })).status, 404);
  assert.equal((await bob.call(device, { method: 'POST', query: { deviceId: pi.deviceId, action: 'command' }, body: { type: 'delete', filename: 'a.jpg' } })).status, 404);
  assert.equal((await bob.call(devices, { method: 'PATCH', query: { deviceId: pi.deviceId }, body: { name: 'mine now' } })).status, 404);
  assert.equal((await bob.call(devices, { method: 'DELETE', query: { deviceId: pi.deviceId } })).status, 404);
  const tr = await bob.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'x.jpg', size: 10, sha256: sha('x') } });
  assert.equal(tr.status, 404, 'cannot upload to another customer’s Pi');
});

test('claim nonce: single use, bound to the account and network', async () => {
  const ip = '198.51.100.230';
  const pi = new Pi(ip); await pi.sync();
  const carol = new Client('carol', ip); await register(carol, 'carol');
  const dave = new Client('dave', ip); await register(dave, 'dave');
  const f = await carol.call(find);
  const nonce = f.body.devices.find((d) => d.deviceId === pi.deviceId).claimNonce;
  assert.equal((await dave.call(devices, { method: 'POST', body: { claimNonce: nonce } })).status, 410, 'other account cannot use it');
  const f2 = await carol.call(find);
  const nonce2 = f2.body.devices.find((d) => d.deviceId === pi.deviceId).claimNonce;
  carol.ip = '203.0.113.99';
  assert.equal((await carol.call(devices, { method: 'POST', body: { claimNonce: nonce2 } })).status, 403, 'network changed');
  carol.ip = ip;
  const f3 = await carol.call(find);
  const nonce3 = f3.body.devices.find((d) => d.deviceId === pi.deviceId).claimNonce;
  assert.equal((await carol.call(devices, { method: 'POST', body: { claimNonce: nonce3 } })).status, 200);
  assert.equal((await carol.call(devices, { method: 'POST', body: { claimNonce: nonce3 } })).status, 410, 'reused nonce');
});

test('pairing codes: device-authenticated, single use, rejected when wrong/expired/reused, rate limited', async () => {
  const pi = new Pi('198.51.100.240'); await pi.sync();
  assert.equal((await pi.requestCode(secret())).status, 401, 'invalid device credential');
  const stranger = new Pi('198.51.100.241'); // never synced
  assert.equal((await stranger.requestCode()).status, 401);
  const r1 = await pi.requestCode();
  assert.equal(r1.status, 200);
  assert.match(r1.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const r2 = await pi.requestCode();
  const erin = new Client('erin', '203.0.113.50'); // different network: code is the proof
  await register(erin, 'erin');
  const old = await erin.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: r1.body.code } });
  assert.equal(old.status, 400, 'previous code invalidated by a new one');
  const bad = await erin.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: 'ZZZZ-ZZZZ' } });
  assert.equal(bad.status, 400);
  const ok = await erin.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: r2.body.code.toLowerCase().replace('-', ' '), name: 'Reception' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.device.via, 'pairing-code');
  const reuse = await new Client('frank').call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: r2.body.code } });
  assert.equal(reuse.status, 401, 'needs login');
  const frank = new Client('frank'); await register(frank, 'frank');
  assert.equal((await frank.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: r2.body.code } })).status, 400, 'used code');
  assert.equal((await pi.requestCode()).status, 409, 'owned Pi gets no new codes');

  // expiry: the code key carries a 10-minute TTL
  const pi2 = new Pi('198.51.100.242'); await pi2.sync();
  const c = await pi2.requestCode();
  const [ttl] = await sql((t) => t`select extract(epoch from expires_at - created_at)::int as s from nsignage.pairing_codes
                                  where device_id = ${pi2.deviceId} and used_at is null`);
  assert.equal(ttl.s, 600, 'codes are valid 10 minutes');
  await sql((t) => t`update nsignage.pairing_codes set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
                     where device_id = ${pi2.deviceId}`); // simulate expiry
  assert.equal((await frank.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: c.body.code } })).status, 400, 'expired');

  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await frank.call(devices, { method: 'POST', query: { action: 'pair' }, body: { code: 'ABCD-EFGH' } });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'pairing attempts are rate limited');
});

test('legacy (pre-accounts) devices: verified one-time link, never automatic', async () => {
  const ip = '198.51.100.250';
  const pi = new Pi(ip); await pi.sync();
  const pi2 = new Pi('198.51.100.251'); await pi2.sync();
  // Old anonymous browser data, exactly as the previous version stored it
  const token = crypto.randomBytes(32).toString('base64url');
  const browserId = crypto.randomUUID();
  // (as imported from Redis by scripts/migrate-redis-to-supabase.mjs)
  created.legacyBrowsers.add(browserId);
  await sql(async (t) => {
    await t`insert into nsignage.legacy_browser_sessions (token_hash, browser_id) values (${sha(token)}, ${browserId})`;
    for (const p of [pi, pi2]) {
      await t`insert into nsignage.legacy_browser_devices (browser_id, device_id, name, location) values (${browserId}, ${p.deviceId}, 'Old name', 'Lobby')`;
    }
  });

  const grace = new Client('grace', '203.0.113.200'); // away from the Pi's network
  await register(grace, 'grace');
  assert.equal((await grace.call(devices)).body.devices.length, 0, 'nothing assigned automatically');
  assert.equal((await grace.call(devices, { query: { action: 'legacy' } })).body.available, false, 'needs the old browser cookie');

  grace.cookies.ns_session = token;
  const l = await grace.call(devices, { query: { action: 'legacy' } });
  assert.equal(l.body.devices.length, 2);
  assert.ok(l.body.devices.every((d) => d.status === 'linkable' && !d.sameNetwork));
  const away = await grace.call(devices, { method: 'POST', query: { action: 'link-legacy' }, body: { deviceId: pi.deviceId } });
  assert.equal(away.status, 403);
  assert.equal(away.body.reason, 'verify-required');

  grace.ip = ip;
  const linked = await grace.call(devices, { method: 'POST', query: { action: 'link-legacy' }, body: { deviceId: pi.deviceId } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.device.name, 'Old name');
  assert.equal(linked.body.device.via, 'legacy+network');

  // pi2 with a pairing code instead of being on its network
  const code = (await pi2.requestCode()).body.code;
  const wrongCode = await grace.call(devices, { method: 'POST', query: { action: 'link-legacy' }, body: { deviceId: pi.deviceId, code } });
  assert.notEqual(wrongCode.status, 200);
  const viaCode = await grace.call(devices, { method: 'POST', query: { action: 'link-legacy' }, body: { deviceId: pi2.deviceId, code } });
  assert.equal(viaCode.status, 200, JSON.stringify(viaCode.body));

  // another account with another old browser that also had the Pi cannot take it
  const token2 = crypto.randomBytes(32).toString('base64url'); const b2 = crypto.randomUUID();
  created.legacyBrowsers.add(b2);
  await sql(async (t) => {
    await t`insert into nsignage.legacy_browser_sessions (token_hash, browser_id) values (${sha(token2)}, ${b2})`;
    await t`insert into nsignage.legacy_browser_devices (browser_id, device_id, name) values (${b2}, ${pi.deviceId}, 'x')`;
  });
  const heidi = new Client('heidi', ip); await register(heidi, 'heidi'); heidi.cookies.ns_session = token2;
  assert.equal((await heidi.call(devices, { query: { action: 'legacy' } })).body.devices[0].status, 'other-account');
  assert.equal((await heidi.call(devices, { method: 'POST', query: { action: 'link-legacy' }, body: { deviceId: pi.deviceId } })).status, 409);
  // legacy data is preserved
  const [kept] = await sql((t) => t`select count(*)::int as n from nsignage.legacy_browser_devices where device_id = ${pi2.deviceId}`);
  assert.equal(kept.n, 1);
});

test('re-flashed Pi cannot take over a claimed device id; removal lets it re-register', async () => {
  const { owner, pi } = await ownerWithPi('ivan');
  const impostor = new Pi(pi.ip); impostor.deviceId = pi.deviceId;
  assert.equal((await impostor.sync()).status, 401);
  assert.equal((await owner.call(devices, { method: 'DELETE', query: { deviceId: pi.deviceId } })).status, 200);
  assert.equal((await impostor.sync()).status, 200, 'unclaimed Pi may register a new secret');
});

// ---- transfers --------------------------------------------------------------------

test('transfer validation: type, size, checksum, ownership', async () => {
  const { owner, pi } = await ownerWithPi('judy');
  const mk = (body) => owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, ...body } });
  assert.equal((await mk({ filename: 'virus.exe', size: 10, sha256: sha('a') })).status, 415);
  assert.equal((await mk({ filename: 'big.mp4', size: 501 * 1024 * 1024, sha256: sha('a') })).status, 413);
  assert.equal((await mk({ filename: 'a.jpg', size: 10, sha256: 'nothex' })).status, 400);
  assert.equal((await mk({ filename: 'a.jpg', size: -5, sha256: sha('a') })).status, 400);
  const ok = await mk({ filename: '../../etc/pass wd.JPG', size: 10, sha256: sha('a') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transfer.filename, 'pass wd.jpg', 'directory parts stripped (no path traversal)');
  assert.ok(ok.body.uploadPathname.startsWith(`transfers/${pi.deviceId}/${ok.body.transfer.id}/`));
  for (const ext of ['bmp', 'avi', 'mkv', 'webp', 'mov', 'webm']) {
    assert.equal((await mk({ filename: `clip.${ext}`, size: 10, sha256: sha('a') })).status, 200, ext);
  }
});

test('commit checks path, size and real file content; never "completed" before the Pi confirms', async () => {
  const { owner, pi } = await ownerWithPi('ken');
  const c = await owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: JPEG.length, sha256: sha(JPEG) } });
  const id = c.body.transfer.id;
  const foreign = blob.put(`transfers/${pi.deviceId}/someoneelse/a.jpg`, JPEG);
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: id, url: foreign } })).status, 400);
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: id, url: 'https://evil.example/a.jpg' } })).status, 400);
  const short = blob.put(c.body.uploadPathname, JPEG.subarray(0, 100));
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: id, url: short } })).status, 422);
  assert.ok(!blob.blobs.has(short), 'mismatched upload deleted');
  const fake = Buffer.alloc(JPEG.length, 0x41); // right size, not a JPEG
  const fakeUrl = blob.put(c.body.uploadPathname, fake);
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: id, url: fakeUrl } })).status, 415);
  const good = blob.put(c.body.uploadPathname, JPEG);
  const ok = await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: id, url: good } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transfer.state, 'queued');
  assert.equal(JSON.stringify(ok.body).includes('blob.vercel-storage.com'), false, 'relay URL never sent to the browser');
  assert.equal((await status(owner, id)).body.transfer.state, 'queued');
  const again = await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: id, url: good } });
  assert.equal(again.status, 409);
});

test('agent 1.0 flow: Pi receives command, confirms → completed (unverified), relay copy deleted', async () => {
  const { owner, pi } = await ownerWithPi('liam');
  const { id, url } = await sendFile(owner, pi);
  const s = await pi.sync();
  const cmd = s.body.commands.find((x) => x.transferId === id);
  assert.equal(cmd.type, 'download');
  assert.equal(cmd.url, url);
  assert.equal(cmd.sha256, sha(JPEG));
  assert.equal(cmd.filename, 'promo.jpg');
  assert.equal((await status(owner, id)).body.transfer.state, 'queued', 'not complete until the Pi says so');
  pi.results = [{ id: cmd.id, ok: true, filename: 'promo_1.jpg' }]; // agent 1.0 result shape
  await pi.sync();
  const t = (await status(owner, id)).body.transfer;
  assert.equal(t.state, 'completed');
  assert.equal(t.verified, false);
  assert.equal(t.verification, 'saved-on-pi-unverified');
  assert.equal(t.savedAs, 'promo_1.jpg');
  assert.equal(t.cloudCopy, false);
  assert.ok(!blob.blobs.has(url), 'relay copy deleted after the Pi confirmed');
  assert.equal((await pi.sync()).body.commands.length, 0);
});

test('agent protocol 2: checksum verified; mismatch fails and keeps copy for retry; retry and cancel', async () => {
  const { owner, pi } = await ownerWithPi('mia', { protocol: 2, capabilities: ['sha256', 'progress'] });
  const a = await sendFile(owner, pi, MP4, 'clip.mp4');
  let cmd = (await pi.sync({ progress: [{ transferId: a.id, receivedBytes: 1000 }] })).body.commands[0];
  assert.equal((await status(owner, a.id)).body.transfer.receivedBytes, 1000);
  pi.results = [{ id: cmd.id, ok: true, filename: 'clip.mp4', sha256: sha(MP4), size: MP4.length }];
  await pi.sync();
  let t = (await status(owner, a.id)).body.transfer;
  assert.equal(t.state, 'completed'); assert.equal(t.verified, true);

  const b = await sendFile(owner, pi, MP4, 'clip2.mp4');
  cmd = (await pi.sync()).body.commands[0];
  pi.results = [{ id: cmd.id, ok: true, filename: 'clip2.mp4', sha256: sha('corrupt') }];
  await pi.sync();
  t = (await status(owner, b.id)).body.transfer;
  assert.equal(t.state, 'failed'); assert.equal(t.reason, 'checksum-mismatch'); assert.equal(t.cloudCopy, true);
  assert.ok(blob.blobs.has(b.url), 'copy kept for retry');
  const retry = await owner.call(transfer, { method: 'POST', query: { action: 'retry' }, body: { transferId: b.id } });
  assert.equal(retry.status, 200); assert.equal(retry.body.needsUpload, false); assert.equal(retry.body.transfer.state, 'queued');
  const cmd2 = (await pi.sync()).body.commands[0];
  assert.notEqual(cmd2.id, cmd.id);
  // a late result for the OLD attempt is ignored
  pi.results = [{ id: cmd.id, ok: false, error: 'late' }];
  await pi.sync();
  assert.equal((await status(owner, b.id)).body.transfer.state, 'queued');

  const cancel = await owner.call(transfer, { method: 'POST', query: { action: 'cancel' }, body: { transferId: b.id } });
  assert.equal(cancel.body.transfer.state, 'cancelled');
  assert.ok(!blob.blobs.has(b.url), 'copy deleted on cancel');
  assert.equal((await pi.sync()).body.commands.length, 0, 'command withdrawn');
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'cancel' }, body: { transferId: b.id } })).status, 409);
});

test('Pi failure (e.g. storage full) → failed with the Pi’s reason; retry after copy loss needs re-upload', async () => {
  const { owner, pi } = await ownerWithPi('noah', { protocol: 2, capabilities: ['sha256'], storage: { freeBytes: 10 * 1024 * 1024 * 1024, totalBytes: 16e9 } });
  const a = await sendFile(owner, pi);
  const cmd = (await pi.sync()).body.commands[0];
  pi.results = [{ id: cmd.id, ok: false, error: 'No space left on the SD card', reason: 'insufficient-storage' }];
  await pi.sync();
  let t = (await status(owner, a.id)).body.transfer;
  assert.equal(t.state, 'failed'); assert.equal(t.reason, 'insufficient-storage'); assert.match(t.error, /space/);
  blob.blobs.delete(a.url);
  await sql((t) => t`update nsignage.transfers set blob_url = null where id = ${a.id}`);
  const retry = await owner.call(transfer, { method: 'POST', query: { action: 'retry' }, body: { transferId: a.id } });
  assert.equal(retry.body.needsUpload, true); assert.equal(retry.body.transfer.state, 'created');
  const url = blob.put(retry.body.uploadPathname, JPEG);
  const commit = await owner.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: a.id, url } });
  assert.equal(commit.body.transfer.state, 'queued');

  // a Pi reporting too little free space is refused up front
  const { owner: o2, pi: p2 } = await ownerWithPi('olga', { protocol: 2, storage: { freeBytes: 100 * 1024 * 1024, totalBytes: 8e9 } });
  const full = await o2.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: p2.deviceId, filename: 'a.mp4', size: 50 * 1024 * 1024, sha256: sha('x') } });
  assert.equal(full.status, 507);
});

test('expiry + cleanup cron: abandoned transfers expire, relay copies and orphans are deleted', async () => {
  const { owner, pi } = await ownerWithPi('pat');
  const a = await sendFile(owner, pi);
  const orphan = blob.put(`transfers/${pi.deviceId}/AAAAAAAAAAAAAAAAAAAAAA/x.jpg`, JPEG, { uploadedAt: Date.now() - 5 * 3600 * 1000 });
  assert.equal((await new Client('x').call(cron)).status, 401);
  assert.equal((await new Client('x').call(cron, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  await sql((t) => t`update nsignage.transfers set expires_at = now() - interval '1 second' where id = ${a.id}`);
  const run = await new Client('cron').call(cron, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.expired >= 1);
  assert.equal((await status(owner, a.id)).body.transfer.state, 'expired');
  assert.ok(!blob.blobs.has(a.url));
  assert.ok(!blob.blobs.has(orphan), 'orphan copy swept');
  assert.equal((await pi.sync()).body.commands.length, 0);
});

test('removing a device cancels its transfers and deletes copies; files on the Pi untouched (no delete command)', async () => {
  const { owner, pi } = await ownerWithPi('quinn');
  const a = await sendFile(owner, pi);
  assert.equal((await owner.call(devices, { method: 'DELETE', query: { deviceId: pi.deviceId } })).status, 200);
  assert.ok(!blob.blobs.has(a.url));
  assert.equal((await status(owner, a.id)).body.transfer.state, 'cancelled');
  assert.equal((await pi.sync()).body.commands.filter((c) => c.type === 'delete').length, 0);
});

test('private relay mode needs Pi support; presigned URL delivered per sync', async () => {
  process.env.NSIGNAGE_BLOB_ACCESS = 'private';
  try {
    const { owner, pi } = await ownerWithPi('rita');
    const r = await owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: JPEG.length, sha256: sha(JPEG) } });
    assert.equal(r.status, 409); assert.equal(r.body.reason, 'agent-update-required');
    const { owner: o2, pi: p2 } = await ownerWithPi('sam', { protocol: 2, capabilities: ['sha256', 'private-blob'] });
    const c = await o2.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: p2.deviceId, filename: 'a.jpg', size: JPEG.length, sha256: sha(JPEG) } });
    const url = blob.put(c.body.uploadPathname, JPEG, { access: 'private' });
    const commit = await o2.call(transfer, { method: 'POST', query: { action: 'commit' }, body: { transferId: c.body.transfer.id, url } });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    const cmd = (await p2.sync()).body.commands[0];
    assert.match(cmd.url, /\.private\.blob\.vercel-storage\.com\/.*\?sig=/);
  } finally {
    delete process.env.NSIGNAGE_BLOB_ACCESS;
  }
});

test('Blob client-upload token is only issued for the exact transfer path, size and type', async () => {
  const { owner, pi } = await ownerWithPi('tom');
  const c = await owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: JPEG.length, sha256: sha(JPEG) } });
  const token = (pathname, transferId = c.body.transfer.id, who = owner) => who.call(transfer, {
    method: 'POST', query: { action: 'blob-token' },
    body: { type: 'blob.generate-client-token', payload: { pathname, multipart: false, clientPayload: JSON.stringify({ transferId }) } },
  });
  const ok = await token(c.body.uploadPathname);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.clientToken.startsWith('vercel_blob_client_'));
  // vercel_blob_client_<store>_<base64("<hmac>.<base64 json payload>")>
  const inner = Buffer.from(ok.body.clientToken.split('_').pop(), 'base64').toString();
  const decoded = JSON.parse(Buffer.from(inner.split('.')[1], 'base64').toString());
  assert.equal(decoded.maximumSizeInBytes, JPEG.length);
  assert.deepEqual(decoded.allowedContentTypes, ['image/jpeg']);
  assert.equal(decoded.pathname, c.body.uploadPathname);
  assert.notEqual((await token(`transfers/${pi.deviceId}/other/a.jpg`)).status, 200);
  const eve = new Client('eve'); await register(eve, 'eve');
  assert.notEqual((await token(c.body.uploadPathname, c.body.transfer.id, eve)).status, 200, 'other account');
});

test('transfer list and views never expose relay URLs or owner ids', async () => {
  const { owner, pi } = await ownerWithPi('uma');
  await sendFile(owner, pi);
  const l = await owner.call(transfer, { query: { action: 'list' } });
  assert.equal(l.status, 200);
  assert.ok(l.body.transfers.length >= 1);
  const text = JSON.stringify(l.body);
  assert.ok(!text.includes('vercel-storage.com'));
  assert.ok(!text.includes('userId'));
  assert.equal(l.body.transfers[0].relay, 'cloud');
});

// ---- Add Device by name + IP, persistence, next-login restoration ----------------

const save = (client, body) => client.call(devices, { method: 'POST', query: { action: 'save' }, body });

test('Add Device by name + IP is saved in PostgreSQL for the logged-in customer only', async () => {
  const shop = new Client('shop-owner'); await register(shop, 'shop.owner.save');
  // validation
  assert.equal((await save(shop, { name: '', ip: '192.168.1.120' })).body.reason, 'bad-name');
  assert.equal((await save(shop, { name: 'Shop Display 01', ip: '' })).body.reason, 'bad-ip');
  assert.equal((await save(shop, { name: 'Shop Display 01', ip: '192.168.1.300' })).body.reason, 'bad-ip');
  assert.equal((await save(shop, { name: 'Shop Display 01', ip: '192.168.1.0/24' })).body.reason, 'bad-ip');
  assert.equal((await save(shop, { name: 'Shop Display 01', ip: '192.168.1.120', hostname: 'bad host!' })).body.reason, 'bad-hostname');
  assert.equal((await save(shop, { name: 'Shop Display 01', ip: '192.168.1.120', deviceUid: 'xyz' })).body.reason, 'bad-uid');
  // a browser-supplied owner id is ignored: ownership comes from the session
  const other = new Client('other'); const otherReg = await register(other, 'other.customer.save');
  const r = await save(shop, { name: 'Shop Display 01', ip: '192.168.1.120', hostname: 'shop-pi', customer_id: otherReg.body.user.id, owner_id: otherReg.body.user.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.verified, false);
  assert.equal(r.body.device.registration, 'saved');
  assert.equal(r.body.device.status, 'unknown', 'an IP address alone proves nothing: status unknown');
  assert.equal(r.body.device.online, false);
  const id = r.body.device.deviceId;
  assert.match(id, /^saved_[a-f0-9]{24}$/);
  created.devices.add(id);
  const [row] = await sql((t) => t`select d.nickname, host(d.local_ip) as ip, d.hostname, d.registration, u.username
                                   from nsignage.devices d join nsignage.users u on u.id = d.owner_id where d.id = ${id}`);
  assert.deepEqual({ ...row }, { nickname: 'Shop Display 01', ip: '192.168.1.120', hostname: 'shop-pi', registration: 'saved', username: 'shop.owner.save' });
  const [view] = await sql((t) => t`select device_name, host(ip_address) ip, status from nsignage.customer_devices where device_uid = ${id}`);
  assert.deepEqual({ ...view }, { device_name: 'Shop Display 01', ip: '192.168.1.120', status: 'unknown' });
  const events = await sql((t) => t`select event_type from nsignage.device_events where device_id = ${id}`);
  assert.deepEqual(events.map((e) => e.event_type), ['saved']);
  assert.equal((await save(shop, { name: 'Again', ip: '192.168.1.120' })).body.reason, 'duplicate');

  // logout → login again → the saved device is listed again (from the database)
  await shop.call(auth, { method: 'POST', query: { action: 'logout' } });
  assert.equal((await shop.call(devices)).status, 401);
  await shop.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'shop.owner.save', password: PASSWORD } });
  const again = (await shop.call(devices)).body.devices.find((d) => d.deviceId === id);
  assert.equal(again.name, 'Shop Display 01');
  assert.equal(again.ip, '192.168.1.120');
  // another computer, same account
  const laptop = new Client('laptop');
  await laptop.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'shop.owner.save', password: PASSWORD } });
  assert.ok((await laptop.call(devices)).body.devices.some((d) => d.deviceId === id && d.ip === '192.168.1.120'));

  // the other customer can't see, edit or delete it
  assert.equal((await other.call(devices)).body.devices.length, 0);
  assert.equal((await other.call(devices, { method: 'PATCH', query: { deviceId: id }, body: { name: 'mine' } })).status, 404);
  assert.equal((await other.call(devices, { method: 'DELETE', query: { deviceId: id } })).status, 404);
  assert.equal((await other.call(device, { query: { deviceId: id, action: 'status' } })).status, 404);

  // owner edits the IP when the network changes; status endpoint is honest
  const upd = await shop.call(devices, { method: 'PATCH', query: { deviceId: id }, body: { ip: '192.168.1.121' } });
  assert.equal(upd.body.device.ip, '192.168.1.121');
  const st = await shop.call(device, { query: { deviceId: id, action: 'status' } });
  assert.equal(st.body.saved, true); assert.equal(st.body.ok, false);
  // no uploads to an unverified record
  const tr = await shop.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: id, filename: 'a.jpg', size: 10, sha256: sha('a') } });
  assert.equal(tr.status, 409); assert.equal(tr.body.reason, 'device-not-verified');
  // removal deletes the record
  assert.equal((await shop.call(devices, { method: 'DELETE', query: { deviceId: id } })).status, 200);
  assert.equal((await sql((t) => t`select count(*)::int n from nsignage.devices where id = ${id}`))[0].n, 0);
});

test('Add Device with name + IP + pairing code verifies the real Pi and replaces a matching saved record', async () => {
  const c = new Client('verifier', '198.51.100.233'); await register(c, 'verify.owner');
  const pi = new Pi('198.51.100.234'); await pi.sync();
  const saved = await save(c, { name: 'Lobby Screen', ip: '192.168.1.50', deviceUid: pi.deviceId });
  assert.equal(saved.body.device.registration, 'saved');
  created.devices.add(saved.body.device.deviceId);
  const { code } = (await pi.requestCode()).body;
  const v = await save(c, { name: '', ip: '192.168.1.50', code }).catch(() => null);
  assert.equal(v.body.reason, 'bad-name', 'name still required');
  const ok = await save(c, { name: 'Lobby Screen', ip: '192.168.1.50', code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verified, true);
  assert.equal(ok.body.device.deviceId, pi.deviceId);
  assert.equal(ok.body.device.registration, 'verified');
  const list = (await c.call(devices)).body.devices;
  assert.equal(list.length, 1, 'the saved placeholder was merged into the verified display');
  assert.equal(list[0].name, 'Lobby Screen');
  const ev = await sql((t) => t`select event_type from nsignage.device_events where device_id = ${pi.deviceId} order by created_at`);
  assert.ok(ev.some((e) => e.event_type === 'registered'));
});

test('device events: Pi coming online and IP changes are recorded (not every heartbeat)', async () => {
  const { pi } = await ownerWithPi('events.owner');
  await pi.sync(); await pi.sync();
  await pi.sync({ localIp: '192.168.1.77' });
  const ev = await sql((t) => t`select event_type, host(ip_address) ip from nsignage.device_events where device_id = ${pi.deviceId} order by created_at`);
  const types = ev.map((e) => e.event_type);
  assert.equal(types.filter((x) => x === 'online').length, 1, `one online event, got ${types}`);
  assert.ok(ev.some((e) => e.event_type === 'ip-changed' && e.ip === '192.168.1.77'));
  assert.ok(types.includes('registered'));
});

test('remember me off → short browser-session cookie; logout keeps an audit row with revoked_at', async () => {
  await register(new Client('rm'), 'remember.me.user');
  const c = new Client('rm2');
  const r = await c.call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'remember.me.user', password: PASSWORD, remember: false } });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.headers['set-cookie'], /Max-Age/, 'browser-session cookie');
  const [s] = await sql((t) => t`select persistent, extract(epoch from s.expires_at - s.created_at)::int as ttl from nsignage.user_sessions s
                                 join nsignage.users u on u.id = s.user_id where u.username = 'remember.me.user' order by s.created_at desc limit 1`);
  assert.equal(s.persistent, false); assert.equal(s.ttl, 12 * 3600);
  const r2 = await new Client('rm3').call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'remember.me.user', password: PASSWORD } });
  assert.match(r2.headers['set-cookie'], /Max-Age=2592000/, '30 days when remembered');
  await c.call(auth, { method: 'POST', query: { action: 'logout' } });
  const rows = await sql((t) => t`select count(*) filter (where revoked_at is not null)::int as revoked from nsignage.user_sessions s
                                  join nsignage.users u on u.id = s.user_id where u.username = 'remember.me.user'`);
  assert.equal(rows[0].revoked, 1);
  assert.equal((await c.call(auth, { query: { action: 'me' } })).status, 401);
  const [u] = await sql((t) => t`select last_login_at is not null as seen from nsignage.users where username = 'remember.me.user'`);
  assert.equal(u.seen, true);
});

test('suspended accounts cannot log in; registration can be closed (staff-created accounts)', async () => {
  const c = new Client('susp'); await register(c, 'suspended.user');
  await sql((t) => t`update nsignage.users set account_status = 'suspended' where username = 'suspended.user'`);
  assert.equal((await c.call(auth, { query: { action: 'me' } })).status, 401, 'existing session stops working');
  const l = await new Client('susp2').call(auth, { method: 'POST', query: { action: 'login' }, body: { username: 'suspended.user', password: PASSWORD } });
  assert.equal(l.status, 401);
  assert.equal(l.body.error, 'Incorrect username or password.');
  process.env.NSIGNAGE_REGISTRATION = 'closed';
  try {
    assert.equal((await new Client('cfg').call(auth, { query: { action: 'config' } })).body.registration, 'closed');
    const reg = await register(new Client('closed'), 'should.not.exist');
    assert.equal(reg.status, 403); assert.equal(reg.body.reason, 'registration-closed');
  } finally {
    delete process.env.NSIGNAGE_REGISTRATION;
  }
  assert.equal((await new Client('cfg2').call(auth, { query: { action: 'config' } })).body.registration, 'open');
});

test('health reports configuration flags only', async () => {
  const h = await new Client('h').call(health);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.deepEqual(h.body.blob, { configured: true, access: 'public' });
  const d = h.body.database;
  assert.equal(d.provider, 'supabase-postgres');
  assert.equal(d.reachable, true);
  assert.equal(d.role, 'nsignage_api', 'queries run as the least-privilege role');
  assert.equal(d.schema, true);
  assert.equal(d.rlsOnAllTables, true);
  assert.equal(d.roleBypassesRls, false);
  const text = JSON.stringify(h.body);
  assert.ok(!text.includes(process.env.DATABASE_URL), 'no connection string');
  assert.ok(!/postgres:\/\//.test(text));
});

test('every query runs as nsignage_api under RLS, even with a more privileged connection URL', async () => {
  // In local mode DATABASE_URL connects as the superuser "postgres"; the API must still switch role
  const [r] = await db.asAnonymous((t) => t`select current_user as u, session_user as s,
    (select count(*)::int from nsignage.users) as visible_users`);
  assert.equal(r.u, 'nsignage_api');
  assert.equal(r.visible_users, 0, 'no RLS context → no rows');
  const [cu] = await db.asUser(crypto.randomUUID(), (t) => t`select count(*)::int as n from nsignage.devices`);
  assert.equal(cu.n, 0, 'an unknown customer sees no devices');
});

export { ORIGIN };
