// =============================================
// N Signage — Customer accounts, sessions and device ownership (Supabase)
//
// Accounts  : nsignage.users — username + scrypt password hash (password.js).
//             No email anywhere.
// Sessions  : random 256-bit token in an HttpOnly, Secure, SameSite=Strict
//             cookie ("__Host-ns_acct"); only its SHA-256 is stored, in
//             nsignage.user_sessions, with an absolute expiry. Logout,
//             "sign out everywhere", password change and recovery delete rows.
// Ownership : nsignage.devices.owner_id — exactly one account per Pi; changed
//             only by single-statement claims in the 'system' RLS context.
//
// Legacy    : pre-accounts browser sessions imported from Redis live in
//             nsignage.legacy_browser_sessions / legacy_browser_devices and are
//             only read by the one-time "link my old devices" flow.
// =============================================
import { sha256, randomToken, httpError, DEVICE_ID_RX, SAVED_ID_RX, deviceFromRow } from './cloud.js';
import { asSystem, setContext, withContext, ms } from './db.js';

const LEGACY_COOKIE = 'ns_session';
const SESSION_DAYS = Math.min(90, Math.max(1, Number(process.env.NSIGNAGE_SESSION_DAYS) || 30));
export const SESSION_TTL_S = SESSION_DAYS * 24 * 3600;
const MAX_SESSIONS_PER_USER = 20;
const LAST_SEEN_EVERY_MS = 10 * 60_000;
export const MAX_DEVICES_PER_USER = 200;

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

const LOCAL_DEV_HOST_RX = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

/**
 * Local development over plain http (npm run dev / dev:cloud), opened as
 * localhost or by this computer's LAN address. Never true on Vercel or for an
 * https request, so the hosted website always uses the strict cookie.
 */
function isLocalHost(req) {
  if (process.env.VERCEL) return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https' || req.socket?.encrypted) return false;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return LOCAL_DEV_HOST_RX.test(host);
}

// "__Host-" cookies must be Secure, Path=/ and have no Domain, so a sibling
// subdomain cannot set or overwrite them. Plain http (local development on
// localhost or this PC's LAN address) cannot use Secure, so it uses the
// unprefixed name.
function accountCookieName(req) {
  return isLocalHost(req) ? 'ns_acct' : '__Host-ns_acct';
}

