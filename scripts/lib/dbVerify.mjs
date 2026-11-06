// =============================================
// N Signage — verify the database schema from PostgreSQL's own catalog
// (not from migration files). Used by `npm run db:setup` (as the project
// owner) and `npm run db:verify` (as the website's nsignage_api role).
// Returns { ok, report, problems } — no secrets are ever included.
// =============================================

export const REQUIRED_TABLES = [
  'users', 'user_sessions', 'devices', 'device_events', 'device_network_sightings', 'claim_nonces',
  'pairing_codes', 'transfers', 'device_commands', 'legacy_browser_sessions', 'legacy_browser_devices',
  'legacy_relay_copies', 'rate_limits', 'security_events', 'schema_migrations',
];
export const REQUIRED_VIEWS = ['customers', 'customer_sessions', 'customer_devices', 'media_transfers'];
export const REQUIRED_MIGRATIONS = ['20261106000000_nsignage_init', '20261106000001_customer_devices'];
// indexes asked for: username, device ownership, device UID, last seen, session expiry, transfer lookup
export const REQUIRED_INDEXES = [
  'users_username_key', 'devices_owner_idx', 'devices_owner_registration_idx', 'devices_uid_idx', 'devices_pkey',
  'devices_last_seen_idx', 'user_sessions_expiry_idx', 'user_sessions_user_idx', 'transfers_user_idx',
  'transfers_device_idx', 'transfers_pkey', 'device_events_device_idx',
];
export const REQUIRED_FKS = [
  ['user_sessions', 'users'], ['devices', 'users'], ['device_events', 'devices'], ['transfers', 'users'],
  ['transfers', 'devices'], ['device_commands', 'devices'], ['pairing_codes', 'devices'],
];

export async function verifyCatalog(sql) {
  const problems = [];
  const [db] = await sql`select current_database() as name, current_user as connected_as,
                                (select setting from pg_settings where name = 'server_version') as postgres_version`;
  const [schema] = await sql`select count(*)::int as n from pg_namespace where nspname = 'nsignage'`;
  if (!schema.n) return { ok: false, problems: ['schema nsignage does not exist'], report: { database: db } };

  const tables = await sql`
    select c.relname as name, c.relkind as kind, c.relrowsecurity as rls,
           coalesce((select reltuples::bigint from pg_class x where x.oid = c.oid), 0) as approx_rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'nsignage' and c.relkind in ('r', 'v') order by c.relkind, c.relname`;
  const tableNames = new Set(tables.filter((t) => t.kind === 'r').map((t) => t.name));
  const viewNames = new Set(tables.filter((t) => t.kind === 'v').map((t) => t.name));
  for (const t of REQUIRED_TABLES) if (!tableNames.has(t)) problems.push(`missing table nsignage.${t}`);
  for (const v of REQUIRED_VIEWS) if (!viewNames.has(v)) problems.push(`missing view nsignage.${v}`);
  for (const t of tables) if (t.kind === 'r' && !t.rls) problems.push(`RLS disabled on nsignage.${t.name}`);

  const columns = await sql`select table_name, count(*)::int as n from information_schema.columns
                            where table_schema = 'nsignage' group by table_name`;
  const fks = await sql`
    select conrelid::regclass::text as from_table, confrelid::regclass::text as to_table, conname
    from pg_constraint where contype = 'f' and connamespace = 'nsignage'::regnamespace order by 1`;
  for (const [from, to] of REQUIRED_FKS) {
    if (!fks.some((f) => f.from_table === `nsignage.${from}` && f.to_table === `nsignage.${to}`)) problems.push(`missing foreign key ${from} → ${to}`);
  }
  const indexes = await sql`select indexname from pg_indexes where schemaname = 'nsignage' order by 1`;
  const indexNames = new Set(indexes.map((i) => i.indexname));
  for (const i of REQUIRED_INDEXES) if (!indexNames.has(i)) problems.push(`missing index ${i}`);
  const checks = await sql`select count(*)::int as n from pg_constraint where contype = 'c' and connamespace = 'nsignage'::regnamespace`;
  const uniques = await sql`select count(*)::int as n from pg_constraint where contype = 'u' and connamespace = 'nsignage'::regnamespace`;

  let migrations = [];
  if (tableNames.has('schema_migrations')) {
    migrations = (await sql`select version, applied_at from nsignage.schema_migrations order by version`).map((m) => m.version);
  }
  for (const m of REQUIRED_MIGRATIONS) if (!migrations.includes(m)) problems.push(`migration ${m} not recorded`);

  const [role] = await sql`select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
                           from pg_roles where rolname = 'nsignage_api'`;
  if (!role) problems.push('role nsignage_api missing');
  else if (role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb) problems.push('nsignage_api has too many privileges');
  const publicAccess = await sql`
    select r.rolname, has_schema_privilege(r.rolname, 'nsignage', 'USAGE') as usage
    from pg_roles r where r.rolname in ('anon', 'authenticated')`;
  for (const p of publicAccess) if (p.usage) problems.push(`role ${p.rolname} can use schema nsignage`);

  const report = {
    database: db,
    schema: 'nsignage',
    tables: tables.filter((t) => t.kind === 'r').map((t) => ({ name: t.name, rls: t.rls, columns: columns.find((c) => c.table_name === t.name)?.n || 0 })),
    views: [...viewNames],
    foreignKeys: fks.map((f) => `${f.from_table.replace('nsignage.', '')} → ${f.to_table.replace('nsignage.', '')}`),
    indexes: indexes.length,
    requiredIndexesPresent: REQUIRED_INDEXES.filter((i) => indexNames.has(i)).length + '/' + REQUIRED_INDEXES.length,
    checkConstraints: checks[0].n,
    uniqueConstraints: uniques[0].n,
    migrationsApplied: migrations,
    apiRole: role ? { canLogin: role.rolcanlogin, superuser: role.rolsuper, bypassRls: role.rolbypassrls } : null,
    publicApiRolesCanUseSchema: publicAccess.map((p) => `${p.rolname}:${p.usage}`),
  };
  return { ok: problems.length === 0, problems, report };
}
