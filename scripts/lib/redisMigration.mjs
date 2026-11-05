// =============================================
// N Signage — Redis (Upstash) → Supabase migration logic
//
// Redis is only READ: SCAN, GET, HGETALL, SMEMBERS, LRANGE, ZRANGE. Use the
// read-only token when available (KV_REST_API_READ_ONLY_TOKEN) so writing is
// impossible. Nothing is ever deleted from Redis by this code.
//
// What is migrated (see docs/SUPABASE-SETUP.md §Migration):
//   ns:dev:<id>                 → nsignage.devices (secret hash kept: Pis keep working)
//   ns:net:<key>                → nsignage.device_network_sightings (recent only)
//   ns:sess:<hash> {id}         → nsignage.legacy_browser_sessions
//   ns:owners + ns:browser-devs → nsignage.legacy_browser_devices (for the verified link)
//   ns:blob:<id>                → nsignage.legacy_relay_copies (old cloud copies, deleted later)
//   ns:cmd:<id>                 → nsignage.device_commands (pending delete / old download)
//   Phase 2 Redis build (only if it was ever deployed):
//   ns:user / ns:username       → nsignage.users (scrypt + recovery hashes copied as-is)
//   ns:dev-owner + ns:user-devs → devices.owner_id / nickname / location
//   ns:xfer (unfinished)        → their relay copies → legacy_relay_copies (to be deleted)
// Not migrated (short-lived): login sessions, nonces, pairing codes, rate limits.
// Not migrated: ns:acct:* (email accounts of the 10-minute build b979de3) — counted only.
// =============================================

const DEVICE_ID_RX = /^[a-f0-9]{16}$/;
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[a-f0-9]{64}$/;
const PI_USER_RX = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const IPV4_RX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const USERNAME_RX = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
const SCRYPT_RX = /^scrypt\$v1\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;
const PUBLIC_BLOB_RX = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//;

const parse = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);
const iso = (msVal) => (Number.isFinite(msVal) && msVal > 0 ? new Date(msVal).toISOString() : null);

export function redisFromEnv(Redis) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const readOnly = process.env.KV_REST_API_READ_ONLY_TOKEN;
  const token = readOnly || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { redis: null, readOnly: false };
  return { redis: new Redis({ url, token, enableAutoPipelining: false }), readOnly: Boolean(readOnly) };
}

async function scanKeys(redis, match) {
  const out = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, { match, count: 500 });
    out.push(...keys);
    cursor = String(next);
  } while (cursor !== '0');
  return out;
}

const PATTERNS = {
  devices: 'ns:dev:*', networks: 'ns:net:*', browserSessions: 'ns:sess:*', owners: 'ns:owners:*',
  browserDevices: 'ns:browser-devs:*', legacyBlobs: 'ns:blob:*', commands: 'ns:cmd:*', results: 'ns:res:*',
  users: 'ns:user:*', usernames: 'ns:username:*', deviceOwners: 'ns:dev-owner:*', userDevices: 'ns:user-devs:*',
  transfers: 'ns:xfer:*', emailAccounts: 'ns:acct:*', other: 'ns:*',
};

/** Counts per key family (read-only). */
export async function inspectRedis(redis) {
  const counts = {};
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    if (name === 'other') continue;
    counts[name] = (await scanKeys(redis, pattern)).length;
  }
  const all = (await scanKeys(redis, PATTERNS.other)).length;
  // ns:dev-owner and ns:user-devs also match ns:dev:* / ns:user:* only if prefixes overlap — they do not
  return { totalNsKeys: all, ...counts };
}

