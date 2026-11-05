// =============================================
// N Signage — Cloud relay shared helpers (Vercel serverless functions)
//
// The website is hosted in the cloud, so it can never open a connection to a
// Raspberry Pi on a customer's Wi-Fi (browsers cannot send UDP/mDNS, and an
// HTTPS page cannot call http://192.168.x.x). Instead every Pi runs
// cloud_agent.py, which connects OUT to this relay every few seconds ("sync"):
//   - reports its identity, local IP and media list
//   - picks up queued commands (download a file, delete a file)
//   - reports the results of commands it ran
//
// "Find Pi" matches the browser and the Pi by the public IP address they
// both use to reach the internet (same Wi-Fi → same router → same public IP).
//
// Storage (both added from the Vercel dashboard → Storage):
//   - Upstash Redis  : accounts, sessions, device state, ownership, queues
//   - Vercel Blob    : uploaded media files (the Pi downloads them from here)
// =============================================

import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

export const ONLINE_WINDOW_MS = 45_000;          // seen within this → online
export const NEARBY_WINDOW_MS = 2 * 60_000;      // Find Pi: Pi synced from this network within 2 min
const NET_INDEX_TTL_S = 15 * 60;
const COMMAND_TTL_S = 7 * 24 * 3600;
const RESULT_TTL_S = 24 * 3600;
const STALE_SECRET_MS = 10 * 60_000;             // unowned Pi offline this long may re-register (reflash)

export const USERNAME_RX = /^[a-z0-9_][a-z0-9_.-]{0,31}$/i;
export const DEVICE_ID_RX = /^[a-f0-9]{16}$/;
const HOSTNAME_RX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const MEDIA_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,200}\.(jpg|jpeg|png|gif|webp|bmp|mp4|m4v|webm|mov|avi|mkv)$/i;

let redisClient = null;
export function redis() {
  if (redisClient) return redisClient;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // Names only — never log the values.
    console.error('[N-SIGNAGE CLOUD] Redis not configured: missing',
      [!url && 'KV_REST_API_URL/UPSTASH_REDIS_REST_URL', !token && 'KV_REST_API_TOKEN/UPSTASH_REDIS_REST_TOKEN'].filter(Boolean).join(', '));
    const err = new Error('Cloud storage is not configured. Connect an Upstash Redis store to this Vercel project.');
    err.status = 503;
    err.reason = 'cloud-not-configured';
    throw err;
  }
  redisClient = new Redis({ url, token });
  return redisClient;
}

export const keys = {
  device: (id) => `ns:dev:${id}`,
  net: (netKey) => `ns:net:${netKey}`,
  owner: (id) => `ns:owner:${id}`,
  commands: (id) => `ns:cmd:${id}`,
  results: (id) => `ns:res:${id}`,
  blobs: (id) => `ns:blob:${id}`,
  account: (id) => `ns:acct:${id}`,
  email: (email) => `ns:email:${email}`,
  session: (hash) => `ns:sess:${hash}`,
  accountDevices: (id) => `ns:acct-devs:${id}`,
  nonce: (n) => `ns:nonce:${n}`,
  rate: (bucket, id) => `ns:rl:${bucket}:${id}`,
};

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ---- Network matching ------------------------------------------------------

// Public IP of the caller as seen by Vercel's edge.
export function clientIp(req) {
  const real = req.headers['x-real-ip'];
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof real === 'string' && real) || (typeof fwd === 'string' && fwd.split(',')[0]) || '';
  return ip.trim().toLowerCase();
}

function ipv6Prefix64(ip) {
  if (!ip.includes(':')) return null;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (full.length !== 8) return null;
  return full.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':');
}

/** Same network = same public IPv4 (NAT), or same IPv6 /64 prefix. */
export function networkKey(ip) {
  if (!ip) return null;
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return v4mapped[1];
  if (IPV4_RX.test(ip)) return ip;
  const p = ipv6Prefix64(ip);
  return p ? `${p}::/64` : null;
}

// ---- HTTP helpers ----------------------------------------------------------

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

export function handleError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[N-SIGNAGE CLOUD]', status, err.reason || '', err.message);
  if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
  send(res, status, {
    ok: false,
    error: status >= 500 && !err.status ? 'Cloud server error' : err.message,
    ...(err.reason && { reason: err.reason }),
  });
}

export function redisConfigured() {
  return Boolean(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
  );
}

export function httpError(status, message, reason) {
  const err = new Error(message);
  err.status = status;
  if (reason) err.reason = reason;
  return err;
}

export function readJsonBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { throw httpError(400, 'Invalid JSON body'); }
  }
  return {};
}

/**
 * Browser requests that change state must come from this website itself
 * (blocks cross-site form posts / CSRF together with SameSite cookies).
 */
