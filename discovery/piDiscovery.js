// =============================================
// N Signage V3 — Pi Discovery Helper (Node.js, runs on the LAN)
//
// Browsers cannot send mDNS/UDP packets or sweep LAN addresses, so discovery
// runs here, on the machine that serves the website (Vite dev/preview server
// or the standalone `npm run discovery` server). The browser only calls:
//
//   GET /discovery-api/find?identifier=<pi-username>
//
// Discovery order (local network only, no IP scanning):
//   1. UDP broadcast — `nsignage-discover` sent to the broadcast address of
//      each of this machine's own LAN interfaces (UDP 50500). Every N-Signage
//      Pi running n-signage-discovery.service answers with its own Linux
//      username, hostname, device id and current IPv4.      [primary]
//   2. mDNS fallback (only if no Pi answered the broadcast):
//      DNS-SD `_nsignage._tcp.local` / `<identifier>.local` A record, then the
//      OS `.local` resolver in case the multicast socket is blocked.
// A Pi is only accepted when the Linux username IT reports (broadcast reply or
// `/api/status.pi_username`) matches the identifier. Every match is then
// checked against the Pi Flask API `/api/status` for online status.
//
// Results are returned to the caller only. Nothing is written to the device
// store here; registration happens in the website's Add Device form.
// =============================================

import dgram from 'node:dgram';
import os from 'node:os';
import dns from 'node:dns/promises';
import http from 'node:http';
import crypto from 'node:crypto';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const MDNS_TIMEOUT = 2500;     // total listen window
const MDNS_RESEND_AT = 1000;   // send the query a second time (UDP is lossy)
const RESOLVER_TIMEOUT = 3000;
const VERIFY_TIMEOUT = 3000;
const DEFAULT_PI_PORT = 5000;

export const UDP_DISCOVERY_PORT = Number(process.env.NSIGNAGE_DISCOVERY_PORT) || 50500;
const UDP_TIMEOUT = 2500;      // total listen window
const UDP_RESEND_AT = 900;     // re-broadcast once (UDP is lossy)
const UDP_MAX_REPLY = 2048;
const PROTOCOL_VERSION = 1;

export const SERVICE_TYPE = '_nsignage._tcp.local';

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 };

// Linux username rules (Debian NAME_REGEX, relaxed) — also keeps arbitrary
// input out of DNS/HTTP. Hostname labels (RFC 1123) are a stricter subset.
const IDENTIFIER_RX = /^[a-z0-9_][a-z0-9_.-]{0,31}$/i;
const HOSTNAME_LABEL_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const HOSTNAME_RX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const DEVICE_ID_RX = /^[a-f0-9]{16}$/;

export function isValidIdentifier(identifier) {
  return typeof identifier === 'string' && IDENTIFIER_RX.test(identifier);
}

// Linux usernames are lowercase on Raspberry Pi OS; compare case-insensitively
// so phone auto-capitalisation ("Ns") does not cause a false mismatch.
function sameUser(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function isPrivateIPv4(ip) {
  if (ipToInt(ip) === null) return false;
  const p = String(ip).split('.').map(Number);
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254)
  );
}

// Every active IPv4 interface of the helper machine. Some LANs (e.g. campus
// networks) use non-RFC1918 ranges, so interfaces are not filtered by range.
function lanIPv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (isV4 && !a.internal && !a.address.startsWith('169.254.')) {
        out.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  return out;
}

// Only local-network addresses are ever accepted as discovery results:
// a private range, or the same subnet as one of the helper's interfaces.
export function isLocalNetworkIPv4(ip, ifaces = lanIPv4Interfaces()) {
  if (isPrivateIPv4(ip)) return true;
  const target = ipToInt(ip);
  if (target === null) return false;
  return ifaces.some(({ address, netmask }) => {
    const mask = ipToInt(netmask);
    return mask !== null && mask !== 0 && ((ipToInt(address) & mask) >>> 0) === ((target & mask) >>> 0);
  });
}

