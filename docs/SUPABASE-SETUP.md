# N-Signage on Supabase: setup, testing, migration, deployment, rollback

> **Current setup (Phase 6):** one Supabase project (Singapore, ap-southeast-1), is shared by local development and the live domain https://software.nsinages.in (Vercel production branch `main`, functions in `sin1`). All local secrets are in the single git-ignored `.env` (see `.env.example`). The deployment workflow and rollback are in [DEPLOYMENT.md](DEPLOYMENT.md); it supersedes the Preview/Mumbai instructions below.

Branch: **`phase2-supabase`**. The previous Redis implementation is preserved
unchanged on **`phase2-redis`**, and `main` (production) is untouched.
Design rationale: [SUPABASE-DESIGN.md](SUPABASE-DESIGN.md). Pi contract:
[PI-AGENT-V2-CONTRACT.md](PI-AGENT-V2-CONTRACT.md).

## 0. Status (2026-11-05)

| Item | Status |
|---|---|
| Supabase PostgreSQL is the only database; no Upstash Redis needed at runtime | **implemented** |
| Schema, constraints, RLS ([migration](../supabase/migrations/20261106000000_nsignage_init.sql)) | implemented; **40/40 DB checks pass** on PostgreSQL 17 (PGlite) |
| API on Postgres (auth, devices, pairing, transfers, Pi sync, cron, admin) | implemented; **27/27 API tests pass** on PostgreSQL 17 |
| Unmodified Pi agent 1.0 against the new backend | **passes** (real `cloud_agent.py`) |
| Redis → Supabase migration tool (read-only on Redis) | implemented; **tested** with seeded Redis data |
| Browser UI (unchanged frontend) on the new backend, Chrome and Edge | **29/29 checks in each** |
| TLS `verify-full` to the Singapore pooler | **verified**: the certificate chain checks out against the bundled Supabase Root 2021 CA (`Verify return code: 0`) |
| **Real Supabase test project** | **NOT YET**. It needs you to create the project (§2). The tests are ready: `npm run test:supabase` |
| **Vercel Preview with real Supabase** | **NOT YET**. It needs Preview env vars (§4) |
| Production | **not deployed**; waits for your approval |

Production today (`main`, commit 18c3de7) has **no database configured**.
`GET https://software.nsinages.in/api/health` returned HTTP 503
`{"redis":{"configured":false},"blob":{"configured":false}}` on 2026-11-05. See §6.

---

## 1. Architecture summary

```
Browser ──HTTPS──► Vercel functions (region sin1, Singapore)
                     │ postgres driver, TLS verify-full, Supavisor TRANSACTION pooler :6543
                     │ every request = 1 transaction:  SET LOCAL ROLE nsignage_api + RLS context
                     ▼
                  Supabase PostgreSQL (ap-southeast-1, Singapore), schema `nsignage` (not exposed via Data API)

Pi (cloud_agent.py) ──HTTPS──► /api/pi/sync  (device secret; RLS context 'device')
Media bytes ──► Vercel Blob (temporary relay copy) ──► Pi;  copy deleted after the Pi confirms
```

- **Customer authentication:** username + password (scrypt). Sessions live in `nsignage.user_sessions`; the cookie is HttpOnly, Secure, SameSite=Strict. No email.
- **Pi authentication:** a separate per-device secret, stored as SHA-256 in `devices.secret_hash`.
- **The browser never connects to Supabase.** No Supabase key reaches the frontend.
- **Single owner per device:** an ownership change is a single `UPDATE … WHERE owner_id IS NULL`, inside the same transaction as the code or nonce check.

## 2. Create the Supabase TEST project (Free plan)

1. Go to https://supabase.com/dashboard → **New project**.
   - Name: `nsignage-test`.
   - **Region: Southeast Asia (Singapore) – ap-southeast-1** (the region of the existing project).
   - Database password: generate a strong one and keep it in your password manager. It is the *admin* password and is used only in step 3.
   - Plan: Free.