/** Read everything needed into a plain JSON snapshot (read-only). */
export async function exportRedis(redis, { now = Date.now() } = {}) {
  const snap = {
    exportedAt: new Date(now).toISOString(),
    devices: [], sightings: [], legacySessions: [], legacyBrowserDevices: [], legacyRelayCopies: [],
    pendingCommands: [], users: [], ownership: [], skipped: [],
  };
  const skip = (kind, key, why) => snap.skipped.push({ kind, key, why });

  for (const key of await scanKeys(redis, 'ns:dev:*')) {
    const id = key.slice('ns:dev:'.length);
    const d = parse(await redis.get(key));
    if (!DEVICE_ID_RX.test(id) || !d || typeof d !== 'object') { skip('device', key, 'invalid id or value'); continue; }
    if (!PI_USER_RX.test(String(d.username || ''))) { skip('device', key, 'invalid Pi username'); continue; }
    snap.devices.push({
      id,
      secret_hash: HEX64.test(d.secretHash || '') ? d.secretHash : null,
      pi_username: d.username,
      hostname: typeof d.hostname === 'string' ? d.hostname.slice(0, 253) : null,
      local_ip: IPV4_RX.test(d.localIp || '') ? d.localIp : null,
      api_port: Number.isInteger(d.port) && d.port > 0 && d.port < 65536 ? d.port : 5000,
      agent_version: typeof d.agentVersion === 'string' ? d.agentVersion.slice(0, 20) : null,
      media: Array.isArray(d.media) ? d.media.slice(0, 1000) : [],
      current_media: typeof d.currentMedia === 'string' ? d.currentMedia : null,
      first_seen_at: iso(d.firstSeen) || iso(now),
      last_seen_at: iso(d.lastSeen) || iso(now),
    });
  }
  const deviceIds = new Set(snap.devices.map((d) => d.id));

  for (const key of await scanKeys(redis, 'ns:net:*')) {
    const net = key.slice('ns:net:'.length);
    const members = await redis.zrange(key, 0, -1, { withScores: true });
    for (let i = 0; i < members.length; i += 2) {
      const id = String(members[i]); const score = Number(members[i + 1]);
      if (deviceIds.has(id) && net.length <= 64 && now - score < 15 * 60_000) snap.sightings.push({ device_id: id, net_key: net, seen_at: iso(score) });
    }
  }

  for (const key of await scanKeys(redis, 'ns:sess:*')) {
    const hash = key.slice('ns:sess:'.length);
    const s = parse(await redis.get(key));
    if (!HEX64.test(hash) || !s || typeof s !== 'object') { skip('browser-session', key, 'invalid'); continue; }
    if (s.accountId) { skip('browser-session', key, 'email-account session (b979de3) — not migrated'); continue; }
    if (!UUID_RX.test(String(s.id || ''))) { skip('browser-session', key, 'invalid browser id'); continue; }
    snap.legacySessions.push({ token_hash: hash, browser_id: s.id, created_at: iso(s.createdAt) });
  }

  // A browser↔device pair counts only if the browser is still in the Pi's owner set
  const owners = new Map();
  for (const key of await scanKeys(redis, 'ns:owners:*')) {
    owners.set(key.slice('ns:owners:'.length), new Set((await redis.smembers(key)).map(String)));
  }
  for (const key of await scanKeys(redis, 'ns:browser-devs:*')) {
    const browserId = key.slice('ns:browser-devs:'.length);
    if (!UUID_RX.test(browserId)) { skip('browser-devices', key, 'invalid browser id'); continue; }
    const entries = (await redis.hgetall(key)) || {};
    for (const [deviceId, raw] of Object.entries(entries)) {
      const m = parse(raw) || {};
      if (!deviceIds.has(deviceId)) { skip('browser-device', `${key}#${deviceId}`, 'device record missing'); continue; }
      if (!owners.get(deviceId)?.has(browserId)) { skip('browser-device', `${key}#${deviceId}`, 'removed from that browser'); continue; }
      snap.legacyBrowserDevices.push({
        browser_id: browserId, device_id: deviceId,
        name: typeof m.name === 'string' ? m.name.slice(0, 64) : null,
        location: typeof m.location === 'string' ? m.location.slice(0, 80) : null,
        added_at: iso(m.addedAt),
      });
    }
  }

  for (const key of await scanKeys(redis, 'ns:blob:*')) {
    const deviceId = key.slice('ns:blob:'.length);
    const blobs = (await redis.hgetall(key)) || {};
    const results = (await redis.hgetall(`ns:res:${deviceId}`)) || {};
    for (const [cmdId, raw] of Object.entries(blobs)) {
      const b = parse(raw) || {};
      if (!PUBLIC_BLOB_RX.test(String(b.url || ''))) continue;
      const res = parse(results[cmdId]);
      snap.legacyRelayCopies.push({ url: b.url, device_id: deviceId, filename: res?.state === 'done' ? res.filename || null : null });
    }
  }

  for (const key of await scanKeys(redis, 'ns:cmd:*')) {
    const deviceId = key.slice('ns:cmd:'.length);
    if (!deviceIds.has(deviceId)) continue;
    for (const raw of (await redis.lrange(key, 0, -1)) || []) {
      const c = parse(raw) || {};
      if (c.type === 'delete' && typeof c.filename === 'string') {
        snap.pendingCommands.push({ device_id: deviceId, type: 'delete', payload: { filename: c.filename }, created_at: iso(c.createdAt) });
      } else if (c.type === 'download' && !c.transferId && PUBLIC_BLOB_RX.test(String(c.url || ''))) {
        snap.pendingCommands.push({ device_id: deviceId, type: 'download', payload: { url: c.url, filename: c.filename, size: c.size || null }, created_at: iso(c.createdAt) });
      }
    }
  }

  // ---- Phase 2 Redis build (accounts), only if it ever ran ----
  for (const key of await scanKeys(redis, 'ns:user:*')) {
    const u = parse(await redis.get(key));
    if (!u || !UUID_RX.test(String(u.id || '')) || !USERNAME_RX.test(String(u.username || '')) || !SCRYPT_RX.test(String(u.passwordHash || ''))) {
      skip('user', key, 'invalid account record'); continue;
    }
    snap.users.push({
      id: u.id, username: u.username, display_name: u.displayName || null, password_hash: u.passwordHash,
      recovery_hash: HEX64.test(u.recoveryHash || '') ? u.recoveryHash : null, recovery_created_at: iso(u.recoveryKeyCreatedAt),
      password_changed_at: iso(u.passwordChangedAt) || iso(u.createdAt), disabled: Boolean(u.disabled), created_at: iso(u.createdAt),
    });
  }
  const userIds = new Set(snap.users.map((u) => u.id));
  for (const key of await scanKeys(redis, 'ns:dev-owner:*')) {
    const deviceId = key.slice('ns:dev-owner:'.length);
    const userId = String(await redis.get(key) || '');
    if (!deviceIds.has(deviceId) || !userIds.has(userId)) { skip('ownership', key, 'device or user missing'); continue; }
    const meta = parse(await redis.hget(`ns:user-devs:${userId}`, deviceId)) || {};
    snap.ownership.push({
      device_id: deviceId, owner_id: userId,
      nickname: typeof meta.name === 'string' ? meta.name.slice(0, 64) : null,
      location: typeof meta.location === 'string' ? meta.location.slice(0, 80) : null,
      added_at: iso(meta.addedAt) || iso(now),
    });
  }
  for (const key of await scanKeys(redis, 'ns:xfer:*')) {
    const t = parse(await redis.get(key));
    if (t?.blobUrl && PUBLIC_BLOB_RX.test(t.blobUrl)) snap.legacyRelayCopies.push({ url: t.blobUrl, device_id: t.deviceId || null, filename: null });
  }
  snap.counts = Object.fromEntries(Object.entries(snap).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  snap.emailAccountsNotMigrated = (await scanKeys(redis, 'ns:acct:*')).length;
  return snap;
}

/** Import a snapshot into Supabase (one transaction, idempotent, never overwrites newer data). */
export async function importSnapshot(asSystem, snap) {
  return asSystem(async (t) => {
    const n = {};
    const run = async (name, rows, fn) => { n[name] = 0; for (const r of rows) if ((await fn(r)).length) n[name] += 1; };
    await run('users', snap.users, (u) => t`
      insert into nsignage.users (id, username, display_name, password_hash, recovery_hash, recovery_created_at, password_changed_at, disabled, created_at)
      values (${u.id}, ${u.username}, ${u.display_name}, ${u.password_hash}, ${u.recovery_hash}, ${u.recovery_created_at},
              coalesce(${u.password_changed_at}::timestamptz, now()), ${u.disabled}, coalesce(${u.created_at}::timestamptz, now()))
      on conflict do nothing returning 1`);
    await run('devices', snap.devices, (d) => t`
      insert into nsignage.devices (id, secret_hash, pi_username, hostname, local_ip, api_port, agent_version, media, current_media, first_seen_at, last_seen_at)
      values (${d.id}, ${d.secret_hash}, ${d.pi_username}, ${d.hostname}, ${d.local_ip}, ${d.api_port}, ${d.agent_version},
              ${t.json(d.media)}, ${d.current_media}, ${d.first_seen_at}, ${d.last_seen_at})
      on conflict (id) do nothing returning 1`);
    await run('ownership', snap.ownership, (o) => t`
      update nsignage.devices set owner_id = ${o.owner_id}, added_at = ${o.added_at}, added_via = 'migrated',
             nickname = ${o.nickname}, location = ${o.location}
      where id = ${o.device_id} and owner_id is null returning 1`);
    await run('sightings', snap.sightings, (s) => t`
      insert into nsignage.device_network_sightings (device_id, net_key, seen_at) values (${s.device_id}, ${s.net_key}, ${s.seen_at})
      on conflict do nothing returning 1`);
    await run('legacySessions', snap.legacySessions, (s) => t`
      insert into nsignage.legacy_browser_sessions (token_hash, browser_id, created_at) values (${s.token_hash}, ${s.browser_id}, ${s.created_at})
      on conflict do nothing returning 1`);
    await run('legacyBrowserDevices', snap.legacyBrowserDevices, (l) => t`
      insert into nsignage.legacy_browser_devices (browser_id, device_id, name, location, added_at)
      values (${l.browser_id}, ${l.device_id}, ${l.name}, ${l.location}, ${l.added_at})
      on conflict do nothing returning 1`);
    await run('legacyRelayCopies', snap.legacyRelayCopies, (c) => t`
      insert into nsignage.legacy_relay_copies (url, device_id, filename) values (${c.url}, ${c.device_id}, ${c.filename})
      on conflict do nothing returning 1`);
    // pending commands: only once (skip if an identical pending command exists)
    await run('pendingCommands', snap.pendingCommands, (c) => t`
      insert into nsignage.device_commands (device_id, type, payload, created_at)
      select ${c.device_id}, ${c.type}, ${t.json(c.payload)}, coalesce(${c.created_at}::timestamptz, now())
      where not exists (select 1 from nsignage.device_commands x where x.device_id = ${c.device_id} and x.state = 'queued'
                        and x.type = ${c.type} and x.payload = ${t.json(c.payload)})
      returning 1`);
    await t`insert into nsignage.security_events (event, detail) values ('redis-import', ${t.json(n)})`;
    return n;
  });
}

/** Compare the snapshot with Supabase, record by record. Returns { ok, problems, checked }. */
export async function verifySnapshot(asSystem, snap) {
  const problems = [];
  const checked = {};
  await asSystem(async (t) => {
    const devs = new Map((await t`select id, secret_hash, owner_id from nsignage.devices where id = any(${snap.devices.map((d) => d.id)}::text[])`).map((r) => [r.id, r]));
    checked.devices = snap.devices.length;
    for (const d of snap.devices) {
      const row = devs.get(d.id);
      if (!row) problems.push(`device ${d.id} missing`);
      else if (d.secret_hash && row.secret_hash !== d.secret_hash) problems.push(`device ${d.id}: secret hash differs (Pi re-registered after export?)`);
    }
    const users = new Map((await t`select id, username, password_hash from nsignage.users where id = any(${snap.users.map((u) => u.id)}::uuid[])`).map((r) => [r.id, r]));
    checked.users = snap.users.length;
    for (const u of snap.users) {
      const row = users.get(u.id);
      if (!row) problems.push(`user ${u.username} missing`);
      else if (row.username !== u.username || row.password_hash !== u.password_hash) problems.push(`user ${u.username}: data differs`);
    }
    checked.ownership = snap.ownership.length;
    for (const o of snap.ownership) {
      const row = devs.get(o.device_id);
      if (!row || row.owner_id !== o.owner_id) problems.push(`device ${o.device_id}: owner differs from Redis`);
    }
    const pairs = await t`select browser_id::text || '/' || device_id as k from nsignage.legacy_browser_devices`;
    const have = new Set(pairs.map((r) => r.k));
    checked.legacyBrowserDevices = snap.legacyBrowserDevices.length;
    for (const l of snap.legacyBrowserDevices) if (!have.has(`${l.browser_id}/${l.device_id}`)) problems.push(`legacy link ${l.browser_id}/${l.device_id} missing`);
    const sess = new Set((await t`select token_hash from nsignage.legacy_browser_sessions`).map((r) => r.token_hash));
    checked.legacySessions = snap.legacySessions.length;
    for (const s of snap.legacySessions) if (!sess.has(s.token_hash)) problems.push(`legacy session ${s.token_hash.slice(0, 8)}… missing`);
    const copies = new Set((await t`select url from nsignage.legacy_relay_copies`).map((r) => r.url));
    checked.legacyRelayCopies = snap.legacyRelayCopies.length;
    for (const c of snap.legacyRelayCopies) if (!copies.has(c.url)) problems.push('a legacy relay copy URL is missing');
  });
  return { ok: problems.length === 0, problems, checked };
}
