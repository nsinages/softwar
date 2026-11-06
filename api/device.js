// /api/device?deviceId=<id>&action=<action> — manage a Pi through the cloud.
// Every action needs the logged-in customer account that owns the Pi
// (checked in SQL and enforced again by RLS in the 'user' context).
//
//   GET  action=status            last state reported by the Pi (heartbeat)
//   GET  action=media             media files the Pi reports it has (+ legacy preview URLs)
//   POST action=command           { type: 'delete', filename }
//   GET  action=result&id=<cmd>   progress of a queued command
//
// Uploads use /api/transfer (checksums, cancel/retry, relay copy deleted after delivery).
import {
  send, handleError, httpError, readJsonBody, requireSameOrigin, isOnline, MEDIA_NAME_RX,
} from './_lib/cloud.js';
import { withCustomer, requireOwnedDevice } from './_lib/auth.js';
import { setContext } from './_lib/db.js';
import { deleteRelayCopies } from './_lib/transfers.js';

const CMD_ID_RX = /^[0-9a-f-]{36}$/i;

function statusAction(device) {
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

async function mediaAction(t, device) {
  const pending = await t`
    select payload->>'filename' as name, (payload->>'size')::bigint as size, transfer_id
    from nsignage.device_commands
    where device_id = ${device.deviceId} and state = 'queued' and type = 'download'
    order by created_at`;
  // Previews only exist for files sent by the OLD flow (kept copies); new transfers keep none.
  await setContext(t, 'system');
  const legacy = await t`select filename, url from nsignage.legacy_relay_copies
                         where device_id = ${device.deviceId} and deleted_at is null and filename is not null`;
  const previews = Object.fromEntries(legacy.map((l) => [l.filename, l.url]));
  const media = (device.media || []).map((m) => ({ ...m, url: previews[m.name] || null }));
  return {
    ok: true,
    online: isOnline(device),
    media,
    pending: pending.map((p) => ({ name: p.name, pending: true, size: p.size || null, transferId: p.transfer_id || null })),
  };
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    if (action === 'upload') {
      throw httpError(410, 'Uploads now use /api/transfer. Please reload the page.', 'use-transfer-api');
    }
    const deviceId = String(req.query?.deviceId || '');
    if (req.method === 'POST') requireSameOrigin(req);
    let urls = [];

    const result = await withCustomer(req, async (t, { user }) => {
      const device = await requireOwnedDevice(t, user, deviceId, { allowSaved: true });
      if (device.registration === 'saved') {
        // Saved by the customer (name + IP) but no Pi has confirmed it: nothing to report or control yet
        const notConnected = 'Saved in your account, but this display is not connected yet. Add it with "Find on this Wi-Fi" or its pairing code to verify it.';
        if (req.method === 'GET' && action === 'status') {
          return { ok: false, saved: true, online: false, lastSeen: null, error: notConnected, data: { status: 'unknown', ip: device.localIp, hostname: device.hostname } };
        }
        if (req.method === 'GET' && action === 'media') return { ok: true, saved: true, online: false, media: [], pending: [], message: notConnected };
        throw httpError(409, notConnected, 'device-not-verified');
      }
      if (req.method === 'GET' && action === 'status') return statusAction(device);
      if (req.method === 'GET' && action === 'media') return mediaAction(t, device);
      if (req.method === 'GET' && action === 'result') {
        const id = String(req.query?.id || '');
        if (!CMD_ID_RX.test(id)) throw httpError(400, 'Invalid command id');
        const [c] = await t`select state, error, result, created_at, completed_at from nsignage.device_commands
                            where id = ${id} and device_id = ${deviceId}`;
        if (!c) throw httpError(404, 'Command not found');
        const state = c.state === 'withdrawn' ? 'failed' : c.state;
        return { ok: true, online: isOnline(device), result: { state, error: c.error || undefined, filename: c.result?.filename, at: (c.completed_at || c.created_at).getTime() } };
      }
      if (req.method === 'POST' && action === 'command') {
        const body = readJsonBody(req);
        if (body.type !== 'delete') throw httpError(400, 'Unknown command');
        const filename = String(body.filename || '');
        if (!MEDIA_NAME_RX.test(filename)) throw httpError(400, 'Invalid filename');
        // RLS (commands_owner) only allows commands for the customer's own Pi
        const [cmd] = await t`insert into nsignage.device_commands (device_id, type, payload)
                              values (${deviceId}, 'delete', ${t.json({ filename })}) returning id, created_at`;
        // Remove the old cloud copy too, if this file came through the pre-transfer flow
        await setContext(t, 'system');
        urls = (await t`select url from nsignage.legacy_relay_copies
                        where device_id = ${deviceId} and filename = ${filename} and deleted_at is null`).map((r) => r.url);
        return { ok: true, command: { id: cmd.id, type: 'delete', filename, createdAt: cmd.created_at.getTime() } };
      }
      throw httpError(404, 'Unknown action');
    });
    if (urls.length) await deleteRelayCopies(urls);
    send(res, 200, result);
  } catch (err) {
    handleError(res, err);
  }
}