// =============================================
// UDP broadcast discovery (protocol v1, see N-Signage/app/discovery_responder.py)
// Broadcasts only to the subnets this machine is directly attached to.
// =============================================
function directedBroadcast({ address, netmask }) {
  const a = ipToInt(address);
  const m = ipToInt(netmask);
  if (a === null || m === null) return null;
  const b = ((a & m) | (~m >>> 0)) >>> 0;
  return [b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}

// Strictly validate one reply. Returns a clean object or null.
export function parseAnnounce(buf, rinfo, nonce, ifaces) {
  if (buf.length > UDP_MAX_REPLY) return null;
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type !== 'nsignage-announce' || msg.v !== PROTOCOL_VERSION) return null;
  if (msg.nonce !== nonce) return null;                          // stale / not ours
  if (!isValidIdentifier(msg.pi_username)) return null;
  if (typeof msg.hostname !== 'string' || !HOSTNAME_RX.test(msg.hostname)) return null;
  if (typeof msg.device_id !== 'string' || !DEVICE_ID_RX.test(msg.device_id)) return null;
  if (ipToInt(msg.ip) === null || msg.ip !== rinfo.address) return null; // must be the real sender
  if (!isLocalNetworkIPv4(msg.ip, ifaces)) return null;
  const port = msg.api_port === undefined ? DEFAULT_PI_PORT : msg.api_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    username: msg.pi_username,
    hostname: msg.hostname,
    deviceId: msg.device_id,
    ip: msg.ip,
    port,
    protocolVersion: msg.discovery_protocol_version ?? msg.v,
  };
}

function udpDiscover(log) {
  return new Promise((resolve) => {
    const ifaces = lanIPv4Interfaces();
    const byDevice = new Map();
    if (ifaces.length === 0) {
      log('No active IPv4 network interface found on the helper machine.');
      resolve([]);
      return;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const packet = Buffer.from(JSON.stringify({ type: 'nsignage-discover', v: PROTOCOL_VERSION, nonce }));

    const sockets = ifaces.map((iface) => {
      const targets = [...new Set([directedBroadcast(iface), '255.255.255.255'].filter(Boolean))];
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const send = () => targets.forEach((t) => sock.send(packet, UDP_DISCOVERY_PORT, t, (err) => {
        if (err) log(`UDP broadcast to ${t} failed on ${iface.name}: ${err.message}`);
      }));

      sock.on('error', (err) => log(`UDP socket error on ${iface.address}: ${err.message}`));
      sock.on('message', (msg, rinfo) => {
        const pi = parseAnnounce(msg, rinfo, nonce, ifaces);
        if (!pi) {
          log(`Ignored invalid discovery reply from ${rinfo.address}`);
          return;
        }
        if (!byDevice.has(pi.deviceId)) {
          log(`Reply from ${pi.ip}: user "${pi.username}", host "${pi.hostname}", id ${pi.deviceId}`);
          byDevice.set(pi.deviceId, pi);
        }
      });
      sock.bind(0, iface.address, () => {
        try { sock.setBroadcast(true); } catch (err) { log(`setBroadcast failed on ${iface.address}: ${err.message}`); }
        log(`UDP discovery broadcast on ${iface.name} (${iface.address}) -> ${targets.join(', ')}:${UDP_DISCOVERY_PORT}`);
        send();
        setTimeout(send, UDP_RESEND_AT);
      });
      return sock;
    });

    setTimeout(() => {
      sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
      resolve([...byDevice.values()]);
    }, UDP_TIMEOUT);
  });
}

// =============================================
// Minimal DNS packet encode / decode (mDNS uses the DNS wire format)
// =============================================
function encodeName(name) {
  const labels = name.split('.').filter(Boolean).map((label) => {
    const b = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...labels, Buffer.from([0])]);
}

function buildQuery(questions) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0); // id (echoed in legacy-unicast replies)
  header.writeUInt16BE(questions.length, 4);
  const body = questions.map(({ name, type }) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2); // class IN
    return Buffer.concat([encodeName(name), tail]);
  });
  return Buffer.concat([header, ...body]);
}

function readName(buf, offset) {
  const labels = [];
  let end = -1;
  for (let guard = 0; guard < 128; guard++) {
    if (offset >= buf.length) throw new Error('Truncated name');
    const len = buf[offset];
    if (len === 0) { offset += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (end === -1) end = offset + 2;
      offset = buf.readUInt16BE(offset) & 0x3fff;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), end: end === -1 ? offset : end };
}

