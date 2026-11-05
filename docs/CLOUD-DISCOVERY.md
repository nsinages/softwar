# N-Signage — hosted website, Find Pi and Add Device

How customers find and add a Raspberry Pi from https://software.nsinages.in,
without installing anything on their phone or computer.

## 1. Why "Find Pi" returned HTTP 503

`GET /api/find` → **503 `cloud-not-configured`**. On 2026-11-05 the live site's
`/api/health` returned:

```json
{"ok":false,"redis":{"configured":false,"reachable":false},"blob":{"configured":false}}
```

The relay code was deployed, but **the Vercel project had no Upstash Redis and no
Blob store connected**. So `KV_REST_API_URL` and `KV_REST_API_TOKEN` did not
exist, and every relay call failed before it ran. The Pi was not at fault.

### Why it works on localhost but not on the website

| | Localhost (`npm run dev` / `npm start`) | Hosted (Vercel) |
|---|---|---|
| Where the server runs | On the same Wi-Fi as the Pi | In a cloud data centre |
| Discovery | Node sends a UDP broadcast to port 50500 and the Pi answers | A cloud server cannot send packets into a customer's private network |
| Talking to the Pi | `/pi-proxy` → `http://192.168.x.x:5000` | Not possible: private IPs are unreachable from the internet |

A browser cannot do this either. JavaScript cannot send UDP or mDNS. An
HTTPS page cannot call `http://192.168.x.x`, because browsers block it as
mixed content. Chrome's new Local Network Access prompt only exists in
Chromium, and Safari and Firefox have no equivalent.

## 2. Architecture (no customer install)

The Pi connects **out** to the website. The website matches the browser to
the Pi by the **public IP address** they share: same Wi-Fi → same router →
same public IP (or the same IPv6 /64).

```
 Customer phone / PC (browser)                  Raspberry Pi (customer Wi-Fi)
   │ HTTPS, login cookie                           │ cloud_agent.py, HTTPS every 5 s
   ▼                                               ▼
 ┌──────────────────── software.nsinages.in (Vercel) ────────────────────┐
 │ /api/auth      sign up, log in, log out (HttpOnly session cookie)       │
 │ /api/find      Pis that synced from the browser's public IP < 2 min ago │
 │                → each addable Pi gets a single-use 3-minute claim nonce │
 │ /api/devices   Add (nonce), rename, remove; list the account's Pis      │
 │ /api/device    status, media list, delete; uploads via Vercel Blob      │
 │ /api/pi/sync   Pi reports username, hostname, device ID, LAN IP, media; │
 │                picks up queued commands (download / delete)            │
 │ /api/health    is Redis/Blob configured? (flags only, no secrets)       │
 └───────────────┬──────────────────────────────┬────────────────────────┘
                 ▼                              ▼
         Upstash Redis                     Vercel Blob
   accounts, sessions, ownership,     uploaded media (the Pi downloads
   device state, nonces, queues       it from here)
```

LAN mode is unchanged. When you open the dashboard on `localhost` or a LAN
address, it still uses UDP discovery and `/pi-proxy`, with no login.

### Browser compatibility

The hosted flow uses only `fetch`/XHR to the site's own origin, plus a cookie.
It needs no local-network permission prompt.

| Method | Android Chrome | iPhone Safari | Windows Chrome/Edge | macOS Safari/Chrome | Firefox |
|---|---|---|---|---|---|
| UDP broadcast / mDNS from a web page | ✗ | ✗ | ✗ | ✗ | ✗ |
| HTTPS page → `http://<pi-ip>:5000` (mixed content) | ✗ | ✗ | Only with Chrome's Local Network Access prompt (new Chromium versions) | Chrome: same as Windows. Safari: ✗ | ✗ |
| Pi-hosted HTTPS bridge | ✗ needs a trusted TLS cert for a LAN IP | ✗ | ✗ | ✗ | ✗ |
| Pi setup hotspot (captive portal) | ✓ but the phone leaves the internet, so it can't log in to the site at the same time | ✓ same limit | ✓ same limit | ✓ same limit | ✓ |
| **Cloud rendezvous (implemented)** | **✓** | **✓** | **✓** | **✓** | **✓** |

## 3. One-time Vercel setup (fixes the 503)

In the Vercel project for software.nsinages.in:

1. **Storage → Create / Connect → Upstash for Redis.** Connect it to
   Production, Preview and Development. This adds `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`. The names `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` also work.
2. **Storage → Create → Blob**, with **public** access, connected to the same
   project. This adds `BLOB_READ_WRITE_TOKEN`.
3. **Deployments → Redeploy.** Environment variables only apply to new
   deployments.
4. Check the setup:
   ```bash
   curl https://software.nsinages.in/api/health
   # {"ok":true,"redis":{"configured":true,"reachable":true},"blob":{"configured":true}}
   ```

No other environment variables are needed, and there are no hard-coded secrets.

| Variable | Set by | Used for |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash integration | accounts, sessions, devices |
| `BLOB_READ_WRITE_TOKEN` | Blob store | media uploads through the cloud |
| `VITE_CONNECTION_MODE` (optional) | you | force `cloud` or `lan` at build time |

## 4. Build and deploy

```bash
npm ci
npm run lint
npm run build          # outputs dist/; Vercel runs this itself
git push               # Vercel deploys main automatically
# or with the Vercel CLI:  npx vercel --prod
```

## 5. Install the cloud agent on each Raspberry Pi (one time)

