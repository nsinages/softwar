#!/usr/bin/env node
// =============================================
// N Signage — one-time Redis (Upstash) → Supabase migration
//
//   node scripts/migrate-redis-to-supabase.mjs inspect            what is in Redis? (counts only)
//   node scripts/migrate-redis-to-supabase.mjs export [file]      read-only snapshot → .migration/redis-export.json
//   node scripts/migrate-redis-to-supabase.mjs import [file]      snapshot → Supabase (idempotent)
//   node scripts/migrate-redis-to-supabase.mjs verify [file]      compare snapshot with Supabase, record by record
//
// Env (e.g. from `npx vercel env pull .env.local`):
//   KV_REST_API_URL + KV_REST_API_READ_ONLY_TOKEN (preferred; or KV_REST_API_TOKEN)  — Redis, READ ONLY
//   DATABASE_URL                                                                      — Supabase (import/verify)
//
// Redis is never written to or deleted. The snapshot contains password and
// device-secret HASHES: it is written with owner-only permissions under
// .migration/ (git-ignored). Delete it after verification.
// =============================================
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}
loadEnvFile(path.resolve('.env.local'));

const { Redis } = await import('@upstash/redis');
const { redisFromEnv, inspectRedis, exportRedis, importSnapshot, verifySnapshot } = await import('./lib/redisMigration.mjs');

const [cmd, fileArg] = process.argv.slice(2);
const file = path.resolve(fileArg || '.migration/redis-export.json');

function needRedis() {
  const { redis, readOnly } = redisFromEnv(Redis);
  if (!redis) {
    console.log('Redis is NOT configured (no KV_REST_API_URL / token). Nothing to migrate from Redis.');
    process.exit(0);
  }
  console.error(readOnly ? 'Using the READ-ONLY Redis token.' : 'Warning: no read-only token found; using the normal token (this script still only reads).');
  return redis;
}

try {
  if (cmd === 'inspect') {
    const counts = await inspectRedis(needRedis());
    console.log(JSON.stringify(counts, null, 2));
    console.log(counts.totalNsKeys === 0 ? '\nRedis contains no N-Signage data: no migration is necessary.' : '\nRedis contains N-Signage data: run "export", then "import" and "verify".');
  } else if (cmd === 'export') {
    const snap = await exportRedis(needRedis());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snap, null, 2), { mode: 0o600 });
    console.log(`Snapshot written to ${file}\n${JSON.stringify({ counts: snap.counts, skipped: snap.skipped.length, emailAccountsNotMigrated: snap.emailAccountsNotMigrated }, null, 2)}`);
    if (snap.skipped.length) console.log('Skipped records:', JSON.stringify(snap.skipped, null, 2));
  } else if (cmd === 'import' || cmd === 'verify') {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { asSystem, closeDb } = await import('../api/_lib/db.js');
    try {
      if (cmd === 'import') {
        const n = await importSnapshot(asSystem, snap);
        console.log('Imported (new rows):', JSON.stringify(n, null, 2));
        console.log('Now run: node scripts/migrate-redis-to-supabase.mjs verify');
      } else {
        const v = await verifySnapshot(asSystem, snap);
        console.log(JSON.stringify(v, null, 2));
        console.log(v.ok ? '\nVERIFIED: every exported record is present in Supabase.' : '\nVERIFICATION FAILED — do not switch production yet.');
        process.exitCode = v.ok ? 0 : 1;
      }
    } finally {
      await closeDb();
    }
  } else {
    console.log('Usage: node scripts/migrate-redis-to-supabase.mjs <inspect|export|import|verify> [snapshot file]');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error('Error:', err.reason || err.message);
  process.exitCode = 1;
}
