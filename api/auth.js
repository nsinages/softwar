// /api/auth?action=<action> — customer accounts for the hosted website.
//
//   GET  action=me        → { ok, account } or 401
//   POST action=register  { email, password, name? }
//   POST action=login     { email, password }
//   POST action=logout
import crypto from 'node:crypto';
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin, rateLimit, clientIp,
} from './_lib/cloud.js';
import {
  hashPassword, verifyPassword, normalizeEmail, validatePassword, EMAIL_RX,
  createSession, destroySession, currentAccount, accountView,
} from './_lib/auth.js';

async function register(req, res) {
  const { email: rawEmail, password, name } = readJsonBody(req);
  const email = normalizeEmail(rawEmail);
  await rateLimit('register', clientIp(req), 10, 3600);
  if (!EMAIL_RX.test(email) || email.length > 254) throw httpError(400, 'Enter a valid email address.');
  validatePassword(password);

  const account = {
    id: crypto.randomUUID(),
    email,
    name: typeof name === 'string' ? name.trim().slice(0, 80) || null : null,
    passwordHash: await hashPassword(password),
    createdAt: Date.now(),
  };
  // NX: two sign-ups with the same email cannot both succeed
  const claimed = await redis().set(keys.email(email), account.id, { nx: true });
  if (claimed !== 'OK') throw httpError(409, 'An account with this email already exists. Log in instead.', 'email-taken');
  await redis().set(keys.account(account.id), account);
  await createSession(req, res, account.id);
  console.log('[N-SIGNAGE AUTH] account created', account.id);
  send(res, 200, { ok: true, account: accountView(account) });
}

async function login(req, res) {
  const { email: rawEmail, password } = readJsonBody(req);
  const email = normalizeEmail(rawEmail);
  await rateLimit('login-ip', clientIp(req), 30, 600);
  await rateLimit('login-email', email, 10, 600);
  if (!email || typeof password !== 'string' || password.length > 200) throw httpError(400, 'Enter your email and password.');

  const id = await redis().get(keys.email(email));
  const account = id ? await redis().get(keys.account(id)) : null;
  const ok = await verifyPassword(password, account?.passwordHash);
  if (!account || !ok) throw httpError(401, 'Incorrect email or password.', 'bad-credentials');
  await createSession(req, res, account.id);
  send(res, 200, { ok: true, account: accountView(account) });
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    if (req.method === 'GET' && action === 'me') {
      const account = await currentAccount(req);
      if (!account) return send(res, 401, { ok: false, reason: 'not-logged-in' });
      return send(res, 200, { ok: true, account: accountView(account) });
    }
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    requireSameOrigin(req);
    if (action === 'register') return await register(req, res);
    if (action === 'login') return await login(req, res);
    if (action === 'logout') {
      await destroySession(req, res);
      return send(res, 200, { ok: true });
    }
    throw httpError(404, 'Unknown action');
  } catch (err) {
    handleError(res, err);
  }
}
