// =============================================
// N Signage — client address for the LOCAL dev servers (npm run dev / dev:cloud)
//
// Find IP (and "Enter IP manually") match a browser and a Pi by the PUBLIC
// address both use to reach the website, as Vercel sees it. A browser on this
// PC reaches a local dev server as 127.0.0.1 (or a LAN address), which never
// matches the Pi's public address, so Add Device could not find any Pi locally.
// For requests from loopback / the local network, the dev servers therefore
// use this PC's public IPv4 (looked up once via https://1.1.1.1/cdn-cgi/trace,
// cached 5 minutes): exactly what Vercel would see for the same browser.
//
// Never used on Vercel. NSIGNAGE_DEV_PUBLIC_IP=<ip> fixes the value,
// NSIGNAGE_DEV_PUBLIC_IP=off keeps the raw socket address.
// =============================================
import https from 'node:https';

const LOCAL_RX = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const CACHE_MS = 5 * 60_000;
let cache = { ip: null, at: 0 };
let warned = false;

/** Loopback, private, link-local or carrier-NAT address (IPv4, IPv4-mapped IPv6, ::1, fe80::/10, fc00::/7). */
export function isLocalAddress(raw) {
  const ip = String(raw || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!ip) return true;
  if (ip === '::1' || ip.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(ip)) return true;
  return LOCAL_RX.test(ip);
}

function lookupPublicIpv4() {
  return new Promise((resolve) => {
    const req = https.get({ host: '1.1.1.1', path: '/cdn-cgi/trace', family: 4, timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        const ip = /^ip=(\d+\.\d+\.\d+\.\d+)$/m.exec(body)?.[1] || null;
        resolve(ip);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

/** The address the API should treat as the browser's (dev servers only). */
export async function devClientIp(remote, { lookup = lookupPublicIpv4 } = {}) {
  const raw = String(remote || '').replace(/^::ffff:/, '') || '127.0.0.1';
  if (process.env.VERCEL) return raw;
  const override = String(process.env.NSIGNAGE_DEV_PUBLIC_IP || '').trim();
  if (override.toLowerCase() === 'off' || !isLocalAddress(raw)) return raw;
  if (override) return override;
  if (!cache.ip || Date.now() - cache.at > CACHE_MS) {
    const ip = await lookup();
    if (ip) cache = { ip, at: Date.now() };
    else if (!warned) {
      warned = true;
      console.warn('[n-signage dev] could not look up this PC\'s public IP; Find IP will not match Pis locally. Set NSIGNAGE_DEV_PUBLIC_IP=<your public IPv4>.');
    }
  }
  return cache.ip || raw;
}

/** Tests only. */
export function resetDevClientIp() {
  cache = { ip: null, at: 0 };
  warned = false;
}
