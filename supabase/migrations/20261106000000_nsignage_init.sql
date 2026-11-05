-- =============================================================================
-- N-Signage — Supabase PostgreSQL schema (PROPOSED — not applied anywhere yet)
--
-- Metadata only: customers, sessions, devices, ownership, pairing, commands,
-- relay-transfer records, rate limits, security events.
-- NEVER media bytes, base64 media or media files. No Supabase Storage buckets.
--
-- Access model
--   * Tables live in the private schema `nsignage`, which is NOT exposed through
--     the Supabase Data API (PostgREST). The browser never talks to Supabase.
--   * The website's serverless functions connect through the Supavisor pooler
--     as the least-privilege role `nsignage_api` (no superuser, no BYPASSRLS).
--   * Row Level Security is enabled on every table. Each API transaction sets a
--     context (transaction-local settings):
--         nsignage.ctx        'user' | 'device' | 'system'
--         nsignage.user_id    customer id   (ctx = user)
--         nsignage.device_id  Pi device id  (ctx = device)
--     Policies only show a customer their own rows and a Pi its own rows.
--     'system' is used only by login/registration, claim/pairing, cron and admin
--     code paths.
--   * anon / authenticated (Supabase API roles) get no access at all.
--
-- Run as the project owner (postgres) in the Supabase SQL editor, or with
-- `supabase db push`. Re-runnable: objects are created only if missing.
-- Set the API role's password separately (never commit it):
--     alter role nsignage_api with password '<long random>';
-- =============================================================================

begin;

create schema if not exists nsignage;

-- ---------------------------------------------------------------------------
-- Roles and schema privileges
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nsignage_api') then
    create role nsignage_api login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

revoke all on schema nsignage from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema nsignage from %I', r);
    end if;
  end loop;
end $$;
grant usage on schema nsignage to nsignage_api;

-- ---------------------------------------------------------------------------
-- Context helpers (read the transaction-local settings set by the API)
-- ---------------------------------------------------------------------------
create or replace function nsignage.ctx() returns text
  language sql stable set search_path = pg_catalog
  as $$ select coalesce(nullif(current_setting('nsignage.ctx', true), ''), 'none') $$;

create or replace function nsignage.ctx_user() returns uuid
  language sql stable set search_path = pg_catalog
  as $$ select nullif(current_setting('nsignage.user_id', true), '')::uuid $$;

create or replace function nsignage.ctx_device() returns text
  language sql stable set search_path = pg_catalog
  as $$ select nullif(current_setting('nsignage.device_id', true), '') $$;

create or replace function nsignage.touch_updated_at() returns trigger
  language plpgsql set search_path = pg_catalog
  as $$ begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------------
