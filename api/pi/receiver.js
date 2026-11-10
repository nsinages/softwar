// POST /api/pi/receiver?action=<action> — the Pi's direct-upload receiver
// (N-Signage/upload-receiver/receiver.py, service n-signage-upload) talks to the website.
// Auth: `Authorization: Bearer <device secret>`, the SAME secret the existing cloud
// agent uses (data/cloud_secret, read-only for the receiver). The Pi must have synced.
// No media bytes ever reach this endpoint.
//
//   action=heartbeat { deviceId, publicKey, hostname, version, freeBytes }
//        → { serverTime, ticketKeys: [{kid, publicKey}], keyStatus: 'pinned'|'pending' }
//   action=check     { deviceId, transferId, size, sha256, epk, phase: 'start'|'finish' }
//        → { allowed, reason? }            online authorisation at the first chunk and before saving
//   action=result    { deviceId, transferId, ok, savedAs?, sha256?, size?, reason?, error? }
//        → { state }                        the only way a direct transfer becomes "completed"
import {
  send, handleError, httpError, readJsonBody, bearerSecret, sha256, safeEqual, keyHash, DEVICE_ID_RX,
} from '../_lib/cloud.js';
import { asSystem, asDevice, rateLimit } from '../_lib/db.js';
import { ticketPublicKeys } from '../_lib/tickets.js';
import { upsertReceiver, receiverCheck, applyReceiverResult, noteReceiverAuthFailure } from '../_lib/transfers.js';

async function authenticate(req, deviceId) {
  const secretHash = sha256(bearerSecret(req));
  const [d] = await asSystem((t) => t`select secret_hash, owner_id from nsignage.devices where id = ${deviceId}`);
  if (!d?.secret_hash || !safeEqual(d.secret_hash, secretHash)) {
    console.warn('[N-SIGNAGE UPLOAD] receiver auth failed', deviceId);
    // Remembered (at most every 10 min) only for a Pi someone owns, so its owner sees
    // "installed but authentication failed" instead of "not installed".
    if (d?.owner_id) {
      try {
        await asSystem((t) => noteReceiverAuthFailure(t, deviceId, d.secret_hash ? 'secret-mismatch' : 'not-registered'));
      } catch (err) {
        console.warn('[N-SIGNAGE UPLOAD] could not record the auth failure', err.message);
      }
    }
    throw httpError(401, 'Device authentication failed', 'bad-device-secret');
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const action = String(req.query?.action || '');
    if (!['heartbeat', 'check', 'result'].includes(action)) throw httpError(404, 'Unknown action');
    const body = readJsonBody(req);
    const deviceId = String(body.deviceId || '');
    if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
    // authenticate BEFORE rate limiting, so nobody can exhaust a Pi's quota by knowing its id
    await authenticate(req, deviceId);
    await rateLimit(`rcv-${action}`, keyHash(deviceId), action === 'heartbeat' ? 240 : 1200, 3600);

    if (action === 'heartbeat') {
      const { keyStatus } = await asDevice(deviceId, (t) => upsertReceiver(t, deviceId, body));
      return send(res, 200, { ok: true, serverTime: Date.now(), ticketKeys: ticketPublicKeys(), keyStatus });
    }
    if (action === 'check') {
      const r = await asDevice(deviceId, (t) => receiverCheck(t, deviceId, body));
      if (!r.allowed) console.warn('[N-SIGNAGE UPLOAD] receiver check denied', JSON.stringify({ deviceId, transfer: body.transferId, reason: r.reason }));
      return send(res, 200, { ok: true, ...r, serverTime: Date.now() });
    }
    const { transfer, duplicate } = await asDevice(deviceId, (t) => applyReceiverResult(t, deviceId, body));
    return send(res, 200, { ok: true, state: transfer.state, duplicate: Boolean(duplicate) });
  } catch (err) {
    handleError(res, err);
  }
}
