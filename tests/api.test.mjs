// End-to-end tests of the cloud API handlers against real PostgreSQL (in-process
// PGlite with the Supabase migration, or a real Supabase TEST project when
// TEST_DATABASE_URL is set) and an in-memory Blob backend. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setupEnv, Client, ORIGIN, deleteFootprint } from './helpers/harness.js';
import { verifyTicket } from '../api/_lib/tickets.js';

let database; let db; let receiverApi;
let auth; let devices; let device; let find; let sync; let pairing; let transfer; let cron; let health;

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
  ({ default: receiverApi } = await import('../api/pi/receiver.js'));
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

// ---- direct upload helpers (the Pi receiver simulated through its website API) ----
const rawP256 = () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
};
const b64u = (b) => Buffer.from(b).toString('base64url');
const newEpk = () => { const raw = rawP256(); return { epk: b64u(raw), hash: sha(raw) }; };
const receiverHost = () => `p-${crypto.randomBytes(8).toString('hex')}.nsinages.in`;

/** The Pi's receiver calling /api/pi/receiver with the device secret. */
function rcv(pi, action, body = {}, secretOverride) {
  return pi.call(receiverApi, {
    method: 'POST', query: { action }, origin: null,
    headers: { authorization: `Bearer ${secretOverride || pi.secret}` }, body: { deviceId: pi.deviceId, ...body },
  });
}
async function withReceiver(pi, extra = {}) {
  pi.receiverKey = pi.receiverKey || b64u(rawP256());
  pi.receiverHost = pi.receiverHost || receiverHost();
  const r = await rcv(pi, 'heartbeat', { publicKey: pi.receiverKey, hostname: pi.receiverHost, version: '1.0.0', freeBytes: 20 * 1024 ** 3, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

/** Browser part of a direct transfer: create (gets a ticket); the bytes would go to the Pi, never here. */
async function sendFile(client, pi, bytes = JPEG, filename = 'promo.jpg') {
  const k = newEpk();
  const c = await client.call(transfer, {
    method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename, size: bytes.length, sha256: sha(bytes), epk: k.epk },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return { id: c.body.transfer.id, ticket: c.body.ticket, epk: k, body: c.body };
}
const piReports = (pi, id, bytes, extra = {}) => rcv(pi, 'result', { transferId: id, ok: true, savedAs: 'promo.jpg', sha256: sha(bytes), size: bytes.length, ...extra });

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

test('direct upload: receiver heartbeat pins its key; tickets bind device, transfer, file, size, checksum and browser key', async () => {
  const { owner, pi } = await ownerWithPi('judy');
  assert.equal((await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver.available, false, 'no receiver yet');
  const noRcv = await owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: 10, sha256: sha('a'), epk: newEpk().epk } });
  assert.equal(noRcv.status, 409); assert.equal(noRcv.body.reason, 'no-receiver');
  const noRcvTarget = (await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver;
  assert.equal(noRcvTarget.status, 'no-receiver'); assert.match(noRcvTarget.message, /not installed/);
  assert.equal((await rcv(pi, 'heartbeat', { publicKey: b64u(rawP256()) }, 'wrong-secret-'.padEnd(43, 'x'))).status, 401, 'device secret required');
  const authFail = (await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver;
  assert.equal(authFail.status, 'receiver-auth-failed', 'installed but refused is not reported as "not installed"');
  assert.equal((await rcv(pi, 'heartbeat', { publicKey: 'not-a-key' })).status, 400);
  assert.equal((await rcv(pi, 'heartbeat', { publicKey: b64u(rawP256()), hostname: 'evil.example.com' })).status, 400, 'only p-<16 hex>.nsinages.in');
  const hb = await withReceiver(pi);
  assert.equal(hb.body.keyStatus, 'pinned');
  assert.ok(hb.body.ticketKeys.length >= 1 && typeof hb.body.serverTime === 'number');
  const target = (await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver;
  assert.equal(target.online, true); assert.equal(target.url, `https://${pi.receiverHost}`); assert.equal(target.publicKey, pi.receiverKey);
  assert.equal(target.status, 'ready');
  assert.equal(target.fingerprint, sha(Buffer.from(pi.receiverKey, 'base64url')));
  const a = await sendFile(owner, pi, MP4, 'clip.mp4');
  assert.equal(a.body.uploadUrl, `https://${pi.receiverHost}`);
  assert.equal(a.body.transfer.method, 'direct'); assert.equal(a.body.transfer.state, 'created');
  const claims = verifyTicket(a.ticket, { keys: hb.body.ticketKeys });
  assert.deepEqual([claims.aud, claims.tid, claims.name, claims.size, claims.sha256, claims.epk], [pi.deviceId, a.id, 'clip.mp4', MP4.length, sha(MP4), a.epk.hash]);
  assert.ok(claims.exp - claims.iat <= 900 && claims.chunk === 4 * 1024 * 1024);
  assert.ok(!JSON.stringify(a.body).match(/blob|vercel-storage|secret/i), 'no storage, no secrets in the reply');
  for (const old of ['blob-token', 'commit']) {
    assert.equal((await owner.call(transfer, { method: 'POST', query: { action: old }, body: {} })).status, 404, `${old} is gone`);
  }
});

test('transfer validation: type, size, checksum, key, storage, offline, ownership', async () => {
  const { owner, pi } = await ownerWithPi('ken');
  await withReceiver(pi, { freeBytes: 300 * 1024 * 1024 });
  const mk = (body) => owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, epk: newEpk().epk, ...body } });
  assert.equal((await mk({ filename: 'virus.exe', size: 10, sha256: sha('a') })).status, 415);
  assert.equal((await mk({ filename: 'big.mp4', size: 501 * 1024 * 1024, sha256: sha('a') })).status, 413);
  assert.equal((await mk({ filename: 'a.jpg', size: 10, sha256: 'nothex' })).status, 400);
  assert.equal((await mk({ filename: 'a.jpg', size: -5, sha256: sha('a') })).status, 400);
  assert.equal((await mk({ filename: 'a.jpg', size: 10, sha256: sha('a'), epk: 'short' })).body.reason, 'bad-key');
  assert.equal((await mk({ filename: 'big.mp4', size: 200 * 1024 * 1024, sha256: sha('a') })).body.reason, 'insufficient-storage');
  const ok = await mk({ filename: '../../etc/pass wd.JPG', size: 10, sha256: sha('a') });
  assert.equal(ok.status, 200); assert.equal(ok.body.transfer.filename, 'pass wd.jpg', 'directory parts stripped');
  await sql((t) => t`update nsignage.device_receivers set last_seen_at = now() - interval '5 minutes' where device_id = ${pi.deviceId}`);
  const off = await mk({ filename: 'a.jpg', size: 10, sha256: sha('a') });
  assert.equal(off.status, 409); assert.equal(off.body.reason, 'receiver-offline', 'the Pi checks in, only its upload service is silent');
  const eve = new Client('eve.k'); await register(eve, 'eve.k');
  assert.equal((await eve.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: 10, sha256: sha('a'), epk: newEpk().epk } })).status, 404);
  assert.equal((await eve.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).status, 404);
});

