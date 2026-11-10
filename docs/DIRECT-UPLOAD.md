# Direct, end-to-end encrypted uploads (browser → Raspberry Pi)

The N-Signage website never stores customer images or videos, not even temporarily.
The browser encrypts each chunk for one specific Pi and sends it straight to that Pi
through a Cloudflare Tunnel. The website signs short-lived upload tickets and keeps
metadata only. Cloudflare only ever carries ciphertext. Vercel Blob is no longer used.

```
browser ──login, ticket, metadata──► software.nsinages.in (Vercel + Supabase)   no media bytes
browser ──encrypted chunks──► https://p-<16 hex>.nsinages.in ──Cloudflare Tunnel──► Pi 127.0.0.1:8090
Pi receiver ──heartbeat / check / result (device secret)──► software.nsinages.in
LAN dashboard ──multipart /api/upload──► Pi :5000                                  unchanged
```

## 1. Components

| Where | What | File |
|---|---|---|
| Website | Upload tickets (Ed25519, 15 min) | `api/_lib/tickets.js` |
| Website | Transfers, receiver records, checks | `api/_lib/transfers.js` |
| Website | Browser API: `target`, `create`, `ticket`, `status`, `list`, `cancel`, `confirm-key` | `api/transfer.js` |
| Website | Pi receiver API: `heartbeat`, `check`, `result` | `api/pi/receiver.js` |
| Website | Schema: `transfers.relay_access += 'direct'`, `epk_hash`, table `device_receivers` | `supabase/migrations/20261108000000_direct_upload.sql` |
| Browser | Encryption (WebCrypto only) | `shared/e2eCrypto.js` |
| Browser | Chunked, resumable upload | `shared/directUpload.js`, `src/api/transferApi.js` |
| Pi | Receiver (stdlib + `cryptography`), 127.0.0.1 only | `N-Signage/upload-receiver/receiver.py` |
| Pi | Services | `n-signage-upload.service` (user `ns`), `n-signage-tunnel.service` (DynamicUser) |
| Pi | Installer / rollback | `N-Signage/upload-receiver/install-upload-receiver.sh` |
| Staff | Ticket key, tunnel provisioning | `scripts/upload-keygen.mjs`, `scripts/provision-tunnel.mjs` |

The installed V2.1 cloud agent, its files, the device identity and the six existing
services are not modified. The receiver reads `data/device_identity.json` and
`data/cloud_secret` and writes only `media/` (hidden `.upload-<id>.part`, then an
atomic rename to a new name) and its own `data/upload/`.

## 2. Security design

**Keys**

| Key | Where it lives | Who can see it |
|---|---|---|
| Receiver key pair (P-256) | created on the Pi in `data/upload/receiver_key.pem` (0600, user `ns`) | private key: the Pi only. Public key: website, browser |
| Ticket signing key (Ed25519) | Vercel env `NSIGNAGE_TICKET_KEY` (Sensitive) | website only; Pis get the public key in their heartbeat |
| Browser one-time key (P-256) | in the browser's crypto engine, per transfer | public key goes to the website and the Pi |
| Chunk key (AES-256-GCM) | derived in the browser (non-extractable) and on the Pi | nobody else; never transmitted |
| Device secret | `data/cloud_secret` on the Pi (existing) | Pi; the website stores only its SHA-256 |
| Tunnel token | `/etc/n-signage-tunnel.env` (root, 0600) | Pi's `cloudflared` only |

**Key exchange.**
1. The receiver creates its key pair and announces the public key in its heartbeat,
   authenticated with the device secret. The website pins the first key it sees.
2. A different key later is stored as *pending* and not used until the owner confirms
   its fingerprint on the website.
3. The browser fetches the pinned key from the website over Vercel's TLS, so Cloudflare
   cannot swap it.
4. The chunk key is `HKDF-SHA256(ECDH(browser one-time key, receiver key), salt = transferId,
   info = "nsignage-media-v1|<deviceId>")`.
5. Chunk *i* uses IV = 8 zero bytes + uint32be(*i*). It is tamper-checked over
   `nsignage-v1|device|transfer|i|plainLen|size|sha256`, so a chunk cannot be moved,
   reordered, cut or reused in another transfer.

