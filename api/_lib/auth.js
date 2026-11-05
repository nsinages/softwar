// =============================================
// N Signage — Customer accounts and sessions (cloud mode)
//
// - Passwords: scrypt with a random salt per account (never stored or logged in clear)
// - Sessions : random 256-bit token in an HttpOnly, Secure, SameSite=Lax cookie;
//              only its SHA-256 is stored in Redis (30-day expiry)
// - Devices  : a Pi belongs to exactly one account (ns:owner:<deviceId>)
// =============================================
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  redis, keys, sha256, randomToken, httpError, getDevice, DEVICE_ID_RX, parse,
} from './cloud.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'ns_session';
const SESSION_TTL_S = 30 * 24 * 3600;
export const EMAIL_RX = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Used when the email does not exist, so login time does not reveal that.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored || DUMMY_HASH).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected) && Boolean(stored);
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  if (password.length > 200) throw httpError(400, 'Password is too long.');
}

// ---- Cookies ---------------------------------------------------------------

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isLocalHost(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
}

function sessionCookie(req, value, maxAge) {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(isLocalHost(req) ? [] : ['Secure']),
  ].join('; ');
}

// ---- Sessions --------------------------------------------------------------

export async function createSession(req, res, accountId) {
  const token = randomToken();
  await redis().set(keys.session(sha256(token)), { accountId, createdAt: Date.now() }, { ex: SESSION_TTL_S });
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL_S));
}

export async function destroySession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token && token.length <= 200) await redis().del(keys.session(sha256(token)));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

/** The logged-in account, or null. */
export async function currentAccount(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await redis().get(keys.session(sha256(token)));
  if (!session?.accountId) return null;
  const account = await redis().get(keys.account(session.accountId));
  return account || null;
}

export async function requireAccount(req) {
  const account = await currentAccount(req);
  if (!account) throw httpError(401, 'Please log in again.', 'not-logged-in');
  return account;
}

export const accountView = (a) => ({ id: a.id, email: a.email, name: a.name || null, createdAt: a.createdAt });

// ---- Device ownership ------------------------------------------------------

export async function accountDeviceMeta(accountId) {
  const raw = (await redis().hgetall(keys.accountDevices(accountId))) || {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) out[id] = parse(v);
  return out;
}

/** Logged-in account that owns this Pi, plus the Pi's latest state. */
export async function requireOwnedDevice(req, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) throw httpError(400, 'Invalid device id');
  const account = await requireAccount(req);
  const owner = await redis().get(keys.owner(deviceId));
  if (owner !== account.id) throw httpError(404, 'This Raspberry Pi is not registered in your account.', 'not-owner');
  const device = await getDevice(deviceId);
  if (!device) throw httpError(404, 'Raspberry Pi not found in the cloud');
  return { account, device };
}
