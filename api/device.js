// /api/device?deviceId=<id>&action=<action> — manage a Pi through the cloud.
// Every action needs a logged-in session (cookie) whose account owns the Pi.
//
//   GET  action=status            last state reported by the Pi
//   GET  action=media             media files on the Pi (+ preview URLs)
//   POST action=command           { type: 'delete', filename } |
//                                 { type: 'download', url, filename, size }
//   GET  action=result&id=<cmd>   progress of a queued command
//   POST action=upload            Vercel Blob client-upload token exchange
import { handleUpload } from '@vercel/blob/client';
import { del } from '@vercel/blob';
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin,
  isOnline, enqueueCommand, pendingCommands, parse, MEDIA_NAME_RX, DEVICE_ID_RX,
} from './_lib/cloud.js';
import { requireOwnedDevice } from './_lib/auth.js';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime',
];
const BLOB_HOST_RX = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;

function isBlobUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && BLOB_HOST_RX.test(u.hostname);
  } catch {
    return false;
  }
}

// filename on the Pi → blob URL, for files that were uploaded through the cloud
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
    },
  };
}

async function mediaAction(device) {
  const index = await blobIndex(device.deviceId);
  const pending = (await pendingCommands(device.deviceId))
    .filter((c) => c.type === 'download')
    .map((c) => ({ name: c.filename, pending: true, size: c.size || null }));
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
      try { await del(entry.url); } catch (err) { console.warn('[N-SIGNAGE CLOUD] blob delete failed', err.message); }
    }
    return { ok: true, command: cmd };
  }
  if (body.type === 'download') {
    const filename = String(body.filename || '');
    const url = String(body.url || '');
    if (!MEDIA_NAME_RX.test(filename)) throw httpError(400, 'Unsupported file name or type');
    if (!isBlobUrl(url)) throw httpError(400, 'Invalid upload URL');
    const size = Number.isFinite(body.size) && body.size > 0 ? Math.min(body.size, MAX_UPLOAD_BYTES) : null;
    const cmd = await enqueueCommand(deviceId, { type: 'download', url, filename, size });
    await redis().hset(keys.blobs(deviceId), { [cmd.id]: JSON.stringify({ url, filename }) });
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

async function uploadAction(req, body) {
  return handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      let payload;
      try { payload = JSON.parse(clientPayload || '{}'); } catch { throw httpError(400, 'Invalid upload payload'); }
      const deviceId = String(payload.deviceId || '');
      if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
      await requireOwnedDevice(req, deviceId); // session cookie must own this Pi
      if (!pathname.startsWith(`media/${deviceId}/`)) throw httpError(400, 'Invalid upload path');
      return {
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: true,
      };
    },
  });
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    if (action === 'upload') {
      if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
      const body = readJsonBody(req);
      if (body?.type !== 'blob.generate-client-token') throw httpError(400, 'Unsupported upload event');
      requireSameOrigin(req);
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        throw httpError(503, 'Media storage is not configured. Connect a Vercel Blob store to this project.', 'blob-not-configured');
      }
      send(res, 200, await uploadAction(req, body));
      return;
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