export function requireSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (typeof origin !== 'string' || !host) throw httpError(403, 'Request origin not allowed', 'bad-origin');
  let o;
  try { o = new URL(origin); } catch { throw httpError(403, 'Request origin not allowed', 'bad-origin'); }
  if (o.host.toLowerCase() !== String(host).split(',')[0].trim().toLowerCase()) {
    throw httpError(403, 'Request origin not allowed', 'bad-origin');
  }
}

/** Fixed-window rate limit. Throws 429 when `limit` is exceeded within `windowS`. */
export async function rateLimit(bucket, id, limit, windowS) {
  const key = keys.rate(bucket, sha256(id || 'unknown').slice(0, 24));
  const r = redis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, windowS);
  if (n > limit) {
    const err = httpError(429, 'Too many attempts. Please wait a minute and try again.', 'rate-limited');
    err.retryAfter = windowS;
    throw err;
  }
}

// ---- Device state ----------------------------------------------------------

export async function getDevice(deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) return null;
  return (await redis().get(keys.device(deviceId))) || null;
}

export function isOnline(device, now = Date.now()) {
  return Boolean(device?.lastSeen && now - device.lastSeen < ONLINE_WINDOW_MS);
}

export function canReplaceSecret(device, owned, now = Date.now()) {
  return !device?.secretHash || (!owned && now - (device.lastSeen || 0) > STALE_SECRET_MS);
}

export function publicView(device, now = Date.now()) {
  return {
    deviceId: device.deviceId,
    username: device.username,
    hostname: device.hostname || null,
    ip: device.localIp || null,
    port: device.port || 5000,
    online: isOnline(device, now),
    status: isOnline(device, now) ? 'online' : 'offline',
    lastSeen: device.lastSeen || null,
    agentVersion: device.agentVersion || null,
    method: 'cloud',
  };
}

// ---- Commands --------------------------------------------------------------

export async function enqueueCommand(deviceId, command) {
  const cmd = { ...command, id: crypto.randomUUID(), createdAt: Date.now() };
  const r = redis();
  await r.rpush(keys.commands(deviceId), JSON.stringify(cmd));
  await r.expire(keys.commands(deviceId), COMMAND_TTL_S);
  await r.hset(keys.results(deviceId), { [cmd.id]: JSON.stringify({ state: 'queued', at: Date.now() }) });
  await r.expire(keys.results(deviceId), RESULT_TTL_S);
  return cmd;
}

export async function pendingCommands(deviceId) {
  const list = (await redis().lrange(keys.commands(deviceId), 0, 19)) || [];
  return list.map(parse);
}

export async function completeCommands(deviceId, results) {
  if (!Array.isArray(results) || results.length === 0) return;
  const r = redis();
  const done = new Set();
  const updates = {};
  for (const res of results.slice(0, 50)) {
    if (!res || typeof res.id !== 'string' || res.id.length > 64) continue;
    done.add(res.id);
    updates[res.id] = JSON.stringify({
      state: res.ok ? 'done' : 'failed',
      error: res.ok ? undefined : String(res.error || 'Failed on the Raspberry Pi').slice(0, 300),
      filename: typeof res.filename === 'string' ? res.filename.slice(0, 220) : undefined,
      at: Date.now(),
    });
  }
  if (done.size === 0) return;
  await r.hset(keys.results(deviceId), updates);
  const list = (await r.lrange(keys.commands(deviceId), 0, -1)) || [];
  for (const raw of list) {
    const cmd = parse(raw);
    if (done.has(cmd.id)) await r.lrem(keys.commands(deviceId), 1, typeof raw === 'string' ? raw : JSON.stringify(raw));
  }
}

// ---- Validation of what a Pi reports ----------------------------------------

export function cleanReport(body) {
  const username = String(body.username || '');
  if (!USERNAME_RX.test(username)) throw httpError(400, 'Invalid username');
  const hostname = typeof body.hostname === 'string' && HOSTNAME_RX.test(body.hostname) ? body.hostname : null;
  const localIp = typeof body.localIp === 'string' && IPV4_RX.test(body.localIp) ? body.localIp : null;
  const port = Number.isInteger(body.port) && body.port > 0 && body.port < 65536 ? body.port : 5000;
  const media = Array.isArray(body.media)
    ? body.media
        .filter((m) => m && typeof m.name === 'string' && MEDIA_NAME_RX.test(m.name))
        .slice(0, 1000)
        .map((m) => ({
          name: m.name,
          size: Number.isFinite(m.size) ? m.size : null,
          type: m.type === 'video' || m.type === 'image' ? m.type : 'unknown',
        }))
    : [];
  const currentMedia = typeof body.currentMedia === 'string' && MEDIA_NAME_RX.test(body.currentMedia) ? body.currentMedia : null;
  const agentVersion = typeof body.agentVersion === 'string' ? body.agentVersion.slice(0, 20) : null;
  return { username, hostname, localIp, port, media, currentMedia, agentVersion };
}

export const NET_TTL_S = NET_INDEX_TTL_S;
