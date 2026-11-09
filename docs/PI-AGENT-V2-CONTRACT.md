# Pi cloud agent — protocol 2 contract (next phase, Pi side)

**Status:**
- The website side is implemented and tested against a simulated protocol-2 Pi.
- **Agent 2.2 (`N-Signage/app/cloud_agent.py`) implements protocol 2:**
  `sha256`, `range-resume`, `progress`, `storage` and `private-blob`.
  **Pairing codes are switched off** (`PAIRING_ENABLED = False`): customers add a
  display with Add Device → Pi Name → Find IP on the same Wi-Fi. The website's
  pairing endpoints remain only for rollback and are not offered in the UI.
  It is tested end to end against the website, the real `@vercel/blob` SDK and a
  stand-in for the Vercel Blob API (`tests/blob-relay.test.mjs`), with unit tests in
  `tests/helpers/test_cloud_agent_v2.py`. Not yet run on a real Pi. See §4b.
- Agent 1.1 (Phase 4) implemented §4 pairing codes only (`capabilities: ["pairing"]`).
- **Installed MPV-based Pis** (`/home/ns/n-signage`) run their own self-contained agent
  2.0-ns1 ("V2.1"; unchanged reference copy in `N-Signage/mpv-agent/cloud_agent_v2.1.py`).
  It stays as it is. **Media no longer travels through sync at all**: the website sends no
  download commands. Files go from the browser, end-to-end encrypted, to the separate
  upload receiver (`N-Signage/upload-receiver/`, see [DIRECT-UPLOAD.md](DIRECT-UPLOAD.md)).
  The private-Blob agent 2.2-ns1 prepared earlier is withdrawn.
- Pis running agent 1.0 keep working unchanged (tested with a frozen copy of
  the released 1.0 agent in `tests/fixtures/agent-1.0/`).

Everything below is additive. A Pi announces `protocol: 2` plus the
capabilities it really implements, and the website uses only those.

## 1. Sync request: additional fields

`POST /api/pi/sync`, `Authorization: Bearer <device secret>` (unchanged).

```json
{
  "deviceId": "…", "username": "…", "hostname": "…", "localIp": "…", "port": 5000,
  "media": [{ "name": "promo.mp4", "size": 1234, "type": "video" }],
  "agentVersion": "2.0",
  "results": [ … see §3 … ],

  "protocol": 2,
  "capabilities": ["sha256", "range-resume", "progress", "storage", "pairing", "private-blob"],
  "storage": { "freeBytes": 12884901888, "totalBytes": 31914983424 },
  "progress": [{ "transferId": "ptMHZ-BuXPuzjnjLjk1wPw", "receivedBytes": 52428800 }]
}
```

| Capability | Meaning, and what the Pi must do |
|---|---|
| `sha256` | Verify the SHA-256 of every download against `command.sha256` before saving, and report `sha256` + `size` in the result. Without it, transfers show "not checksum-verified". |
| `range-resume` | Resume an interrupted download with `Range: bytes=<n>-` from the partial temp file. |
| `progress` | Send `progress` for downloads in progress (at most once per sync). |
| `storage` | Send `storage` (free and total bytes of the filesystem holding `media/`). The website then refuses files that would not fit (leaving a 200 MB margin). |
| `pairing` | Implements §4 (pairing code on screen). Needed so the website can offer "pairing code" to link old devices. |
| `private-blob` | Accepts download URLs on `*.private.blob.vercel-storage.com` (presigned, valid 30 min; may change on every sync). Required before the site can use `NSIGNAGE_BLOB_ACCESS=private`. |

Unknown capability strings are ignored by the server. Announce a capability only
when it is fully implemented: the website relies on it (for example, a Pi that
announces `sha256` must report `sha256` + `size` with every successful download, or
the result is rejected as `unverified-result`).

## 2. Download command (already sent today)

```json
{ "id": "uuid", "type": "download", "transferId": "22 chars",
  "url": "https://<store>.public.blob.vercel-storage.com/transfers/<deviceId>/<transferId>/promo-<suffix>.mp4",
  "filename": "promo.mp4", "size": 52428800, "sha256": "64 hex", "createdAt": 1762000000000 }
```

Required behaviour (protocol 2):

