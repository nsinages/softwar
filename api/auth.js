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
// Data: Supabase nsignage.users / nsignage.user_sessions (see supabase/migrations).
// The recovery key replaces email-based password reset. It is shown once; only
// its hash is stored. Staff can issue a new one with scripts/nsignage-admin.mjs.
import {
  send, handleError, httpError, readJsonBody, requireSameOrigin, clientIp, safeEqual, keyHash,
} from './_lib/cloud.js';
import {
  createSession, destroySession, currentUser, withCustomer, revokeSessions, getUserByUsername, userView, userFromRow,
} from './_lib/auth.js';
import {
  hashPassword, verifyPassword, needsRehash, validatePassword, validateUsername, normalizeUsername,
  newRecoveryKey, hashRecoveryKey, PASSWORD_MAX,
} from './_lib/password.js';
import { asSystem, rateLimit } from './_lib/db.js';

const FAIL_LIMIT = 10;           // failed logins per username …
const FAIL_WINDOW_S = 15 * 60;   // … within 15 minutes, then that username is locked for the window

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '';
}

// Failed-login counter: its own committed transaction (a failed login's
// rollback must never undo the count).
async function checkLockout(username) {
  const [r] = await asSystem((t) => t`
    select hits from nsignage.rate_limits
    where bucket = 'login-fail' and key_hash = ${keyHash(username)} and window_start > now() - make_interval(secs => ${FAIL_WINDOW_S})`);
  if (r && r.hits >= FAIL_LIMIT) {
    const err = httpError(429, 'Too many failed attempts for this account. Please wait 15 minutes and try again.', 'locked');
    err.retryAfter = FAIL_WINDOW_S;
    throw err;
  }
}

async function recordFailure(username, req, known) {
  await asSystem(async (t) => {
    await t`select nsignage.rate_limit_hit('login-fail', ${keyHash(username)}, ${FAIL_LIMIT}, ${FAIL_WINDOW_S})`;
    await t`insert into nsignage.security_events (event, ip_hash, detail)
            values ('login-failed', ${keyHash(clientIp(req))}, ${t.json({ known })})`;
  });
}

function newRecovery() {
  const recoveryKey = newRecoveryKey();
  return { recoveryKey, recoveryHash: hashRecoveryKey(recoveryKey) };
}

async function register(req, res) {
  await rateLimit('register', keyHash(clientIp(req)), 5, 3600);
  const body = readJsonBody(req);
  const username = normalizeUsername(body.username);
  validateUsername(username);
  validatePassword(body.password, username);
  const passwordHash = await hashPassword(body.password);
  const { recoveryKey, recoveryHash } = newRecovery();

  const user = await asSystem(async (t) => {
    // unique(username) makes two simultaneous sign-ups for one name impossible
    const [r] = await t`
      insert into nsignage.users (username, display_name, password_hash, recovery_hash, recovery_created_at)
      values (${username}, ${cleanText(body.displayName, 80) || null}, ${passwordHash}, ${recoveryHash}, now())
      on conflict (username) do nothing
      returning *`;
    if (!r) throw httpError(409, 'This username is already taken. Please choose another.', 'username-taken');
    await createSession(t, req, res, r.id);
    await t`insert into nsignage.security_events (event, user_id, ip_hash) values ('account-created', ${r.id}, ${keyHash(clientIp(req))})`;
    return userFromRow(r);
  });
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
  await rateLimit('login-ip', keyHash(clientIp(req)), 30, 600);
  await checkLockout(username);

  const user = await asSystem((t) => getUserByUsername(t, username));
  const ok = await verifyPassword(password, user?.passwordHash); // same work for unknown users
  if (!user || !ok || user.disabled) {
    await recordFailure(username, req, Boolean(user));
    console.warn('[N-SIGNAGE AUTH] login failed', JSON.stringify({ known: Boolean(user) }));
    throw httpError(401, 'Incorrect username or password.', 'bad-credentials');
  }
  const newHash = needsRehash(user.passwordHash) ? await hashPassword(password) : null;
  await asSystem(async (t) => {
    await t`delete from nsignage.rate_limits where bucket = 'login-fail' and key_hash = ${keyHash(username)}`;
    if (newHash) await t`update nsignage.users set password_hash = ${newHash} where id = ${user.id}`;
    await createSession(t, req, res, user.id);
  });
  console.log('[N-SIGNAGE AUTH] login', JSON.stringify({ user: user.id }));
  send(res, 200, { ok: true, user: userView(user) });
}

