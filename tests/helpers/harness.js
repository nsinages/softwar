// Calls the real Vercel-style API handlers in-process, with a cookie jar per
// simulated browser, a configurable client IP and an in-memory Blob backend.
import crypto from 'node:crypto';
import { startMockUpstash } from './mockUpstash.js';

export const HOST = 'software.nsinages.in';
export const ORIGIN = `https://${HOST}`;

export async function setupEnv() {
  const upstash = await startMockUpstash();
  process.env.KV_REST_API_URL = upstash.url;
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.UPSTASH_DISABLE_TELEMETRY = '1';
  process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_teststore123_${'x'.repeat(30)}`;
  process.env.CRON_SECRET = 'cron-secret-for-tests';
  return upstash;
}

/** In-memory replacement for Vercel Blob. */
export function memoryBlob() {
  const blobs = new Map(); // url -> { bytes, pathname, uploadedAt }
  return {
    blobs,
    put(pathname, bytes, { access = 'public', uploadedAt = Date.now() } = {}) {
      const dot = pathname.lastIndexOf('.');
      const withSuffix = `${pathname.slice(0, dot)}-${crypto.randomBytes(15).toString('base64url')}${pathname.slice(dot)}`;
      const url = `https://teststore123.${access}.blob.vercel-storage.com/${withSuffix}`;
      blobs.set(url, { bytes: Buffer.from(bytes), pathname: withSuffix, uploadedAt });
      return url;
    },
    backend: {
      async head(url) { const b = blobs.get(url); return b ? { size: b.bytes.length, contentType: 'x', pathname: b.pathname } : null; },
      async del(urls) { for (const u of [].concat(urls)) blobs.delete(u); },
      async list(prefix) {
        return { blobs: [...blobs.entries()].filter(([, b]) => b.pathname.startsWith(prefix)).map(([url, b]) => ({ url, pathname: b.pathname, size: b.bytes.length, uploadedAt: b.uploadedAt })), cursor: null };
      },
      async readPrefix(url, n) { const b = blobs.get(url); if (!b) throw new Error('404'); return b.bytes.subarray(0, n); },
      async presignGet(pathname, validUntil) { return `https://teststore123.private.blob.vercel-storage.com/${pathname}?sig=test&exp=${validUntil}`; },
    },
  };
}

function makeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: undefined,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    end(data) { this.body = data ? JSON.parse(data) : undefined; this.ended = true; },
  };
}

/** A simulated browser (or Pi) with its own cookies and public IP. */
export class Client {
  constructor(name, ip = `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${((Math.random() * 250) | 0) + 1}`) {
    this.name = name;
    this.ip = ip;
    this.cookies = {};
  }

  async call(handler, { method = 'GET', query = {}, body, headers = {}, origin = ORIGIN } = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const req = {
      method,
      query,
      body,
      url: '/api/x',
      headers: {
        host: HOST,
        'x-real-ip': this.ip,
        'user-agent': `test-${this.name}`,
        ...(origin && method !== 'GET' && { origin }),
        ...(cookie && { cookie }),
        ...(body && { 'content-type': 'application/json' }),
        ...headers,
      },
    };
    const res = makeRes();
    await handler(req, res);
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      for (const c of [].concat(setCookie)) {
        const [pair, ...attrs] = c.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const maxAge = attrs.find((a) => a.trim().toLowerCase().startsWith('max-age='));
        if (!value || (maxAge && Number(maxAge.split('=')[1]) <= 0)) delete this.cookies[name];
        else this.cookies[name] = value;
      }
    }
    return { status: res.statusCode, body: res.body, headers: res.headers };
  }
}