1. **Validate before downloading.**
   - Allowed URL hosts:
     - `*.public.blob.vercel-storage.com`;
     - plus `*.private.blob.vercel-storage.com` only if `private-blob` is announced.
   - Other checks:
     - HTTPS with certificate validation;
     - the extension is in `config.ALLOWED_EXTENSIONS`;
     - `size` ≤ the agent's maximum;
     - `size` ≤ free space minus a margin, otherwise report `reason: "insufficient-storage"`.
2. **Temporary file:** `media/.transfer-<transferId>.part`. Hidden, so the player and `list_media()` ignore it. Never use a name taken from the URL.
3. **Stream** to the temp file in 1 MB chunks, hashing (SHA-256) while writing. Never hold the whole file in RAM.
4. **Resume** (`range-resume`):
   - If the `.part` file exists, re-hash what is already there, then request `Range: bytes=<len>-`.
   - If the server ignores the Range header (200 instead of 206), start over.
5. **Verify:** the byte count equals `size` and the SHA-256 equals `sha256`. On a mismatch, delete the temp file and report `ok:false, reason:"checksum-mismatch"`.
6. **Atomic placement:**
   - Reserve the final name with `O_CREAT|O_EXCL` (as `unique_target()` does today, e.g. `promo_1.mp4`), then `os.replace(temp, final)` and `chmod 0644`.
   - Same filesystem, so the move is atomic.
   - A partial file is never visible under a media name.
7. **Player refresh:** none needed. `display.js` re-reads `/api/media` on its poll interval, and the file appears once it is in `media/`. (Optional: an `inotify` hook can be added later.)
8. **Report** in the next sync (§3).
9. **Clean up `.transfer-*.part` files:**
   - files older than 72 h, removed at agent start and every hour;
   - files for transfers the cloud no longer lists, once no download is running.

Delete command (unchanged): `{ "type": "delete", "filename": "…" }`. Resolve
the name strictly inside `media/` (as `resolve_media_file()` does today), and
treat "already gone" as success.

## 3. Results

```json
{ "id": "<command id>", "ok": true,  "filename": "promo_1.mp4", "sha256": "<64 hex>", "size": 52428800 }
{ "id": "<command id>", "ok": false, "error": "No space left on the SD card", "reason": "insufficient-storage" }
```

| `reason` | When |
|---|---|
| `checksum-mismatch` | hash differs after download |
| `size-mismatch` | byte count differs |
| `insufficient-storage` | not enough free space |
| `download-failed` | network or HTTP error after retries |
| `unsupported-type` | extension not allowed |
| `untrusted-url` | host, port, scheme, redirect target or URL path not allowed |
| `too-large` | `size` above the agent's limit |
| `unverified-result` | (set by the website) a `sha256`-capable Pi reported success without `sha256` + `size` |
| `bad-filename` | (set by the website) the reported saved name is not a media name with the transfer's extension |

The website marks a transfer **completed** only on `ok: true`. With `sha256`
it shows "checksum verified". If the reported `sha256` or `size` differs from
the transfer, the website marks it **failed** and keeps the relay copy for
Retry.

## 4. Pairing codes

`POST /api/pi/pairing`, `Authorization: Bearer <device secret>`, body `{ "deviceId": "…" }`.

```json
200 { "ok": true, "code": "K7QM-3XPA", "expiresAt": 1762000600000, "ttlSeconds": 600 }
409 { "ok": false, "reason": "already-registered" }   → this display already belongs to an account
401                                                   → secret wrong / Pi never synced
429                                                   → more than 10 codes in 10 minutes
```

**Pi behaviour:**
- **When to request a code:**
  - while the display is not registered (after a 409, show "Registered");
  - when a local button or setup-screen action asks for one;
  - otherwise at most once per 10 minutes, refreshing shortly before `expiresAt`.
- **Showing it:** on the signage screen (a non-intrusive overlay, or the setup screen when there is no media) and on the V3 setup portal. Use large characters with the dash. Never log it at INFO level.
- **Codes are not Pi secrets:** the server invalidates the previous code whenever a new one is issued, and a code is single use.

## 4a. Agent 1.1: what changed on the Pi, and how to update one

The sync response now also carries `registered: true|false` (whether the Pi
belongs to an account). Agent 1.0 ignores it.