test('receiver status: each failure is named precisely (offline, tunnel, agent down but receiver up, auth)', async () => {
  const { owner, pi } = await ownerWithPi('kim');
  const target = async () => (await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver;
  const mk = () => owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: 10, sha256: sha('a'), epk: newEpk().epk } });
  // receiver running but no tunnel hostname configured
  pi.receiverKey = b64u(rawP256());
  assert.equal((await rcv(pi, 'heartbeat', { publicKey: pi.receiverKey, version: '1.1.0' })).status, 200);
  assert.equal((await target()).status, 'tunnel-not-configured');
  assert.equal((await mk()).body.reason, 'tunnel-not-configured');
  // ready
  await withReceiver(pi);
  assert.equal((await target()).status, 'ready');
  // agent (V2.1) silent but the receiver reports: the receiver can still take the file
  await sql((t) => t`update nsignage.devices set last_seen_at = now() - interval '1 hour' where id = ${pi.deviceId}`);
  assert.equal((await target()).status, 'ready');
  assert.equal((await mk()).status, 200);
  // both silent: the whole display is offline
  await sql((t) => t`update nsignage.device_receivers set last_seen_at = now() - interval '1 hour' where device_id = ${pi.deviceId}`);
  const off = await target();
  assert.equal(off.status, 'display-offline'); assert.match(off.message, /last report \d+ min ago/);
  assert.equal((await mk()).body.reason, 'display-offline');
  // agent back, receiver still silent
  assert.equal((await pi.sync()).status, 200);
  assert.equal((await target()).status, 'receiver-offline');
  // receiver comes back with a wrong secret: authentication failure, not "offline"
  assert.equal((await rcv(pi, 'heartbeat', { publicKey: pi.receiverKey }, 'wrong-secret-'.padEnd(43, 'y'))).status, 401);
  assert.equal((await target()).status, 'receiver-auth-failed');
  // the next good heartbeat clears it
  await withReceiver(pi);
  assert.equal((await target()).status, 'ready');
  // another customer learns nothing
  const eve = new Client('eve.kim'); await register(eve, 'eve.kim');
  const other = await eve.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } });
  assert.equal(other.status, 404); assert.ok(!JSON.stringify(other.body).includes('receiver'));
});