2. In the project: **Connect** (top bar) → **Session pooler**. Copy the URI. It looks like
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`.
   (The host may start with `aws-1-`; use exactly what the dashboard shows.)
3. On this computer, in the project folder (PowerShell):
   ```powershell
   # put SUPABASE_ADMIN_URL=<session pooler URL> in .env, then:
   npm run db:setup
   ```
   This:
   - applies the migration;
   - gives the role `nsignage_api` a random 48-character password;
   - writes `DATABASE_URL=…` (transaction pooler, port 6543, user `nsignage_api.<ref>`) into `.env` (other lines are kept). That file is git-ignored, and **the password is never printed**;
   - connects as `nsignage_api` with verified TLS and checks the role, schema and RLS.
   
   Expected last line: `OK: least-privilege role, RLS on every table, nothing visible without a context.`

   Alternative without the script:
   1. Paste the migration file into Supabase → **SQL Editor** → Run.
   2. Then run `alter role nsignage_api with password '<long random>';`.
   3. Build the `DATABASE_URL` from the **Transaction pooler** URI, replacing the user `postgres.<ref>` with `nsignage_api.<ref>` and using that password.
4. Run the real-database tests:
   ```powershell
   npm run test:supabase
   ```
   This runs the API suite (accounts, ownership isolation, Pi auth, pairing expiry and single use, transfers, cleanup) and the unmodified Pi agent against the real project. Test data is deleted afterwards.
5. Supabase → **Database → Settings**: check that **Enforce SSL on incoming connections** is ON.
6. Supabase → **Settings → API**: there is nothing to do. The `nsignage` schema is not in "Exposed schemas", so the Data API can't reach it; leave the defaults.

## 3. Environment variables

| Variable | Scope | Required | Value |
|---|---|---|---|
| `DATABASE_URL` | Vercel **Preview** (test project) / **Production** (prod project) | **yes** | `postgresql://nsignage_api.<ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`. Must be the **transaction** pooler (6543) as **`nsignage_api`**. |
| `DATABASE_CA_CERT` | Vercel | no | Override for the bundled Supabase Root 2021 CA (valid until 2031-04-26) |
| `DATABASE_POOL_MAX` | Vercel | no | Client connections per function instance (default 3, max 10) |
| `BLOB_READ_WRITE_TOKEN` | Vercel | for cloud uploads | Vercel Blob store (temporary relay only) |
| `CRON_SECRET` | Vercel | yes | Any long random value (daily cleanup) |
| `NSIGNAGE_IDLE_POLL_SECONDS` | Vercel | no | How often idle Pis sync (default 15; raise to cut database egress) |
| `NSIGNAGE_BLOB_ACCESS`, `NSIGNAGE_MAX_UPLOAD_MB`, `NSIGNAGE_TRANSFER_TTL_HOURS`, `NSIGNAGE_SESSION_DAYS`, `NSIGNAGE_NETWORK_CLAIM`, `NSIGNAGE_PURGE_LEGACY_BLOBS` | Vercel | no | Unchanged; see [ACCOUNTS-AND-TRANSFERS.md §7](ACCOUNTS-AND-TRANSFERS.md) |

**Not used:**
- `SUPABASE_URL`, the anon/publishable key, and the service-role/secret key. The app never calls the Supabase Data API. If the Vercel–Supabase integration adds them, they are unused.
- **Never** give a database variable a `VITE_` prefix; Vite would put it in the public JavaScript.

**No longer needed at runtime:** `KV_REST_API_URL` and `KV_REST_API_TOKEN`. They are used only by the one-time migration tool, if Redis data ever existed.

## 4. Vercel Preview with the real test database

1. Vercel → Project → **Settings → Environment Variables**. Add, scoped to **Preview** only:
   - `DATABASE_URL`: the value from `.env`;
   - `CRON_SECRET`: a random value;
   - `BLOB_READ_WRITE_TOKEN`: connect a Blob store to Preview (Storage → Blob → connect to Preview), so you can test uploads.
2. **Region:** `vercel.json` sets `"regions": ["sin1"]` (Singapore), next to Supabase ap-southeast-1. After the deploy, `/api/health` shows `"region":"sin1"`. If it shows another region, your plan doesn't allow the setting. Database calls then cross continents, so tell me before going live.
3. Push the branch. Vercel builds a Preview deployment; it never touches Production:
   ```bash
   git push -u origin phase2-supabase
   ```
4. Open the Preview URL from Vercel → Deployments, and check:
   ```bash
   curl https://<preview-url>/api/health
   # expect HTTP 200 with
   # "database":{"provider":"supabase-postgres","configured":true,"reachable":true,"role":"nsignage_api",
   #             "schema":true,"rlsOnAllTables":true,"roleBypassesRls":false,"tls":"verify-full","latencyMs":…}
   ```
   - If Vercel Deployment Protection is on, open the URL in a browser logged into Vercel, or use a bypass token.
5. Persistence checks on the Preview:
   1. Create an account.
   2. Log out, then log in from **another browser or phone**. Your account must be there.
   3. Supabase → **Table Editor → schema `nsignage` → users**: your username appears with a `scrypt$v1$…` hash, and no plaintext anywhere.
   4. Redeploy the Preview; you can still log in.
   5. Add a Pi. This needs a Pi whose agent points at the Preview URL: `NSIGNAGE_CLOUD_URL=<preview-url>` in `/etc/n-signage.env`. **That changes only an environment file on a test Pi**, so do it only on a test Pi, and only if you want this check now.

