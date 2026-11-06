#!/usr/bin/env node
// Verify the real database from PostgreSQL's catalog, connected exactly like the
// website (nsignage_api, transaction pooler, verify-full TLS).
//   npm run db:verify                      (uses .env.supabase-test.local)
//   npm run db:verify -- <file.local>
import fs from 'node:fs';
import postgres from 'postgres';
import { SUPABASE_ROOT_CA_2021 } from '../api/_lib/supabaseCa.js';
import { verifyCatalog } from './lib/dbVerify.mjs';

const file = process.argv[2] || '.env.supabase-test.local';
if (!fs.existsSync(file)) { console.error(`Missing ${file}`); process.exit(1); }
const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
if (!line) { console.error(`${file} has no DATABASE_URL`); process.exit(1); }
const url = line.slice('DATABASE_URL='.length).trim();
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
