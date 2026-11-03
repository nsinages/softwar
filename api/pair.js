// POST /api/pair { deviceId, username }
// Pairs this browser with a Pi it found on the same network and returns a
// control token. The browser sends that token (X-Device-Token) on every
// later request, so the Pi can then be managed from anywhere.
import {
  redis, keys, clientIp, sameNetwork, send, handleError, httpError, readJsonBody,
  getDevice, randomToken, sha256, NEARBY_IP_WINDOW_MS, publicView,
} from './_lib/cloud.js';

const MAX_CONTROLLERS = 50;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const { deviceId, username } = readJsonBody(req);
    const device = await getDevice(String(deviceId || ''));
    if (!device || typeof username !== 'string' || device.username.toLowerCase() !== username.trim().toLowerCase()) {
      throw httpError(404, 'Raspberry Pi not found. Use Find Pi first.');
    }

    const ip = clientIp(req);
    const now = Date.now();
    const nearby = Object.entries(device.publicIps || {}).some(
      ([pip, t]) => now - t < NEARBY_IP_WINDOW_MS && sameNetwork(pip, ip)
    );
    if (!nearby) {
      throw httpError(403, 'To add this Raspberry Pi, connect this computer or phone to the same Wi-Fi network as the Pi.');
    }

    const r = redis();
    if ((await r.scard(keys.controllers(device.deviceId))) >= MAX_CONTROLLERS) {
      throw httpError(409, 'Too many browsers are paired with this Raspberry Pi.');
    }
    const token = randomToken();
    await r.sadd(keys.controllers(device.deviceId), sha256(token));

    send(res, 200, { ok: true, token, device: publicView(device, now) });
  } catch (err) {
    handleError(res, err);
  }
}
