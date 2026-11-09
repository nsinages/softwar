// Calls the real Vercel-style API handlers in-process, with a cookie jar per
// simulated browser and a configurable client IP. There is no media storage to fake:
// uploads go from the browser straight to the Pi's receiver.
// Database: real PostgreSQL (see testDb.js).
import crypto from 'node:crypto';
import { setupDatabase } from './testDb.js';

export const HOST = 'software.nsinages.in';
export const ORIGIN = `https://${HOST}`;

export async function setupEnv() {
  const database = await setupDatabase();
  // Throwaway Ed25519 key that signs upload tickets in this test process only
  process.env.NSIGNAGE_TICKET_KEY ||= crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  process.env.CRON_SECRET = 'cron-secret-for-tests';
  return database;
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

/**
 * Everything a simulated client sent that the API turns into rate-limit keys or
 * security-event IP hashes (client IPs, usernames given to auth actions). Used to
 * remove exactly this run's rows from a real Supabase test project afterwards.
 */
export const footprint = { ips: new Set(), usernames: new Set() };

/**
 * Delete this run's rate-limit rows and security events (they have no foreign key to
 * users/devices, so deleting those does not remove them). Targeted: only keys derived
 * from values this run used. Call inside db.asSystem().
 */
export async function deleteFootprint(t, { userIds = [], deviceIds = [] } = {}) {
  const { keyHash } = await import('../../api/_lib/cloud.js');
  const ipHashes = [...footprint.ips].map(keyHash);
  const keys = [...ipHashes, ...[...footprint.usernames, ...userIds, ...deviceIds].map(keyHash)];
  await t`delete from nsignage.security_events
          where user_id = any(${userIds}::uuid[]) or device_id = any(${deviceIds}::text[]) or ip_hash = any(${ipHashes}::text[])`;
  await t`delete from nsignage.rate_limits where key_hash = any(${keys}::text[])`;
}

/** A simulated browser (or Pi) with its own cookies and public IP. */
export class Client {
  constructor(name, ip = `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${((Math.random() * 250) | 0) + 1}`) {
    this.name = name;
    this.ip = ip;
    this.cookies = {};
  }

  async call(handler, { method = 'GET', query = {}, body, headers = {}, origin = ORIGIN } = {}) {
    footprint.ips.add(String(this.ip).trim().toLowerCase());
    if (query?.action && body && typeof body.username === 'string') footprint.usernames.add(body.username.trim().toLowerCase());
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
