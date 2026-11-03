// =============================================
// N Signage — Cloud relay shared helpers (Vercel serverless functions)
//
// The website is hosted in the cloud, so it can never open a connection to a
// Raspberry Pi on a customer's Wi-Fi. Instead every Pi runs cloud_agent.py,
// which connects OUT to this relay every few seconds ("sync"):
//   - reports its identity, local IP and media list
//   - picks up queued commands (download a file, delete a file)
//   - reports the results of commands it ran
//
// Storage (both added from the Vercel dashboard → Storage):
//   - Upstash Redis  : device state, pairings, command queues
//   - Vercel Blob    : uploaded media files (the Pi downloads them from here)
// =============================================

import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

export const ONLINE_WINDOW_MS = 45_000;        // seen within this → online
export const NEARBY_IP_WINDOW_MS = 15 * 60_000; // public IPs remembered for pairing
const COMMAND_TTL_S = 7 * 24 * 3600;
const RESULT_TTL_S = 24 * 3600;

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
  user: (username) => `ns:user:${username.toLowerCase()}`,
  controllers: (id) => `ns:ctl:${id}`,
  commands: (id) => `ns:cmd:${id}`,
  results: (id) => `ns:res:${id}`,
  blobs: (id) => `ns:blob:${id}`,
};

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Public IP of the caller as seen by Vercel's edge.
export function clientIp(req) {
  const real = req.headers['x-real-ip'];
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof real === 'string' && real) || (typeof fwd === 'string' && fwd.split(',')[0]) || '';
  return ip.trim().toLowerCase();
}

// Same network = same public IPv4 (NAT), or same IPv6 /64 prefix.
function ipv6Prefix64(ip) {
  if (!ip.includes(':')) return null;
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (full.length !== 8) return null;
  return full.slice(0, 4).map((g) => parseInt(g || '0', 16)).join(':');
}

export function sameNetwork(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = ipv6Prefix64(a);
  return pa !== null && pa === ipv6Prefix64(b);
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function handleError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[N-SIGNAGE CLOUD]', status, err.reason || '', err.message);
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

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
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

// ---- Device state ----------------------------------------------------------

export async function getDevice(deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) return null;
  return (await redis().get(keys.device(deviceId))) || null;
}

export function isOnline(device, now = Date.now()) {
  return Boolean(device?.lastSeen && now - device.lastSeen < ONLINE_WINDOW_MS);
}

export function publicView(device, now = Date.now()) {
  return {
    deviceId: device.deviceId,
    username: device.username,
    hostname: device.hostname || null,
    ip: device.localIp || null,
    port: device.port || 5000,
    online: isOnline(device, now),
    lastSeen: device.lastSeen || null,
    method: 'cloud',
  };
}

// The browser proves it was paired with this Pi (header X-Device-Token).
export async function requireController(req, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId || '')) throw httpError(400, 'Invalid device id');
  const token = req.headers['x-device-token'];
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw httpError(401, 'This browser is not paired with the Raspberry Pi. Remove the device and add it again.');
  }
  const ok = await redis().sismember(keys.controllers(deviceId), sha256(token));
  if (!ok) throw httpError(401, 'This browser is not paired with the Raspberry Pi. Remove the device and add it again.');
  const device = await getDevice(deviceId);
  if (!device) throw httpError(404, 'Raspberry Pi not found in the cloud');
  return device;
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
  return list.map((c) => (typeof c === 'string' ? JSON.parse(c) : c));
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
    const cmd = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
