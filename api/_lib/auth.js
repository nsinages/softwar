// =============================================
// N Signage — Customer accounts, sessions and device ownership (cloud mode)
//
// Accounts  : username + scrypt password hash (see password.js). No email.
// Sessions  : random 256-bit token in an HttpOnly, Secure, SameSite=Strict
//             cookie ("__Host-ns_acct"). Only its SHA-256 is stored in Redis,
//             with an absolute expiry. Every session is also listed under its
//             account (ns:user-sess:<id>) so it can be revoked: logout, "sign
//             out everywhere", password change and recovery.
// Ownership : a Pi belongs to exactly one account (ns:dev-owner:<deviceId>).
//
// Legacy    : before accounts, each browser had an anonymous "ns_session"
//             cookie (ns:sess:<hash>) and the Pis it added (ns:owners,
//             ns:browser-devs). That data is kept untouched and only read by
//             the one-time "link my old devices" flow in api/devices.js.
// =============================================
import {
  redis, keys, sha256, randomToken, httpError, getDevice, DEVICE_ID_RX, parse,
} from './cloud.js';

const LEGACY_COOKIE = 'ns_session';
const SESSION_DAYS = Math.min(90, Math.max(1, Number(process.env.NSIGNAGE_SESSION_DAYS) || 30));
export const SESSION_TTL_S = SESSION_DAYS * 24 * 3600;
const MAX_SESSIONS_PER_USER = 20;

// ---- Cookies ---------------------------------------------------------------

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function isLocalHost(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
}

// "__Host-" cookies must be Secure, Path=/ and have no Domain, so they cannot
// be set or overwritten by a sibling subdomain. Plain http://localhost cannot
// use Secure, so local development uses the unprefixed name.
function accountCookieName(req) {
  return isLocalHost(req) ? 'ns_acct' : '__Host-ns_acct';
}

