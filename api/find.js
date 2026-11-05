// GET /api/find[?identifier=<pi-username>]
//
// Cloud replacement for LAN discovery. Returns the Raspberry Pis that synced
// with the cloud in the last 2 minutes from the SAME public network as this
// browser (same Wi-Fi → same router → same public IP / IPv6 /64).
//
// - Needs a logged-in customer account.
// - The username is optional; when given it only filters the results.
// - Each Pi that no account owns yet gets a single-use, 3-minute claim nonce
//   bound to this account and this network. POST /api/devices needs it, so a
//   Pi can only be added right after it was found from its own network.
// - ownership: 'mine' (this account) | 'other' (another account) | 'available'.
import {
  redis, keys, clientIp, networkKey, send, handleError, httpError, rateLimit,
  USERNAME_RX, NEARBY_WINDOW_MS, publicView, randomToken, networkClaimEnabled,
} from './_lib/cloud.js';
import { requireUser } from './_lib/auth.js';

const NONCE_TTL_S = 180;

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    const { user } = await requireUser(req);
    await rateLimit('find', user.id, 40, 60);

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
    const records = unique.length ? await r.mget(...unique.map(keys.device)) : [];
    const owners = unique.length ? await r.mget(...unique.map(keys.deviceOwner)) : [];
    const claimAllowed = networkClaimEnabled();

    const devices = [];
    for (let i = 0; i < unique.length; i += 1) {
      const d = records[i];
      if (!d) continue;
      if (identifier && d.username.toLowerCase() !== identifier.toLowerCase()) continue;
      const owner = owners[i] ? String(owners[i]) : null;
      const ownership = owner === user.id ? 'mine' : owner ? 'other' : 'available';
      const view = { ...publicView(d, now), ownership };
      if (ownership === 'other') { delete view.ip; delete view.storage; } // nothing about other customers' Pis beyond identity
      if (ownership === 'available' && claimAllowed) {
        const nonce = randomToken();
        await r.set(keys.nonce(nonce), { userId: user.id, deviceId: d.deviceId, net }, { ex: NONCE_TTL_S });
        view.claimNonce = nonce;
        view.claimExpiresAt = now + NONCE_TTL_S * 1000;
      }
      devices.push(view);
    }

    const rank = { available: 0, mine: 1, other: 2 };
    devices.sort((a, b) => (rank[a.ownership] - rank[b.ownership]) || (b.online - a.online) || ((b.lastSeen || 0) - (a.lastSeen || 0)));

    console.log('[N-SIGNAGE CLOUD] find', JSON.stringify({
      user: user.id, filtered: Boolean(identifier), nearby: unique.length, returned: devices.length,
    }));

    const found = devices.length > 0;
    const single = devices.length === 1 ? devices[0] : null;
    send(res, 200, {
      found,
      networkClaim: claimAllowed,
      identifier: identifier || null,
      reason: found ? undefined : 'not-found',
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
