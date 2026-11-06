#!/usr/bin/env node
// Runs the API + Pi-agent tests against the REAL Supabase database in `.env`
// (DATABASE_URL). Test data uses its own accounts/devices and is deleted afterwards.
//
// SAFETY: this database is shared with the live domain (software.nsinages.in).
// The tests only touch rows they create, but they still write to the live
// database, so they refuse to run unless ALLOW_REAL_DB_TESTS=1 is set (in .env
// or the shell). Stop running them once real customers use the site.
//   npm run test:supabase
import { spawn } from 'node:child_process';
import { loadEnvFile, ENV_FILE } from './lib/env.mjs';

loadEnvFile();
if (!process.env.DATABASE_URL) {
  console.error(`DATABASE_URL is not set (expected in ${ENV_FILE}).`);
  process.exit(1);
}
if (process.env.ALLOW_REAL_DB_TESTS !== '1') {
  console.error('Refusing to run: the database in .env is shared with the live website.');
  console.error('Set ALLOW_REAL_DB_TESTS=1 (in .env or the shell) for one deliberate run, then set it back to 0.');
  process.exit(1);
}
const env = { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL };
const u = new URL(process.env.DATABASE_URL);
console.log(`Testing against Supabase pooler ${u.hostname} as ${decodeURIComponent(u.username).split('.')[0]} (credentials not shown)`);
const p = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/api.test.mjs', 'tests/legacy-agent.test.mjs', 'tests/pi-pairing.test.mjs'], { env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 1));
