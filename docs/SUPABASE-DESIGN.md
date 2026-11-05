# N-Signage — Supabase as the only primary database (design proposal)

**Status: APPROVED (Option A, Mumbai, Free for test / Pro for production) and
IMPLEMENTED on branch `phase2-supabase`.** Setup, test results, migration report,
deployment and rollback: [SUPABASE-SETUP.md](SUPABASE-SETUP.md). The text below
is the original proposal, kept for reference. The migration SQL is in
[`supabase/migrations/20261106000000_nsignage_init.sql`](../supabase/migrations/20261106000000_nsignage_init.sql)
and was validated on PostgreSQL 17 (PGlite): **40/40 checks passed**. The
checks cover constraints, Row Level Security isolation between customers and
between Pis, single-use pairing codes, single ownership, the rate limiter, and
no access for Supabase's `anon` / `authenticated` roles.

---

## 1. Decisions in one table

| Topic | Proposal |
|---|---|
| Primary database | **Supabase PostgreSQL**, the only database. Upstash Redis is no longer required. |
| Media | Never in Supabase. The temporary relay stays on Vercel Blob, and Supabase stores only the relay URL until the copy is deleted. |
| Where tables live | Private schema `nsignage`, **not exposed** through the Supabase Data API |
| Who connects | Only the website's serverless functions, through the Supabase pooler, as a least-privilege role `nsignage_api` (no superuser, no BYPASSRLS) |
| Browser access to Supabase | **None.** No anon key and no Supabase client in the frontend |
| Customer login | Username + password, handled server-side (scrypt), as today. No email. |
| Sessions | HttpOnly cookie; SHA-256 of the token in `nsignage.user_sessions` |
| RLS | On every table. Policies limit a customer to their own rows and a Pi to its own rows. `anon` and `authenticated` get nothing. |
| HTTP API | **Unchanged**, so the frontend and the Pi agent (1.0 and the planned 2) need no changes for the switch |

## 2. Authentication design: two options

### Option A (recommended): our own username/password auth, stored in Supabase

- `nsignage.users` stores the username, scrypt hash (N=2¹⁶, r=8, p=2, 16-byte
  salt) and the SHA-256 of the recovery key. The table has no email column, and
  a check constraint rejects anything that isn't a scrypt hash.
- Everything already built and tested stays the same:
  - recovery keys and the staff `reset-recovery` tool;
  - account lockout (10 failures, then 15 minutes);
  - per-IP rate limits;
  - timing-equalised login.
- The browser holds only an HttpOnly, Secure, SameSite=Strict cookie. **No
  token is ever readable by JavaScript.**

### Option B: Supabase Auth with placeholder emails

Supabase Auth requires an email or a phone number. Username-only login would
mean generating fake addresses (`<username>@users.invalid`), turning off email
confirmation, and doing password resets through the service-role admin API.

- **Gains:**
  - Supabase's own password hashing (bcrypt) and JWT sessions;
  - `auth.uid()` can be used in RLS policies.
- **Costs:**
  - the fake-email workaround, and you asked for no email;
  - account lockout is not built in;
  - by default `supabase-js` keeps tokens in browser storage, readable by JavaScript;
  - the Pi endpoints still need a service-role path anyway;
  - the tested auth code would be rewritten.

**Recommendation: A.** It meets "username and password only" without
workarounds, keeps the session secret out of JavaScript, and still gives real
database-level RLS (next section).

## 3. How RLS works with server-side auth

Each API request runs in **one database transaction** as `nsignage_api` and
first sets a transaction-local context:

```sql
select set_config('nsignage.ctx', 'user', true),          -- 'user' | 'device' | 'system'
       set_config('nsignage.user_id', '<customer uuid>', true),
       set_config('nsignage.device_id', '', true);
```

| Context | Used by | What RLS allows |
|---|---|---|
| `user` | everything a logged-in customer does | their own `users` row, sessions, devices (rename only), transfers and commands for **their** devices |
| `device` | `/api/pi/*` after the Pi's secret is verified | its own `devices` row, its own network sightings, commands and transfers addressed to it |
| `system` | registration/login, Find Pi and pairing claims, cron, admin script, migration | everything (these paths check ownership explicitly) |
| (none) | — | nothing |

