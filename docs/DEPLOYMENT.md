# Deploying N-Signage to https://software.nsinages.in

Pre-launch workflow: the live domain is the main development and testing website.

```
local change → tests (local + browser) → approval → push to GitHub main
            → Vercel builds automatically → https://software.nsinages.in updated → checks on the live domain
```

- **Vercel production branch:** `main`. The domain `software.nsinages.in` is assigned to Production.
- **Database:** the existing Supabase project in Singapore. It is **shared** by local development and the live domain.
- **Functions:** `vercel.json` → `"regions": ["sin1"]` (Singapore), next to the database.
- **Media:** never stored on the website. Browsers send files, end-to-end encrypted, directly to the Pis; Supabase stores only metadata.

## 1. Secrets

| Variable | Local `.env` | Vercel → Production | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | **yes, same value** | transaction pooler `:6543` as the restricted role `nsignage_api` |
| `CRON_SECRET` | yes | **yes, same value** | authorises `/api/cron/cleanup` (daily) |
| `NSIGNAGE_TICKET_KEY` | optional (`npm test` makes its own) | **yes** (Sensitive) | signs upload tickets; see DIRECT-UPLOAD.md |
| `SUPABASE_ADMIN_URL` | yes | **never** | project owner, only for `npm run db:setup` |
| `ALLOW_REAL_DB_TESTS` | `0` | no | safety switch for `npm run test:supabase` |
| `QA_n_*` | yes | no | QA/demo website logins |

- **One local file:** `.env` in the project root, git-ignored. `.env.example` lists the names without values.
- **Vercel can't read it:** Vercel never sees `.env`, so production values are entered in Vercel → Project → Settings → Environment Variables, scope **Production**.
- **Never** prefix a secret with `VITE_`. Vite would publish it in the browser JavaScript.

## 2. First deployment of the customer website

1. **Vercel:**
   - add `DATABASE_URL` and `CRON_SECRET` (Production);
   - `NSIGNAGE_TICKET_KEY` from `npm run upload:keygen` (Production, Sensitive); see §2a. No Blob store is needed;
   - Settings → Functions → region **Singapore (sin1)**, if the dashboard offers it (`vercel.json` already asks for `sin1`).
2. **Backup tag** of the old live version: `git tag live-2026-11-05 18c3de7` → `git push origin live-2026-11-05`.
3. **Publish:** `git checkout main && git merge --ff-only phase2-supabase && git push origin main`.
4. **Watch:** Vercel → Deployments shows the build of the new `main` commit, then it becomes Production.
5. **Check:**
   - `curl https://software.nsinages.in/api/health` → HTTP 200 with
     `"database":{"configured":true,"reachable":true,"role":"nsignage_api","rlsOnAllTables":true,"roleBypassesRls":false}`,
     `"upload":{"mode":"direct-e2e","ticketKey":true,"mediaStoredOnWebsite":false}`, `"cron":{"configured":true}` and the `sin1` region;
   - then the browser checks (register, login/logout, dashboard, devices, persistence, isolation, media pages, mobile/desktop) in Chrome and Edge.

## 2a. Media uploads: direct and end-to-end encrypted (no Vercel Blob)

The website never stores media. Uploads go from the browser, encrypted, straight to
the Pi's upload receiver through a Cloudflare Tunnel. Design, DNS move, cost, Pi
resources, deployment and rollback: **[DIRECT-UPLOAD.md](DIRECT-UPLOAD.md)**.

Vercel settings for this:
- `NSIGNAGE_TICKET_KEY`, from `npm run upload:keygen` (Production, Sensitive). Required.
- `BLOB_*` and `NSIGNAGE_BLOB_ACCESS` are no longer used; remove them after the release.

The installed MPV Pis keep their V2.1 cloud agent unchanged
(`N-Signage/mpv-agent/cloud_agent_v2.1.py` is a reference copy). The upload receiver is a
separate service installed with `N-Signage/upload-receiver/install-upload-receiver.sh`.

## 3. Every later change

1. Develop on a local branch.
2. Run `npm test`, `npm run lint`, `npm run build`, plus the browser checks on `npm run dev`.
3. Commit, then **get approval**.
4. `git checkout main && git merge --ff-only <branch> && git push origin main`.
5. Vercel deploys. Re-run `/api/health` and the browser checks on the live domain.

## 4. Rollback

- **Fastest, no Git change:** Vercel → Deployments → the previous Production deployment → **⋯ → Instant Rollback**. The domain serves the old build within about a minute. Then fix forward on `main`.
- **The pre-customer-website version** is the deployment built from commit `18c3de7`, tagged `live-2026-11-05`.
- **Code:** revert the faulty commit (`git revert <sha>`) and push `main`. Never force-push `main`.
- **Database:** the migrations are additive. Rolling back the website never requires a database change, and the old version simply doesn't use the `nsignage` schema.

## 5. Shared database: rules while it serves the live domain

- `npm run test:supabase` writes temporary rows to the live database, then deletes them. It runs only with `ALLOW_REAL_DB_TESTS=1`. **Stop using it once real customers sign up**; use `npm test`, which uses an in-process PostgreSQL, instead.
- `npm run db:setup` rotates the `nsignage_api` password. If it is ever re-run, update `DATABASE_URL` in Vercel → Production at the same time, or the live site loses its database.
- The QA accounts (`qa-…`, `demo-user`) live in the same database. They are test logins, kept on purpose.
- **Backups:** the Supabase Free plan has no restorable backups. Move the project to **Pro** before real customers depend on it.

## 6. What this does not change

- **The local-network dashboard** (`npm start` on a shop PC, `npm run dev:lan`) works as before.
- **Raspberry Pi software:** nothing is installed on any Pi by deploying. Pis already running agent 1.0 that point at `software.nsinages.in` start syncing with the new backend and appear as unclaimed displays until a customer adds them.
