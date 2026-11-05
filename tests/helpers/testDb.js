// Test database for the API tests.
//
// Default: an in-process PostgreSQL 17 (PGlite) exposed over the Postgres wire
// protocol (pglite-socket), with the real migration applied and Supabase's
// anon/authenticated roles simulated — the API uses the real `postgres` driver.
//
// TEST_DATABASE_URL=<nsignage_api pooler URL of a Supabase TEST project>:
// runs the same tests against real Supabase (migration must already be
// applied there). Test data uses random names and is removed afterwards.
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve('supabase/migrations');

export async function setupDatabase() {
  process.env.DATABASE_POOL_MAX = '1';
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    delete process.env.DATABASE_SSL; // verify-full against Supabase
    return { external: true, async close() {} };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  process.env.DATABASE_SSL = 'disable';
  return {
    external: false,
    db,
    port,
    async close() {
      await server.stop();
      await db.close();
    },
  };
}
