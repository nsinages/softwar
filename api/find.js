// GET /api/find[?identifier=<pi-username>]
//
// Cloud replacement for LAN discovery. Returns the Raspberry Pis that synced
// with the cloud in the last 2 minutes from the SAME public network as this
// browser (same Wi-Fi → same router → same public IP / IPv6 /64).
//
// - Login required (no anonymous network scanning).
// - The username is optional; when given it only filters the results.
// - Pis owned by another account are shown without any private details.
// - Each Pi that can be added gets a single-use, 3-minute claim nonce that is
//   bound to this account and this network. POST /api/devices needs it, so a
//   Pi can only be added right after it was found from its own network.
import {
  redis, keys, clientIp, networkKey, send, handleError, httpError, rateLimit,
  USERNAME_RX, NEARBY_WINDOW_MS, publicView, randomToken,
} from './_lib/cloud.js';
import { requireAccount } from './_lib/auth.js';

const NONCE_TTL_S = 180;

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    const account = await requireAccount(req);
    await rateLimit('find', account.id, 40, 60);

    const identifier = String(req.query?.identifier || '').trim();
    if (identifier && !USERNAME_RX.test(identifier)) {
      send(res, 400, { found: false, reason: 'invalid-identifier', error: 'Pi username may only contain letters, numbers, "_", "." or "-".' });
      return;
    }

    const started = Date.now();
    const ip = clientIp(req);
    const net = networkKey(ip);
    if (!net) throw httpError(400, 'Could not determine your network address.', 'no-network');

    const r = redis();
    const now = Date.now();
    const ids = (await r.zrange(keys.net(net), now - NEARBY_WINDOW_MS, '+inf', { byScore: true })) || [];
    const unique = [...new Set(ids)].slice(0, 50);
    const [records, owners] = unique.length
      ? await Promise.all([r.mget(...unique.map(keys.device)), r.mget(...unique.map(keys.owner))])
      : [[], []];

    const devices = [];
    for (let i = 0; i < unique.length; i += 1) {
      const d = records[i];
      if (!d) continue;
      if (identifier && d.username.toLowerCase() !== identifier.toLowerCase()) continue;
      const owner = owners[i];
      if (owner && owner !== account.id) {
        // Someone else's Pi: say it exists (helps support), reveal nothing private.
        devices.push({ deviceId: d.deviceId, hostname: d.hostname || null, online: publicView(d, now).online, ownership: 'other' });
        continue;
      }
      const view = { ...publicView(d, now), ownership: owner === account.id ? 'mine' : 'available' };
      if (view.ownership === 'available') {
        const nonce = randomToken();
        await r.set(keys.nonce(nonce), { accountId: account.id, deviceId: d.deviceId, net }, { ex: NONCE_TTL_S });
        view.claimNonce = nonce;
        view.claimExpiresAt = now + NONCE_TTL_S * 1000;
      }
      devices.push(view);
    }

    const rank = { available: 0, mine: 1, other: 2 };
    devices.sort((a, b) => (rank[a.ownership] - rank[b.ownership]) || (b.online - a.online) || ((b.lastSeen || 0) - (a.lastSeen || 0)));

    console.log('[N-SIGNAGE CLOUD] find', JSON.stringify({
      account: account.id, filtered: Boolean(identifier), nearby: unique.length, returned: devices.length,
    }));

    const found = devices.some((d) => d.ownership !== 'other');
    const single = devices.length === 1 && devices[0].ownership !== 'other' ? devices[0] : null;
    send(res, 200, {
      found,
      identifier: identifier || null,
      reason: found ? undefined : devices.length ? 'only-other-accounts' : 'not-found',
      multiple: devices.length > 1,
      devices,
      ...(single || {}),
      durationMs: Date.now() - started,
      log: [
        `Cloud lookup${identifier ? ` for "${identifier}"` : ''} on network ${net.includes(':') ? 'IPv6 /64' : 'IPv4'}`,
        `${unique.length} Pi(s) synced from this network in the last ${NEARBY_WINDOW_MS / 60000} min, ${devices.length} listed`,
      ],
    });
  } catch (err) {
    handleError(res, err);
  }
}