## 5. Production (only after your approval)

1. (Superseded: the existing Singapore project is reused, see DEPLOYMENT.md.) A separate project would be created the same way (§2). Use **Pro** once real customers sign up (backups; see §8).
2. Run `npm run db:setup` with that project's admin URL in `.env`.
3. Vercel → Environment Variables, scope **Production**: `DATABASE_URL` (production `nsignage_api` URL), `CRON_SECRET`, and connect the Blob store to Production.
4. Redis migration: §6. Today there is nothing to migrate.
5. Merge `phase2-supabase` into `main` and push. Vercel deploys Production.
6. Check:
   - `curl https://software.nsinages.in/api/health` returns HTTP 200 with the database flags as in §4;
   - sign up and log in from two browsers;
   - add a display;
   - upload a small image; it shows on the display, and the success message appears only after the display confirms.

## 6. Redis → Supabase migration report

**What I could check (2026-11-05):**
- **Production code** (`main` 18c3de7) runs **without Redis credentials**. `/api/health` returns `"redis":{"configured":false,"reachable":false}`, so the deployed site cannot have written anything to Redis.
- **The Phase 2 Redis build** was never deployed.
- There is **no `.vercel` link or Vercel login on this computer**, so I cannot list your Vercel stores. Please confirm in **Vercel → Storage** (and on upstash.com) whether any Upstash database exists.

**Conclusion:**
- If no Upstash database exists, **no migration is necessary**.
- If one exists (for example, created earlier and later disconnected), check it read-only:
  ```bash
  # .env with KV_REST_API_URL + KV_REST_API_READ_ONLY_TOKEN (from Upstash / vercel env pull)
  npm run db:migrate-redis -- inspect      # counts only; "no N-Signage data" → nothing to do
  ```
  If it reports data:
  ```bash
  npm run db:migrate-redis -- export       # read-only snapshot → .migration/redis-export.json (git-ignored, owner-only)
  # with DATABASE_URL of the target project in .env:
  npm run db:migrate-redis -- import       # idempotent; never overwrites newer rows
  npm run db:migrate-redis -- verify       # record-by-record check; must print VERIFIED
  ```

**What the tool guarantees (tested in `tests/migration.test.mjs`):**
- **Redis is unchanged:** a byte-for-byte comparison before and after, and the tool sends only `SCAN/GET/HGET/HGETALL/SMEMBERS/LRANGE/ZRANGE`.
- **Pis keep their secrets**, so they keep working without any Pi change.
- **Migrated accounts log in with their existing passwords** (hashes copied as they are).
- **Old browser–display pairs** can still be linked through the verified flow. Pairs a browser had removed are not imported.
- **Re-import adds nothing**, and verification compares device secret hashes, owners, usernames, password hashes, legacy pairs and old cloud copies.
- **Not migrated:** short-lived data (login sessions, nonces, codes, rate limits) and `ns:acct:*` email accounts from the 10-minute build b979de3 (they are reported as a count).

**Delete Redis only after `verify` passes, production has run on Supabase for at least 30 days, and you approve.**

## 7. Connection pooling and latency (Vercel serverless)

- **Transaction pooler (Supavisor, port 6543)** is Supabase's recommended mode for serverless functions.
  - Each warm function instance keeps at most `DATABASE_POOL_MAX` (3) client connections, and Supavisor multiplexes them onto a few database connections.
  - Prepared statements are not supported in this mode, so the driver runs with `prepare: false`.
  - `SET LOCAL ROLE` and `set_config(..., true)` are transaction-local, which is exactly what transaction mode supports.
- **Not used:**
  - the direct connection on port 5432 (IPv6 only, one connection per instance; wrong for serverless);
  - the session pooler on 5432 (holds a connection per client; used only by the setup script).
- **Latency:** Vercel `sin1` and Supabase `ap-southeast-1` are both in Singapore.
  - A request makes 1–3 short transactions of a few round trips each, which should be tens of milliseconds.
  - A cold start adds one TLS handshake plus authentication with the pooler.
  - `/api/health` reports `latencyMs`.
  - **If functions ran in `iad1` (US East) against Singapore, every round trip would cross continents, and that would be very slow.**
- **No transaction ever waits on network I/O:** Blob checks happen before the transaction opens, and Blob deletions happen after it commits. Rate limits and failed-login counters commit in their own transaction, so a failed login can't roll them back.

## 8. Growth: size, egress, connections, backups

These are estimates, to be measured on the Supabase **Usage** page. Plan limits change; check supabase.com/pricing.