function parseTxt(buf, start, length) {
  const kv = {};
  let p = start;
  while (p < start + length) {
    const len = buf[p];
    const s = buf.toString('utf8', p + 1, p + 1 + len);
    const eq = s.indexOf('=');
    if (eq > 0) kv[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
    else if (s) kv[s.toLowerCase()] = true;
    p += 1 + len;
  }
  return kv;
}

export function parsePacket(buf) {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).end + 4;

  const records = [];
  for (let i = 0; i < rrCount; i++) {
    const { name, end } = readName(buf, off);
    const type = buf.readUInt16BE(end);
    const rdlen = buf.readUInt16BE(end + 8);
    const rd = end + 10;
    off = rd + rdlen;
    if (off > buf.length) break;

    if (type === TYPE.A && rdlen === 4) {
      records.push({ name, type, data: [...buf.subarray(rd, rd + 4)].join('.') });
    } else if (type === TYPE.PTR) {
      records.push({ name, type, data: readName(buf, rd).name });
    } else if (type === TYPE.SRV) {
      records.push({ name, type, data: { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name } });
    } else if (type === TYPE.TXT) {
      records.push({ name, type, data: parseTxt(buf, rd, rdlen) });
    }
  }
  return records;
}

// =============================================
// mDNS query over every LAN interface
// Sent from an ephemeral port => responders reply by unicast (RFC 6762 §6.7),
// so we never need to bind port 5353 (often held by Bonjour/Chrome).
// =============================================
function mdnsQuery(questions, log) {
  return new Promise((resolve) => {
    const records = [];
    const ifaces = lanIPv4Interfaces();
    if (ifaces.length === 0) {
      log('No active IPv4 network interface found on the helper machine.');
      resolve(records);
      return;
    }

    const packet = buildQuery(questions);
    const sockets = ifaces.map((iface) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const send = () => sock.send(packet, MDNS_PORT, MDNS_ADDR, (err) => {
        if (err) log(`mDNS send failed on ${iface.name} (${iface.address}): ${err.message}`);
      });

      sock.on('error', (err) => log(`mDNS socket error on ${iface.address}: ${err.message}`));
      sock.on('message', (msg, rinfo) => {
        try {
          parsePacket(msg).forEach((r) => records.push({ ...r, from: rinfo.address }));
        } catch {
          log(`Ignored malformed mDNS packet from ${rinfo.address}`);
        }
      });
      sock.bind(0, iface.address, () => {
        try {
          sock.setMulticastInterface(iface.address);
          sock.setMulticastTTL(255);
        } catch (err) {
          log(`Could not set multicast options on ${iface.address}: ${err.message}`);
        }
        log(`mDNS query sent on ${iface.name} (${iface.address})`);
        send();
        setTimeout(send, MDNS_RESEND_AT);
      });
      return sock;
    });

    setTimeout(() => {
      sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
      resolve(records);
    }, MDNS_TIMEOUT);
  });
}

function candidatesFromRecords(records, identifier) {
  const id = identifier.toLowerCase();
  const out = [];

  // 1. DNS-SD service announced by the Pi (V3 Phase 2)
  const instances = new Set(
    records.filter((r) => r.type === TYPE.PTR && r.name === SERVICE_TYPE).map((r) => r.data)
  );
  for (const inst of instances) {
    const txt = records.find((r) => r.type === TYPE.TXT && r.name === inst)?.data || {};
    const instLabel = inst.endsWith(`.${SERVICE_TYPE}`) ? inst.slice(0, -(SERVICE_TYPE.length + 1)) : inst;
    if (String(txt.id || '').toLowerCase() !== id && instLabel !== id) continue;

    const srv = records.find((r) => r.type === TYPE.SRV && r.name === inst)?.data;
    const port = srv?.port || Number(txt.port) || DEFAULT_PI_PORT;
    const ips = srv
      ? records.filter((r) => r.type === TYPE.A && r.name === srv.target).map((r) => r.data)
      : [];
    if (ips.length === 0) {
      // No A record in the answer — fall back to the address that answered
      const from = records.find((r) => r.name === inst)?.from;
      if (from) ips.push(from);
    }
    ips.forEach((ip) => out.push({ ip, port, method: 'dns-sd', hostname: srv?.target || null }));
  }

  // 2. Plain hostname announcement (Avahi default on Raspberry Pi OS)
  const host = `${id}.local`;
  records
    .filter((r) => r.type === TYPE.A && r.name === host)
    .forEach((r) => out.push({ ip: r.data, port: DEFAULT_PI_PORT, method: 'mdns-hostname', hostname: host }));

  return out;
}

