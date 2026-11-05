// /api/auth?action=<action> — customer accounts (username + password, no email).
//
//   GET  action=me                   → { ok, user } | 401
//   POST action=register             { username, password, displayName? } → { ok, user, recoveryKey }
//   POST action=login                { username, password }
//   POST action=logout
//   POST action=logout-others        sign out every other session of this account
//   POST action=change-password      { currentPassword, newPassword }   (signs out other sessions)
//   POST action=recover              { username, recoveryKey, newPassword } → { ok, user, recoveryKey }
//   POST action=regenerate-recovery  { password } → { ok, recoveryKey }
//
// The recovery key replaces email-based password reset. It is shown once; only
// its hash is stored. Staff can issue a new one with scripts/nsignage-admin.mjs
// after verifying the customer offline (see docs/ACCOUNTS-AND-TRANSFERS.md).
import crypto from 'node:crypto';
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin, rateLimit, clientIp, safeEqual,
} from './_lib/cloud.js';
import {
  createSession, destroySession, currentUser, requireUser, revokeSessions, getUserByUsername, saveUser, userView,
} from './_lib/auth.js';
import {
  hashPassword, verifyPassword, needsRehash, validatePassword, validateUsername, normalizeUsername,
  newRecoveryKey, hashRecoveryKey, PASSWORD_MAX,
} from './_lib/password.js';

const FAIL_LIMIT = 10;           // failed logins per username …
const FAIL_WINDOW_S = 15 * 60;   // … within 15 minutes, then that username is locked for the window

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '';
}

async function checkLockout(username) {
  const n = Number(await redis().get(keys.loginFail(username))) || 0;
  if (n >= FAIL_LIMIT) {
    const err = httpError(429, 'Too many failed attempts for this account. Please wait 15 minutes and try again.', 'locked');
    err.retryAfter = FAIL_WINDOW_S;
    throw err;
  }
}

async function recordFailure(username) {
  const r = redis();
  const n = await r.incr(keys.loginFail(username));
  if (n === 1) await r.expire(keys.loginFail(username), FAIL_WINDOW_S);
  if (n === FAIL_LIMIT) console.warn('[N-SIGNAGE AUTH] username locked after failed attempts', JSON.stringify({ username }));
}

function newRecovery() {
  const recoveryKey = newRecoveryKey();
  return { recoveryKey, recoveryHash: hashRecoveryKey(recoveryKey), recoveryKeyCreatedAt: Date.now() };
}

async function register(req, res) {
  await rateLimit('register', clientIp(req), 5, 3600);
  const body = readJsonBody(req);
  const username = normalizeUsername(body.username);
  validateUsername(username);
  validatePassword(body.password, username);

  const { recoveryKey, ...recovery } = newRecovery();
  const user = {
    id: crypto.randomUUID(),
    username,
    displayName: cleanText(body.displayName, 80) || null,
    passwordHash: await hashPassword(body.password),
    ...recovery,
    createdAt: Date.now(),
    passwordChangedAt: Date.now(),
  };
  // NX: two sign-ups for the same username cannot both succeed
  const claimed = await redis().set(keys.username(username), user.id, { nx: true });
  if (claimed !== 'OK') throw httpError(409, 'This username is already taken. Please choose another.', 'username-taken');
  await saveUser(user);
  await createSession(req, res, user.id);
  console.log('[N-SIGNAGE AUTH] account created', JSON.stringify({ user: user.id, username }));
  send(res, 200, { ok: true, user: userView(user), recoveryKey });
}

async function login(req, res) {
  const body = readJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = body.password;
  if (!username || username.length > 64 || typeof password !== 'string' || !password || password.length > PASSWORD_MAX) {
    throw httpError(400, 'Enter your username and password.');
  }
  await rateLimit('login-ip', clientIp(req), 30, 600);
  await checkLockout(username);

  const user = await getUserByUsername(username);
  const ok = await verifyPassword(password, user?.passwordHash); // same work for unknown users
  if (!user || !ok || user.disabled) {
    await recordFailure(username);
    console.warn('[N-SIGNAGE AUTH] login failed', JSON.stringify({ username, known: Boolean(user) }));
    throw httpError(401, 'Incorrect username or password.', 'bad-credentials');
  }
  await redis().del(keys.loginFail(username));
  if (needsRehash(user.passwordHash)) {
    user.passwordHash = await hashPassword(password);
    await saveUser(user);
  }
  await createSession(req, res, user.id);
  console.log('[N-SIGNAGE AUTH] login', JSON.stringify({ user: user.id }));
  send(res, 200, { ok: true, user: userView(user) });
}

