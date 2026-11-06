#!/usr/bin/env node
// =============================================
// N Signage — run the HOSTED website locally (cloud mode + real /api handlers)
//
//   npm run dev:cloud                                   → real Supabase (DATABASE_URL etc. from .env)
//   npm run dev:cloud -- --pglite                       → in-process PostgreSQL with the migration (no Supabase)
//
// Builds the site with VITE_CONNECTION_MODE=cloud into .cloud-dist/ and serves
// it on http://localhost:5180 together with the Vercel-style functions in api/.
// The browser only ever talks to this server; DATABASE_URL stays server-side.
// With --pglite, test-only helpers are mounted under /__test (never in production).
// =============================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFile, ENV_FILE } from './lib/env.mjs';

const args = process.argv.slice(2);
const usePglite = args.includes('--pglite');
const PORT = Number(process.env.PORT) || 5180;
const DIST = path.resolve('.cloud-dist');


let testHooks = null;
if (usePglite) {
  const { setupEnv, memoryBlob } = await import(pathToFileURL(path.resolve('tests/helpers/harness.js')).href);
  await setupEnv();
  const blobStore = await import(pathToFileURL(path.resolve('api/_lib/blobStore.js')).href);
  const blob = memoryBlob();
  blobStore.setBlobBackend(blob.backend);
  const db = await import(pathToFileURL(path.resolve('api/_lib/db.js')).href);
  testHooks = { blob, db };
  console.log('Database: in-process PostgreSQL (PGlite) with supabase/migrations applied');
} else {
  if (!loadEnvFile() || !process.env.DATABASE_URL) {
    console.error(`Missing DATABASE_URL in ${ENV_FILE}. Use --pglite, or see .env.example.`);
    process.exit(1);
  }
  const u = new URL(process.env.DATABASE_URL);
  console.log(`Database: Supabase ${u.hostname}:${u.port} as ${decodeURIComponent(u.username).split('.')[0]} (credentials not shown)`);
}
process.env.CRON_SECRET ||= 'local-dev-cron-secret';

if (!args.includes('--no-build')) {
  const r = spawnSync(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', DIST, '--emptyOutDir'],
    { env: { ...process.env, VITE_CONNECTION_MODE: 'cloud' }, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

const ROUTES = {};
for (const name of ['auth', 'devices', 'device', 'find', 'transfer', 'health', 'pi/sync', 'pi/pairing', 'cron/cleanup']) {
  ROUTES[`/api/${name}`] = (await import(pathToFileURL(path.resolve(`api/${name}.js`)).href)).default;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://localhost');
    const raw = Buffer.concat(chunks);
    try {
      if (testHooks && u.pathname === '/__test/blob-put') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ url: testHooks.blob.put(u.searchParams.get('pathname'), raw) }));
        return;
      }
      if (testHooks && u.pathname === '/__test/legacy') {
        const { tokenHash, browserId, deviceId, name, location } = JSON.parse(raw.toString());
        await testHooks.db.asSystem(async (t) => {
          await t`insert into nsignage.legacy_browser_sessions (token_hash, browser_id) values (${tokenHash}, ${browserId})`;
          await t`insert into nsignage.legacy_browser_devices (browser_id, device_id, name, location) values (${browserId}, ${deviceId}, ${name}, ${location})`;
        });
        res.end('{}');
        return;
      }
      if (testHooks && u.pathname === '/__test/sql-user') {
        const [row] = await testHooks.db.asSystem((t) => t`select username, password_hash, created_at from nsignage.users where username = ${u.searchParams.get('u')}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(row || null));
        return;
      }
      if (testHooks && u.pathname === '/__test/sql-devices') {
        // test-only: what the database holds for a customer (proves server-side persistence)
        const rows = await testHooks.db.asSystem((t) => t`
          select d.nickname, host(d.local_ip) as ip, d.registration, u.username as owner
          from nsignage.devices d join nsignage.users u on u.id = d.owner_id where u.username = ${u.searchParams.get('u')}
          order by d.added_at`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rows));
        return;
      }
      const handler = ROUTES[u.pathname];
      if (handler) {
        req.query = Object.fromEntries(u.searchParams);
        const ct = String(req.headers['content-type'] || '');
        req.body = ct.includes('json') && raw.length ? JSON.parse(raw.toString()) : raw.toString();
        // client network address (simulated per test run only in --pglite test mode)
        req.headers['x-real-ip'] = (testHooks && req.headers['x-test-ip']) || req.socket.remoteAddress || '127.0.0.1';
        await handler(req, res);
        return;
      }
      if (u.pathname.startsWith('/api/')) { res.statusCode = 404; res.end('{"ok":false,"error":"Not found"}'); return; }
      let file = path.join(DIST, decodeURIComponent(u.pathname));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error('[cloud-dev]', err.message);
      if (!res.headersSent) { res.statusCode = 500; res.end('{"ok":false,"error":"Server error"}'); }
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Hosted website (cloud mode) on http://localhost:${PORT}`));
