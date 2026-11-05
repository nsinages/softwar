# N-Signage V2 — Management Dashboard

Web dashboard for managing Raspberry Pi digital-signage displays on a local network:
register Pis (with LAN discovery), monitor status, browse/delete media, and upload
images/videos to one or many displays.

The Raspberry Pi side (Flask API + fullscreen player) lives in [`N-Signage/`](N-Signage/).

## Architecture

```
Browser ──► N-Signage V2 server (this repo, Node)          ──► Raspberry Pi (Flask, :5000)
            ├─ /                 built React app (dist/)
            ├─ /pi-proxy/<ip>/<port>/api|media/...  ─────────►  /api/status, /api/media, /api/upload, /media/<file>
            └─ /discovery-api/find?identifier=<user>  (UDP broadcast + mDNS on the LAN)
```

The dashboard server **must run on a machine on the same network as the Pis**
(browsers cannot reach LAN devices across origins or do discovery themselves).
Device list and settings are stored in each browser's `localStorage`.

## Hosted website (cloud relay) — software.nsinages.in

A website hosted on the internet (Vercel) can never connect to a Pi on a
customer's Wi-Fi, and browsers cannot do UDP/mDNS discovery. When the site is
opened from a public domain it switches to **cloud mode** automatically:
customers log in, every Pi connects *out* to the website, and "Find Pi" lists
the Pis that synced from the customer's own network (same public IP).

```
Pi (cloud_agent.py) ──every 5 s──►  POST /api/pi/sync   ◄── queued commands (download / delete)
Browser ──► /api/auth     log in / create account (HttpOnly session cookie)
        ──► /api/find     Pis on the SAME Wi-Fi as the browser (no username needed)
        ──► /api/devices  Add Device (single-use nonce) / rename / remove — stored in the account
        ──► /api/device   status, media list, delete; uploads go to Vercel Blob, the Pi downloads them
```

A Pi can only be **added** from a phone or computer on the same Wi-Fi as the
Pi. After that it can be managed from anywhere, on any device the customer
logs in from.

**Setup, Pi install, customer/staff instructions, security and limitations:**
see [docs/CLOUD-DISCOVERY.md](docs/CLOUD-DISCOVERY.md).

Quick version:

1. Vercel → Storage: connect **Upstash Redis** and a **public Blob** store, redeploy.
   `curl https://software.nsinages.in/api/health` → `"ok":true`.
2. On each Pi, in the N-Signage folder: `sudo ./install-cloud-agent.sh`
   (detects the Linux user and folder; `--uninstall` to roll back).

## Requirements

- Node.js 20.19+ (dashboard server)
- Python 3.9+ on each Raspberry Pi (see `N-Signage/README.md`)

## Production deployment

```bash
npm ci
npm run build
PORT=8080 npm start          # serves http://<this-machine-ip>:8080
```

Environment variables for `npm start`:

| Variable | Default   | Purpose                  |
|----------|-----------|--------------------------|
| `PORT`   | `8080`    | HTTP port                |
| `HOST`   | `0.0.0.0` | Bind address             |

Run it under a process manager (systemd, pm2, NSSM on Windows) so it restarts on boot.

### Securing uploads and deletes (strongly recommended)

1. On every Pi, create `/etc/n-signage.env` (owner root, mode 600):
   ```
   NSIGNAGE_API_KEY=<long random string, e.g. output of: openssl rand -hex 32>
   ```
   then `sudo systemctl restart n-signage.service`.
2. In the dashboard open **Settings → Security → Pi API Key**, enter the same key, and save.

Without a key, anyone on the network can upload or delete media on the Pis
(the Pi logs a warning at startup).

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (same proxy + discovery as production)
npm run lint
```

## Security notes

- `/pi-proxy` only forwards to local-network IPv4 addresses (never loopback,
  `169.254.x.x` or public internet) and only to `/api/*` and `/media/*`.
- The production server sends CSP, `X-Frame-Options: DENY`, `nosniff` and
  `Referrer-Policy` headers.
- The dashboard itself has no login. Expose it only on a trusted LAN — never
  directly to the internet. Put it behind a VPN or an authenticating reverse
  proxy if remote access is needed.