async function changePassword(req, res) {
  const { user, sessionHash } = await requireUser(req);
  await rateLimit('change-password', user.id, 10, 3600);
  const body = readJsonBody(req);
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
    throw httpError(400, 'Your current password is incorrect.', 'bad-credentials');
  }
  validatePassword(body.newPassword, user.username);
  if (body.newPassword === body.currentPassword) throw httpError(400, 'The new password must be different.', 'weak-password');
  user.passwordHash = await hashPassword(body.newPassword);
  user.passwordChangedAt = Date.now();
  await saveUser(user);
  const revoked = await revokeSessions(user.id, sessionHash);
  console.log('[N-SIGNAGE AUTH] password changed', JSON.stringify({ user: user.id, revokedSessions: revoked }));
  send(res, 200, { ok: true, user: userView(user), revokedSessions: revoked });
}

async function recover(req, res) {
  const body = readJsonBody(req);
  const username = normalizeUsername(body.username);
  await rateLimit('recover-ip', clientIp(req), 10, 3600);
  if (!username || username.length > 64) throw httpError(400, 'Enter your username.');
  await rateLimit('recover-user', username, 5, 3600);
  const user = await getUserByUsername(username);
  const keyHash = hashRecoveryKey(body.recoveryKey);
  // Same response for unknown username and wrong key
  if (!user || !user.recoveryHash || user.disabled || !safeEqual(user.recoveryHash, keyHash)) {
    console.warn('[N-SIGNAGE AUTH] recovery failed', JSON.stringify({ username }));
    throw httpError(400, 'The username or recovery key is not correct.', 'bad-recovery');
  }
  validatePassword(body.newPassword, username);
  const { recoveryKey, ...recovery } = newRecovery(); // a used key is never valid again
  Object.assign(user, recovery, { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: Date.now() });
  await saveUser(user);
  const revoked = await revokeSessions(user.id);
  await redis().del(keys.loginFail(username));
  await createSession(req, res, user.id);
  console.log('[N-SIGNAGE AUTH] password reset with recovery key', JSON.stringify({ user: user.id, revokedSessions: revoked }));
  send(res, 200, { ok: true, user: userView(user), recoveryKey });
}

async function regenerateRecovery(req, res) {
  const { user } = await requireUser(req);
  await rateLimit('regen-recovery', user.id, 5, 3600);
  const body = readJsonBody(req);
  if (!(await verifyPassword(body.password, user.passwordHash))) {
    throw httpError(400, 'Your password is incorrect.', 'bad-credentials');
  }
  const { recoveryKey, ...recovery } = newRecovery();
  Object.assign(user, recovery);
  await saveUser(user);
  console.log('[N-SIGNAGE AUTH] recovery key regenerated', JSON.stringify({ user: user.id }));
  send(res, 200, { ok: true, user: userView(user), recoveryKey });
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    if (req.method === 'GET' && action === 'me') {
      const cur = await currentUser(req);
      if (!cur) return send(res, 401, { ok: false, reason: 'not-logged-in' });
      return send(res, 200, { ok: true, user: userView(cur.user) });
    }
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    requireSameOrigin(req);
    switch (action) {
      case 'register': return await register(req, res);
      case 'login': return await login(req, res);
      case 'logout':
        await destroySession(req, res);
        return send(res, 200, { ok: true });
      case 'logout-others': {
        const { user, sessionHash } = await requireUser(req);
        const revoked = await revokeSessions(user.id, sessionHash);
        return send(res, 200, { ok: true, revokedSessions: revoked });
      }
      case 'change-password': return await changePassword(req, res);
      case 'recover': return await recover(req, res);
      case 'regenerate-recovery': return await regenerateRecovery(req, res);
      case 'session':
        // Anonymous browser sessions were replaced by customer accounts
        throw httpError(410, 'Please reload the page and log in.', 'accounts-required');
      default:
        throw httpError(404, 'Unknown action');
    }
  } catch (err) {
    handleError(res, err);
  }
}