async function changePassword(req, res) {
  const body = readJsonBody(req);
  const { user } = await currentUserOr401(req);
  await rateLimit('change-password', keyHash(user.id), 10, 3600);
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
    throw httpError(400, 'Your current password is incorrect.', 'bad-credentials');
  }
  validatePassword(body.newPassword, user.username);
  if (body.newPassword === body.currentPassword) throw httpError(400, 'The new password must be different.', 'weak-password');
  const hash = await hashPassword(body.newPassword);
  const result = await withCustomer(req, async (t, { user: u, sessionHash }) => {
    const [r] = await t`update nsignage.users set password_hash = ${hash}, password_changed_at = now()
                        where id = ${u.id} returning *`;
    const revoked = await revokeSessions(t, u.id, sessionHash); // same transaction as the password change
    await t`insert into nsignage.security_events (event, user_id, detail) values ('password-changed', ${u.id}, ${t.json({ revoked })})`;
    return { user: userFromRow(r), revoked };
  });
  console.log('[N-SIGNAGE AUTH] password changed', JSON.stringify({ user: user.id, revokedSessions: result.revoked }));
  send(res, 200, { ok: true, user: userView(result.user), revokedSessions: result.revoked });
}

async function currentUserOr401(req) {
  const cur = await currentUser(req);
  if (!cur) throw httpError(401, 'Please log in again.', 'not-logged-in');
  return cur;
}

async function recover(req, res) {
  const body = readJsonBody(req);
  const username = normalizeUsername(body.username);
  await rateLimit('recover-ip', keyHash(clientIp(req)), 10, 3600);
  if (!username || username.length > 64) throw httpError(400, 'Enter your username.');
  await rateLimit('recover-user', keyHash(username), 5, 3600);
  const user = await asSystem((t) => getUserByUsername(t, username));
  const keyHashed = hashRecoveryKey(body.recoveryKey);
  // Same response for unknown username and wrong key
  if (!user || !user.recoveryHash || user.disabled || !safeEqual(user.recoveryHash, keyHashed)) {
    await asSystem((t) => t`insert into nsignage.security_events (event, ip_hash) values ('recovery-failed', ${keyHash(clientIp(req))})`);
    throw httpError(400, 'The username or recovery key is not correct.', 'bad-recovery');
  }
  validatePassword(body.newPassword, username);
  const hash = await hashPassword(body.newPassword);
  const { recoveryKey, recoveryHash } = newRecovery(); // a used key is never valid again
  const updated = await asSystem(async (t) => {
    // only succeeds if the key was not used concurrently
    const [r] = await t`
      update nsignage.users
         set password_hash = ${hash}, password_changed_at = now(), recovery_hash = ${recoveryHash}, recovery_created_at = now()
       where id = ${user.id} and recovery_hash = ${user.recoveryHash}
      returning *`;
    if (!r) throw httpError(400, 'The username or recovery key is not correct.', 'bad-recovery');
    const revoked = await revokeSessions(t, user.id);
    await t`delete from nsignage.rate_limits where bucket = 'login-fail' and key_hash = ${keyHash(username)}`;
    await createSession(t, req, res, user.id);
    await t`insert into nsignage.security_events (event, user_id, detail) values ('password-recovered', ${user.id}, ${t.json({ revoked })})`;
    return userFromRow(r);
  });
  console.log('[N-SIGNAGE AUTH] password reset with recovery key', JSON.stringify({ user: user.id }));
  send(res, 200, { ok: true, user: userView(updated), recoveryKey });
}

async function regenerateRecovery(req, res) {
  const body = readJsonBody(req);
  const { user } = await currentUserOr401(req);
  await rateLimit('regen-recovery', keyHash(user.id), 5, 3600);
  if (!(await verifyPassword(body.password, user.passwordHash))) {
    throw httpError(400, 'Your password is incorrect.', 'bad-credentials');
  }
  const { recoveryKey, recoveryHash } = newRecovery();
  const updated = await withCustomer(req, async (t, { user: u }) => {
    const [r] = await t`update nsignage.users set recovery_hash = ${recoveryHash}, recovery_created_at = now()
                        where id = ${u.id} returning *`;
    await t`insert into nsignage.security_events (event, user_id) values ('recovery-key-regenerated', ${u.id})`;
    return userFromRow(r);
  });
  send(res, 200, { ok: true, user: userView(updated), recoveryKey });
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
        const revoked = await withCustomer(req, (t, { user, sessionHash }) => revokeSessions(t, user.id, sessionHash));
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
