#!/usr/bin/env node
// =============================================
// N Signage — apply the database migration to a Supabase project and create
// the least-privilege connection for the website.
//
//   SUPABASE_ADMIN_URL='postgresql://postgres.<ref>:<db password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' \
//     node scripts/supabase-setup.mjs --env-file .env.supabase-test.local
//
// SUPABASE_ADMIN_URL: the "Session pooler" connection string from Supabase →
// Connect (role postgres, port 5432). Used ONLY here, never deployed.
//
// What it does (all in one transaction):
//   1. runs every file in supabase/migrations/ (idempotent)
//   2. sets a new random 48-char password for the role nsignage_api
//   3. writes DATABASE_URL=<transaction pooler URL as nsignage_api> to --env-file
//      (git-ignored; the password is NEVER printed)
//   4. connects as nsignage_api with verify-full TLS and checks role, schema and RLS
// Re-running rotates the nsignage_api password (update Vercel afterwards).
// =============================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { SUPABASE_ROOT_CA_2021 } from '../api/_lib/supabaseCa.js';
import { verifyCatalog } from './lib/dbVerify.mjs';

// Usage (recommended — the admin URL stays in a git-ignored file, never in the shell history):
//   npm run db:setup -- --admin-env-file .env.supabase-admin.local --env-file .env.supabase-test.local
//   where .env.supabase-admin.local has one line: SUPABASE_ADMIN_URL=postgresql://postgres.<ref>:<db password>@<pooler host>:5432/postgres

const args = process.argv.slice(2);
const envFile = path.resolve(args[args.indexOf('--env-file') + 1] || '.env.supabase.local');
if (args.includes('--admin-env-file')) {
  const f = args[args.indexOf('--admin-env-file') + 1];
  if (!f || !/\.local$/.test(f) || !fs.existsSync(f)) { console.error('Admin env file missing (its name must end in .local).'); process.exit(1); }
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*SUPABASE_ADMIN_URL\s*=\s*(.+?)\s*$/.exec(line);
    if (m) process.env.SUPABASE_ADMIN_URL = m[1].replace(/^["']|["']$/g, '');
  }
}
const adminUrl = process.env.SUPABASE_ADMIN_URL;
if (!adminUrl || args.indexOf('--env-file') < 0) {
  console.log('Usage: npm run db:setup -- --admin-env-file <admin.local> --env-file <file.local>');
  process.exit(1);
}
if (!/\.local$/.test(envFile)) {
  console.error('The env file name must end in ".local" so git ignores it.');
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
const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('DATABASE_URL=')) : [];
fs.writeFileSync(envFile, [...lines, `DATABASE_URL=${apiUrl}`, ''].join('\n'), { mode: 0o600 });
console.log(`DATABASE_URL for nsignage_api written to ${envFile} (password not shown).`);

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