| Pis online 24/7 | DB size (metadata) | DB egress / month (idle poll 15 s) | DB writes | Recommendation |
|---|---|---|---|---|
| 10 | < 20 MB | ~2 GB | ~1 update/s | Free is enough **for testing** |
| 50 | < 50 MB | ~8–9 GB | ~4 /s | **Pro** (Free egress ~5 GB is exceeded) |
| 300 | ~100 MB | ~50 GB | ~20 /s | Pro, small compute |
| 1,000 | ~300 MB | ~170 GB | ~70 /s | Pro + larger compute; raise `NSIGNAGE_IDLE_POLL_SECONDS` to 30 (halves both) |

**What drives these numbers:**
- **Each sync is about 1 KB of database traffic**, from one transaction of about 6 short statements. At one sync per 15 s that is ~5,760 syncs, or ~5–6 MB per Pi per day.
- **Writes:** each sync updates `last_seen_at`. The media list is rewritten only when it changes, and the network sighting at most every 30 s.
- **Size:**
  - a device row is 1–40 KB (the media-name list);
  - transfers are ~1 KB each and kept 14 days;
  - security events are ~0.3 KB each and kept 90 days;
  - **no media is stored.**
- **Connections:**
  - 1 transaction per request, at most 3 client connections per warm function instance;
  - Free allows ~200 pooler clients, Pro more;
  - with Vercel Fluid compute, instances are reused, so this is ample.
- **Backups:**
  - **Free has no restorable backups, so don't keep real customer data on Free.**
  - Pro has daily backups (7 days), and point-in-time recovery is an add-on.
  - Before going live, use Pro and consider point-in-time recovery once customers depend on it.
- **Pausing:** Free projects pause after about a week of inactivity, which is another reason to use Pro for production.

The architecture doesn't depend on Free-plan limits. Moving to Pro is a billing change only: same project, same URL, no code change.

## 9. Rollback

- **Preview:** nothing to roll back; Preview deployments don't affect production.
- **Production application:** Vercel → Deployments → the previous production deployment → **Promote**. Or `git revert` the merge and push.
- **Data:**
  - The migration is additive and self-contained (schema `nsignage`, role `nsignage_api`).
  - The previous app version simply doesn't use it.
  - Accounts created after the switch exist only in Supabase.
- **Removing the schema** (destructive; only with your written approval, and only before real customer data exists):
  ```sql
  drop schema nsignage cascade;
  drop role nsignage_api;
  ```
- **Redis:** never modified by this work. If an Upstash database exists, it remains as it is.

## 10. Staff procedures

The admin script now uses Supabase (`DATABASE_URL` in `.env`):

```bash
npm run admin -- account <username>
npm run admin -- reset-recovery <username>   # new recovery key, signs out every session
npm run admin -- revoke-sessions <username>
npm run admin -- disable <username> | enable <username>
npm run admin -- device <deviceId>
npm run admin -- unlink-device <deviceId>
```

- Every action is written to `nsignage.security_events`.
- **Recovery without email:** verify the customer offline first (order number, device ID shown on the display, business details, call-back), then run `reset-recovery` and give them the key by phone or in person.

## 11. Security summary

| Requirement | How it's met |
|---|---|
| No credentials in frontend | `DATABASE_URL` is read only in `api/_lib/db.js`; `src/` has no database code; no `VITE_` variables for secrets |
| Verified TLS | `verify-full` with the Supabase Root 2021 CA (fingerprint `80:70:25:AD…CA:FA`, checked against the Supabase pooler) |
| Least privilege | the app connects as `nsignage_api` (no superuser, no BYPASSRLS, no DDL), and also forces `SET LOCAL ROLE nsignage_api` in every transaction |
| RLS on all tables | 13/13 tables; customers see only their own rows, a Pi only its own; `anon` and `authenticated` have no privileges |
| Ownership in transactions | claims, pairing redemption, legacy linking and removal are single transactions; single-owner `UPDATE … WHERE owner_id IS NULL` |
| Customer A ≠ customer B | API tests plus database tests (cross-customer reads and writes return 0 rows or are rejected) |
| Pi auth separate | device secret (SHA-256) and the `device` context; customer sessions can't act as a Pi, and a Pi can't change ownership (guard trigger) |
| No media in Supabase | metadata only; no `bytea` columns (tested); no Storage buckets |
| Blob is a temporary relay | copy deleted after the Pi confirms; expiry and cron cleanup otherwise |

**Known, pre-existing:** `npm audit` reports 4 high-severity advisories in the
`@vercel/blob` → `@vercel/oidc` → `@vercel/cli-config` → `zod` dependency
chain. They were already present before this work and are not introduced by
it. The suggested `npm audit fix --force` is a breaking change, so it was not
applied. Review it separately.
