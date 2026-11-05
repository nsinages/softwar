// POST /api/pi/sync — called every few seconds by cloud_agent.py on each Pi.
// Auth: `Authorization: Bearer <device secret>`. The first sync of a device id
// registers the secret; every later sync must present the same one.
//
// Body (agent 1.0): { deviceId, username, hostname, localIp, port, media,
//                     agentVersion, results }
// Optional (agent protocol 2, see docs/PI-AGENT-V2-CONTRACT.md):
//                   { protocol: 2, capabilities: [...], storage: { freeBytes, totalBytes },
//                     progress: [{ transferId, receivedBytes }] }
// Response: { ok, serverTime, commands, pollSeconds }
import {
  redis, keys, sha256, safeEqual, clientIp, networkKey, send, handleError, httpError, readJsonBody,
  DEVICE_ID_RX, NET_TTL_S, cleanReport, getDevice, pendingCommands, completeCommands, canReplaceSecret,
  isDeviceClaimed, bearerSecret,
} from '../_lib/cloud.js';
import { applyTransferResults, applyTransferProgress, prepareCommandsForDevice } from '../_lib/transfers.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const body = readJsonBody(req);
    const deviceId = String(body.deviceId || '');
    if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
    const secret = bearerSecret(req);

    const report = cleanReport(body);
    const r = redis();
    const now = Date.now();
    const existing = await getDevice(deviceId);
    let secretHash = existing?.secretHash;
    if (existing?.secretHash && !safeEqual(existing.secretHash, sha256(secret))) {
      // A re-flashed SD card creates a new secret. Accept it only for a Pi that
      // no account (or legacy browser) has claimed and that has been silent for
      // a while; otherwise its owner must remove it first (that clears the secret).
      const owned = await isDeviceClaimed(deviceId);
      if (!canReplaceSecret(existing, owned, now)) {
        console.warn('[N-SIGNAGE CLOUD] sync rejected: secret mismatch', deviceId);
        throw httpError(401, 'Device secret does not match. Remove this Pi on the website (Devices → delete), then it can re-register.');
      }
      console.warn('[N-SIGNAGE CLOUD] device secret replaced for an unclaimed Pi', deviceId);
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

    const results = await completeCommands(deviceId, body.results);
    await applyTransferResults(deviceId, results);
    await applyTransferProgress(deviceId, body.progress);
    const commands = await prepareCommandsForDevice(deviceId, await pendingCommands(deviceId));

    send(res, 200, { ok: true, serverTime: now, commands, pollSeconds: commands.length ? 2 : 5 });
  } catch (err) {
    handleError(res, err);
  }
}
