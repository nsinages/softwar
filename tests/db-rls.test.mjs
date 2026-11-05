// Database-level security of the Supabase schema, on real PostgreSQL (PGlite):
// constraints, Row Level Security isolation between customers and between Pis,
// column guards, single-use pairing codes, single ownership, rate limiter,
// and no access for Supabase's anon/authenticated roles.
// Local only (needs SET ROLE as superuser); skipped with TEST_DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve('supabase/migrations');

test('Supabase schema: constraints, RLS and role isolation (40 checks)', { skip: Boolean(process.env.TEST_DATABASE_URL) && 'local PGlite only' }, async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  const SQL = fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');
  const failures = [];
  let pass = 0;
  const ok = (name, cond, detail = '') => { if (cond) pass += 1; else failures.push(`${name}${detail ? ` - ${detail}` : ''}`); };
  const rejects = async (name, fn, match) => {
    try { await fn(); ok(name, false, 'no error'); } catch (e) { ok(name, !match || match.test(e.message), e.message.split('\n')[0]); }
  };

  await db.exec('create role anon nologin; create role authenticated nologin;');
  await db.exec(SQL);
  ok('migration applies', true);
  await db.exec(SQL);
  ok('migration is re-runnable (idempotent)', true);

  const H = (c) => c.repeat(64).slice(0, 64);
  const PW = 'scrypt$v1$65536$8$2$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(43) + '=';

  // run statements in one transaction as nsignage_api with a context
  async function as(ctx, ids, fn) {
    return db.transaction(async (tx) => {
      await tx.exec('set local role nsignage_api');
      await tx.query(`select set_config('nsignage.ctx', $1, true), set_config('nsignage.user_id', $2, true), set_config('nsignage.device_id', $3, true)`,
        [ctx, ids.user || '', ids.device || '']);
      return fn(tx);
    });
  }

  // --- system context: create two customers, two devices
  const { A, B } = await as('system', {}, async (tx) => {
    const a = (await tx.query(`insert into nsignage.users (username, password_hash) values ('alice', $1) returning id`, [PW])).rows[0].id;
    const b = (await tx.query(`insert into nsignage.users (username, password_hash) values ('bob', $1) returning id`, [PW])).rows[0].id;
    await tx.query(`insert into nsignage.devices (id, secret_hash, pi_username, owner_id, added_at, added_via, nickname) values ('aaaaaaaaaaaaaaaa', $1, 'ns', $2, now(), 'network', 'Shop')`, [H('a'), a]);
    await tx.query(`insert into nsignage.devices (id, secret_hash, pi_username, owner_id, added_at, added_via, nickname) values ('bbbbbbbbbbbbbbbb', $1, 'ns', $2, now(), 'pairing-code', 'Office')`, [H('b'), b]);
    await tx.query(`insert into nsignage.devices (id, secret_hash, pi_username) values ('cccccccccccccccc', $1, 'ns')`, [H('c')]);
    await tx.query(`insert into nsignage.security_events (event, user_id) values ('test', $1)`, [a]);
    return { A: a, B: b };
  });
  ok('system context can create users/devices', Boolean(A && B));

  // --- constraints
  await rejects('username must be lowercase/valid', () => as('system', {}, (tx) => tx.query(`insert into nsignage.users (username, password_hash) values ('Bad Name', $1)`, [PW])), /check constraint/);
  await rejects('usernames are unique', () => as('system', {}, (tx) => tx.query(`insert into nsignage.users (username, password_hash) values ('alice', $1)`, [PW])), /unique/);
  await rejects('plaintext password rejected by format check', () => as('system', {}, (tx) => tx.query(`insert into nsignage.users (username, password_hash) values ('carol', 'hunter2hunter2')`)), /check constraint/);
  await rejects('owner and added_at must go together', () => as('system', {}, (tx) => tx.query(`update nsignage.devices set owner_id = $1 where id = 'cccccccccccccccc'`, [A])), /check constraint/);
  await rejects('blob_url must be a Vercel Blob relay URL', () => as('user', { user: A }, (tx) => tx.query(
    `insert into nsignage.transfers (id, user_id, device_id, filename, size_bytes, sha256, content_type, kind, relay_access, state, expires_at, blob_url)
     values ('AAAAAAAAAAAAAAAAAAAAAA', $1, 'aaaaaaaaaaaaaaaa', 'a.jpg', 10, $2, 'image/jpeg', 'image', 'public', 'queued', now() + interval '2 days', 'https://evil.example/x.jpg')`, [A, H('f')])), /check constraint/);

  // --- no context: nothing visible, nothing writable
  const none = await as('none', {}, (tx) => tx.query('select count(*)::int n from nsignage.devices'));
  ok('no context sees no devices', none.rows[0].n === 0);
  await rejects('no context cannot insert users', () => as('none', {}, (tx) => tx.query(`insert into nsignage.users (username, password_hash) values ('mallory', $1)`, [PW])), /row-level security/);

  // --- customer isolation
  const aDev = await as('user', { user: A }, (tx) => tx.query('select id, nickname from nsignage.devices order by id'));
  ok('Alice sees only her device', aDev.rows.length === 1 && aDev.rows[0].id === 'aaaaaaaaaaaaaaaa', JSON.stringify(aDev.rows));
  const aUsers = await as('user', { user: A }, (tx) => tx.query('select username from nsignage.users'));
  ok('Alice sees only her own account row', aUsers.rows.length === 1 && aUsers.rows[0].username === 'alice');
  const upd = await as('user', { user: A }, (tx) => tx.query(`update nsignage.devices set nickname = 'pwned' where id = 'bbbbbbbbbbbbbbbb'`));
  ok("Alice cannot rename Bob's device (0 rows)", upd.affectedRows === 0);
  const ren = await as('user', { user: A }, (tx) => tx.query(`update nsignage.devices set nickname = 'Front Shop' where id = 'aaaaaaaaaaaaaaaa'`));
  ok('Alice can rename her own device', ren.affectedRows === 1);
  await rejects('Alice cannot take ownership of an unclaimed device', () => as('user', { user: A }, (tx) => tx.query(`update nsignage.devices set owner_id = $1, added_at = now() where id = 'aaaaaaaaaaaaaaaa' and false or id = 'aaaaaaaaaaaaaaaa'`, [B])), /ownership|row-level/);
  await rejects("Alice cannot change her device's secret", () => as('user', { user: A }, (tx) => tx.query(`update nsignage.devices set secret_hash = $1 where id = 'aaaaaaaaaaaaaaaa'`, [H('9')])), /only change nickname/);
  await rejects("Alice cannot create a transfer to Bob's device", () => as('user', { user: A }, (tx) => tx.query(
    `insert into nsignage.transfers (id, user_id, device_id, filename, size_bytes, sha256, content_type, kind, relay_access, state, expires_at)
     values ('BBBBBBBBBBBBBBBBBBBBBB', $1, 'bbbbbbbbbbbbbbbb', 'a.jpg', 10, $2, 'image/jpeg', 'image', 'public', 'created', now() + interval '2 days')`, [A, H('e')])), /row-level security/);
  await as('user', { user: A }, (tx) => tx.query(
    `insert into nsignage.transfers (id, user_id, device_id, filename, size_bytes, sha256, content_type, kind, relay_access, state, expires_at, blob_url)
     values ('CCCCCCCCCCCCCCCCCCCCCC', $1, 'aaaaaaaaaaaaaaaa', 'a.jpg', 10, $2, 'image/jpeg', 'image', 'public', 'queued', now() + interval '2 days',
             'https://store1.public.blob.vercel-storage.com/transfers/aaaaaaaaaaaaaaaa/CCCCCCCCCCCCCCCCCCCCCC/a-x.jpg')`, [A, H('d')]));
  ok('Alice can create a transfer to her own device', true);
  await rejects('Alice cannot forge a transfer as Bob', () => as('user', { user: A }, (tx) => tx.query(
    `insert into nsignage.transfers (id, user_id, device_id, filename, size_bytes, sha256, content_type, kind, relay_access, state, expires_at)
     values ('DDDDDDDDDDDDDDDDDDDDDD', $1, 'bbbbbbbbbbbbbbbb', 'a.jpg', 10, $2, 'image/jpeg', 'image', 'public', 'created', now() + interval '2 days')`, [B, H('e')])), /row-level security/);
  const bX = await as('user', { user: B }, (tx) => tx.query('select count(*)::int n from nsignage.transfers'));
  ok("Bob cannot see Alice's transfers", bX.rows[0].n === 0);
  await rejects('customers cannot read pairing codes', () => as('user', { user: A }, (tx) => tx.query(`insert into nsignage.pairing_codes (code_hash, device_id, expires_at) values ($1, 'cccccccccccccccc', now() + interval '10 min')`, [H('1')])), /row-level security/);
  const ev = await as('user', { user: A }, (tx) => tx.query('select count(*)::int n from nsignage.security_events'));
  ok('customers cannot read security events', ev.rows[0].n === 0);
  await as('user', { user: A }, (tx) => tx.query(`insert into nsignage.security_events (event, user_id) values ('login', $1)`, [A]));
  ok('customers can append security events', true);

  // --- device context
  const dSelf = await as('device', { device: 'aaaaaaaaaaaaaaaa' }, (tx) => tx.query('select id from nsignage.devices'));
  ok('a Pi sees only itself', dSelf.rows.length === 1 && dSelf.rows[0].id === 'aaaaaaaaaaaaaaaa');
  const dSync = await as('device', { device: 'aaaaaaaaaaaaaaaa' }, (tx) => tx.query(`update nsignage.devices set last_seen_at = now(), hostname = 'shop-pi' where id = 'aaaaaaaaaaaaaaaa'`));
  ok('a Pi can report its own state', dSync.affectedRows === 1);
  await rejects('a Pi cannot change its owner', () => as('device', { device: 'aaaaaaaaaaaaaaaa' }, (tx) => tx.query(`update nsignage.devices set owner_id = null, added_at = null where id = 'aaaaaaaaaaaaaaaa'`)), /ownership/);
  const dOther = await as('device', { device: 'aaaaaaaaaaaaaaaa' }, (tx) => tx.query(`update nsignage.devices set hostname = 'x' where id = 'bbbbbbbbbbbbbbbb'`));
  ok('a Pi cannot update another Pi', dOther.affectedRows === 0);
  const dX = await as('device', { device: 'aaaaaaaaaaaaaaaa' }, (tx) => tx.query('select id from nsignage.transfers'));
  ok('a Pi sees transfers addressed to it', dX.rows.length === 1);
  const dX2 = await as('device', { device: 'bbbbbbbbbbbbbbbb' }, (tx) => tx.query('select id from nsignage.transfers'));
  ok("a Pi does not see other Pis' transfers", dX2.rows.length === 0);

  // --- pairing code: single live code, single use (atomic update ... returning)
  await as('system', {}, (tx) => tx.query(`insert into nsignage.pairing_codes (code_hash, device_id, expires_at) values ($1, 'cccccccccccccccc', now() + interval '10 min')`, [H('2')]));
  await rejects('only one unused code per Pi', () => as('system', {}, (tx) => tx.query(`insert into nsignage.pairing_codes (code_hash, device_id, expires_at) values ($1, 'cccccccccccccccc', now() + interval '10 min')`, [H('3')])), /unique/);
  const redeem = (who) => as('system', {}, (tx) => tx.query(
    `update nsignage.pairing_codes set used_at = now(), used_by = $2 where code_hash = $1 and used_at is null and expires_at > now() returning device_id`, [H('2'), who]));
  const r1 = await redeem(A); const r2 = await redeem(B);
  ok('pairing code redeems once', r1.rows.length === 1 && r2.rows.length === 0);
  const claim = await as('system', {}, (tx) => tx.query(
    `update nsignage.devices set owner_id = $1, added_at = now(), added_via = 'pairing-code' where id = 'cccccccccccccccc' and owner_id is null returning id`, [A]));
  const claim2 = await as('system', {}, (tx) => tx.query(
    `update nsignage.devices set owner_id = $1, added_at = now(), added_via = 'pairing-code' where id = 'cccccccccccccccc' and owner_id is null returning id`, [B]));
  ok('single owner: second claim gets 0 rows', claim.rows.length === 1 && claim2.rows.length === 0);

  // --- rate limit function
  const hits = [];
  for (let i = 0; i < 4; i += 1) hits.push((await as('none', {}, (tx) => tx.query(`select nsignage.rate_limit_hit('login-ip', $1, 3, 600) ok`, [H('7')]))).rows[0].ok);
  ok('rate_limit_hit allows 3 then blocks', JSON.stringify(hits) === '[true,true,true,false]', JSON.stringify(hits));

  // --- Supabase API roles have no access
  for (const role of ['anon', 'authenticated']) {
    await rejects(`${role} cannot read tables`, () => db.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query('select * from nsignage.users'); }), /permission denied/);
    await rejects(`${role} cannot call functions`, () => db.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select nsignage.rate_limit_hit('x', 'y', 1, 1)`); }), /permission denied/);
  }

  // --- retention function
  const purge = await as('system', {}, (tx) => tx.query('select nsignage.purge_expired() r'));
  ok('purge_expired runs', typeof purge.rows[0].r === 'object', JSON.stringify(purge.rows[0].r));

  // --- schema check: nothing that could hold media
  const cols = await db.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'nsignage' and data_type in ('bytea')`);
  ok('no binary (bytea) columns anywhere', cols.rows.length === 0);
  const rls = await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'nsignage' and c.relkind = 'r' and not c.relrowsecurity`);
  ok('RLS enabled on every table', rls.rows.length === 0, rls.rows.map((r) => r.relname).join(','));


  await db.close();
  assert.deepEqual(failures, [], `${failures.length} check(s) failed`);
  assert.equal(pass, 40);
});
