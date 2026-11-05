// GET /api/find[?identifier=<pi-username>]
//
// Cloud replacement for LAN discovery. Returns the Raspberry Pis that synced
// with the cloud in the last 2 minutes from the SAME public network as this
// browser (same Wi-Fi → same router → same public IP / IPv6 /64).
//
// - Needs a logged-in customer account.
// - The username is optional; when given it only filters the results.
// - Each Pi that no account owns yet gets a single-use, 3-minute claim nonce
//   bound to this account and this network (stored hashed in
//   nsignage.claim_nonces). POST /api/devices needs it, so a Pi can only be
//   added right after it was found from its own network.
// - ownership: 'mine' (this account) | 'other' (another account) | 'available'.
import {
  clientIp, networkKey, send, handleError, httpError, keyHash, sha256, randomToken,
  USERNAME_RX, NEARBY_WINDOW_MS, publicView, networkClaimEnabled, deviceFromRow,
} from './_lib/cloud.js';
import { requireUser, withCustomer } from './_lib/auth.js';
import { setContext, rateLimit } from './_lib/db.js';

const NONCE_TTL_S = 180;

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    const { user } = await requireUser(req);
    await rateLimit('find', keyHash(user.id), 40, 60);

    const identifier = String(req.query?.identifier || '').trim();
    if (identifier && !USERNAME_RX.test(identifier)) {
      send(res, 400, { found: false, reason: 'invalid-identifier', error: 'Pi username may only contain letters, numbers, "_", "." or "-".' });
      return;
    }

    const started = Date.now();
    const net = networkKey(clientIp(req));
    if (!net) throw httpError(400, 'Could not determine your network address.', 'no-network');
    const claimAllowed = networkClaimEnabled();

    const { devices, nearby } = await withCustomer(req, async (t, { user: me }) => {
      // Looking at Pis this customer does not own yet: system context, limited columns returned
      await setContext(t, 'system');
      const rows = await t`
        select d.*
        from nsignage.device_network_sightings s join nsignage.devices d on d.id = s.device_id
        where s.net_key = ${net} and s.seen_at > now() - make_interval(secs => ${NEARBY_WINDOW_MS / 1000})
        order by s.seen_at desc
        limit 50`;
      const now = Date.now();
      const out = [];
      for (const r of rows) {
        const d = deviceFromRow(r);
        if (identifier && d.username.toLowerCase() !== identifier.toLowerCase()) continue;
        const ownership = d.ownerId === me.id ? 'mine' : d.ownerId ? 'other' : 'available';
        const view = { ...publicView(d, now), ownership };
        if (ownership === 'other') { delete view.ip; delete view.storage; } // nothing about other customers' Pis beyond identity
        if (ownership === 'available' && claimAllowed) {
          const nonce = randomToken();
          await t`insert into nsignage.claim_nonces (nonce_hash, user_id, device_id, net_key, expires_at)
                  values (${sha256(nonce)}, ${me.id}, ${d.deviceId}, ${net}, now() + make_interval(secs => ${NONCE_TTL_S}))`;
          view.claimNonce = nonce;
          view.claimExpiresAt = now + NONCE_TTL_S * 1000;
        }
        out.push(view);
      }
      await t`delete from nsignage.claim_nonces where expires_at < now()`; // keep the table small
      return { devices: out, nearby: rows.length };
    });

    const rank = { available: 0, mine: 1, other: 2 };
    devices.sort((a, b) => (rank[a.ownership] - rank[b.ownership]) || (b.online - a.online) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
    console.log('[N-SIGNAGE CLOUD] find', JSON.stringify({ user: user.id, filtered: Boolean(identifier), nearby, returned: devices.length }));

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
        `${nearby} Pi(s) synced from this network in the last ${NEARBY_WINDOW_MS / 60000} min, ${devices.length} listed`,
      ],
    });
  } catch (err) {
    handleError(res, err);
  }
}
