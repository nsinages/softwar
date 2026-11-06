-- =============================================================================
-- N-Signage — migration 2: customer device records, device events, account
-- status, session revocation timestamps, and customer-facing views.
--
-- ADDITIVE ONLY: no table is dropped, no data is deleted. Re-runnable.
--
-- Mapping to the requested logical tables (existing tables are reused, never duplicated):
--   customers          → nsignage.users          (+ view nsignage.customers)
--   customer_sessions  → nsignage.user_sessions  (+ view nsignage.customer_sessions)
--   devices            → nsignage.devices        (one table for Pi-verified AND customer-saved records)
--   device_events      → nsignage.device_events  (new table)
--   media_transfers    → nsignage.transfers      (+ view nsignage.media_transfers)
-- devices column mapping: uid = UUID identity, id = device_uid (Pi's stable id, or saved_… for a
-- customer-saved record that no Pi has confirmed yet), owner_id = customer_id, nickname = device_name,
-- local_ip = ip_address (last known), agent_version = device_version; status is derived from the
-- Pi's heartbeat (last_seen_at), never from a stored flag a customer could set.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- customers: account status + last login
-- ---------------------------------------------------------------------------
alter table nsignage.users add column if not exists account_status text not null default 'active';
alter table nsignage.users add column if not exists last_login_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_account_status_check') then
    alter table nsignage.users add constraint users_account_status_check check (account_status in ('active', 'disabled', 'suspended'));
  end if;
end $$;
update nsignage.users set account_status = 'disabled' where disabled and account_status = 'active';
create index if not exists users_status_idx on nsignage.users (account_status);

-- ---------------------------------------------------------------------------
-- customer sessions: UUID id, revocation timestamp, "remember me"
-- ---------------------------------------------------------------------------
alter table nsignage.user_sessions add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists user_sessions_id_idx on nsignage.user_sessions (id);
alter table nsignage.user_sessions add column if not exists revoked_at timestamptz;
alter table nsignage.user_sessions add column if not exists persistent boolean not null default true;
create index if not exists user_sessions_active_idx on nsignage.user_sessions (user_id) where revoked_at is null;
-- sign out other sessions / password change revoke (UPDATE revoked_at) the customer's OWN sessions
drop policy if exists sessions_self_update on nsignage.user_sessions;
create policy sessions_self_update on nsignage.user_sessions for update to nsignage_api
  using (nsignage.ctx() = 'user' and user_id = nsignage.ctx_user())
  with check (nsignage.ctx() = 'user' and user_id = nsignage.ctx_user());