Copy the updated `N-Signage/` files to the Pi first, at least
`install-cloud-agent.sh`, `app/cloud_agent.py` and `app/device_identity.py`.
Then, in the N-Signage folder on the Pi (for example `/home/<user>/n-signage`):

```bash
cd ~/n-signage
chmod +x install-cloud-agent.sh
sudo ./install-cloud-agent.sh            # detects the Linux user and folder itself
# expect in the output:  "Connected to the cloud"
sudo ./install-cloud-agent.sh --status   # check at any time
```

The installer only adds `n-signage-cloud.service`. It does **not** change
playback, uploads, the Wi-Fi hotspot, the captive portal, Wi-Fi
auto-connection, media storage, or `n-signage-discovery.service` (UDP 50500).
The agent makes outgoing HTTPS requests only and opens no ports.

**Rollback (Pi):** `sudo ./install-cloud-agent.sh --uninstall`

## 6. Customer instructions

1. Power on the display. Wait until N-Signage shows on the screen.
2. Connect your phone or computer to **the same Wi-Fi** as the display. Turn
   off mobile data and any VPN.
3. Open **https://software.nsinages.in**, then log in or create an account.
4. Go to **Devices → Add Device**. The search starts by itself.
5. Your display appears with its name (hostname), IP address and *Online*
   status. Optionally type a display name and location, then press
   **Add Device**.
6. Done. The display stays in your account on every phone or computer you
   log in from, on any network.

## 7. Staff instructions

- **Installing for a customer:** connect the Pi to the customer's Wi-Fi, then
  run `install-cloud-agent.sh` once. Log in as the customer, or have the
  customer log in, on a phone on the same Wi-Fi. Then Devices → Add Device.
- **"No Raspberry Pi found"**
  1. On the Pi: `sudo ./install-cloud-agent.sh --status` should say
     *Connected to the cloud*.
  2. Is the phone on the same Wi-Fi, with mobile data and VPN off?
  3. Guest Wi-Fi or a different SSID can use a different public IP. Use the
     same SSID as the Pi.
  4. Check `curl https://software.nsinages.in/api/health`.
- **"Registered to another account":** each Pi belongs to one account. The
  owner must remove it (Devices → delete) before anyone else can add it.
- **Re-flashed SD card:** the Pi creates a new secret. If the Pi is in an
  account, remove it there first, then add it again. If no account owns it,
  it re-registers by itself after 10 minutes offline.
- **Debug view:** add `?debug=1` to the URL to see the discovery log.

## 8. Security

- Passwords are hashed with scrypt and a per-account salt. The session is a
  random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie, and only
  its SHA-256 is stored.
- Every request that changes data checks that its `Origin` is this website.
  There is no CORS opening; the API is same-origin only.
- Rate limits: login (10 per email and 30 per IP per 10 min), sign-up (10 per
  IP per hour), Find Pi (40 per minute), Add Device (20 per 10 min).
- Add Device needs a **single-use, 3-minute nonce**. It is bound to the
  account and the network it was found on, and only an *available* Pi gets
  one. The server checks again that the browser is still on that network and
  that the Pi is still online. Ownership is assigned atomically, so duplicates
  are impossible.
- Find Pi needs a login and only shows Pis on the caller's own network. Pis
  owned by other accounts show only their hostname and online status.
- Each Pi authenticates with its own random secret
  (`data/cloud_secret`, mode 600).
- Media downloads on the Pi are only accepted from `*.public.blob.vercel-storage.com`.
- DNS rebinding: the browser never talks to the Pi on the hosted flow, and the
  Pi's local API is unchanged. Set `NSIGNAGE_API_KEY` for LAN uploads.

## 9. Known limitations

- **Carrier-grade NAT:** some ISPs put many homes behind one public IP. Pis
  from other homes on that ISP may then appear in Find Pi. Their details are
  only visible, and they can only be added, if no one owns them yet and they
  synced within the last 2 minutes. Customers should add their Pi right after
  installing it. A future hardening step is a pairing code shown on the TV.
- **Different exits:** if the phone and the Pi reach the internet through
  different routes (dual-WAN, guest VLAN with its own IP, VPN, mobile data),
  they won't match.
- **The Pi needs internet access.** A Pi on an offline LAN can only be managed
  in LAN mode, which needs a computer on that LAN running `npm start`.
- **Uploads go through the cloud** (Vercel Blob). Large videos use the
  customer's upload bandwidth twice: once to the cloud, then down to the Pi.

## 10. Rollback (website)

```bash
git revert <commit>      # then push; Vercel redeploys
```

Or, in Vercel → Deployments, pick the previous deployment → **Promote to
Production**. Data in Redis is namespaced `ns:*` and can stay. The old builds
ignore it.

## 11. Tests

Run on 2026-11-05 on Windows, against the real handlers and a local Upstash-compatible server:

- API end-to-end, 67 checks: the 503 reproduced, then sync, accounts, Find Pi,
  nonces, duplicates, cross-account isolation, persistence, commands, uploads,
  re-flash, offline/expiry, rate limiting.
- UI in headless **Chrome 156** and **Edge**, 19 checks each: sign up, Find Pi
  auto-start with progress, discovery, Add Device, refresh, logout/login,
  duplicate, media list, phone width (390 px) without horizontal scroll.
- The real `cloud_agent.py` synced with the new API and appeared in Find Pi.

**Not yet run:** the real Pi (it was unreachable from the test machine),
iPhone Safari, Android Chrome, macOS, and the production Vercel deployment.
Run those with the checklist in the hand-off notes.
