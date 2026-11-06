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
// Storage:
//   - Supabase PostgreSQL : accounts, sessions, devices, ownership, pairing,
//                           commands, transfer metadata (see db.js)
//   - Vercel Blob         : TEMPORARY relay copies of media only
// =============================================

import crypto from 'node:crypto';

export const ONLINE_WINDOW_MS = 60_000;          // seen within this → online (idle Pis sync every 15 s)
export const NEARBY_WINDOW_MS = 2 * 60_000;      // Find Pi: Pi synced from this network within 2 min
export const IDLE_POLL_SECONDS = Math.min(60, Math.max(5, Number(process.env.NSIGNAGE_IDLE_POLL_SECONDS) || 15));
export const BUSY_POLL_SECONDS = 2;
const STALE_SECRET_MS = 10 * 60_000;             // unclaimed Pi offline this long may re-register (SD re-flash)

export const USERNAME_RX = /^[a-z0-9_][a-z0-9_.-]{0,31}$/i;
export const DEVICE_ID_RX = /^[a-f0-9]{16}$/;
/** A device record a customer saved by name + IP that no Pi has confirmed yet. */
export const SAVED_ID_RX = /^saved_[a-f0-9]{24}$/;
const HOSTNAME_RX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const MEDIA_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,200}\.(jpg|jpeg|png|gif|webp|bmp|mp4|m4v|webm|mov|avi|mkv)$/i;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
/** Short hash used as a rate-limit / log key (never store raw IPs or usernames there). */
export const keyHash = (s) => sha256(`ns-key:${s || 'unknown'}`).slice(0, 32);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

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

export function bearerSecret(req) {
  const auth = String(req.headers.authorization || '');
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (secret.length < 32 || secret.length > 200) throw httpError(401, 'Missing device secret');
  return secret;
}

// ---- Device state ----------------------------------------------------------

const ms = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : null);

/** nsignage.devices row → the device object used by the API code. */
export function deviceFromRow(r) {
  if (!r) return null;
  return {
    deviceId: r.id,
    secretHash: r.secret_hash || null,
    ownerId: r.owner_id || null,
    nickname: r.nickname || '',
    location: r.location || '',
    addedAt: ms(r.added_at),
    addedVia: r.added_via || null,
    username: r.pi_username,
    hostname: r.hostname || null,
    localIp: r.local_ip || null,
    port: r.api_port || 5000,
    agentVersion: r.agent_version || null,
    protocol: r.agent_protocol || 1,
    capabilities: r.capabilities || [],
    storage: r.storage_total_bytes ? { freeBytes: r.storage_free_bytes, totalBytes: r.storage_total_bytes } : null,
    media: r.media || [],
    mediaHash: r.media_hash || null,
    currentMedia: r.current_media || null,
    firstSeen: ms(r.first_seen_at),
    lastSeen: r.registration === 'saved' ? null : ms(r.last_seen_at),
    uid: r.uid || null,
    registration: r.registration || 'verified',
    deviceModel: r.device_model || null,
    connectionType: r.connection_type || null,
    expectedDeviceUid: r.expected_device_uid || null,
  };
}

export function isOnline(device, now = Date.now()) {
  return Boolean(device?.lastSeen && now - device.lastSeen < ONLINE_WINDOW_MS);
}

export function canReplaceSecret(device, owned, now = Date.now()) {
  return !device?.secretHash || (!owned && now - (device.lastSeen || 0) > STALE_SECRET_MS);
}

export function publicView(device, now = Date.now()) {
  const saved = device.registration === 'saved';
  return {
    deviceId: device.deviceId,
    uid: device.uid || null,
    registration: device.registration || 'verified',
    deviceModel: device.deviceModel || null,
    connectionType: device.connectionType || null,
    username: device.username,
    hostname: device.hostname || null,
    ip: device.localIp || null,
    port: device.port || 5000,
    online: saved ? false : isOnline(device, now),
    // 'unknown' for a saved record: no Pi has confirmed it, so there is no heartbeat to judge by
    status: saved ? 'unknown' : isOnline(device, now) ? 'online' : 'offline',
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

const SHA256_RX = /^[a-f0-9]{64}$/;

/** Validate command results reported by a Pi (agent 1.0 and protocol 2). */
export function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  const out = [];
  for (const res of results.slice(0, 50)) {
    if (!res || typeof res.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(res.id)) continue;
    out.push({
      id: res.id,
      ok: res.ok === true,
      error: res.ok === true ? null : String(res.error || 'Failed on the Raspberry Pi').slice(0, 300),
      reason: typeof res.reason === 'string' ? res.reason.slice(0, 40) : null,
      filename: typeof res.filename === 'string' ? res.filename.slice(0, 220) : null,
      sha256: typeof res.sha256 === 'string' && SHA256_RX.test(res.sha256.toLowerCase()) ? res.sha256.toLowerCase() : null,
      size: Number.isSafeInteger(res.size) && res.size >= 0 ? res.size : null,
    });
  }
  return out;
}
