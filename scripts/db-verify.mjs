#!/usr/bin/env node
// Verify the real database from PostgreSQL's catalog, connected exactly like the
// website (nsignage_api, transaction pooler, verify-full TLS).
//   npm run db:verify                      (DATABASE_URL from .env)
import { loadEnvFile, ENV_FILE } from './lib/env.mjs';
import postgres from 'postgres';
import { SUPABASE_ROOT_CA_2021 } from '../api/_lib/supabaseCa.js';
import { verifyCatalog } from './lib/dbVerify.mjs';

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) { console.error(`DATABASE_URL is not set (expected in ${ENV_FILE})`); process.exit(1); }
const u = new URL(url);
console.log(`Connecting to ${u.hostname}:${u.port} as ${decodeURIComponent(u.username).split('.')[0]} (project ${decodeURIComponent(u.username).split('.')[1]}), TLS verify-full`);
const sql = postgres(url, { ssl: { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true }, max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
try {
  const started = Date.now();
  await sql`select 1`;
  console.log(`Connected in ${Date.now() - started} ms`);
  const v = await verifyCatalog(sql);
  console.log(JSON.stringify(v.report, null, 2));
  console.log(v.ok ? 'CATALOG OK' : `CATALOG PROBLEMS:\n - ${v.problems.join('\n - ')}`);
  process.exitCode = v.ok ? 0 : 1;
} catch (err) {
  console.error('Connection failed:', err.code || '', String(err.message).replace(/[A-Za-z0-9_-]{40,}/g, '***'));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
