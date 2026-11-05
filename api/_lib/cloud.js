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
//   - Upstash Redis  : browser sessions, device state, queues
//   - Vercel Blob    : uploaded media files (the Pi downloads them from here)
// =============================================

import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

export const ONLINE_WINDOW_MS = 45_000;          // seen within this → online
export const NEARBY_WINDOW_MS = 2 * 60_000;      // Find Pi: Pi synced from this network within 2 min
const NET_INDEX_TTL_S = 15 * 60;
const COMMAND_TTL_S = 7 * 24 * 3600;
const RESULT_TTL_S = 24 * 3600;
const STALE_SECRET_MS = 10 * 60_000;             // Pi not added anywhere, offline this long, may re-register (reflash)

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
  commands: (id) => `ns:cmd:${id}`,
  results: (id) => `ns:res:${id}`,
  nonce: (n) => `ns:nonce:${n}`,
  rate: (bucket, id) => `ns:rl:${bucket}:${id}`,

  // Legacy (anonymous browser sessions, before customer accounts). Read-only
  // except for the one-time "link my old devices" flow; never deleted in bulk.
  owners: (id) => `ns:owners:${id}`,             // set of browser ids that added this Pi
  session: (hash) => `ns:sess:${hash}`,
  browserDevices: (id) => `ns:browser-devs:${id}`,
  blobs: (id) => `ns:blob:${id}`,                // cloud copies made by the old upload flow

  // Customer accounts (new prefixes: never collide with the short-lived
  // email-account build b979de3, which used ns:acct / ns:owner / ns:sess)
  user: (id) => `ns:user:${id}`,
  username: (name) => `ns:username:${name}`,
  userSession: (hash) => `ns:usess:${hash}`,
  userSessions: (id) => `ns:user-sess:${id}`,    // set of session hashes, for revocation
  userDevices: (id) => `ns:user-devs:${id}`,     // hash deviceId -> { name, location, addedAt, via }
  deviceOwner: (id) => `ns:dev-owner:${id}`,     // deviceId -> userId (exactly one owner)
  loginFail: (name) => `ns:login-fail:${name}`,

  // Pairing codes shown on the Pi screen
  pairCode: (hash) => `ns:pair:${hash}`,
  pairDevice: (id) => `ns:pair-dev:${id}`,

  // Relay transfers (metadata only — the media bytes live in Blob, transiently)
  transfer: (id) => `ns:xfer:${id}`,
  transferIndex: () => 'ns:xfer-expiry',         // zset transferId -> expiresAt
  userTransfers: (id) => `ns:user-xfers:${id}`,  // zset transferId -> createdAt
  transferProgress: (id) => `ns:xfer-prog:${id}`,
};

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** Find Pi (same-network) claiming; set NSIGNAGE_NETWORK_CLAIM=off once all Pis show pairing codes. */
export const networkClaimEnabled = () => String(process.env.NSIGNAGE_NETWORK_CLAIM || 'on').toLowerCase() !== 'off';

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

/** True when a customer account owns the Pi, or (legacy) any browser added it. */
export async function isDeviceClaimed(deviceId) {
  const r = redis();
  if (await r.get(keys.deviceOwner(deviceId))) return true;
  return (await r.scard(keys.owners(deviceId))) > 0;
}

function bearerSecret(req) {
  const auth = String(req.headers.authorization || '');
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (secret.length < 32 || secret.length > 200) throw httpError(401, 'Missing device secret');
  return secret;
}

/**
 * Authenticate a Pi that has already registered (any Pi endpoint other than
 * the first sync). Returns the device record.
 */
export async function authenticateDevice(req, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) throw httpError(400, 'Invalid device id');
  const secret = bearerSecret(req);
  const device = await getDevice(deviceId);
  if (!device?.secretHash || !safeEqual(device.secretHash, sha256(secret))) {
    console.warn('[N-SIGNAGE CLOUD] device auth failed', deviceId);
    throw httpError(401, 'Device authentication failed', 'bad-device-secret');
  }
  return device;
}

export { bearerSecret };

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
    capabilities: device.capabilities || [],
    storage: device.storage || null,
    method: 'cloud',
  };
}

export function hasCapability(device, name) {
  return Array.isArray(device?.capabilities) && device.capabilities.includes(name);
}

// ---- Commands --------------------------------------------------------------