/** maxAge null → browser-session cookie (deleted when the browser closes). */
function accountCookie(req, value, maxAge) {
  return [
    `${accountCookieName(req)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(maxAge === null ? [] : [`Max-Age=${maxAge}`]),
    ...(isLocalHost(req) ? [] : ['Secure']),
  ].join('; ');
}

// "Remember me" off: server-side session lasts 12 hours and the cookie is not kept after the browser closes
export const SHORT_SESSION_TTL_S = 12 * 3600;

const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 200;

function sessionHash(req) {
  const token = readCookie(req, accountCookieName(req));
  return validToken(token) ? sha256(token) : null;
}

// ---- Accounts ----------------------------------------------------------------

export function userFromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || null,
    passwordHash: r.password_hash,
    recoveryHash: r.recovery_hash || null,
    recoveryKeyCreatedAt: ms(r.recovery_created_at),
    passwordChangedAt: ms(r.password_changed_at),
    createdAt: ms(r.created_at),
    lastLoginAt: ms(r.last_login_at),
    accountStatus: r.account_status || (r.disabled ? 'disabled' : 'active'),
    disabled: Boolean(r.disabled) || (r.account_status && r.account_status !== 'active'),
  };
}

export const userView = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName || null,
  accountStatus: u.accountStatus || 'active',
  lastLoginAt: u.lastLoginAt || null,
  createdAt: u.createdAt,
  passwordChangedAt: u.passwordChangedAt || null,
  recoveryKeyCreatedAt: u.recoveryKeyCreatedAt || null,
});

export async function getUserByUsername(t, username) {
  const [r] = await t`select * from nsignage.users where username = ${username}`;
  return userFromRow(r);
}

// ---- Sessions ----------------------------------------------------------------

/** Create a session inside transaction `t` (system context) and set the cookie. */
export async function createSession(t, req, res, userId, { remember = true } = {}) {
  const token = randomToken();
  const ua = String(req.headers['user-agent'] || '').slice(0, 160);
  const ttl = remember ? SESSION_TTL_S : SHORT_SESSION_TTL_S;
  await t`insert into nsignage.user_sessions (token_hash, user_id, expires_at, user_agent, persistent)
          values (${sha256(token)}, ${userId}, now() + make_interval(secs => ${ttl}), ${ua}, ${remember})`;
  // Keep at most MAX_SESSIONS_PER_USER active sessions (oldest revoked first)
  await t`update nsignage.user_sessions set revoked_at = now()
          where user_id = ${userId} and revoked_at is null
            and token_hash not in (select token_hash from nsignage.user_sessions
                                   where user_id = ${userId} and revoked_at is null
                                   order by created_at desc limit ${MAX_SESSIONS_PER_USER})`;
  await t`update nsignage.users set last_login_at = now() where id = ${userId}`;
  res.setHeader('Set-Cookie', accountCookie(req, token, remember ? ttl : null));
}

/** Log out: the session is revoked in the database (kept 7 days for audit) and the cookie cleared. */
export async function destroySession(req, res) {
  const hash = sessionHash(req);
  if (hash) await asSystem((t) => t`update nsignage.user_sessions set revoked_at = now() where token_hash = ${hash} and revoked_at is null`);
  res.setHeader('Set-Cookie', accountCookie(req, '', 0));
}

/** Revoke every active session of an account except `keepHash`. Returns the number revoked. */
export async function revokeSessions(t, userId, keepHash = null) {
  const rows = await t`update nsignage.user_sessions set revoked_at = now()
                       where user_id = ${userId} and token_hash <> ${keepHash || ''} and revoked_at is null
                       returning 1`;
  return rows.length;
}

/** Look up the session inside an open transaction (switches to the system context). */
async function lookupSession(t, hash) {
  await setContext(t, 'system');
  const [r] = await t`
    select s.token_hash, s.last_seen_at, u.*
    from nsignage.user_sessions s join nsignage.users u on u.id = s.user_id
    where s.token_hash = ${hash} and s.expires_at > now() and s.revoked_at is null
      and not u.disabled and u.account_status = 'active'`;
  if (!r) return null;
  if (Date.now() - ms(r.last_seen_at) > LAST_SEEN_EVERY_MS) {
    await t`update nsignage.user_sessions set last_seen_at = now() where token_hash = ${hash}`;
  }
  return userFromRow(r);
}

/** { user, sessionHash } for the logged-in customer, or null. */
export async function currentUser(req) {
  const hash = sessionHash(req);
  if (!hash) return null;
  const user = await withContext('none', {}, (t) => lookupSession(t, hash));
  return user ? { user, sessionHash: hash } : null;
}

export async function requireUser(req) {
  const cur = await currentUser(req);
  if (!cur) throw httpError(401, 'Please log in again.', 'not-logged-in');
  return cur;
}

/**
 * Authenticate the customer and run `fn(t, { user, sessionHash })` in ONE
 * transaction whose RLS context is that customer ('user').
 */
export async function withCustomer(req, fn) {
  const hash = sessionHash(req);
  if (!hash) throw httpError(401, 'Please log in again.', 'not-logged-in');
  return withContext('none', {}, async (t) => {
    const user = await lookupSession(t, hash);
    if (!user) throw httpError(401, 'Please log in again.', 'not-logged-in');
    await setContext(t, 'user', { user: user.id });
    return fn(t, { user, sessionHash: hash });
  });
}

// ---- Device ownership --------------------------------------------------------

/** A Pi owned by the current customer (RLS context 'user'), or 404. */
export async function requireOwnedDevice(t, user, deviceId, { allowSaved = false } = {}) {
  if (!(DEVICE_ID_RX.test(deviceId || '') || (allowSaved && SAVED_ID_RX.test(deviceId || '')))) {
    throw httpError(400, 'Invalid device id');
  }
  const [r] = await t`select * from nsignage.devices where id = ${deviceId} and owner_id = ${user.id}`;
  if (!r) throw httpError(404, 'This Raspberry Pi is not registered to your account.', 'not-owner');
  return deviceFromRow(r);
}

/**
 * Link a Pi to an account, atomically: the UPDATE only succeeds while the Pi
 * has no owner, so two accounts can never both own it. Runs in the 'system'
 * context of the caller's transaction and switches back to 'user'.
 */
export async function linkDevice(t, user, deviceId, { name, location, via }) {
  await setContext(t, 'system');
  const [{ n }] = await t`select count(*)::int as n from nsignage.devices where owner_id = ${user.id}`;
  if (n >= MAX_DEVICES_PER_USER) throw httpError(409, 'Device limit reached for this account.');
  const [r] = await t`
    update nsignage.devices
       set owner_id = ${user.id}, added_at = now(), added_via = ${via},
           nickname = left(coalesce(nullif(${name || ''}, ''), hostname, pi_username), 64),
           location = nullif(${location || ''}, '')
     where id = ${deviceId} and owner_id is null
    returning *`;
  if (!r) {
    const [cur] = await t`select owner_id from nsignage.devices where id = ${deviceId}`;
    if (!cur) throw httpError(404, 'Raspberry Pi not found in the cloud');
    if (cur.owner_id === user.id) throw httpError(409, 'This Raspberry Pi is already in your account.', 'duplicate');
    throw httpError(409, 'This Raspberry Pi is registered to another account. The owner must remove it first.', 'owned-by-other');
  }
  await t`insert into nsignage.security_events (event, user_id, device_id, detail)
          values ('device-linked', ${user.id}, ${deviceId}, ${t.json({ via })})`;
  await t`insert into nsignage.device_events (device_id, event_type, ip_address, details)
          values (${deviceId}, 'registered', ${r.local_ip}, ${t.json({ via })})`;
  // A record this customer saved earlier for this Pi (same expected UID) is now replaced by the verified one
  const merged = await t`delete from nsignage.devices
                         where owner_id = ${user.id} and registration = 'saved' and expected_device_uid = ${deviceId}
                         returning nickname`;
  if (merged.length && !name) {
    const [m] = await t`update nsignage.devices set nickname = ${merged[0].nickname} where id = ${deviceId} returning *`;
    Object.assign(r, m);
  }
  // back to the customer's own context for the rest of the request
  await setContext(t, 'user', { user: user.id });
  console.log('[N-SIGNAGE CLOUD] device linked', JSON.stringify({ user: user.id, deviceId, via }));
  return deviceFromRow(r);
}

// ---- Legacy anonymous browser session (read-only) ------------------------------

/** The pre-accounts browser id from the old "ns_session" cookie, or null. Needs 'system' context. */
export async function legacyBrowserId(t, req) {
  const token = readCookie(req, LEGACY_COOKIE);
  if (!validToken(token)) return null;
  const [r] = await t`select browser_id from nsignage.legacy_browser_sessions where token_hash = ${sha256(token)}`;
  return r ? r.browser_id : null;
}
