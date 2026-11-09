-- =============================================================================
-- N-Signage — migration 3: direct, end-to-end encrypted browser → Pi uploads
--
-- The website never stores media bytes, not even temporarily: the browser
-- encrypts each chunk for the Pi and sends it straight to the Pi's upload
-- receiver (through a Cloudflare Tunnel). The database keeps metadata only.
--
-- ADDITIVE ONLY: no table is dropped, no data is deleted. Re-runnable.
--   transfers.relay_access  += 'direct'      (old 'public'/'private' relay rows stay readable)
--   transfers.epk_hash      SHA-256 of the browser's one-time public key (public data)
--   device_receivers        one row per Pi receiver: public key (pinned), hostname, heartbeat
-- =============================================================================

begin;

-- transfers: a third transfer method, 'direct' (no relay copy ever exists)
alter table nsignage.transfers drop constraint if exists transfers_relay_access_check;
alter table nsignage.transfers add constraint transfers_relay_access_check
  check (relay_access in ('public', 'private', 'direct'));
alter table nsignage.transfers add column if not exists epk_hash text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transfers_epk_hash_check') then
    alter table nsignage.transfers add constraint transfers_epk_hash_check check (epk_hash is null or epk_hash ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transfers_direct_has_no_copy') then
    alter table nsignage.transfers add constraint transfers_direct_has_no_copy check (relay_access <> 'direct' or blob_url is null);
  end if;
end $$;

-- device_receivers: the Pi's upload receiver (public key only; the private key never leaves the Pi)
create table if not exists nsignage.device_receivers (
  device_id           text primary key references nsignage.devices(id) on delete cascade,
  public_key          text not null check (public_key ~ '^[A-Za-z0-9_-]{87}$'),          -- P-256, uncompressed, base64url
  key_fingerprint     text not null check (key_fingerprint ~ '^[a-f0-9]{64}$'),
  key_confirmed_at    timestamptz not null default now(),                                 -- first key is pinned (trust on first use)
  pending_public_key  text check (pending_public_key is null or pending_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  pending_fingerprint text check (pending_fingerprint is null or pending_fingerprint ~ '^[a-f0-9]{64}$'),
  pending_since       timestamptz,
  hostname            text check (hostname is null or hostname ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'),
  receiver_version    text check (char_length(receiver_version) <= 20),
  free_bytes          bigint check (free_bytes >= 0),
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
create unique index if not exists device_receivers_hostname_idx on nsignage.device_receivers (hostname) where hostname is not null;

grant select, insert, update, delete on nsignage.device_receivers to nsignage_api;
revoke truncate, references, trigger on nsignage.device_receivers from nsignage_api;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on nsignage.device_receivers from %I', r);
    end if;
  end loop;
end $$;

alter table nsignage.device_receivers enable row level security;
drop policy if exists system_all on nsignage.device_receivers;
create policy system_all on nsignage.device_receivers to nsignage_api
  using (nsignage.ctx() = 'system') with check (nsignage.ctx() = 'system');
-- a Pi manages only its own receiver row
drop policy if exists receivers_self on nsignage.device_receivers;
create policy receivers_self on nsignage.device_receivers for all to nsignage_api
  using (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device())
  with check (nsignage.ctx() = 'device' and device_id = nsignage.ctx_device());
-- a customer reads (and confirms key changes of) the receivers of Pis they own
drop policy if exists receivers_owner_read on nsignage.device_receivers;
create policy receivers_owner_read on nsignage.device_receivers for select to nsignage_api
  using (nsignage.ctx() = 'user' and exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user()));
drop policy if exists receivers_owner_update on nsignage.device_receivers;
create policy receivers_owner_update on nsignage.device_receivers for update to nsignage_api
  using (nsignage.ctx() = 'user' and exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user()))
  with check (exists (select 1 from nsignage.devices d where d.id = device_id and d.owner_id = nsignage.ctx_user()));

commit;
