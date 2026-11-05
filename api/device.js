// /api/device?deviceId=<id>&action=<action> — manage a Pi through the cloud.
// Every action needs the logged-in customer account that owns the Pi.
//
//   GET  action=status            last state reported by the Pi (heartbeat every ~5 s)
//   GET  action=media             media files the Pi reports it has (+ legacy preview URLs)
//   POST action=command           { type: 'delete', filename }
//   GET  action=result&id=<cmd>   progress of a queued command
//
// Uploads moved to /api/transfer (checksums, cancel/retry, relay copy deleted
// after delivery). The old "download any blob URL" command was removed.
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin,
  isOnline, enqueueCommand, pendingCommands, parse, MEDIA_NAME_RX,
} from './_lib/cloud.js';
import { requireOwnedDevice } from './_lib/auth.js';
import { safeDelete } from './_lib/blobStore.js';

// filename on the Pi → blob URL, for files uploaded by the OLD cloud flow
// (before transfers). New transfers keep no cloud copy once delivered.
async function blobIndex(deviceId) {
  const r = redis();
  const [blobs, results] = await Promise.all([
    r.hgetall(keys.blobs(deviceId)),
    r.hgetall(keys.results(deviceId)),
  ]);
  const byName = {};
  for (const [cmdId, raw] of Object.entries(blobs || {})) {
    const b = parse(raw);
    const result = results?.[cmdId] ? parse(results[cmdId]) : null;
    const name = result?.state === 'done' && result.filename ? result.filename : null;
    if (name) byName[name] = { cmdId, url: b.url };
  }
  return byName;
}

async function statusAction(device) {
  const online = isOnline(device);
  return {
    ok: online,
    online,
    lastSeen: device.lastSeen,
    error: online ? undefined : 'The Raspberry Pi has not connected to the cloud recently. Check that it is powered on and has internet access.',
    data: {
      status: online ? 'online' : 'offline',
      pi_username: device.username,
      hostname: device.hostname,
      ip: device.localIp,
      device_id: device.deviceId,
      current_media: device.currentMedia || undefined,
      media_count: device.media?.length ?? 0,
      agent_version: device.agentVersion,
      agent_protocol: device.protocol || 1,
      capabilities: device.capabilities || [],
      storage: device.storage || null,
    },
  };
}

async function mediaAction(device) {
  const index = await blobIndex(device.deviceId);
  const pending = (await pendingCommands(device.deviceId))
    .filter((c) => c.type === 'download')
    .map((c) => ({ name: c.filename, pending: true, size: c.size || null, transferId: c.transferId || null }));
  const media = (device.media || []).map((m) => ({ ...m, url: index[m.name]?.url || null }));
  return { ok: true, online: isOnline(device), media, pending };
}

async function commandAction(device, body) {
  const deviceId = device.deviceId;
  if (body.type === 'delete') {
    const filename = String(body.filename || '');
    if (!MEDIA_NAME_RX.test(filename)) throw httpError(400, 'Invalid filename');
    const cmd = await enqueueCommand(deviceId, { type: 'delete', filename });
    // Remove the cloud copy too, if this file came through the cloud
    const entry = (await blobIndex(deviceId))[filename];
    if (entry) {
      await redis().hdel(keys.blobs(deviceId), entry.cmdId);
      await safeDelete(entry.url);
    }
    return { ok: true, command: cmd };
  }
  throw httpError(400, 'Unknown command');
}

async function resultAction(device, id) {
  if (typeof id !== 'string' || id.length > 64) throw httpError(400, 'Invalid command id');
  const raw = await redis().hget(keys.results(device.deviceId), id);
  if (!raw) throw httpError(404, 'Command not found');
  return { ok: true, online: isOnline(device), result: parse(raw) };
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    if (action === 'upload') {
      throw httpError(410, 'Uploads now use /api/transfer. Please reload the page.', 'use-transfer-api');
    }

    const deviceId = String(req.query?.deviceId || '');
    const { device } = await requireOwnedDevice(req, deviceId);

    if (req.method === 'GET' && action === 'status') return send(res, 200, await statusAction(device));
    if (req.method === 'GET' && action === 'media') return send(res, 200, await mediaAction(device));
    if (req.method === 'GET' && action === 'result') return send(res, 200, await resultAction(device, req.query?.id));
    if (req.method === 'POST' && action === 'command') {
      requireSameOrigin(req);
      return send(res, 200, await commandAction(device, readJsonBody(req)));
    }
    throw httpError(404, 'Unknown action');
  } catch (err) {
    handleError(res, err);
  }
}