**What the receiver checks on every request** (CORS is not a security control here):
- **The ticket:**
  - Ed25519 signature, with a key ID from the heartbeat;
  - `v`, `iss`, audience equal to this Pi's device ID, transfer ID equal to the URL;
  - time window using the website's clock (±120 s; the Pi has no clock battery);
  - lifetime of at most 1 hour and within the transfer deadline;
  - size of at most 500 MB; chunk size from 256 KiB to 8 MiB;
  - a valid SHA-256 and a safe file name with an allowed extension;
  - SHA-256 of the `X-NS-EPK` header equals the ticket's `epk`.
- **The website, asked online:** at the first chunk and before saving, to catch cancelled,
  expired, removed or re-owned transfers.
- **The chunk:**
  - the exact next index, or an identical retry of the last one;
  - the exact length, checked before the body is read;
  - the AES-GCM tag.
- **The file:** total size and SHA-256, then O_EXCL reservation of a new name, never
  overwriting, then an atomic rename.
- **Free space:** checked against a 200 MB safety margin.
- **The origin header:** a browser `Origin` other than the website's is refused, as
  defence in depth only.

**Replay, resume, expiry**

| Case | Behaviour |
|---|---|
| Ticket replayed for another Pi or transfer | refused (audience / transfer ID) |
| Ticket replayed with another browser key | refused (epk hash) |
| Chunk replayed | identical last chunk → no-op "OK"; anything else → 409 with `nextIndex` |
| Finished transfer, any request | answers "done" with the saved name, writes nothing |
| Connection lost | the browser retries with back-off. The Pi keeps the `.part` file and its state (`data/upload/transfers/<id>.json`) |
| Page reload | the customer re-selects the file (SHA-256 checked); a new browser key and ticket; the Pi continues at `nextIndex` |
| Receiver restart | state reloaded; running SHA-256 rebuilt from the `.part`; a crash between data and state write is repaired by truncating |
| Ticket expired (15 min) | the browser renews it; the website re-checks ownership, state and expiry |
| Transfer expired (24 h) | the website refuses; the Pi deletes the `.part` and state after the deadline + 1 h, or 72 h |
| Display offline | refused before anything is sent ("Display offline", no record) |

**Website.**
- **Ownership:** every action requires the owning account, enforced in SQL and by row-level
  security. `device_receivers` has row-level security for system, device and owner.
- **Completion:** a transfer is completed only by the Pi's authenticated report, with
  matching size and SHA-256 and a valid media name. Reports are idempotent.
- **Device removal:** cancels the device's transfers and deletes its receiver record, so a
  new owner pins the key afresh.
- **No media in the database:** there is no binary column anywhere in the schema, and the
  end-to-end test checks this.

**Content security policy:** `connect-src 'self' https://*.nsinages.in`. Blob and
`vercel.com` were removed.

**Residual risks:**
- **The website serves the page code.** A compromised deployment could serve malicious
  code. Mitigations: the CSP, owner confirmation of receiver key changes, and the key
  fingerprint logged on the Pi (`journalctl -u n-signage-upload`).
- **Metadata stays visible.** Cloudflare sees ciphertext sizes and timing; the website
  sees file name, size and SHA-256.

## 3. DNS and Cloudflare

**Status (2026-11-10):** the zone is on Cloudflare (`bradley`/`marjory.ns.cloudflare.com`);
steps 1–3 are done. Before the move, `nsinages.in` was on GoDaddy DNS
(`ns51/ns52.domaincontrol.com`). Visible records were the apex `A 216.198.79.1`,
`www → vercel-dns` and `software → vercel-dns`; no MX or TXT records were found.

1. Export the full zone from GoDaddy, which includes records that are not visible from outside.
2. Add the zone to Cloudflare (Free). Recreate every record exactly, with the Vercel
   records set to **DNS only** (grey cloud).
3. Switch the nameservers at GoDaddy. The registration stays at GoDaddy. Wait for
   propagation, then check `https://software.nsinages.in/api/health`.
4. Each Pi gets a **first-level**, random hostname, `p-<16 hex>.nsinages.in`, which the
   free Universal SSL covers. A two-level name such as `x.pi.nsinages.in` would need the
   paid Advanced Certificate Manager.
