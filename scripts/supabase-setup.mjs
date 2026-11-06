#!/usr/bin/env node
// =============================================
// N Signage — apply the database migrations to the Supabase project and give
// the website's least-privilege role (nsignage_api) a new password.
//
//   npm run db:setup
//
// Reads SUPABASE_ADMIN_URL from `.env` (the "Session pooler" connection string
// from Supabase → Connect: role postgres, port 5432). Used ONLY here, never deployed.
//
// What it does (all in one transaction):
//   1. runs every file in supabase/migrations/ (idempotent: skips what exists)
//   2. sets a new random 48-char password for the role nsignage_api
//   3. updates DATABASE_URL=<transaction pooler URL as nsignage_api> in `.env`
//      (other lines are kept; the password is NEVER printed)
//   4. connects as nsignage_api with verify-full TLS and checks role, schema and RLS
// Re-running ROTATES the nsignage_api password: the live website keeps failing
// until DATABASE_URL is updated in Vercel → Production too, so run it deliberately.
// =============================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { SUPABASE_ROOT_CA_2021 } from '../api/_lib/supabaseCa.js';
import { verifyCatalog } from './lib/dbVerify.mjs';
import { loadEnvFile, setEnvValue, ENV_FILE } from './lib/env.mjs';

loadEnvFile();
const adminUrl = process.env.SUPABASE_ADMIN_URL;
if (!adminUrl) {
  console.log(`SUPABASE_ADMIN_URL is not set in ${ENV_FILE}. Usage: npm run db:setup`);
  process.exit(1);
}

const tls = { ca: process.env.DATABASE_CA_CERT || SUPABASE_ROOT_CA_2021, rejectUnauthorized: true };
const u = new URL(adminUrl);
const ref = decodeURIComponent(u.username).split('.')[1];
if (!ref || !u.hostname.endsWith('.pooler.supabase.com')) {
  console.error('Use the Supavisor pooler URL (user "postgres.<project-ref>", host *.pooler.supabase.com).');
  process.exit(1);
}

const admin = postgres(adminUrl.replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, ''), { ssl: tls, max: 1, prepare: false, onnotice: () => {} });
const password = crypto.randomBytes(36).toString('base64url'); // 48 chars, URL-safe
try {
  const files = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  await admin.begin(async (t) => {
    for (const f of files) {
      // the migration files manage their own begin/commit; strip them inside our transaction
      const sql = fs.readFileSync(path.join('supabase/migrations', f), 'utf8').replace(/^\s*(begin|commit);\s*$/gim, '');
      await t.unsafe(sql);
      console.log(`applied ${f}`);
    }
    await t.unsafe(`alter role nsignage_api with password '${password}'`); // base64url: no quotes possible
  });
  const v = await verifyCatalog(admin);
  console.log('Catalog verification (as project owner):');
  console.log(JSON.stringify(v.report, null, 2));
  console.log(v.ok ? 'CATALOG OK: all required tables, views, foreign keys, indexes and migrations exist.' : `CATALOG PROBLEMS:\n - ${v.problems.join('\n - ')}`);
  if (!v.ok) process.exitCode = 1;
} catch (err) {
  console.error('Migration failed:', err.code || '', err.message);
  await admin.end();
  process.exit(1);
}
await admin.end();

// Transaction pooler (port 6543) as nsignage_api — what the website uses
const apiUrl = `postgresql://nsignage_api.${ref}:${password}@${u.hostname}:6543/postgres`;
setEnvValue('DATABASE_URL', apiUrl);
console.log(`DATABASE_URL for nsignage_api updated in ${ENV_FILE} (password not shown). Update Vercel → Production too.`);

// Verify the API connection the way the website will use it
const api = postgres(apiUrl, { ssl: tls, max: 1, prepare: false, onnotice: () => {} });
try {
  const [r] = await api.begin(async (t) => t`
    select current_user as role, (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
           (select count(*)::int from pg_tables where schemaname = 'nsignage') as tables,
           (select count(*)::int from pg_tables where schemaname = 'nsignage' and not rowsecurity) as no_rls,
           (select count(*)::int from nsignage.users) as visible_users_without_context`);
  console.log(JSON.stringify({ connectedAs: r.role, tls: 'verify-full', bypassRls: r.bypass, tables: r.tables, tablesWithoutRls: r.no_rls, visibleUsersWithoutContext: r.visible_users_without_context }));
  const ok = r.role === 'nsignage_api' && !r.bypass && r.tables >= 13 && r.no_rls === 0 && r.visible_users_without_context === 0;
  console.log(ok ? 'OK: least-privilege role, RLS on every table, nothing visible without a context.' : 'CHECK FAILED — see above.');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error('Could not connect as nsignage_api:', err.code || '', err.message);
  process.exitCode = 1;
} finally {
  await api.end();
}