async function osResolve(identifier, log) {
  const host = `${identifier.toLowerCase()}.local`;
  try {
    const result = await Promise.race([
      dns.lookup(host, { family: 4, all: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), RESOLVER_TIMEOUT)),
    ]);
    return result.map((r) => ({ ip: r.address, port: DEFAULT_PI_PORT, method: 'os-resolver', hostname: host }));
  } catch (err) {
    log(`OS resolver could not resolve ${host}: ${err.code || err.message}`);
    return [];
  }
}

// =============================================
// Verify a candidate against the existing V2 Flask API
// =============================================
function getJson(ip, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: ip, port, path, timeout: VERIFY_TIMEOUT }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Ask the Pi's own Flask API who it is and whether it is serving.
async function checkStatus(ip, port, log) {
  try {
    const status = await getJson(ip, port, '/api/status');
    log(`${ip}:${port} /api/status OK (pi_username "${status?.pi_username ?? '—'}")`);
    return { online: true, status };
  } catch (err) {
    log(`${ip}:${port} /api/status failed: ${err.message}`);
    return { online: false, status: null };
  }
}

// Broadcast match: username already reported by the Pi. If /api/status also
// reports a username it must agree, otherwise the address is not trusted.
async function verifyAnnounced(pi, log) {
  const { online, status } = await checkStatus(pi.ip, pi.port, log);
  if (status?.pi_username && !sameUser(status.pi_username, pi.username)) {
    log(`${pi.ip}: broadcast says "${pi.username}" but /api/status says "${status.pi_username}" — rejected.`);
    return null;
  }
  return { ...pi, online, method: 'udp-broadcast', identityVerified: true };
}

// mDNS fallback: only the hostname matched, so the username MUST come from
// the Pi's /api/status before the address is accepted.
async function verifyMdnsCandidate(candidate, identifier, log) {
  const { online, status } = await checkStatus(candidate.ip, candidate.port, log);
  if (!online || !sameUser(status?.pi_username, identifier)) {
    log(`${candidate.ip}: username not confirmed by the Pi — not accepted.`);
    return null;
  }
  return {
    ip: candidate.ip,
    port: candidate.port,
    username: status.pi_username,
    hostname: status.hostname || candidate.hostname,
    deviceId: DEVICE_ID_RX.test(status.device_id || '') ? status.device_id : null,
    online: true,
    method: candidate.method,
    identityVerified: true,
  };
}