export async function enqueueCommand(deviceId, command) {
  const cmd = { ...command, id: crypto.randomUUID(), createdAt: Date.now() };
  const r = redis();
  await r.rpush(keys.commands(deviceId), JSON.stringify(cmd));
  await r.expire(keys.commands(deviceId), COMMAND_TTL_S);
  const entry = { state: 'queued', at: Date.now(), ...(cmd.transferId && { transferId: cmd.transferId }) };
  await r.hset(keys.results(deviceId), { [cmd.id]: JSON.stringify(entry) });
  await r.expire(keys.results(deviceId), RESULT_TTL_S);
  return cmd;
}

/** Remove a queued command (e.g. a cancelled transfer). True if it was still queued. */
export async function removeCommand(deviceId, commandId) {
  const r = redis();
  const list = (await r.lrange(keys.commands(deviceId), 0, -1)) || [];
  let removed = false;
  for (const raw of list) {
    if (parse(raw).id === commandId) {
      await r.lrem(keys.commands(deviceId), 1, typeof raw === 'string' ? raw : JSON.stringify(raw));
      removed = true;
    }
  }
  return removed;
}

export async function pendingCommands(deviceId) {
  const list = (await redis().lrange(keys.commands(deviceId), 0, 19)) || [];
  return list.map(parse);
}

const SHA256_RX = /^[a-f0-9]{64}$/;

/**
 * Record command results reported by a Pi. Returns the cleaned results, each
 * with the transferId it belongs to (if any), so transfers can be updated.
 */
export async function completeCommands(deviceId, results) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const r = redis();
  const previous = (await r.hgetall(keys.results(deviceId))) || {};
  const done = new Set();
  const updates = {};
  const cleaned = [];
  for (const res of results.slice(0, 50)) {
    if (!res || typeof res.id !== 'string' || res.id.length > 64) continue;
    done.add(res.id);
    const prev = previous[res.id] ? parse(previous[res.id]) : null;
    const item = {
      id: res.id,
      ok: res.ok === true,
      error: res.ok === true ? undefined : String(res.error || 'Failed on the Raspberry Pi').slice(0, 300),
      reason: typeof res.reason === 'string' ? res.reason.slice(0, 40) : undefined,
      filename: typeof res.filename === 'string' ? res.filename.slice(0, 220) : undefined,
      // Only reported by agent protocol 2 (checksum verification on the Pi)
      sha256: typeof res.sha256 === 'string' && SHA256_RX.test(res.sha256.toLowerCase()) ? res.sha256.toLowerCase() : undefined,
      size: Number.isSafeInteger(res.size) && res.size >= 0 ? res.size : undefined,
      transferId: prev?.transferId,
    };
    cleaned.push(item);
    updates[res.id] = JSON.stringify({
      state: item.ok ? 'done' : 'failed',
      error: item.error,
      filename: item.filename,
      transferId: item.transferId,
      at: Date.now(),
    });
  }
  if (done.size === 0) return [];
  await r.hset(keys.results(deviceId), updates);
  const list = (await r.lrange(keys.commands(deviceId), 0, -1)) || [];
  for (const raw of list) {
    const cmd = parse(raw);
    if (done.has(cmd.id)) await r.lrem(keys.commands(deviceId), 1, typeof raw === 'string' ? raw : JSON.stringify(raw));
  }
  return cleaned;
}

// Capabilities a Pi agent may announce (protocol 2+). Unknown values are dropped.
export const KNOWN_CAPABILITIES = ['sha256', 'range-resume', 'private-blob', 'pairing', 'progress', 'storage'];

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
  // Protocol 2 fields (optional; agent 1.0 sends none of them)
  const protocol = Number.isInteger(body.protocol) && body.protocol > 0 && body.protocol < 100 ? body.protocol : 1;
  const capabilities = Array.isArray(body.capabilities)
    ? [...new Set(body.capabilities.filter((c) => KNOWN_CAPABILITIES.includes(c)))]
    : [];
  const s = body.storage;
  const storage = s && Number.isSafeInteger(s.freeBytes) && s.freeBytes >= 0 && Number.isSafeInteger(s.totalBytes) && s.totalBytes > 0
    ? { freeBytes: s.freeBytes, totalBytes: s.totalBytes }
    : null;
  return { username, hostname, localIp, port, media, currentMedia, agentVersion, protocol, capabilities, storage };
}

export const NET_TTL_S = NET_INDEX_TTL_S;