5. Staff provision with `scripts/provision-tunnel.mjs`, which creates:
   - a remotely managed tunnel whose only ingress is that hostname → `http://127.0.0.1:8090`,
     with everything else 404;
   - a proxied CNAME to `<tunnel>.cfargotunnel.com`;
   - a token file.

   The Cloudflare API token needs Account › Cloudflare Tunnel › Edit and Zone › DNS › Edit,
   and lives on the staff PC only.

**Limits:**
- 100 MB per request on Free; chunks are 4 MiB.
- 125 s proxy read timeout.
- 1,000 tunnels per account.
- No documented tunnel bandwidth fee.

**Terms.** The Free/Pro/Business restriction covers *serving* video or large files to
visitors over public hostnames, including tunnels. Uploads to an origin are not mentioned.
Get written confirmation from Cloudflare before production. The encryption and ticket
design is independent of Cloudflare, so a self-hosted tunnel could replace it unchanged.

## 4. Cost

| Item | Cost |
|---|---|
| Cloudflare Free zone, tunnels, Universal SSL | $0 |
| Vercel Blob | removed (saves its storage and bandwidth) |
| Vercel, Supabase | unchanged; requests are small JSON only |
| GoDaddy registration | unchanged |
| Fallback if Cloudflare declines | a small server running our own tunnel; estimate about $5 a month |

## 5. Raspberry Pi 3B+ resources

These are **estimates** from the design; the pilot measures them.

| | Receiver | cloudflared |
|---|---|---|
| Memory | about 30 MB idle (Python + `cryptography`); peak about 60 MB with 2 chunks of 4 MiB in flight (ciphertext + plaintext) | typically 30–50 MB |
| systemd cap | `MemoryHigh=96M`, `MemoryMax=160M` | `MemoryHigh=80M`, `MemoryMax=128M` |
| CPU | AES-GCM and SHA-256 in OpenSSL on Cortex-A53, which has no ARMv8 crypto extensions: tens of MB/s per core, far above mobile upload rates | TLS to Cloudflare |
| Disk | writes at network speed, one `fsync` per 4 MiB chunk; the `.part` file needs free space equal to the file plus a 200 MB margin | none |
| Priority | `Nice=10`, best-effort I/O priority 7, so MPV playback keeps priority | `Nice=5` |

Available at inspection: 421 MB RAM and 900 MB swap free. The worst case for both
services, about 110 MB, fits. The caps prevent either service from starving the player.

## 6. Deployment plan (nothing is done until approved)

1. **Approvals:** Cloudflare's written answer on the terms; DNS move approved.
2. **DNS move** (§3), with a check that `software`, `www` and the apex still serve from Vercel.
3. **Ticket key:** run `npm run upload:keygen` and add `NSIGNAGE_TICKET_KEY` in Vercel
   (Production, Sensitive).
4. **Database:** `npm run db:setup`, which applies `20261108000000_direct_upload.sql`. It
   is additive; old transfer rows stay readable.
5. **Website release:** merge to `main` and deploy, then check `/api/health`. It should show
   `"upload": { "mode": "direct-e2e", "ticketKey": true, "mediaStoredOnWebsite": false }`.
   Cloud uploads show "Receiver service is not installed" until a Pi has the receiver (§7).
   LAN upload is unaffected.
6. **Provision one Pi** (staff PC):
   `node scripts/provision-tunnel.mjs --device <deviceId>`, then again with `--apply`.
7. **Pilot install** on that Pi:
   ```
   sudo ./install-upload-receiver.sh --dry-run --hostname p-….nsinages.in
   sudo ./install-upload-receiver.sh --hostname p-….nsinages.in < tunnel-<deviceId>.token
   sudo ./install-upload-receiver.sh --status
   ```
   Then delete the token file. The script prints the six existing services before and after.
8. **Pilot checks:**
   - `sudo ./install-upload-receiver.sh --status`: every line `OK`;
   - `curl https://p-….nsinages.in/v1/health` from outside the Pi's network;
   - Devices → **Test** and the Upload page show "Secure upload ready" for that display;
   - a small image upload ends in "Upload completed successfully", and the file is in
     `/home/ns/n-signage/media` and playing;
   - 50, 200 and 500 MB uploads from mobile data;
   - a cut connection, then resume; a receiver restart mid-upload;
   - a reboot;
   - MPV plays the new file;
   - `systemctl status` memory and `top` CPU during an upload;
   - 24 hours of tunnel stability; try `--protocol auto` (QUIC) only if HTTP/2 is unstable.