-- ---------------------------------------------------------------------------
-- devices: UUID identity, customer-saved records, model / connection type
-- ---------------------------------------------------------------------------
alter table nsignage.devices add column if not exists uid uuid not null default gen_random_uuid();
create unique index if not exists devices_uid_idx on nsignage.devices (uid);
alter table nsignage.devices add column if not exists registration text not null default 'verified';
alter table nsignage.devices add column if not exists device_model text;
alter table nsignage.devices add column if not exists connection_type text;
-- A Pi UID the customer typed when saving a record. Informational only: knowing a UID is NOT proof of ownership.
alter table nsignage.devices add column if not exists expected_device_uid text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'devices_registration_check') then
    alter table nsignage.devices add constraint devices_registration_check check (registration in ('verified', 'saved'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_device_model_check') then
    alter table nsignage.devices add constraint devices_device_model_check check (char_length(device_model) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_connection_type_check') then
    alter table nsignage.devices add constraint devices_connection_type_check check (connection_type in ('wifi', 'ethernet', 'cellular', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_expected_uid_check') then
    alter table nsignage.devices add constraint devices_expected_uid_check check (expected_device_uid ~ '^[a-f0-9]{16}$');
  end if;
end $$;

-- Saved records use ids "saved_<24 hex>" (never a valid Pi id, so no Pi can authenticate as one)
alter table nsignage.devices drop constraint if exists devices_id_check;
alter table nsignage.devices add constraint devices_id_check check (id ~ '^([a-f0-9]{16}|saved_[a-f0-9]{24})$');
alter table nsignage.devices alter column pi_username drop not null;
alter table nsignage.devices drop constraint if exists devices_added_via_check;
alter table nsignage.devices add constraint devices_added_via_check
  check (added_via in ('network', 'pairing-code', 'legacy+network', 'legacy+pairing-code', 'admin', 'migrated', 'manual'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'devices_kind_check') then
    alter table nsignage.devices add constraint devices_kind_check check (
      (registration = 'verified' and id ~ '^[a-f0-9]{16}$' and pi_username is not null)
      or (registration = 'saved' and id ~ '^saved_[a-f0-9]{24}$' and owner_id is not null and secret_hash is null)
    );
  end if;
end $$;
create index if not exists devices_owner_registration_idx on nsignage.devices (owner_id, registration) where owner_id is not null;

-- Column guard: customers may also edit name/IP/hostname/model of their OWN SAVED records
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
     or new.added_via is distinct from old.added_via
     or new.registration is distinct from old.registration then
    raise exception 'device ownership can only change through claim/unlink' using errcode = '42501';
  end if;
  if nsignage.ctx() = 'user' and (
       new.secret_hash is distinct from old.secret_hash
    or new.pi_username is distinct from old.pi_username
    or new.media is distinct from old.media
    or new.last_seen_at is distinct from old.last_seen_at
    or new.capabilities is distinct from old.capabilities
    or (old.registration = 'verified' and (new.hostname is distinct from old.hostname
                                            or new.local_ip is distinct from old.local_ip
                                            or new.device_model is distinct from old.device_model))) then
    raise exception 'customers can only change the name and location of a verified display' using errcode = '42501';
  end if;
  if nsignage.ctx() = 'device' and (
       new.nickname is distinct from old.nickname
    or new.location is distinct from old.location
    or new.secret_hash is distinct from old.secret_hash) then
    raise exception 'a device cannot change its owner metadata or secret' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- device_events: connection / registration history (no secrets in details)
-- ---------------------------------------------------------------------------
create table if not exists nsignage.device_events (
  id         uuid primary key default gen_random_uuid(),
  device_id  text not null references nsignage.devices(id) on delete cascade,
  event_type text not null check (event_type in ('registered', 'saved', 'online', 'ip-changed', 'renamed', 'removed', 'secret-replaced')),
  ip_address inet,
  details    jsonb check (details is null or jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists device_events_device_idx on nsignage.device_events (device_id, created_at desc);

grant select, insert, update, delete on nsignage.device_events to nsignage_api;
revoke truncate, references, trigger on nsignage.device_events from nsignage_api;
alter table nsignage.device_events enable row level security;
drop policy if exists system_all on nsignage.device_events;
create policy system_all on nsignage.device_events to nsignage_api
  using (nsignage.ctx() = 'system') with check (nsignage.ctx() = 'system');
drop policy if exists events_owner_read on nsignage.device_events;
create policy events_owner_read on nsignage.device_events for select to nsignage_api
  using (nsignage.ctx() = 'user' and exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user()));
drop policy if exists events_device_insert on nsignage.device_events;
create policy events_device_insert on nsignage.device_events for insert to nsignage_api
  with check (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device());

-- ---------------------------------------------------------------------------
-- Customer-facing views with the requested names (security_invoker: RLS of
-- the underlying tables applies to whoever queries them)
-- ---------------------------------------------------------------------------
create or replace view nsignage.customers with (security_invoker = true) as
  select id, username, display_name, password_hash, account_status, created_at, updated_at, last_login_at
  from nsignage.users;
create or replace view nsignage.customer_sessions with (security_invoker = true) as
  select id, user_id as customer_id, token_hash as session_token_hash, expires_at, created_at, revoked_at,
         last_seen_at as last_used_at, persistent
  from nsignage.user_sessions;
create or replace view nsignage.media_transfers with (security_invoker = true) as
  select id, user_id as customer_id, device_id, filename, size_bytes as file_size, state as transfer_status,
         sha256 as checksum, created_at, completed_at
  from nsignage.transfers;
create or replace view nsignage.customer_devices with (security_invoker = true) as
  select uid as id, owner_id as customer_id, id as device_uid, nickname as device_name, local_ip as ip_address,
         hostname, device_model, agent_version as device_version, connection_type, registration,
         case when registration = 'saved' then 'unknown'
              when last_seen_at > now() - interval '60 seconds' then 'online' else 'offline' end as status,
         case when registration = 'saved' then null else last_seen_at end as last_seen_at,
         created_at, updated_at
  from nsignage.devices where owner_id is not null;

grant select on nsignage.customers, nsignage.customer_sessions, nsignage.media_transfers, nsignage.customer_devices to nsignage_api;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on nsignage.customers, nsignage.customer_sessions, nsignage.media_transfers, nsignage.customer_devices, nsignage.device_events from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retention now also covers revoked sessions and old device events
-- ---------------------------------------------------------------------------
create or replace function nsignage.purge_expired() returns jsonb
  language plpgsql security definer set search_path = nsignage, pg_catalog
  as $$
declare s int; n int; p int; r int; e int; t int; de int;
begin
  delete from user_sessions where expires_at < now() or revoked_at < now() - interval '7 days'; get diagnostics s = row_count;
  delete from claim_nonces where expires_at < now();                                    get diagnostics n = row_count;
  delete from pairing_codes where expires_at < now() - interval '1 day';               get diagnostics p = row_count;
  delete from rate_limits where window_start < now() - interval '1 day';               get diagnostics r = row_count;
  delete from security_events where at < now() - interval '90 days';                   get diagnostics e = row_count;
  delete from device_events where created_at < now() - interval '180 days';            get diagnostics de = row_count;
  delete from device_commands where state <> 'queued' and created_at < now() - interval '14 days';
  delete from transfers where blob_url is null and state in ('completed', 'cancelled', 'expired')
                          and updated_at < now() - interval '14 days';                  get diagnostics t = row_count;
  return jsonb_build_object('sessions', s, 'nonces', n, 'pairing_codes', p, 'rate_limits', r, 'security_events', e,
                            'device_events', de, 'transfers', t);
end $$;
revoke all on function nsignage.purge_expired() from public;
grant execute on function nsignage.purge_expired() to nsignage_api;

-- ---------------------------------------------------------------------------
-- Migration bookkeeping (lets the health check and setup script verify versions)
-- ---------------------------------------------------------------------------
create table if not exists nsignage.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
alter table nsignage.schema_migrations enable row level security;
drop policy if exists migrations_read on nsignage.schema_migrations;
create policy migrations_read on nsignage.schema_migrations for select to nsignage_api using (true);
grant select on nsignage.schema_migrations to nsignage_api;
insert into nsignage.schema_migrations (version) values ('20261106000000_nsignage_init'), ('20261106000001_customer_devices')
  on conflict do nothing;

commit;
