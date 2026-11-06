// =============================================
// N Signage — Supabase PostgreSQL access (server-side only)
//
// Connection: Supabase Supavisor pooler in TRANSACTION mode (port 6543), the
// mode Supabase recommends for serverless functions: each function instance
// keeps at most a few client connections and the pooler multiplexes them onto
// a small number of database connections. Transaction mode does not support
// prepared statements, so `prepare: false`.
//
// TLS: verify-full. The pooler certificate chains to the Supabase Root 2021 CA
// (bundled in supabaseCa.js), and the host name is checked.
//
// Least privilege + RLS: every transaction first switches to the role
// `nsignage_api` and sets the RLS context ('user' | 'device' | 'system') —
// in ONE statement, transaction-local. Even if DATABASE_URL pointed at a more
// privileged role by mistake, queries still run as nsignage_api under RLS.
//
// Never import this module from frontend code (src/). DATABASE_URL is a
// server-only secret and must never be given a VITE_ prefix.
// =============================================
import postgres from 'postgres';
import { SUPABASE_ROOT_CA_2021 } from './supabaseCa.js';

export const API_ROLE = 'nsignage_api';
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_ID_RX = /^[a-f0-9]{16}$/;

let client = null;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function dbError(status, message, reason) {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function tlsOptions() {
  const mode = String(process.env.DATABASE_SSL || 'verify-full').toLowerCase();
  if (mode === 'disable') {
    // Only for the local test database (PGlite). Refused on Vercel.
    if (process.env.VERCEL) throw dbError(503, 'Database TLS cannot be disabled in a deployment.', 'database-not-configured');
    return false;
  }
  return { ca: process.env.DATABASE_CA_CERT || SUPABASE_ROOT_CA_2021, rejectUnauthorized: true };
}

/** The shared connection pool of this function instance (created lazily). */
export function sql() {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[N-SIGNAGE DB] DATABASE_URL is not set');
    throw dbError(503, 'The N-Signage database is not configured. Please contact support.', 'database-not-configured');
  }
  // sslmode in the URL would be overridden by our explicit TLS settings anyway; strip it for clarity
  const cleanUrl = url.replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, '');
  client = postgres(cleanUrl, {
    prepare: false,                                       // required by the transaction pooler
    max: Math.min(10, Math.max(1, Number(process.env.DATABASE_POOL_MAX) || 3)),
    idle_timeout: 20,                                     // seconds; frees pooler slots between bursts
    max_lifetime: 30 * 60,
    connect_timeout: 10,
    ssl: tlsOptions(),
    connection: { application_name: 'nsignage-api' },
    types: {
      // bigint columns (sizes, byte counts) as JS numbers; values stay far below 2^53
      bigint: { to: 20, from: [20], parse: (v) => Number(v), serialize: (v) => String(v) },
    },
    onnotice: () => {},
  });
  return client;
}

/** Map low-level driver errors to safe HTTP errors (no credentials, no SQL in messages). */
export function mapDbError(err) {
  if (err?.status) return err;
  const code = err?.code || '';
  if (code === '42501') return dbError(403, 'Not allowed.', 'forbidden');              // RLS / privilege / guard trigger
  if (code === '23505') return dbError(409, 'This record already exists.', 'conflict');
  if (code === '23514' || code === '22P02' || code === '23502' || code === '22001') {
    // message names the constraint/column only (row values are in err.detail, which is not logged)
    console.warn('[N-SIGNAGE DB] rejected data', code, err?.message?.slice(0, 200));
    return dbError(400, 'Invalid data.', 'invalid');
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED',
       'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
       '28P01', '28000', '3D000', '57P01', '53300', 'XX000'].includes(code)) {
    console.error('[N-SIGNAGE DB] connection problem', code);
    return dbError(503, 'The N-Signage database is temporarily unavailable. Please try again.', 'database-unreachable');
  }
  console.error('[N-SIGNAGE DB] query failed', code, err?.message?.slice(0, 200));
  return dbError(500, 'Database error', 'database-error');
}

/** Run `fn(t)` in one transaction as nsignage_api with the given RLS context. */
export async function withContext(ctx, ids, fn) {
  const user = ids?.user || '';
  const device = ids?.device || '';
  if (user && !UUID_RX.test(user)) throw dbError(400, 'Invalid user id', 'invalid');
  if (device && !DEVICE_ID_RX.test(device)) throw dbError(400, 'Invalid device id', 'invalid');
  for (let attempt = 1; ; attempt += 1) {
    let started = false;
    try {
      return await sql().begin(async (t) => {
        started = true;
        await t`select set_config('role', ${API_ROLE}, true),
                       set_config('nsignage.ctx', ${ctx}, true),
                       set_config('nsignage.user_id', ${user}, true),
                       set_config('nsignage.device_id', ${device}, true)`;
        return fn(t);
      });
    } catch (err) {
      // A brief DNS / connect failure while OPENING a new pooled connection: nothing was
      // sent, so one retry is safe (never retried once the transaction body has started).
      if (!started && attempt === 1 && CONNECT_ERRORS.has(err?.code)) {
        console.warn('[N-SIGNAGE DB] connect failed, retrying once', err.code);
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw mapDbError(err);
    }
  }
}
const CONNECT_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'CONNECT_TIMEOUT']);

/** Switch the RLS context inside an open transaction (e.g. a claim inside a customer request). */
export async function setContext(t, ctx, ids = {}) {
  await t`select set_config('nsignage.ctx', ${ctx}, true),
                 set_config('nsignage.user_id', ${ids.user || ''}, true),
                 set_config('nsignage.device_id', ${ids.device || ''}, true)`;
}

export const asSystem = (fn) => withContext('system', {}, fn);
export const asUser = (userId, fn) => withContext('user', { user: userId }, fn);
export const asDevice = (deviceId, fn) => withContext('device', { device: deviceId }, fn);
export const asAnonymous = (fn) => withContext('none', {}, fn);

/**
 * Fixed-window rate limit, atomic in the database. Throws 429 when exceeded.
 * Pass `t` to run inside an existing transaction.
 */
export async function rateLimit(bucket, keyHash, limit, windowS, t = null) {
  const run = async (tx) => (await tx`select nsignage.rate_limit_hit(${bucket}, ${keyHash}, ${limit}, ${windowS}) as ok`)[0].ok;
  const ok = t ? await run(t) : await asAnonymous(run);
  if (!ok) {
    const err = dbError(429, 'Too many attempts. Please wait a minute and try again.', 'rate-limited');
    err.retryAfter = windowS;
    throw err;
  }
}

/** Health check: connectivity, role, schema, RLS (never returns secrets). */
export async function databaseHealth() {
  if (!databaseConfigured()) return { configured: false, reachable: false };
  const started = Date.now();
  try {
    const [row] = await asAnonymous((t) => t`
      select current_user as role,
             (select count(*)::int from pg_tables where schemaname = 'nsignage') as tables,
             (select count(*)::int from pg_tables where schemaname = 'nsignage' and not rowsecurity) as tables_without_rls,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls`);
    return {
      configured: true,
      reachable: true,
      role: row.role,
      schema: row.tables >= 13,
      rlsOnAllTables: row.tables_without_rls === 0,
      roleBypassesRls: row.bypass_rls,
      tls: tlsOptions() ? 'verify-full' : 'disabled',
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { configured: true, reachable: false, error: err.reason || 'database-unreachable' };
  }
}

/** Tests / scripts: close the pool. */
export async function closeDb() {
  if (client) {
    const c = client;
    client = null;
    await c.end({ timeout: 5 });
  }
}

export const ms = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : null);