test('only the Pi completes a transfer: online check, verified result, idempotent, isolated between devices', async () => {
  const { owner, pi } = await ownerWithPi('liam');
  const { pi: other } = await ownerWithPi('liam.other');
  await withReceiver(pi); await withReceiver(other);
  const a = await sendFile(owner, pi);
  const check = (who, body) => rcv(who, 'check', { transferId: a.id, size: JPEG.length, sha256: sha(JPEG), epk: a.epk.hash, phase: 'start', ...body });
  assert.equal((await check(pi)).body.allowed, true);
  assert.equal((await check(pi, { epk: newEpk().hash })).body.allowed, false, 'a different browser key is refused');
  assert.equal((await check(pi, { size: 1 })).body.allowed, false);
  assert.equal((await check(other)).body.reason, 'no-transfer', 'another Pi cannot use this transfer');
  assert.equal((await status(owner, a.id)).body.transfer.state, 'created', 'not complete until the Pi reports');
  assert.equal((await piReports(other, a.id, JPEG)).status, 404, 'another Pi cannot complete it');
  assert.equal((await piReports(pi, a.id, JPEG, { savedAs: 'promo.sh' })).status, 400);
  await piReports(pi, a.id, JPEG, { sha256: sha('different') });
  let t = (await status(owner, a.id)).body.transfer;
  assert.equal(t.state, 'failed'); assert.equal(t.reason, 'checksum-mismatch');
  const k2 = newEpk();
  const resumed = await owner.call(transfer, { method: 'POST', query: { action: 'ticket' }, body: { transferId: a.id, epk: k2.epk } });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.transfer.state, 'created');
  assert.equal(verifyTicket(resumed.body.ticket).epk, k2.hash, 'resume with a NEW browser key');
  assert.equal((await check(pi, { epk: k2.hash })).body.allowed, true);
  assert.equal((await piReports(pi, a.id, JPEG, { savedAs: 'promo_1.jpg' })).body.state, 'completed');
  t = (await status(owner, a.id)).body.transfer;
  assert.equal(t.verified, true); assert.equal(t.verification, 'sha256-verified-on-pi'); assert.equal(t.savedAs, 'promo_1.jpg');
  assert.equal((await piReports(pi, a.id, JPEG, { savedAs: 'promo_9.jpg' })).body.duplicate, true, 'repeated report changes nothing');
  assert.equal((await status(owner, a.id)).body.transfer.savedAs, 'promo_1.jpg');
  assert.equal((await check(pi, { epk: k2.hash })).body.allowed, false, 'a completed transfer cannot be written again');
});

test('cancel, expiry and device removal stop the Pi at its next check', async () => {
  const { owner, pi } = await ownerWithPi('mia');
  await withReceiver(pi);
  const check = (x) => rcv(pi, 'check', { transferId: x.id, size: JPEG.length, sha256: sha(JPEG), epk: x.epk.hash, phase: 'finish' });
  const a = await sendFile(owner, pi);
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'cancel' }, body: { transferId: a.id } })).body.transfer.state, 'cancelled');
  assert.equal((await check(a)).body.reason, 'cancelled');
  const b = await sendFile(owner, pi);
  await sql((t) => t`update nsignage.transfers set expires_at = now() - interval '1 second' where id = ${b.id}`);
  assert.equal((await check(b)).body.reason, 'expired');
  const run = await new Client('cron').call(cron, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(run.status, 200); assert.ok(run.body.expired >= 1); assert.equal(run.body.copiesDeleted, undefined, 'no media copies exist to clean up');
  assert.equal((await status(owner, b.id)).body.transfer.state, 'expired');
  const c = await sendFile(owner, pi);
  assert.equal((await owner.call(devices, { method: 'DELETE', query: { deviceId: pi.deviceId } })).status, 200);
  assert.equal((await status(owner, c.id)).body.transfer.state, 'cancelled');
  const [r] = await sql((t) => t`select count(*)::int as n from nsignage.device_receivers where device_id = ${pi.deviceId}`);
  assert.equal(r.n, 0, 'a new owner pins the receiver key afresh');
});