| File (in `/home/nsignage/n-signage`) | Change |
|---|---|
| `app/cloud_agent.py` | Version 1.1. Sends `capabilities: ["pairing"]`. While `registered` is false, fetches a code from `/api/pi/pairing` (refreshed 60 s before expiry; retries 60 s after an error, 300 s after HTTP 429) and writes `data/pairing.json` atomically (mode 600). When `registered` is true, overwrites it with `{"state":"registered"}`. If the website does not send `registered` (older website), it does nothing. The code is never logged. |
| `app/app.py` | New `GET /api/pairing`. It answers **only 127.0.0.1 / ::1** (the kiosk browser); every other address gets 403. No CORS header, `Cache-Control: no-store`, and expired codes are never returned. No other route changed. |
| `templates/display.html`, `static/js/display.js`, `static/css/display.css` | A pairing-code overlay polls `/api/pairing` every 10 s, in a separate script block from the playlist code. It shows a small corner card over playing media, and a large card when nothing is playing. Any error just hides it. |

Not touched: uploads, media API, playback logic, UDP discovery, the systemd units, the installer, and Wi-Fi onboarding.

**Update a Pi:**
1. Copy the five files above.
2. Run `sudo systemctl restart n-signage.service n-signage-cloud.service`.
3. Reload the kiosk browser, or reboot.
4. Expect the log line "New pairing code shown on the display" from `journalctl -u n-signage-cloud`.

**Rollback:** copy back the 1.0 versions of the five files and restart the same two services. The website keeps working with 1.0.

## 4b. Agent 2.2: download rules as implemented

- **Trusted URLs only:**
  - `https` on port 443, no user info;
  - host `*.public.blob.vercel-storage.com`, or `*.private.blob.vercel-storage.com` (with `private-blob`);
  - the path must be `/transfers/<deviceId>/<transferId>/…` of this command.
- **Redirects:** every redirect target must pass the same check (at most 3), else `untrusted-url`.
- **Credentials:** the Pi never gets a storage credential. Private URLs are presigned and expire after 30 minutes. A `403` is treated as an expired URL: the agent keeps the `.part` and resumes with the fresh URL from the next sync.
- **Transient failures:** network errors, `403`, `429` and `5xx` are retried up to 5 times locally before `download-failed` is reported. `404`/`410` (copy gone) is final.
- **Duplicates:** `data/cloud_transfers.json` remembers the last 500 saved transfers (`transferId` → name, size, SHA-256). A repeated command re-hashes the saved file and reports it again instead of downloading a second copy. Different transfers with the same name become `promo.mp4`, `promo_1.mp4`, …
- **Cleanup of temp files:**
  - failed checksums, oversize data and insufficient storage remove the `.part` file;
  - interrupted downloads keep it for resume;
  - `.part` files are removed after 72 h, or 1 h after the cloud stops listing the transfer.
- **Website side:** a late success of a superseded attempt completes the transfer and withdraws the newer command. Repeated reports of the same command are ignored. The relay copy is deleted only after a verified success.

## 5. Device identity (recommended hardening)

Today `device_id` = SHA-256 of the CPU serial (16 hex), and the secret is
**trust on first use**. Someone who knows a Pi's serial could register its ID
before the real Pi first connects. That only blocks the real Pi; it gives no
access to it. Recommended for agent 2:

- Generate an Ed25519 key pair on first start (`data/device_key`, mode 600).
- For new installs, derive the device ID from the public key.
- Sign each sync request: timestamp + nonce + body hash, with 60 s replay protection on the server.
- Keep the Bearer secret during the transition. Never use one secret shared by all Pis.

This needs a matching server change and is **not** implemented yet.

## 6. Tests the Pi update must pass

1. Agent 2 against the website:
   - completed **verified**;
   - corrupted download → `checksum-mismatch`, temp file removed;
   - kill the agent mid-download → restart → resumes with Range → verified;
   - full disk → `insufficient-storage`;
   - two transfers with the same name → `promo.mp4` and `promo_1.mp4`;
   - no `.part` file ever appears in `/api/media` or in the playlist.
2. Pairing: a code appears on screen, the customer adds the display from mobile data, the code can't be reused, and an expired code is rejected.
3. V2 player, the LAN `/api/upload`, and V3 Wi-Fi onboarding / hotspot / captive portal still work. Agent 2 must not touch them.
4. Agent 1.0 Pis keep working against the same website.