9. **Clean-up:** remove `BLOB_*` and `NSIGNAGE_BLOB_ACCESS` from Vercel and disconnect the
   Blob store. Old relay copies in the store can be deleted there.

## 7. Readiness: what each upload message means

Before anything is hashed or sent (and again on every **Retry**), the browser runs a
genuine check: the website's view of the receiver (`GET /api/transfer?action=target`,
field `status`), then its own probe `GET https://p-….nsinages.in/v1/health` through the
tunnel. The Upload page shows the result per display. On the Devices page, **Test** shows it
too. The receiver answers `/v1/health` to any origin (no secrets, no device id). The answer
carries its key fingerprint and whether the caller's origin may upload.

| Status | Message shown | Decided by | What is wrong / how to fix |
|---|---|---|---|
| `upload-not-configured` | Sending files is not available right now | website | `NSIGNAGE_TICKET_KEY` missing or invalid in Vercel |
| `no-receiver` | Receiver service is not installed | website: no heartbeat ever, no refused login | install the receiver (§6.6–6.7) |
| `receiver-auth-failed` | …installed, but the website rejected its device credentials | website: refused receiver login within 15 min (`security_events`) | `data/cloud_secret` does not match the website; check the V2.1 agent is connected, then `sudo systemctl restart n-signage-upload` |
| `key-change-pending` | This display reported a new security key | website | the owner confirms the fingerprint on the Devices page |
| `receiver-offline` | Receiver is offline: the display is online, but its secure upload service is not reporting | website: agent checks in, receiver silent > 90 s | `systemctl status n-signage-upload`, `journalctl -u n-signage-upload` |
| `display-offline` | The display is offline | website: agent and receiver both silent | power / network of the Pi |
| `tunnel-not-configured` | Cloudflare Tunnel is not configured | website: receiver reports no hostname | reinstall with `--hostname p-….nsinages.in` |
| `tunnel-down` | Cloudflare Tunnel is not connected | browser: Cloudflare answers the hostname, the receiver does not (error 1033/530/502) | `journalctl -u n-signage-tunnel` (token, outbound 7844/443), ingress must point at `http://127.0.0.1:8090` |
| `tunnel-unreachable` | The display's upload address cannot be reached from this browser | browser: nothing answers (DNS / network / timeout 8 s) | DNS CNAME missing or not proxied; customer network blocks it |
| `wrong-receiver` | …leads to a different upload service (wrong tunnel hostname) | browser: other key fingerprint or not our service | hostname/CNAME points at another tunnel or Pi; re-provision |
| `origin-mismatch` | The display only accepts uploads from the official website address | browser: `originAllowed: false` | `NSIGNAGE_UPLOAD_ORIGIN` in `/etc/n-signage-upload.env` must be `https://software.nsinages.in` |
| ticket reasons (`bad-ticket`, `ticket-expired`, `unknown-ticket-key`, `wrong-key`, …) | Upload ticket validation failed: … | receiver, during the upload | Retry (fresh ticket); persistent → Pi clock, or the key rotated (§2) |
| — | ✓ Upload completed successfully | Pi's authenticated result (size + SHA-256) | — |

Only the receiver's own heartbeat decides whether it can take a file. A briefly silent V2.1
agent does not block an upload the receiver can accept.

On the Pi, `sudo ./install-upload-receiver.sh --status` checks the same chain step by step:
installed, running, heartbeat accepted, tunnel configured, tunnel connected, public address
answering through Cloudflare.

## 8. Rollback

- **Website:** Vercel Instant Rollback to the previous deployment. The migration is
  additive, so the old code still works with the database.
- **Pi:** `sudo ./install-upload-receiver.sh --uninstall`. That stops and removes both new
  services, their environment files and the receiver code. The receiver key in
  `data/upload` is kept unless `--purge` is given. The six existing services, V2.1, LAN
  upload and media are untouched.
- **DNS:** switch the nameservers back to GoDaddy's. The original records are still in
  the GoDaddy zone export.