test('a changed receiver key is not used until the owner confirms its fingerprint; only the owner can', async () => {
  const { owner, pi } = await ownerWithPi('nina');
  await withReceiver(pi);
  const newKey = b64u(rawP256());
  assert.equal((await rcv(pi, 'heartbeat', { publicKey: newKey, hostname: pi.receiverHost })).body.keyStatus, 'pending');
  const target = (await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver;
  assert.equal(target.publicKey, pi.receiverKey, 'the pinned key is still the one served');
  assert.equal(target.keyChangePending, true);
  const blocked = await owner.call(transfer, { method: 'POST', query: { action: 'create' }, body: { deviceId: pi.deviceId, filename: 'a.jpg', size: 10, sha256: sha('a'), epk: newEpk().epk } });
  assert.equal(blocked.body.reason, 'key-change-pending');
  const eve = new Client('eve.n'); await register(eve, 'eve.n');
  assert.equal((await eve.call(transfer, { method: 'POST', query: { action: 'confirm-key' }, body: { deviceId: pi.deviceId, fingerprint: target.pendingFingerprint } })).status, 404);
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'confirm-key' }, body: { deviceId: pi.deviceId, fingerprint: 'f'.repeat(64) } })).status, 409);
  assert.equal((await owner.call(transfer, { method: 'POST', query: { action: 'confirm-key' }, body: { deviceId: pi.deviceId, fingerprint: target.pendingFingerprint } })).status, 200);
  assert.equal((await owner.call(transfer, { query: { action: 'target', deviceId: pi.deviceId } })).body.receiver.publicKey, newKey);
});