-- Customers (username + password; no email column on purpose)
-- ---------------------------------------------------------------------------
create table if not exists nsignage.users (
  id                  uuid primary key default gen_random_uuid(),
  username            text not null unique
                        check (username ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$'),
  display_name        text check (char_length(display_name) <= 80),
  password_hash       text not null check (password_hash ~ '^scrypt\$v1\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
  recovery_hash       text check (recovery_hash ~ '^[a-f0-9]{64}$'),
  recovery_created_at timestamptz,
  password_changed_at timestamptz not null default now(),
  disabled            boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table nsignage.users is 'Customer accounts. Passwords: scrypt hashes only. Recovery key: SHA-256 only.';

create table if not exists nsignage.user_sessions (
  token_hash   text primary key check (token_hash ~ '^[a-f0-9]{64}$'),  -- SHA-256 of the cookie token
  user_id      uuid not null references nsignage.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text check (char_length(user_agent) <= 160),
  check (expires_at > created_at)
);
create index if not exists user_sessions_user_idx on nsignage.user_sessions (user_id);
create index if not exists user_sessions_expiry_idx on nsignage.user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Raspberry Pi devices (one owner at most) and where they were last seen
-- ---------------------------------------------------------------------------
create table if not exists nsignage.devices (
  id                  text primary key check (id ~ '^[a-f0-9]{16}$'),
  secret_hash         text check (secret_hash ~ '^[a-f0-9]{64}$'),      -- SHA-256 of the Pi's own secret
  owner_id            uuid references nsignage.users(id) on delete restrict,
  nickname            text check (char_length(nickname) <= 64),
  location            text check (char_length(location) <= 80),
  added_at            timestamptz,
  added_via           text check (added_via in ('network', 'pairing-code', 'legacy+network', 'legacy+pairing-code', 'admin', 'migrated')),
  pi_username         text not null check (pi_username ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$'),
  hostname            text check (char_length(hostname) <= 253),
  local_ip            inet,                                               -- metadata only, never used to connect
  api_port            integer not null default 5000 check (api_port between 1 and 65535),
  agent_version       text check (char_length(agent_version) <= 20),
  agent_protocol      smallint not null default 1 check (agent_protocol between 1 and 99),
  capabilities        text[] not null default '{}',
  storage_free_bytes  bigint check (storage_free_bytes >= 0),
  storage_total_bytes bigint check (storage_total_bytes > 0),
  media               jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),  -- names/sizes the Pi reports, no content
  media_hash          text,
  current_media       text,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((owner_id is null) = (added_at is null))
);
create index if not exists devices_owner_idx on nsignage.devices (owner_id) where owner_id is not null;
create index if not exists devices_last_seen_idx on nsignage.devices (last_seen_at);

-- Find Pi: public network(s) a Pi synced from (IPv4 address or IPv6 /64)
create table if not exists nsignage.device_network_sightings (
  device_id text not null references nsignage.devices(id) on delete cascade,
  net_key   text not null check (char_length(net_key) <= 64),
  seen_at   timestamptz not null default now(),
  primary key (device_id, net_key)
);
create index if not exists sightings_net_idx on nsignage.device_network_sightings (net_key, seen_at desc);

-- Find Pi claim nonces: single use, bound to customer + network, 3 minutes
create table if not exists nsignage.claim_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[a-f0-9]{64}$'),
  user_id    uuid not null references nsignage.users(id) on delete cascade,
  device_id  text not null references nsignage.devices(id) on delete cascade,
  net_key    text not null,
  expires_at timestamptz not null
);
create index if not exists claim_nonces_expiry_idx on nsignage.claim_nonces (expires_at);

-- Pairing codes shown on the Pi screen: hashed, 10 minutes, single use
create table if not exists nsignage.pairing_codes (
  code_hash  text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  device_id  text not null references nsignage.devices(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid references nsignage.users(id) on delete set null,
  check (expires_at > created_at)
);
-- at most one unused code per Pi (issuing a new one deletes the old one first)
create unique index if not exists pairing_codes_one_live_idx on nsignage.pairing_codes (device_id) where used_at is null;
create index if not exists pairing_codes_expiry_idx on nsignage.pairing_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Relay transfers (metadata only) and commands delivered to Pis
-- ---------------------------------------------------------------------------
create table if not exists nsignage.transfers (
  id              text primary key check (id ~ '^[A-Za-z0-9_-]{22}$'),        -- 128 random bits
  user_id         uuid not null references nsignage.users(id) on delete cascade,
  device_id       text not null references nsignage.devices(id) on delete cascade,
  filename        text not null check (char_length(filename) between 5 and 220),
  original_name   text check (char_length(original_name) <= 200),
  size_bytes      bigint not null check (size_bytes > 0),
  sha256          text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  content_type    text not null check (content_type ~ '^(image|video)/[a-z0-9.+-]+$'),
  kind            text not null check (kind in ('image', 'video')),
  relay_access    text not null check (relay_access in ('public', 'private')),
  state           text not null check (state in ('created', 'queued', 'completed', 'failed', 'cancelled', 'expired')),
  attempts        smallint not null default 0 check (attempts between 0 and 20),
  command_id      uuid,
  error           text check (char_length(error) <= 300),
  reason          text check (char_length(reason) <= 40),
  saved_as        text check (char_length(saved_as) <= 220),
  verified        boolean not null default false,
  verification    text check (verification in ('sha256-verified-on-pi', 'saved-on-pi-unverified')),
  received_bytes  bigint check (received_bytes >= 0),
  received_at     timestamptz,
  -- Location of the TRANSIENT relay copy (Vercel Blob); never the media itself.
  blob_url        text check (blob_url ~ '^https://[a-z0-9-]+\.(public|private)\.blob\.vercel-storage\.com/'),
  blob_pathname   text check (char_length(blob_pathname) <= 400),
  blob_deleted_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  completed_at    timestamptz,
  check (state <> 'completed' or completed_at is not null),
  check (verified = (verification = 'sha256-verified-on-pi') or verification is null)
);
create index if not exists transfers_user_idx on nsignage.transfers (user_id, created_at desc);
create index if not exists transfers_device_idx on nsignage.transfers (device_id, created_at desc);
-- cleanup: unfinished transfers and relay copies still present
create index if not exists transfers_cleanup_idx on nsignage.transfers (expires_at)
  where blob_url is not null or state in ('created', 'queued', 'failed');

create table if not exists nsignage.device_commands (
  id           uuid primary key default gen_random_uuid(),
  device_id    text not null references nsignage.devices(id) on delete cascade,
  type         text not null check (type in ('download', 'delete')),
  payload      jsonb not null check (jsonb_typeof(payload) = 'object'),   -- filename, size, sha256 (no media)
  transfer_id  text references nsignage.transfers(id) on delete set null,
  state        text not null default 'queued' check (state in ('queued', 'done', 'failed', 'withdrawn')),
  error        text check (char_length(error) <= 300),
  result       jsonb,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists device_commands_pending_idx on nsignage.device_commands (device_id, created_at) where state = 'queued';
create index if not exists device_commands_transfer_idx on nsignage.device_commands (transfer_id) where transfer_id is not null;

-- ---------------------------------------------------------------------------
-- Pre-accounts data imported from Redis (only for the one-time verified link)
-- ---------------------------------------------------------------------------
create table if not exists nsignage.legacy_browser_sessions (
  token_hash  text primary key check (token_hash ~ '^[a-f0-9]{64}$'),   -- SHA-256 of the old ns_session cookie
  browser_id  uuid not null,
  created_at  timestamptz,
  imported_at timestamptz not null default now()
);
create index if not exists legacy_sessions_browser_idx on nsignage.legacy_browser_sessions (browser_id);

create table if not exists nsignage.legacy_browser_devices (
  browser_id  uuid not null,
  device_id   text not null references nsignage.devices(id) on delete cascade,
  name        text check (char_length(name) <= 64),
  location    text check (char_length(location) <= 80),
  added_at    timestamptz,
  imported_at timestamptz not null default now(),
  primary key (browser_id, device_id)
);

-- Old cloud copies made before transfers existed (deleted later by the cron)
create table if not exists nsignage.legacy_relay_copies (
  url         text primary key check (url ~ '^https://[a-z0-9-]+\.public\.blob\.vercel-storage\.com/'),
  device_id   text,
  filename    text,
  imported_at timestamptz not null default now(),
  deleted_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Rate limits and security events
-- ---------------------------------------------------------------------------
create table if not exists nsignage.rate_limits (
  bucket       text not null check (char_length(bucket) <= 40),
  key_hash     text not null check (char_length(key_hash) <= 64),
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, key_hash)
);

create table if not exists nsignage.security_events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  event     text not null check (char_length(event) <= 60),
  user_id   uuid,
  device_id text,
  ip_hash   text check (ip_hash ~ '^[a-f0-9]{16,64}$'),    -- hashed, never the raw IP
  detail    jsonb check (detail is null or jsonb_typeof(detail) = 'object')
);
create index if not exists security_events_at_idx on nsignage.security_events (at);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists users_touch on nsignage.users;
create trigger users_touch before update on nsignage.users for each row execute function nsignage.touch_updated_at();
drop trigger if exists devices_touch on nsignage.devices;
create trigger devices_touch before update on nsignage.devices for each row execute function nsignage.touch_updated_at();
drop trigger if exists transfers_touch on nsignage.transfers;
create trigger transfers_touch before update on nsignage.transfers for each row execute function nsignage.touch_updated_at();

-- Column guard on devices: a customer may only rename; a Pi may only report
-- its own state; ownership changes only in the 'system' context (claim/unlink).
create or replace function nsignage.devices_guard() returns trigger
  language plpgsql set search_path = nsignage, pg_catalog
  as $$
begin
  if nsignage.ctx() = 'system' then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.owner_id is distinct from old.owner_id
     or new.added_at is distinct from old.added_at
     or new.added_via is distinct from old.added_via then
    raise exception 'device ownership can only change through claim/unlink' using errcode = '42501';
  end if;
  if nsignage.ctx() = 'user' and (
       new.secret_hash is distinct from old.secret_hash
    or new.pi_username is distinct from old.pi_username
    or new.hostname is distinct from old.hostname
    or new.local_ip is distinct from old.local_ip
    or new.media is distinct from old.media
    or new.last_seen_at is distinct from old.last_seen_at
    or new.capabilities is distinct from old.capabilities) then
    raise exception 'customers can only change nickname and location' using errcode = '42501';
  end if;
  if nsignage.ctx() = 'device' and (
       new.nickname is distinct from old.nickname
    or new.location is distinct from old.location
    or new.secret_hash is distinct from old.secret_hash) then
    raise exception 'a device cannot change its owner metadata or secret' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists devices_guard on nsignage.devices;
create trigger devices_guard before update on nsignage.devices for each row execute function nsignage.devices_guard();

-- ---------------------------------------------------------------------------
-- Atomic fixed-window rate limit (returns true while under the limit)
-- ---------------------------------------------------------------------------
create or replace function nsignage.rate_limit_hit(p_bucket text, p_key_hash text, p_limit integer, p_window_seconds integer)
  returns boolean
  language plpgsql security definer set search_path = nsignage, pg_catalog
  as $$
declare n integer;
begin
  insert into nsignage.rate_limits as r (bucket, key_hash, window_start, hits)
  values (p_bucket, p_key_hash, now(), 1)
  on conflict (bucket, key_hash) do update
    set hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into n;
  return n <= p_limit;
end $$;

-- Retention: expired / finished rows (relay blobs are deleted by the API cron first)
create or replace function nsignage.purge_expired() returns jsonb
  language plpgsql security definer set search_path = nsignage, pg_catalog
  as $$
declare s int; n int; p int; r int; e int; t int;
begin
  delete from user_sessions where expires_at < now();                                   get diagnostics s = row_count;
  delete from claim_nonces where expires_at < now();                                    get diagnostics n = row_count;
  delete from pairing_codes where expires_at < now() - interval '1 day';               get diagnostics p = row_count;
  delete from rate_limits where window_start < now() - interval '1 day';               get diagnostics r = row_count;
  delete from security_events where at < now() - interval '90 days';                   get diagnostics e = row_count;
  delete from device_commands where state <> 'queued' and created_at < now() - interval '14 days';
  delete from transfers where blob_url is null and state in ('completed', 'cancelled', 'expired')
                          and updated_at < now() - interval '14 days';                  get diagnostics t = row_count;
  return jsonb_build_object('sessions', s, 'nonces', n, 'pairing_codes', p, 'rate_limits', r, 'security_events', e, 'transfers', t);
end $$;

revoke all on function nsignage.rate_limit_hit(text, text, integer, integer) from public;
revoke all on function nsignage.purge_expired() from public;
grant execute on function nsignage.rate_limit_hit(text, text, integer, integer) to nsignage_api;
grant execute on function nsignage.purge_expired() to nsignage_api;
grant execute on function nsignage.ctx(), nsignage.ctx_user(), nsignage.ctx_device() to nsignage_api;

-- ---------------------------------------------------------------------------
-- Table privileges + Row Level Security
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema nsignage to nsignage_api;
revoke truncate, references, trigger on all tables in schema nsignage from nsignage_api;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema nsignage from %I', r);
      execute format('revoke all on all functions in schema nsignage from %I', r);
    end if;
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['users', 'user_sessions', 'devices', 'device_network_sightings', 'claim_nonces',
                           'pairing_codes', 'transfers', 'device_commands', 'legacy_browser_sessions',
                           'legacy_browser_devices', 'legacy_relay_copies', 'rate_limits', 'security_events'] loop
    execute format('alter table nsignage.%I enable row level security', t);
    -- the 'system' context (auth, claims, cron, admin) may use every table
    execute format('drop policy if exists system_all on nsignage.%I', t);
    execute format($p$create policy system_all on nsignage.%I to nsignage_api
                     using (nsignage.ctx() = 'system') with check (nsignage.ctx() = 'system')$p$, t);
  end loop;
end $$;

-- users: a customer sees and updates only their own row
drop policy if exists users_self_read on nsignage.users;
create policy users_self_read on nsignage.users for select to nsignage_api
  using (nsignage.ctx() = 'user' and id = nsignage.ctx_user());
drop policy if exists users_self_update on nsignage.users;
create policy users_self_update on nsignage.users for update to nsignage_api
  using (nsignage.ctx() = 'user' and id = nsignage.ctx_user())
  with check (id = nsignage.ctx_user());

-- user_sessions: a customer can list / end their own sessions
drop policy if exists sessions_self on nsignage.user_sessions;
create policy sessions_self on nsignage.user_sessions for select to nsignage_api
  using (nsignage.ctx() = 'user' and user_id = nsignage.ctx_user());
drop policy if exists sessions_self_delete on nsignage.user_sessions;
create policy sessions_self_delete on nsignage.user_sessions for delete to nsignage_api
  using (nsignage.ctx() = 'user' and user_id = nsignage.ctx_user());

-- devices: customers see/rename only their devices; a Pi sees/updates only itself
drop policy if exists devices_owner_read on nsignage.devices;
create policy devices_owner_read on nsignage.devices for select to nsignage_api
  using (nsignage.ctx() = 'user' and owner_id = nsignage.ctx_user());
drop policy if exists devices_owner_update on nsignage.devices;
create policy devices_owner_update on nsignage.devices for update to nsignage_api
  using (nsignage.ctx() = 'user' and owner_id = nsignage.ctx_user())
  with check (owner_id = nsignage.ctx_user());
drop policy if exists devices_self_read on nsignage.devices;
create policy devices_self_read on nsignage.devices for select to nsignage_api
  using (nsignage.ctx() = 'device' and id = nsignage.ctx_device());
drop policy if exists devices_self_update on nsignage.devices;
create policy devices_self_update on nsignage.devices for update to nsignage_api
  using (nsignage.ctx() = 'device' and id = nsignage.ctx_device())
  with check (id = nsignage.ctx_device());

-- sightings: a Pi records its own networks
drop policy if exists sightings_self on nsignage.device_network_sightings;
create policy sightings_self on nsignage.device_network_sightings for all to nsignage_api
  using (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device())
  with check (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device());

-- transfers: customers only their own, and only to devices they own
drop policy if exists transfers_owner on nsignage.transfers;
create policy transfers_owner on nsignage.transfers for all to nsignage_api
  using (nsignage.ctx() = 'user' and user_id = nsignage.ctx_user())
  with check (
    nsignage.ctx() = 'user' and user_id = nsignage.ctx_user()
    and exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user())
  );
drop policy if exists transfers_device on nsignage.transfers;
create policy transfers_device on nsignage.transfers for select to nsignage_api
  using (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device());
drop policy if exists transfers_device_update on nsignage.transfers;
create policy transfers_device_update on nsignage.transfers for update to nsignage_api
  using (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device())
  with check (device_id = nsignage.ctx_device());

-- commands: customers queue/see commands for their own devices; a Pi reads/updates its own
drop policy if exists commands_owner on nsignage.device_commands;
create policy commands_owner on nsignage.device_commands for all to nsignage_api
  using (nsignage.ctx() = 'user'
         and exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user()))
  with check (nsignage.ctx() = 'user'
         and exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user()));
drop policy if exists commands_device on nsignage.device_commands;
create policy commands_device on nsignage.device_commands for select to nsignage_api
  using (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device());
drop policy if exists commands_device_update on nsignage.device_commands;
create policy commands_device_update on nsignage.device_commands for update to nsignage_api
  using (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device())
  with check (device_id = nsignage.ctx_device());

-- security events: any context may append; only 'system' reads (covered by system_all)
drop policy if exists events_append on nsignage.security_events;
create policy events_append on nsignage.security_events for insert to nsignage_api
  with check (nsignage.ctx() in ('user', 'device', 'system'));

commit;
