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
  send, handleError, httpError, readJsonBody, rateLimit, authenticateDevice, redis, keys,
} from '../_lib/cloud.js';
import { issuePairCode } from '../_lib/pairing.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const body = readJsonBody(req);
    const deviceId = String(body.deviceId || '');
    const device = await authenticateDevice(req, deviceId);
    await rateLimit('pair-issue', device.deviceId, 10, 600);
    if (await redis().get(keys.deviceOwner(device.deviceId))) {
      throw httpError(409, 'This display is already registered to an account.', 'already-registered');
    }
    const result = await issuePairCode(device.deviceId);
    console.log('[N-SIGNAGE CLOUD] pairing code issued', JSON.stringify({ deviceId: device.deviceId }));
    send(res, 200, { ok: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
}
