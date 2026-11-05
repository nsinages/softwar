// POST /api/pi/pairing — a Pi asks for a one-time pairing code to show on screen.
// Auth: `Authorization: Bearer <device secret>` (the same secret as /api/pi/sync;
// the Pi must have synced at least once). Body: { deviceId }.
//
//   200 { ok, code: "ABCD-EFGH", expiresAt, ttlSeconds }
//   409 { ok:false, reason:"already-registered" }  Pi already belongs to an account
//
// Requires agent protocol 2 on the Pi (not yet released): see
// docs/PI-AGENT-V2-CONTRACT.md.
import {
  send, handleError, httpError, readJsonBody, bearerSecret, sha256, safeEqual, keyHash, DEVICE_ID_RX,
} from '../_lib/cloud.js';
import { asSystem, rateLimit } from '../_lib/db.js';
import { issuePairCode } from '../_lib/pairing.js';

async function authenticate(req, deviceId) {
  const secretHash = sha256(bearerSecret(req));
  const [d] = await asSystem((t) => t`select secret_hash, owner_id from nsignage.devices where id = ${deviceId}`);
  if (!d?.secret_hash || !safeEqual(d.secret_hash, secretHash)) {
    console.warn('[N-SIGNAGE CLOUD] pairing: device auth failed', deviceId);
    throw httpError(401, 'Device authentication failed', 'bad-device-secret');
  }
  return d;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const deviceId = String(readJsonBody(req).deviceId || '');
    if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
    // authenticate BEFORE rate limiting, so nobody can exhaust a Pi's quota by knowing its id
    const device = await authenticate(req, deviceId);
    await rateLimit('pair-issue', keyHash(deviceId), 10, 600);
    if (device.owner_id) throw httpError(409, 'This display is already registered to an account.', 'already-registered');
    const result = await asSystem(async (t) => {
      const [d] = await t`select owner_id from nsignage.devices where id = ${deviceId} for update`;
      if (d.owner_id) throw httpError(409, 'This display is already registered to an account.', 'already-registered');
      return issuePairCode(t, deviceId);
    });
    console.log('[N-SIGNAGE CLOUD] pairing code issued', JSON.stringify({ deviceId }));
    send(res, 200, { ok: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
}