async function mdnsFallback(identifier, log) {
  if (!HOSTNAME_LABEL_RX.test(identifier)) {
    log(`"${identifier}" is not a valid hostname — mDNS fallback skipped.`);
    return [];
  }
  log(`mDNS fallback: ${SERVICE_TYPE} and ${identifier.toLowerCase()}.local`);
  const records = await mdnsQuery(
    [
      { name: SERVICE_TYPE, type: TYPE.PTR },
      { name: `${identifier.toLowerCase()}.local`, type: TYPE.A },
    ],
    log
  );
  log(`Received ${records.length} mDNS record(s)`);

  let candidates = candidatesFromRecords(records, identifier);
  if (candidates.length === 0) {
    log('No mDNS answer — trying OS .local resolver');
    candidates = await osResolve(identifier, log);
  }

  // Keep local-network addresses only, de-duplicated, DNS-SD results first
  const ifaces = lanIPv4Interfaces();
  const seen = new Set();
  candidates = candidates.filter((c) => {
    const key = `${c.ip}:${c.port}`;
    if (!isLocalNetworkIPv4(c.ip, ifaces)) { log(`Ignored non-local address ${c.ip}`); return false; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  log(`mDNS candidates: ${candidates.length ? candidates.map((c) => `${c.ip}:${c.port} via ${c.method}`).join(', ') : 'none'}`);

  const verified = await Promise.all(candidates.map((c) => verifyMdnsCandidate(c, identifier, log)));
  return verified.filter(Boolean);
}

// =============================================
// Public entry point
// =============================================
export async function findPi(identifier) {
  const startedAt = Date.now();
  const logLines = [];
  const log = (msg) => {
    logLines.push(`+${Date.now() - startedAt}ms ${msg}`);
    console.log(`[PI DISCOVERY] ${msg}`);
  };

  if (!isValidIdentifier(identifier)) {
    return { found: false, identifier, reason: 'invalid-identifier', log: ['Username may contain only letters, numbers, "_", "." and "-".'] };
  }

  log(`Looking for Pi with Linux username "${identifier}"`);
  const announced = await udpDiscover(log);
  const matching = announced.filter((pi) => sameUser(pi.username, identifier));
  const otherCount = announced.length - matching.length;
  log(`${announced.length} N-Signage Pi(s) answered, ${matching.length} with username "${identifier}"`);

  let devices;
  if (matching.length > 0) {
    devices = (await Promise.all(matching.map((pi) => verifyAnnounced(pi, log)))).filter(Boolean);
  } else if (announced.length === 0) {
    // Nothing answered the broadcast (responder not installed / UDP blocked)
    devices = await mdnsFallback(identifier, log);
  } else {
    devices = [];
  }

  // Online devices first, then stable order by IP
  devices.sort((a, b) => (b.online - a.online) || (ipToInt(a.ip) - ipToInt(b.ip)));
  const durationMs = Date.now() - startedAt;

  if (devices.length === 0) {
    return {
      found: false,
      identifier,
      reason: otherCount > 0 ? 'username-mismatch' : 'not-found',
      otherCount,
      devices: [],
      durationMs,
      log: logLines,
    };
  }

  // A single match is returned flat for convenience; several matches (e.g.
  // many Pis using the same username) must be chosen by the customer.
  const single = devices.length === 1 ? devices[0] : null;
  return {
    found: true,
    identifier,
    multiple: devices.length > 1,
    devices,
    otherCount,
    ...(single && {
      ip: single.ip,
      port: single.port,
      username: single.username,
      hostname: single.hostname,
      deviceId: single.deviceId,
      method: single.method,
      online: single.online,
      identityVerified: single.identityVerified,
    }),
    durationMs,
    log: logLines,
  };
}

// =============================================
// HTTP handler — shared by the Vite middleware and the standalone server.
// `req.url` is relative to the mount point, e.g. "/find?identifier=ns".
// =============================================

// Each search opens UDP sockets on every interface for a few seconds, so
// cap concurrent searches to keep the helper from being flooded.
const MAX_CONCURRENT_FINDS = 4;
let activeFinds = 0;

export function discoveryRequestHandler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const send = (code, body) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    send(200, { ok: true, service: 'n-signage-discovery', interfaces: lanIPv4Interfaces().length });
    return;
  }

  if (req.method !== 'GET' || url.pathname !== '/find') {
    send(404, { error: 'Not found' });
    return;
  }

  const identifier = (url.searchParams.get('identifier') || '').trim();
  if (!isValidIdentifier(identifier)) {
    send(400, { found: false, reason: 'invalid-identifier', error: 'Enter the Pi\'s Linux username (letters, numbers, "_", "." or "-"), e.g. ns.' });
    return;
  }

  if (activeFinds >= MAX_CONCURRENT_FINDS) {
    send(429, { found: false, identifier, reason: 'helper-busy', error: 'Too many searches in progress. Try again in a few seconds.' });
    return;
  }

  activeFinds += 1;
  findPi(identifier)
    .then((result) => send(200, result))
    .catch((err) => {
      console.error(`[PI DISCOVERY ERROR] ${err.stack || err.message}`);
      send(500, { found: false, identifier, reason: 'helper-error', log: [err.message] });
    })
    .finally(() => { activeFinds -= 1; });
}
