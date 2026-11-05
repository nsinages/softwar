# N-Signage — Customer accounts, pairing and relay transfers (Phase 2)

> **Storage update:** this document was written for the first Phase 2 build,
> which kept data in Upstash Redis (preserved on branch `phase2-redis`). The
> current build stores everything in **Supabase PostgreSQL**; Redis is no
> longer used. The behaviour, API and security rules below are unchanged, but
> the Redis-specific parts (the Redis key table in §2, `KV_*` variables in §7,
> deploy steps in §8, test results in §10) are replaced by
> [SUPABASE-SETUP.md](SUPABASE-SETUP.md) and the schema in
> [`supabase/migrations/`](../supabase/migrations/).

Applies to the hosted website (cloud mode, e.g. https://software.nsinages.in).
LAN mode (`npm start` / `npm run dev` on localhost or a LAN address) is unchanged
and still needs no login.

Pi-side work for the next phase: [PI-AGENT-V2-CONTRACT.md](PI-AGENT-V2-CONTRACT.md).
Find Pi / the original cloud relay: [CLOUD-DISCOVERY.md](CLOUD-DISCOVERY.md).

---

## 1. What changed

| Area | Before | Now |
|---|---|---|
| Login | none: an anonymous cookie per browser | **username + password** accounts (no email) |
| Device ownership | any browser that found the Pi on its Wi-Fi; up to 50 browsers per Pi | **exactly one account** per Pi |
| Add Device | Find Pi on the same Wi-Fi | Find Pi on the same Wi-Fi **or** a one-time **pairing code** shown on the display (needs the Pi update) |
| Old browser devices | n/a | one-time **verified link** into an account |
| Cloud upload | browser → public Blob → Pi; copy kept forever; "queued" shown as success | **transfer** with checksum, size and content checks, cancel/retry, expiry; copy **deleted after the Pi confirms**; success only after confirmation |
| Formats | JPG, PNG, GIF, WEBP, MP4, M4V, WEBM, MOV | adds **BMP, MKV, AVI** (the Pi already accepted them) |

Media transfer is a **relay** (browser → cloud → Pi). It is **not peer-to-peer**.
The code keeps transfers separate from the transport, so WebRTC with STUN/TURN
can be added later without changing accounts, devices or transfer records.

## 2. Architecture

```
 Customer browser (any network)                           Raspberry Pi (customer Wi-Fi)
   │ HTTPS, HttpOnly session cookie                          │ cloud_agent.py → HTTPS every 2–5 s
   ▼                                                         ▼
 ┌──────────────────────── software.nsinages.in (Vercel functions) ─────────────────────────┐
 │ /api/auth        register · login · logout · change password · recovery · sessions       │
 │ /api/devices     list · Find-Pi claim · pairing-code claim · legacy link · rename · remove│
 │ /api/find        Pis that synced from the browser's public network (claim nonces)         │
 │ /api/device      status · media list · delete media (queued command to the Pi)            │
 │ /api/transfer    create · upload token · commit · status · list · cancel · retry          │
 │ /api/pi/sync     Pi heartbeat, commands, results (device secret)                         │
 │ /api/pi/pairing  Pi asks for a pairing code (device secret)          [Pi update needed]  │
 │ /api/cron/cleanup  daily: expire transfers, delete relay copies (CRON_SECRET)             │
 │ /api/health      configuration flags only                                                 │
 └─────────────┬───────────────────────────────────────────────┬───────────────────────────┘
               ▼                                               ▼
        Upstash Redis                                    Vercel Blob
  accounts, sessions, devices, ownership,       transient relay copies only:
  pairing codes, transfer metadata, queues      transfers/<deviceId>/<transferId>/<file>
```

### Why Redis (not Supabase)

The project has never used Supabase. Redis (Upstash) already holds all
metadata, and every requirement of this phase works with it: unique usernames
(`SET NX`), single-use codes (`GETDEL`), expiry (TTL), rate limits (`INCR` +
`EXPIRE`), revocable sessions (a set per account). Authorisation is enforced
in the API functions, the only code that holds the Redis credentials. The
browser never talks to Redis. This is the same model that Supabase RLS
provides, but enforced server-side. Adding Supabase would add a second
provider and a data migration without closing any concrete gap.

### Redis keys (new). Nothing existing was renamed or deleted.

| Key | Type | Content | Expiry |
|---|---|---|---|
| `ns:user:<userId>` | JSON | id, username, displayName, passwordHash (scrypt), recoveryHash (SHA-256), createdAt, passwordChangedAt, disabled | — |
| `ns:username:<username>` | string | userId (unique, `SET NX`) | — |
| `ns:usess:<sha256(token)>` | JSON | userId, createdAt, expiresAt, user agent | 30 days |
| `ns:user-sess:<userId>` | set | session hashes (for revocation) | 30 days |
| `ns:user-devs:<userId>` | hash | deviceId → { name, location, addedAt, via } | — |
| `ns:dev-owner:<deviceId>` | string | userId (one owner, `SET NX`) | — |
| `ns:login-fail:<username>` | counter | failed logins | 15 min |
| `ns:pair:<sha256(code)>` / `ns:pair-dev:<deviceId>` | JSON / string | pairing code → deviceId | 10 min |
| `ns:xfer:<transferId>` | JSON | transfer metadata (no media) | 14 days |
| `ns:xfer-expiry` | zset | transferId → expiresAt (cleanup index) | — |
| `ns:user-xfers:<userId>` | zset | last 100 transfers | — |
| `ns:xfer-prog:<transferId>` | number | bytes the Pi received (agent protocol 2) | 10 min |

New prefixes were chosen on purpose: the short-lived email-account build
(commit b979de3) used `ns:acct`, `ns:owner` and `ns:sess`, and any leftovers
from it can never block or grant anything now.

**Legacy keys kept as they are:** `ns:sess:*` (anonymous browser sessions),
`ns:owners:*`, `ns:browser-devs:*`, `ns:blob:*`, `ns:dev:*`, `ns:net:*`,
`ns:cmd:*`, `ns:res:*`. Only one action removes legacy data: when an account
owner removes a Pi, that Pi's `ns:owners` set and its old cloud copies are
deleted.

**No migration script is needed.** The new code only adds keys.

## 3. Accounts and security

- **Passwords:** scrypt, N=2¹⁶, r=8, p=2 (equivalent to the OWASP N=2¹⁷, p=1
  setting), with a 16-byte random salt per hash. The parameters are stored in
  each hash, and older parameters are upgraded on the next login. Passwords
  must be 10–128 characters, not a common password, and must not contain the
  username. Plaintext passwords are never stored or logged (tests scan Redis
  to prove it).
- **Usernames:** 3–32 characters (`a-z 0-9 . _ -`), stored lowercase, unique,
  with reserved names blocked.
- **Sessions:**
  - The cookie is `__Host-ns_acct`: 256-bit random, `HttpOnly; Secure; SameSite=Strict; Path=/`. Only its SHA-256 is stored.
  - Sessions last 30 days (`NSIGNAGE_SESSION_DAYS`), with at most 20 per account.
  - Logout deletes the session.
  - Signing out other sessions, a password change or a recovery revokes the other sessions.
- **CSRF:** every state-changing request must have `Origin` equal to the
  site, and the cookie is SameSite=Strict. There is no CORS on the API.
- **Brute force:**
  - **Login:** 30 attempts per IP per 10 min. After 10 failed attempts on a username, that username is locked for 15 min, and a correct password is refused during the lock.
  - **Login responses:** the same error and the same scrypt work whether or not the username exists.
  - **Registration:** 5 per IP per hour (invalid attempts count too).
  - **Recovery:** 10 per IP and 5 per username per hour.
- **Password recovery without email:**
  1. **Recovery key:** 100 random bits (`XXXX-XXXX-XXXX-XXXX-XXXX`), shown once at sign-up with Copy and Download buttons. It works once; each use issues a new one, and a new one can be created in Settings (password required).
  2. **Staff-assisted:** if the key is lost too, staff verify the customer **offline** and run the admin script to issue a new key (§6).
- **Devices:**
  - Every device request checks that `ns:dev-owner:<id>` equals the logged-in user. Another account gets 404, never data.
  - The Find Pi list hides the IP of displays owned by other accounts.
  - Pis authenticate with their own random secret (hashed in Redis). A secret can't be replaced for a claimed Pi.
- **Device registration proof** (one of these is always required):
  - **Find on this Wi-Fi:** a single-use 3-minute nonce, bound to the account and the public network, re-checked at claim time. The Pi must have synced in the last 2 minutes.
  - **Pairing code:**
    - 8 characters from a 32-symbol alphabet (40 bits).
    - Valid 10 minutes, single use (`GETDEL`), one live code per Pi, stored hashed.
    - Rate limits: 10 per account and 20 per IP every 10 minutes.
    - Issued only to an authenticated, unclaimed Pi.
  - Linking an **old browser device** needs the old browser cookie **and** current proof (same Wi-Fi now, or a pairing code). Nothing is assigned automatically, and a Pi already in another account can't be taken.

## 4. Relay transfers

```
browser                         API                                   Pi (agent 1.0 / 2)
 1 check type, MIME, magic bytes
 2 SHA-256 (streamed, 4 MB slices)
 3 ── POST create {deviceId, filename, size, sha256} ─► owner? type? size ≤ limit? storage?
                                                        → transfer "created", upload path
 4 ── Blob client upload ───────────────────────────► token only for that exact path,
      (multipart > 20 MB, retried parts)                size and content type (6 h)
 5 ── POST commit {transferId, url} ────────────────► path ✓  size == declared ✓
                                                        first bytes match the format ✓
                                                        → "queued", download command
 6                                                     ◄── sync ── command {url, sha256, size}
 7                                                     ◄── result {ok, filename[, sha256, size]}
                                                        sha256 matches → completed, verified
                                                        no sha256 (agent 1.0) → completed, unverified
                                                        mismatch / error → failed (copy kept for retry)
                                                        completed → relay copy DELETED
 8 ◄── status polling: success shown only for "completed"
```

- **States:** `created` → `queued` → `completed` | `failed` (retryable) | `cancelled` | `expired`.
- **Cancel:** withdraws the queued command and deletes the copy. If the Pi had already saved the file, the transfer is reported as completed with a note.
- **Retry:**
  - If the relay copy still exists, the Pi downloads it again.
  - Otherwise the customer re-selects the file, which must have the same SHA-256, and it is uploaded again.
  - A late result from an earlier attempt is ignored. At most 5 attempts.
- **Resume, where it is possible today:**
  - Browser → relay: Blob multipart retries failed parts. After a page reload, re-selecting the same file re-uploads it (checked by checksum).
  - Relay → Pi: the command stays queued while the display is offline, and the Pi downloads it when it reconnects. Agent 1.0 restarts a broken download from the beginning; agent 2 should resume with HTTP Range.
- **Expiry and cleanup:**
  - A transfer expires 48 h after creation (`NSIGNAGE_TRANSFER_TTL_HOURS`).
  - The daily cron and every new transfer expire overdue transfers and delete their copies.
  - The cron also deletes orphan copies (uploaded but never committed) older than 2 h.
  - Old `media/` copies from the previous upload flow are deleted only with `NSIGNAGE_PURGE_LEGACY_BLOBS=1`.
- **Limits:**
  - 500 MB per file (`NSIGNAGE_MAX_UPLOAD_MB`, capped at the Pi agent 1.0 limit of 500 MB).
  - At most 50 unfinished transfers per account, and 120 new transfers per account per hour.
  - If the Pi reports free space (agent 2), files that would not fit are refused.
- **What the browser sees:** the relay URL is never sent to a browser, only to the authenticated Pi. Transfer views contain no owner ID or URL.
- **Public vs private relay** (`NSIGNAGE_BLOB_ACCESS`):
  - **public** (default, required today): agent 1.0 only downloads from `*.public.blob.vercel-storage.com`. Anyone holding the URL could read the file until it is deleted. The URL is unguessable (random 128-bit transfer ID plus a random suffix), given only to the Pi, and deleted after delivery or within 48 h.
  - **private:** needs a private Blob store **and** Pis that announce `private-blob` (agent 2). The Pi gets a presigned GET URL valid for 30 minutes on each sync. Displays without support are refused with "software update needed". Covered by tests using a stand-in Blob API, but **not tested against a real private Vercel Blob store.**
- **Previews:** previously the cloud copies of uploaded files doubled as previews. Files sent through the new flow have no cloud copy once delivered, so the hosted Media page shows a file icon for them. Thumbnails from the Pi are a possible later feature.

## 5. API reference (new or changed)

All responses are JSON, in the form `{ ok, ... }` or `{ ok:false, error, reason? }`. Every POST, PATCH and DELETE from browsers must be same-origin.

**`/api/auth?action=`**
- `me` (GET) → `{ user }` or 401 `not-logged-in`.
- `register` → `{ user, recoveryKey }`.
- `login`.
- `logout`.
- `logout-others` → `{ revokedSessions }`.
- `change-password` `{ currentPassword, newPassword }`.
- `recover` `{ username, recoveryKey, newPassword }` → `{ user, recoveryKey }`.
- `regenerate-recovery` `{ password }` → `{ recoveryKey }`.
- `session` → **410** (the anonymous sessions were retired).

**`/api/devices`**
- `GET` → `{ devices[], networkClaim }`.
- `POST {claimNonce,name?,location?}` (Find Pi claim).
- `POST ?action=pair {code,name?,location?}`.
- `GET ?action=legacy` → `{ available, devices[{deviceId,name,status,sameNetwork,pairingSupported}] }`.
- `POST ?action=link-legacy {deviceId, code?}`.
- `PATCH ?deviceId= {name?,location?}`.
- `DELETE ?deviceId=` (cancels the Pi's open transfers; media on the Pi is not deleted).
- Errors: `owned-by-other` 409, `verify-required` 403, `bad-pair-code` 400, `nonce-expired` 410, `network-changed` 403.

**`/api/transfer?action=`**
- `create` `{deviceId, filename, size, sha256}` → `{ transfer, uploadPathname, deviceOnline }`.
- `blob-token` (Vercel Blob `handleUpload`).
- `commit` `{transferId, url}`.
- `status&id=`.
- `list`.
- `cancel` `{transferId}`.
- `retry` `{transferId}` → `{ transfer, needsUpload, uploadPathname? }`.
- Errors: `unsupported-type` 415, `too-large` 413, `insufficient-storage` 507, `size-mismatch` 422, `content-mismatch` 415, `agent-update-required` 409, `too-many-transfers` 429.

**`/api/device`**
- `action=upload` → **410**.
- The `download` command was removed (it accepted any blob URL).
- Status now includes `agent_protocol`, `capabilities` and `storage`.

**`/api/pi/sync`** accepts optional protocol 2 fields. `/api/pi/pairing` is new. See the Pi contract for both.

## 6. Staff procedures

Get the production credentials once (they go into a git-ignored file):

```bash
npx vercel env pull .env.local
npm run admin -- account <username>
npm run admin -- reset-recovery <username>   # prints a NEW recovery key, signs out every session
npm run admin -- revoke-sessions <username>
npm run admin -- disable <username>          # or: enable
npm run admin -- device <deviceId>           # which account owns a Pi
npm run admin -- unlink-device <deviceId>    # ownership dispute: remove it from its account
```

**Recovery when the customer has lost the recovery key too.**

1. Verify ownership offline. At least two of:
   - the invoice or order number;
   - the device ID shown on the display or its label;
   - the business details on the contract;
   - a call-back to the phone number on file.
2. Run `reset-recovery`.
3. Give the key **by phone or in person** (never in a public channel).
4. The customer opens **Forgot password?**, enters the key and sets a new password.

Staff never see or set passwords. Every admin action prints an `[audit]` line
on stderr; keep it with the support ticket.

## 7. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes | — | Upstash Redis (set by the Vercel integration) |
| `BLOB_READ_WRITE_TOKEN` | yes, for cloud uploads | — | Vercel Blob relay store |
| `CRON_SECRET` | **yes (new)** | — | protects `/api/cron/cleanup`; Vercel sends it automatically |
| `NSIGNAGE_BLOB_ACCESS` | no | `public` | `private` only with a private store and Pis on agent 2 |
| `NSIGNAGE_MAX_UPLOAD_MB` | no | `500` | per-file limit (agent 1.0 refuses > 500 MB anyway) |
| `NSIGNAGE_TRANSFER_TTL_HOURS` | no | `48` | when unfinished transfers expire and copies are deleted |
| `NSIGNAGE_SESSION_DAYS` | no | `30` | login session lifetime (1–90) |
| `NSIGNAGE_NETWORK_CLAIM` | no | `on` | `off` = pairing codes only (once all Pis show codes) |
| `NSIGNAGE_PURGE_LEGACY_BLOBS` | no | `0` | `1` = the cron also deletes old `media/` copies from the previous flow |
| `VITE_CONNECTION_MODE` | no | auto | force `cloud` or `lan` at build time |

## 8. Deploy

```bash
npm ci
npm test                 # 30 tests: API, unmodified Pi agent 1.0, checksum/media utils
npm run lint
npm run build

# one time: cron secret (any long random value)
openssl rand -hex 32     # copy the output
npx vercel env add CRON_SECRET production

git push                 # Vercel deploys main; or: npx vercel --prod
curl https://software.nsinages.in/api/health
# {"ok":true,"redis":{...true},"blob":{"configured":true,"access":"public"},"cron":{"configured":true}}
```

**After deploying, check by hand:**
1. Create an account and save its recovery key.
2. Add a display with Find on this Wi-Fi.
3. Upload a small image and check that it shows on the display.
4. Confirm the success message appears only after the display saved the file.
5. The new **Content-Security-Policy** header (in `vercel.json`) has only been checked against the build output, not on the live domain. If the browser console shows CSP violations, remove that one header and redeploy.

**What customers notice:** the first visit after the release shows the login screen. Displays added in the old way appear under **"Displays added in this browser before accounts"** on the Devices page, in the same browser, and can be linked there (on the display's Wi-Fi).

## 9. Rollback

- **Vercel → Deployments →** previous deployment → **Promote to Production**, or `git revert <commit> && git push`.
- **Data:** the new keys use new prefixes and can stay. The old version still finds its anonymous sessions and device lists, except for Pis an account owner explicitly removed (their `ns:owners` set was deleted on purpose).
- Transfers in progress at rollback time are no longer delivered by the old version. Their copies are not deleted by the old version either. Delete `transfers/` in the Blob dashboard, or redeploy and let the cron run.
- The Pis need no change in either direction.

## 10. Test results (2026-11-05, Windows, Node 22.14, Python 3.13)

| Suite | Result | How |
|---|---|---|
| API (`tests/api.test.mjs`) | **26/26 pass** | real handlers, in-memory Upstash REST server, in-memory Blob |
| Pi agent 1.0 compatibility (`tests/legacy-agent.test.mjs`) | **1/1 pass** | the **unmodified** `cloud_agent.py` syncs over HTTP, is found, claimed, downloads a relay transfer and saves it byte-identical; the site marks it completed (unverified) and deletes the copy. Only `pwd` (Linux-only) and the HTTPS blob download were stubbed |
| Browser utilities (`tests/frontend-utils.test.mjs`) | **3/3 pass** | streaming SHA-256 equals Node's for many sizes; magic-byte checks |
| UI, cloud mode, headless **Chrome** and **Edge** | **29/29 checks pass in each** | sign-up and recovery key; Find on Wi-Fi; pairing code (wrong code rejected); upload waits, then completes only after the simulated Pi confirms; fake JPG rejected; cancel withdraws the command; legacy link; password change; old password refused; recovery from another browser signs out the first; 390 px phone width without horizontal scroll |
| UI, LAN mode (localhost, vite preview) | **6/6 checks pass** | no login; old Add Device form; LAN upload; no cloud API calls; no page errors |

The Chrome/Edge script and its local server are test scaffolding and are not
in the repository. The Vercel Blob upload was emulated in those runs, because
Playwright does not expose XHR `File` bodies. The first run therefore uploaded
0 bytes and was **rejected by the server's size check**, which is the expected
behaviour.

**Not tested:**
- a real Raspberry Pi;
- the production Vercel deployment, real Upstash and real Vercel Blob (including multipart uploads above 20 MB and private mode);
- iPhone Safari, Android Chrome and Firefox;
- files larger than 33 MB in a browser;
- the Vercel cron trigger itself;
- different real networks (mobile data vs office Wi-Fi). The design only needs both sides to reach the website over HTTPS.

**Awaiting the Pi update:**
- pairing codes on the screen;
- checksum verification on the Pi;
- download resume (HTTP Range);
- progress and storage reporting;
- private relay mode.

## 11. Known limitations

- Option A is a **relay**. Every byte goes browser → Vercel Blob → Pi, which uses the customer's upload bandwidth once and Blob transfer and storage while the copy exists. Not peer-to-peer.
- **Until Pis run agent 2:**
  - relay copies are public-access blobs with unguessable URLs (§4);
  - transfers are confirmed as saved but not checksum-verified;
  - pairing codes can't be shown, so adding a display needs the same Wi-Fi.
- **Find on this Wi-Fi limits** (unchanged from before): carrier-grade NAT and dual-WAN limits still apply. Set `NSIGNAGE_NETWORK_CLAIM=off` once every display can show a pairing code.
- **One file at a time:** the upload page sends one file per run, one display after another; each display gets its own relay copy. Multi-file selection and one shared copy for several displays are not implemented.
- **Cron:** Vercel Hobby runs it once a day. Expired copies can therefore live up to about 24 h past `NSIGNAGE_TRANSFER_TTL_HOURS`, though new transfers also trigger cleanup.
- **Accounts and status:**
  - No account deletion from the UI. Staff can disable an account.
  - The 60-second status cache in LocalStorage with an 8-hour window (from the original brief) is **not** in this phase.
  - Device status comes from the Pi's own heartbeat. A Pi is online if it synced in the last 45 s.
