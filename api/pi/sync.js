// POST /api/pi/sync — called every few seconds by cloud_agent.py on each Pi.
// Auth: `Authorization: Bearer <device secret>`. The first sync of a device id
// registers the secret; every later sync must present the same one.
import {
  redis, keys, sha256, safeEqual, clientIp, networkKey, send, handleError, httpError, readJsonBody,
  DEVICE_ID_RX, NET_TTL_S, cleanReport, getDevice, pendingCommands, completeCommands, canReplaceSecret,
} from '../_lib/cloud.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const body = readJsonBody(req);
    const deviceId = String(body.deviceId || '');
    if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');

    const auth = String(req.headers.authorization || '');
    const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (secret.length < 32 || secret.length > 200) throw httpError(401, 'Missing device secret');

    const report = cleanReport(body);
    const r = redis();
    const now = Date.now();
    const existing = await getDevice(deviceId);
    let secretHash = existing?.secretHash;
    if (existing?.secretHash && !safeEqual(existing.secretHash, sha256(secret))) {
      // A re-flashed SD card creates a new secret. Accept it only for a Pi that
      // no account owns and that has been silent for a while; owned Pis must be
      // removed from their account first (that clears the stored secret).
      const owned = Boolean(await r.get(keys.owner(deviceId)));
      if (!canReplaceSecret(existing, owned, now)) {
        throw httpError(401, 'Device secret does not match. Remove this Pi from its account on the website, then it can re-register.');
      }
      console.warn('[N-SIGNAGE CLOUD] device secret replaced for unowned device', deviceId);
      secretHash = null;
    }

    const ip = clientIp(req);
    const device = {
      deviceId,
      secretHash: secretHash || sha256(secret),
      ...report,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
    };
    await r.set(keys.device(deviceId), device);

    // Network index used by Find Pi: deviceId scored by last sync time.
    const net = networkKey(ip);
    if (net) {
      await r.zadd(keys.net(net), { score: now, member: deviceId });
      await r.zremrangebyscore(keys.net(net), 0, now - NET_TTL_S * 1000);
      await r.expire(keys.net(net), NET_TTL_S);
    }

    await completeCommands(deviceId, body.results);
    const commands = await pendingCommands(deviceId);

    send(res, 200, { ok: true, serverTime: now, commands, pollSeconds: commands.length ? 2 : 5 });
  } catch (err) {
    handleError(res, err);
  }
}