A trigger also limits **columns**:
- a customer can change only a device's nickname and location;
- a Pi can't change its owner, name or secret;
- ownership changes only in `system` (claim or unlink).

**What this protects against:** a coding mistake that forgets an owner filter
can't return or change another customer's data. The database refuses it.
Supabase's public `anon` / `authenticated` roles have no privileges on the
schema at all.

**Honest limit:** the context is set by our server code, which also holds the
database password. RLS is a second line of defence behind the API's checks. It
is not protection against a compromised server. The same is true of any design
in which the server holds the service-role key.

## 4. Schema

Full SQL: [`supabase/migrations/20261106000000_nsignage_init.sql`](../supabase/migrations/20261106000000_nsignage_init.sql).

| Table | Purpose | Key constraints and indexes |
|---|---|---|
| `users` | customer accounts | `username` unique and lowercase pattern; `password_hash` must be a `scrypt$v1$…` hash; `recovery_hash` is 64-char hex |
| `user_sessions` | login sessions | PK `token_hash` (SHA-256); FK to user, cascade delete; `expires_at > created_at`; indexes on user and expiry |
| `devices` | Pis plus ownership (single owner) | PK 16-hex `id`; `owner_id` FK (restrict); owner and `added_at` set together; `api_port` 1–65535; `media` is a JSON array of names and sizes (no content); `local_ip inet` (metadata, never used to connect) |
| `device_network_sightings` | Find Pi (public network → Pi) | PK (device, net_key); index (net_key, seen_at) |
| `claim_nonces` | Find Pi claims | hashed; bound to user, device and network; expires in 3 minutes |
| `pairing_codes` | codes shown on the Pi | hashed; 10 minutes; `used_at` for single use; **at most one unused code per Pi** (partial unique index) |
| `transfers` | relay transfer metadata | 22-char random ID; size > 0; 64-hex SHA-256; image/video MIME; state machine values; `blob_url` must be a Vercel Blob URL; cleanup index on `expires_at` |
| `device_commands` | download/delete commands for Pis | type and state enums; partial index on pending commands |
| `legacy_browser_sessions`, `legacy_browser_devices` | imported pre-accounts data for the one-time verified link | hashed cookie only |
| `legacy_relay_copies` | old Blob URLs, to delete later | must be a public Blob URL |
| `rate_limits` | atomic fixed-window counters (`rate_limit_hit()`) | PK (bucket, key) |
| `security_events` | append-only security log, 90-day retention | IP stored hashed only |

Functions:
- `rate_limit_hit(bucket, key, limit, window)`: atomic `INSERT … ON CONFLICT`.
- `purge_expired()`: removes expired sessions, nonces, codes, rate-limit rows, events older than 90 days, and finished transfers older than 14 days.
- Both are `SECURITY DEFINER` with a fixed `search_path`; execute is granted only to `nsignage_api` and revoked from `public`, `anon` and `authenticated`.

Atomic operations that used Redis `SET NX` / `GETDEL` become single SQL statements:
- **Claim a device:** `update devices set owner_id=… where id=… and owner_id is null returning id`. A second claimer gets 0 rows (tested).
- **Redeem a pairing code:** `update pairing_codes set used_at=now() … where used_at is null and expires_at > now() returning device_id` (tested).
- **Register a username:** the `unique` constraint does the job.

**Why there is no Supabase Storage bucket and no binary column:** a test checks
that no `bytea` column exists.

## 5. Session management

- **Cookie:** `__Host-ns_acct` holds a 256-bit random token (`HttpOnly; Secure; SameSite=Strict; Path=/`), as today.
- **Stored:** `user_sessions.token_hash = sha256(token)`, plus `expires_at` (30 days, `NSIGNAGE_SESSION_DAYS`) and a truncated user agent.
- **Validate:** one query per request, `select … from user_sessions s join users u … where s.token_hash=$1 and s.expires_at > now() and not u.disabled`.
- **Last seen:** `last_seen_at` is updated at most every 10 minutes, to avoid a write on every request.
- **Revoke:**
  - logout deletes the row;
  - "sign out other sessions" and a password change delete all other rows, inside the same transaction as the password update;
  - recovery deletes every session.