test('transfer list and views carry metadata only (no URLs, tickets, keys or owner ids)', async () => {
  const { owner, pi } = await ownerWithPi('uma');
  await withReceiver(pi);
  await sendFile(owner, pi);
  const l = await owner.call(transfer, { query: { action: 'list' } });
  assert.equal(l.status, 200);
  const text = JSON.stringify(l.body);
  for (const bad of ['nsinages.in', 'nst1.', 'userId', pi.receiverKey, 'blob']) assert.ok(!text.includes(bad), bad);
  assert.equal(l.body.transfers[0].method, 'direct');
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
  assert.equal(h.body.blob, undefined, 'no media storage is configured or used');
  assert.equal(h.body.upload.mode, 'direct-e2e'); assert.equal(h.body.upload.ticketKey, true);
  assert.equal(h.body.upload.mediaStoredOnWebsite, false); assert.match(h.body.upload.keyId, /^[0-9a-f]{16}$/);
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

// ---- Add Device → Pi Name → Find IP (hosted path) ---------------------------------

test('Find IP matches the Pi Name against username or hostname, never the nickname; clear not-found answer', async () => {
  const ip = '198.51.100.230';
  const owner = new Client('findname', ip); await register(owner, 'find.name.owner');
  const pi = new Pi(ip, { hostname: 'ns001' });
  await pi.sync();
  const find1 = (identifier) => owner.call(find, { query: { identifier } });
  const byHost = (await find1('ns001')).body;
  assert.equal(byHost.found, true); assert.equal(byHost.devices[0].matchedBy, 'hostname');
  assert.equal(byHost.devices[0].ip, '192.168.1.50', 'IP as reported by the Pi');
  assert.equal((await find1('NS001.local')).body.devices[0].matchedBy, 'hostname');
  assert.equal((await find1('nsignage')).body.devices[0].matchedBy, 'username');
  const miss = (await find1('lobby')).body;
  assert.equal(miss.found, false); assert.equal(miss.reason, 'not-found'); assert.ok(miss.otherCount >= 1);
  assert.equal((await find1('a b')).status, 400);
  // claim with a nickname: the nickname is the display name, the identity stays the Pi's
  const claimed = await owner.call(devices, { method: 'POST', body: { claimNonce: byHost.devices[0].claimNonce, name: 'Lobby' } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.device.name, 'Lobby');
  assert.equal(claimed.body.device.deviceId, pi.deviceId);
  assert.equal(claimed.body.device.hostname, 'ns001');
});

test('a Wi-Fi change needs no new registration: same device id + secret, new network and IP, transfers still delivered', async () => {
  const { owner, pi } = await ownerWithPi('wifi.move', { protocol: 2, capabilities: ['sha256'] });
  pi.ip = '203.0.113.200';                         // the Pi now reaches the internet through another router
  assert.equal((await pi.sync({ localIp: '10.0.0.42' })).status, 200);
  const list = (await owner.call(devices)).body.devices;
  assert.equal(list.length, 1);
  assert.equal(list[0].ip, '10.0.0.42'); assert.equal(list[0].online, true); assert.equal(list[0].name, 'Shop Display');
  await withReceiver(pi);                             // the receiver also follows the Pi to the new network
  const a = await sendFile(owner, pi);
  await piReports(pi, a.id, JPEG);
  assert.equal((await status(owner, a.id)).body.transfer.state, 'completed');
  // a different secret for the same device id is still refused (identity cannot be taken over)
  const thief = new Pi(pi.ip); thief.deviceId = pi.deviceId;
  assert.equal((await thief.sync()).status, 401);
});

test('manually saved records stay "saved" (never falsely verified) when a Pi is added with Find IP', async () => {
  const ip = '198.51.100.231';
  const c = new Client('saved.keep', ip); await register(c, 'saved.keep.owner');
  const saved = await save(c, { name: 'Old Lobby Screen', ip: '192.168.1.77', hostname: 'ns009' });
  assert.equal(saved.body.verified, false);
  const pi = new Pi(ip, { hostname: 'ns002' });
  await pi.sync();
  const found = (await c.call(find, { query: { identifier: 'ns002' } })).body.devices[0];
  assert.equal((await c.call(devices, { method: 'POST', body: { claimNonce: found.claimNonce } })).status, 200);
  const list = (await c.call(devices)).body.devices;
  const old = list.find((d) => d.name === 'Old Lobby Screen');
  assert.equal(old.registration, 'saved'); assert.equal(old.status, 'unknown'); assert.equal(old.online, false);
  assert.equal(list.find((d) => d.deviceId === pi.deviceId).registration, 'verified');
});

test('Enter IP manually (hosted): the IP only narrows the search; the Pi must check in from this network with that IP and name', async () => {
  const ip = '198.51.100.232';
  const c = new Client('manual.ip', ip); await register(c, 'manual.ip.owner');
  const pi = new Pi(ip, { hostname: 'ns003', localIp: '192.168.1.73' });
  await pi.sync();
  const find1 = (query) => c.call(find, { query });
  const hit = (await find1({ identifier: 'ns003', ip: '192.168.1.73' })).body;
  assert.equal(hit.found, true); assert.equal(hit.devices[0].ip, '192.168.1.73'); assert.ok(hit.devices[0].claimNonce);
  const wrongIp = (await find1({ identifier: 'ns003', ip: '192.168.1.74' })).body;
  assert.equal(wrongIp.found, false); assert.equal(wrongIp.reason, 'not-found');
  assert.equal((await find1({ identifier: 'ns999', ip: '192.168.1.73' })).body.found, false, 'IP alone does not match a different name');
  assert.equal((await find1({ identifier: 'ns003', ip: '192.168.1.300' })).status, 400);
  // the same IP typed from another network finds nothing (no proof of being on the Pi's Wi-Fi)
  const away = new Client('manual.ip.away', '203.0.113.99'); await register(away, 'manual.ip.away');
  assert.equal((await away.call(find, { query: { identifier: 'ns003', ip: '192.168.1.73' } })).body.found, false);
  // Connect = the usual single-use, network-bound claim
  const claimed = await c.call(devices, { method: 'POST', body: { claimNonce: hit.devices[0].claimNonce, name: 'Manual Screen' } });
  assert.equal(claimed.status, 200); assert.equal(claimed.body.device.registration, 'verified');
  // no Pi answering: "Save without connecting" keeps it saved, never verified
  const saved = await save(away, { name: 'Unreachable Screen', ip: '192.168.1.73', hostname: 'ns003' });
  assert.equal(saved.status, 200); assert.equal(saved.body.verified, false); assert.equal(saved.body.device.registration, 'saved');
});

export { ORIGIN };
