// GET /api/find?identifier=<pi-username>
// Cloud replacement for LAN discovery: returns Pis with this Linux username
// that recently synced from the SAME network (same public IP) as the browser.
import {
  redis, keys, clientIp, sameNetwork, send, handleError, httpError,
  USERNAME_RX, NEARBY_IP_WINDOW_MS, publicView,
} from './_lib/cloud.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    const identifier = String(req.query?.identifier || '').trim();
    if (!USERNAME_RX.test(identifier)) {
      send(res, 400, { found: false, reason: 'invalid-identifier', error: 'Enter the Pi\'s Linux username (letters, numbers, "_", "." or "-"), e.g. ns.' });
      return;
    }

    const started = Date.now();
    const ip = clientIp(req);
    const r = redis();
    const ids = (await r.smembers(keys.user(identifier))) || [];
    const records = ids.length ? await r.mget(...ids.map(keys.device)) : [];
    const now = Date.now();

    const all = records.filter(Boolean);
    const nearby = all.filter((d) =>
      Object.entries(d.publicIps || {}).some(([pip, t]) => now - t < NEARBY_IP_WINDOW_MS && sameNetwork(pip, ip))
    );
    const devices = nearby
      .map((d) => publicView(d, now))
      .sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));

    const log = [
      `Cloud lookup for "${identifier}" from ${ip || 'unknown IP'}`,
      `${all.length} Pi(s) registered with this username, ${devices.length} on your network`,
    ];

    if (devices.length === 0) {
      send(res, 200, {
        found: false,
        identifier,
        reason: all.length > 0 ? 'other-network' : 'not-found',
        devices: [],
        durationMs: Date.now() - started,
        log,
      });
      return;
    }

    const single = devices.length === 1 ? devices[0] : null;
    send(res, 200, {
      found: true,
      identifier,
      multiple: devices.length > 1,
      devices,
      ...(single || {}),
      durationMs: Date.now() - started,
      log,
    });
  } catch (err) {
    handleError(res, err);
  }
}
