// =============================================
// N Signage — Browser sessions (cloud mode, no login)
//
// Each browser gets an anonymous session automatically on its first visit:
// a random 256-bit token in an HttpOnly, Secure, SameSite=Lax cookie. Only its
// SHA-256 is stored in Redis. The Pis a browser adds are saved under that
// browser's id, so they survive refreshes but not clearing the site's cookies
// (the Pi can then simply be added again with Find Pi).
//
// A Pi can be controlled by several browsers (ns:owners:<deviceId>), because
// without accounts there is no way to recover a lost browser session.
// =============================================
import crypto from 'node:crypto';
import {
  redis, keys, sha256, randomToken, httpError, getDevice, DEVICE_ID_RX, parse,
} from './cloud.js';

const SESSION_COOKIE = 'ns_session';
const SESSION_TTL_S = 365 * 24 * 3600;

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

/** The browser's session record ({ id, createdAt }), or null. */
export async function currentBrowser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await redis().get(keys.session(sha256(token)));
  return session?.id ? session : null;
}

/** Existing session, or a new anonymous one (sets the cookie). */
export async function ensureBrowser(req, res) {
  const existing = await currentBrowser(req);
  if (existing) return { browser: existing, created: false };
  const token = randomToken();
  const browser = { id: crypto.randomUUID(), createdAt: Date.now() };
  await redis().set(keys.session(sha256(token)), browser, { ex: SESSION_TTL_S });
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL_S));
  return { browser, created: true };
}

export async function requireBrowser(req) {
  const browser = await currentBrowser(req);
  if (!browser) throw httpError(401, 'Your browser session expired. Reload the page.', 'no-session');
  return browser;
}

// ---- Device control --------------------------------------------------------

export async function browserDeviceMeta(browserId) {
  const raw = (await redis().hgetall(keys.browserDevices(browserId))) || {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) out[id] = parse(v);
  return out;
}

/** Browser that added this Pi, plus the Pi's latest state. */
export async function requireOwnedDevice(req, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) throw httpError(400, 'Invalid device id');
  const browser = await requireBrowser(req);
  const allowed = await redis().sismember(keys.owners(deviceId), browser.id);
  if (!allowed) throw httpError(404, 'This Raspberry Pi has not been added in this browser. Use Find Pi to add it.', 'not-owner');
  const device = await getDevice(deviceId);
  if (!device) throw httpError(404, 'Raspberry Pi not found in the cloud');
  return { browser, device };
}