- **Limit:** at most 20 sessions per customer. The oldest is deleted on login.
- **Cleanup:** `purge_expired()` runs daily.
- **CSRF protection** is unchanged: an `Origin` check plus SameSite=Strict.

## 6. Database driver and connection

- Driver: [`postgres`](https://github.com/porsager/postgres) (porsager). It needs no native dependency and works in Vercel functions.
- Connection: the Supabase **Supavisor transaction pooler** (port 6543). Settings: `prepare: false`, at most 1 connection per function instance, short idle timeout.
- **TLS:** `verify-full`, using Supabase's CA certificate (bundled in the repo, or set in an env var), so the certificate is validated.
- Region: put the Supabase project in the **same region as the Vercel functions**. If most customers are in India, use **ap-south-1 (Mumbai)** for Supabase and `bom1` for Vercel functions. The current default is Vercel `iad1`, US East.
- `/api/health` will report:
  - `database: { configured, reachable, schemaVersion }`, by running `select 1` as `nsignage_api` and checking that the schema exists;
  - plus the existing Blob and cron flags.
  
  It never returns secrets.

## 7. Environment variables

| Variable | Where | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Vercel (Prod and Preview) | **yes** | `postgres://nsignage_api.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `DATABASE_CA_CERT` | Vercel | recommended | Supabase CA certificate (PEM) for `verify-full` TLS. Alternatively, bundle the file in the repo. |
| `BLOB_READ_WRITE_TOKEN` | Vercel | yes, for cloud uploads | temporary media relay (unchanged; separate from the database) |
| `CRON_SECRET` | Vercel | yes | daily cleanup |
| `NSIGNAGE_*` | Vercel | no | the same optional settings as now |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | **only on the computer running the one-time migration** | migration only | read-only export from Redis |

**Not needed:** `SUPABASE_URL`, the anon/publishable key, and the
service-role/secret key. The app connects to Postgres directly as
`nsignage_api` and never uses the Supabase Data API.
- If the Vercel–Supabase integration adds those variables automatically, they go unused.
- Never create any of them with a `VITE_` prefix. Vite would bundle them into the public JavaScript.
- `nsignage_api`'s password exists only in `DATABASE_URL`. It is never committed.

## 8. Supabase Free plan: limits that matter here

These are from Supabase's published plans as I last knew them; **check
supabase.com/pricing before deciding**, as they change.

| Limit (Free) | Effect on N-Signage |
|---|---|
| 500 MB database | Plenty. Metadata only: ~1 KB per user, a few KB per device (the media-name list), ~0.6 KB per transfer with 14-day retention. 100 displays and 1,000 transfers a month is well under 50 MB. |
| ~5 GB egress per month | **The binding limit.** Every Pi sync returns data from the database. To stay small, idle Pis will be told to poll every 15 s instead of 5 s (agent 1.0 already obeys `pollSeconds`), the online window becomes 60 s, and a sync is one short transaction returning only pending commands. Rough estimate: **~25–50 always-on displays** on the free egress, depending on traffic. Measure after launch. |
| Project pauses after ~1 week of inactivity | Probably not a problem while Pis sync, but don't rely on it for production |
| No restorable backups on Free (Pro has daily backups) | **Customer accounts would have no backup.** |
| Shared compute, pooler client limits | Fine at this scale (1 connection per warm function instance) |

**Recommendation:**
- Free is fine for a **staging** project.
- Use **Pro** (about $25/month as last published) for production once real customers sign up, for backups and higher egress.

## 9. Moving existing Redis data (only if any exists)

**Step 0: check whether there is anything to migrate.** The Phase 2 Redis code
was never deployed, and the last health check of production (2026-11-05)
showed Redis **not connected**. Look in **Vercel → Storage** or run
`npx vercel env ls production` for `KV_REST_API_URL`. If Redis was never
connected, there is **nothing to migrate**; skip to §10.

If production Redis exists:

1. **Read-only export.** `scripts/migrate-redis-to-supabase.mjs --dry-run`, run locally with both sets of credentials:
   - it uses only `SCAN`, `GET`, `HGETALL` and `SMEMBERS`, and **never writes or deletes anything in Redis**;
   - it prints the counts per entity.
2. **Mapping:**

   | Redis | Supabase |
   |---|---|
   | `ns:dev:<id>` | `devices` (**keeps `secret_hash`**, so Pis keep authenticating; no Pi changes) |
   | `ns:net:<key>` (zset) | `device_network_sightings` |
   | `ns:sess:<hash>` `{id}` | `legacy_browser_sessions` |
   | `ns:owners:<id>` + `ns:browser-devs:<browser>` | `legacy_browser_devices` (for the verified one-time link to an account) |
   | `ns:blob:<id>` | `legacy_relay_copies` (old cloud copies, deleted later) |
   | `ns:cmd:<id>` (pending) | `device_commands` (state `queued`) |
   | `ns:user:*`, `ns:username:*`, `ns:dev-owner:*`, `ns:user-devs:*`, `ns:xfer:*` (Phase 2, if it was ever deployed) | `users` (hashes copied as they are), `devices.owner_id`/`nickname`/`location`, `transfers` |
   | sessions, nonces, pairing codes, rate limits | **not migrated** (short-lived; customers simply log in again) |

3. **Import** with idempotent upserts (`on conflict do nothing`), so it can be re-run safely.
4. **Verify.** The script compares:
   - counts per entity;
   - every device ID with its identical `secret_hash`;
   - every legacy browser–device pair;
   - every username.
   
   It prints a pass/fail report and exits non-zero on any mismatch.
5. **Cutover delta.** Re-run the import just before switching production (it's idempotent). Device state refreshes on each Pi's next sync anyway.
6. **Keep Redis untouched for at least 30 days.** Only after you approve: remove the Upstash integration and the `KV_*` variables.

The export file contains secret hashes. Keep it local and delete it after the
verification.

## 10. Implementation plan (after approval)

1. Archive the current Redis-based Phase 2 work on a git branch (`phase2-redis`). Nothing is lost; it is not deployed.
2. On a new branch, replace the Redis layer with `api/_lib/db.js`:
   - a `withUser(userId, fn)` / `withDevice(id, fn)` / `withSystem(fn)` transaction helper;
   - rewrite `auth`, `devices`, `find`, `transfer`, `pairing`, `pi/sync`, `cron` and the admin script on top of it.
   - **The HTTP API stays identical**, so the frontend and the Pi agent need no changes.
3. Tests: run the existing 30 tests against real Postgres in-process (PGlite), plus the RLS checks above.
4. Create a **staging** Supabase project (Free), run the migration, set the `nsignage_api` password, and point a Vercel **Preview** deployment at it.
5. On Preview, with the real database:
   - sign up and log in from two different browsers;
   - add a device;
   - upload, with the simulated Pi confirming.
   
   Data must persist across deployments and browsers. Check `/api/health` → `database.reachable: true`.
6. Production project: run the migration, then (if needed) the Redis import and its verification.
7. Set the production env vars and deploy **only after your approval**. Then verify `/api/health` and do the same manual checks on production.

## 11. Rollback

- **Application:** Vercel → promote the previous deployment. The database schema is additive and lives in its own schema, so the old version is unaffected.
  - Accounts created in Supabase after the switch are not visible to an older Redis-based version.
  - Redis stays untouched, so the old version keeps working if it was connected.
- **Database** (destructive; only with your explicit approval, and only if no real customer data exists yet):
  ```sql
  drop schema nsignage cascade;
  drop role nsignage_api;
  ```
- **Redis:** never deleted during migration, so it remains the fallback for 30+ days.

## 12. What this proposal does not change

- The LAN mode (no login, `/pi-proxy` to `:5000`), the V2 player, V3 Wi-Fi onboarding and the Pi software.
- The temporary relay on Vercel Blob (separate from the database), its checksums, expiry and deletion after delivery.
- The pairing-code and Pi agent v2 contract in [PI-AGENT-V2-CONTRACT.md](PI-AGENT-V2-CONTRACT.md). Only the storage behind it changes.

## 13. Decisions needed

1. **Authentication:** Option A (recommended) or Option B (§2).
2. **Region:** Mumbai (Supabase ap-south-1 + Vercel bom1), or another region?
3. **Plan:** Free for staging and Pro for production?
4. **Is there production Redis data?** (§9 step 0)
5. **OK to archive the Redis Phase 2 code on branch `phase2-redis`** and implement on a new branch?
