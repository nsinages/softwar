#!/usr/bin/env node
// Runs the API + Pi-agent tests against a REAL Supabase TEST project.
//   npm run test:supabase            (reads .env.supabase-test.local, written by `npm run db:setup`)
// Test data uses its own accounts/devices and is deleted afterwards.
// Never point this at the production project.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const file = process.argv[2] || '.env.supabase-test.local';
if (!/test/i.test(file) || !fs.existsSync(file)) {
  console.error(`Missing ${file}. Create it with: SUPABASE_ADMIN_URL=... npm run db:setup -- --env-file ${file}`);
  process.exit(1);
}
const env = { ...process.env };
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}
if (!env.DATABASE_URL) { console.error(`${file} has no DATABASE_URL`); process.exit(1); }
env.TEST_DATABASE_URL = env.DATABASE_URL;
const host = new URL(env.DATABASE_URL).hostname;
console.log(`Testing against Supabase pooler ${host} as ${decodeURIComponent(new URL(env.DATABASE_URL).username).split('.')[0]} (credentials not shown)`);
const p = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/api.test.mjs', 'tests/legacy-agent.test.mjs'], { env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 1));
