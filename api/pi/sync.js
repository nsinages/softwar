// POST /api/pi/sync — called every few seconds by cloud_agent.py on each Pi.
// Auth: `Authorization: Bearer <device secret>`. The first sync of a device id
// registers the secret; every later sync must present the same one.
import {
  redis, keys, sha256, safeEqual, clientIp, send, handleError, httpError, readJsonBody,
  DEVICE_ID_RX, NEARBY_IP_WINDOW_MS, cleanReport, getDevice, pendingCommands, completeCommands,
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
    if (existing && !safeEqual(existing.secretHash, sha256(secret))) {
      throw httpError(401, 'Device secret does not match. Reset the device in the cloud to re-register it.');
    }

    // Remember recent public IPs (IPv4 and IPv6) so a browser on the same
    // network can find and pair with this Pi.
    const ip = clientIp(req);
    const publicIps = {};
    for (const [k, t] of Object.entries(existing?.publicIps || {})) {
      if (now - t < NEARBY_IP_WINDOW_MS) publicIps[k] = t;
    }
    if (ip) publicIps[ip] = now;

    const device = {
      deviceId,
      secretHash: existing?.secretHash || sha256(secret),
      ...report,
      publicIps,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
    };

    if (existing && existing.username.toLowerCase() !== report.username.toLowerCase()) {
      await r.srem(keys.user(existing.username), deviceId);
    }
    await r.set(keys.device(deviceId), device);
    await r.sadd(keys.user(report.username), deviceId);

    await completeCommands(deviceId, body.results);
    const commands = await pendingCommands(deviceId);

    send(res, 200, { ok: true, serverTime: now, commands, pollSeconds: commands.length ? 2 : 5 });
  } catch (err) {
    handleError(res, err);
  }
}