function accountCookie(req, value, maxAge) {
  return [
    `${accountCookieName(req)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(isLocalHost(req) ? [] : ['Secure']),
  ].join('; ');
}

function validToken(token) {
  return typeof token === 'string' && token.length >= 20 && token.length <= 200;
}

// ---- Accounts ----------------------------------------------------------------

export async function getUser(userId) {
  if (typeof userId !== 'string' || userId.length > 64) return null;
  return (await redis().get(keys.user(userId))) || null;
}

export async function getUserByUsername(username) {
  const id = await redis().get(keys.username(username));
  return id ? getUser(String(id)) : null;
}

export async function saveUser(user) {
  await redis().set(keys.user(user.id), user);
}

export const userView = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName || null,
  createdAt: u.createdAt,
  passwordChangedAt: u.passwordChangedAt || null,
  recoveryKeyCreatedAt: u.recoveryKeyCreatedAt || null,
});

// ---- Sessions ----------------------------------------------------------------

export async function createSession(req, res, userId) {
  const r = redis();
  const token = randomToken();
  const hash = sha256(token);
  const now = Date.now();
  const ua = String(req.headers['user-agent'] || '').slice(0, 160);
  await r.set(keys.userSession(hash), { userId, createdAt: now, expiresAt: now + SESSION_TTL_S * 1000, ua }, { ex: SESSION_TTL_S });
  await r.sadd(keys.userSessions(userId), hash);
  await r.expire(keys.userSessions(userId), SESSION_TTL_S);
  await pruneSessions(userId);
  res.setHeader('Set-Cookie', accountCookie(req, token, SESSION_TTL_S));
  return hash;
}

/** Drop index entries of expired sessions; cap the number of live sessions. */
async function pruneSessions(userId) {
  const r = redis();
  const hashes = (await r.smembers(keys.userSessions(userId))) || [];
  if (hashes.length <= 5) return;
  const records = await r.mget(...hashes.map(keys.userSession));
  const live = [];
  for (let i = 0; i < hashes.length; i += 1) {
    if (records[i]) live.push({ hash: hashes[i], createdAt: records[i].createdAt || 0 });
    else await r.srem(keys.userSessions(userId), hashes[i]);
  }
  live.sort((a, b) => a.createdAt - b.createdAt);
  while (live.length > MAX_SESSIONS_PER_USER) {
    const oldest = live.shift();
    await r.del(keys.userSession(oldest.hash));
    await r.srem(keys.userSessions(userId), oldest.hash);
  }
}

function sessionHash(req) {
  const token = readCookie(req, accountCookieName(req));
  return validToken(token) ? sha256(token) : null;
}

export async function destroySession(req, res) {
  const hash = sessionHash(req);
  if (hash) {
    const r = redis();
    const s = await r.get(keys.userSession(hash));
    await r.del(keys.userSession(hash));
    if (s?.userId) await r.srem(keys.userSessions(s.userId), hash);
  }
  res.setHeader('Set-Cookie', accountCookie(req, '', 0));
}

/** Revoke every session of an account, optionally keeping one (the caller's). Returns the count revoked. */
export async function revokeSessions(userId, keepHash = null) {
  const r = redis();
  const hashes = (await r.smembers(keys.userSessions(userId))) || [];
  let n = 0;
  for (const h of hashes) {
    if (h === keepHash) continue;
    await r.del(keys.userSession(h));
    await r.srem(keys.userSessions(userId), h);
    n += 1;
  }
  return n;
}

/** { user, sessionHash } for the logged-in customer, or null. */
export async function currentUser(req) {
  const hash = sessionHash(req);
  if (!hash) return null;
  const session = await redis().get(keys.userSession(hash));
  if (!session?.userId) return null;
  if (session.expiresAt && Date.now() > session.expiresAt) return null;
  const user = await getUser(session.userId);
  if (!user || user.disabled) return null;
  // Sessions created before the latest password change are no longer valid
  if (user.sessionsValidAfter && session.createdAt < user.sessionsValidAfter) return null;
  return { user, sessionHash: hash };
}

export async function requireUser(req) {
  const cur = await currentUser(req);
  if (!cur) throw httpError(401, 'Please log in again.', 'not-logged-in');
  return cur;
}

// ---- Device ownership --------------------------------------------------------

export async function userDeviceMeta(userId) {
  const raw = (await redis().hgetall(keys.userDevices(userId))) || {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) out[id] = parse(v);
  return out;
}

export async function deviceOwnerId(deviceId) {
  const v = await redis().get(keys.deviceOwner(deviceId));
  return v ? String(v) : null;
}

/** Logged-in customer who owns this Pi, plus the Pi's latest state. */
export async function requireOwnedDevice(req, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) throw httpError(400, 'Invalid device id');
  const { user } = await requireUser(req);
  if ((await deviceOwnerId(deviceId)) !== user.id) {
    throw httpError(404, 'This Raspberry Pi is not registered to your account.', 'not-owner');
  }
  const device = await getDevice(deviceId);
  if (!device) throw httpError(404, 'Raspberry Pi not found in the cloud');
  return { user, device };
}

export const MAX_DEVICES_PER_USER = 200;

/**
 * Link a Pi to an account. Atomic: SET NX on the owner key means two accounts
 * can never both own the same Pi. `via` records how ownership was proven.
 */
export async function linkDevice(user, device, { name, location, via }) {
  const r = redis();
  const meta = await userDeviceMeta(user.id);
  if (meta[device.deviceId]) throw httpError(409, 'This Raspberry Pi is already in your account.', 'duplicate');
  if (Object.keys(meta).length >= MAX_DEVICES_PER_USER) throw httpError(409, 'Device limit reached for this account.');
  const set = await r.set(keys.deviceOwner(device.deviceId), user.id, { nx: true });
  if (set !== 'OK') {
    const owner = await deviceOwnerId(device.deviceId);
    if (owner !== user.id) {
      throw httpError(409, 'This Raspberry Pi is registered to another account. The owner must remove it first.', 'owned-by-other');
    }
  }
  const entry = { name: name || device.hostname || device.username, location: location || '', addedAt: Date.now(), via };
  await r.hset(keys.userDevices(user.id), { [device.deviceId]: JSON.stringify(entry) });
  console.log('[N-SIGNAGE CLOUD] device linked', JSON.stringify({ user: user.id, deviceId: device.deviceId, via }));
  return entry;
}

// ---- Legacy anonymous browser session (read-only) ------------------------------

/** The pre-accounts browser id from the old "ns_session" cookie, or null. */
export async function legacyBrowserId(req) {
  const token = readCookie(req, LEGACY_COOKIE);
  if (!validToken(token)) return null;
  const s = await redis().get(keys.session(sha256(token)));
  // Only anonymous browser sessions ({ id }); ignore anything else stored there
  return s?.id && !s.accountId ? String(s.id) : null;
}

export async function legacyBrowserDevices(browserId) {
  const raw = (await redis().hgetall(keys.browserDevices(browserId))) || {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) if (DEVICE_ID_RX.test(id)) out[id] = parse(v);
  return out;
}
