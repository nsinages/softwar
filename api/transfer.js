// /api/transfer?action=<action> — send media to a Pi through the cloud relay.
// This is a relay-based transfer (browser → Vercel Blob → Pi), not peer-to-peer.
// Every action needs a logged-in customer who owns the target Pi.
//
//   POST action=create      { deviceId, filename, size, sha256 }  → { transfer, uploadPathname }
//   POST action=blob-token  Vercel Blob client-upload token exchange (handleUpload)
//   POST action=commit      { transferId, url }   upload finished → size + content check → queued for the Pi
//   GET  action=status&id=  → { transfer }        state: created|queued|completed|failed|cancelled|expired
//   GET  action=list        → { transfers }       this account's recent transfers
//   POST action=cancel      { transferId }
//   POST action=retry       { transferId }        → { transfer, needsUpload, uploadPathname? }
//
// A transfer is "completed" only after the Pi reports that it saved the file.
import { handleUpload } from '@vercel/blob/client';
import {
  send, handleError, httpError, readJsonBody, requireSameOrigin, rateLimit, isOnline, DEVICE_ID_RX,
} from './_lib/cloud.js';
import { requireUser, requireOwnedDevice } from './_lib/auth.js';
import { blobConfigured } from './_lib/blobStore.js';
import {
  createTransfer, uploadTokenOptions, uploadPathname, commitTransfer, requireOwnTransfer, transferView,
  transferProgress, listTransfers, cancelTransfer, retryTransfer, expireTransfers,
} from './_lib/transfers.js';

function requireBlob() {
  if (!blobConfigured()) {
    throw httpError(503, 'Media transfer storage is not configured. Connect a Vercel Blob store to this project.', 'blob-not-configured');
  }
}

/** Transfer of this customer whose Pi is still registered to them. */
async function ownTransferAndDevice(req, user, transferId) {
  const t = await requireOwnTransfer(user, transferId);
  const { device } = await requireOwnedDevice(req, t.deviceId);
  return { t, device };
}

async function create(req, user) {
  requireBlob();
  await rateLimit('transfer-create', user.id, 120, 3600);
  const body = readJsonBody(req);
  const deviceId = String(body.deviceId || '');
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
  const { device } = await requireOwnedDevice(req, deviceId);
  // Opportunistic cleanup (the daily cron does the rest)
  try { await expireTransfers({ limit: 5 }); } catch (err) { console.warn('[N-SIGNAGE TRANSFER] cleanup', err.message); }
  const t = await createTransfer(user, device, body);
  return {
    ok: true,
    transfer: transferView(t),
    uploadPathname: uploadPathname(t),
    deviceOnline: isOnline(device),
  };
}

async function blobToken(req, user) {
  requireBlob();
  const body = readJsonBody(req);
  if (body?.type !== 'blob.generate-client-token') throw httpError(400, 'Unsupported upload event');
  await rateLimit('transfer-token', user.id, 300, 3600);
  return handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      let payload;
      try { payload = JSON.parse(clientPayload || '{}'); } catch { throw httpError(400, 'Invalid upload payload'); }
      const { t } = await ownTransferAndDevice(req, user, payload.transferId);
      return uploadTokenOptions(user, pathname, t.id);
    },
    // No onUploadCompleted webhook: completion is confirmed by action=commit
  });
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    const { user } = await requireUser(req);

    if (req.method === 'GET') {
      if (action === 'list') return send(res, 200, { ok: true, transfers: await listTransfers(user) });
      if (action === 'status') {
        const t = await requireOwnTransfer(user, req.query?.id);
        const progress = t.state === 'queued' ? await transferProgress(t) : null;
        return send(res, 200, { ok: true, transfer: transferView(t, progress) });
      }
      throw httpError(404, 'Unknown action');
    }

    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    requireSameOrigin(req);
    if (action === 'create') return send(res, 200, await create(req, user));
    if (action === 'blob-token') return send(res, 200, await blobToken(req, user));

    const body = readJsonBody(req);
    if (action === 'commit') {
      requireBlob();
      const { t, device } = await ownTransferAndDevice(req, user, body.transferId);
      await commitTransfer(t, device, body.url);
      return send(res, 200, { ok: true, transfer: transferView(t), deviceOnline: isOnline(device) });
    }
    if (action === 'cancel') {
      const t = await requireOwnTransfer(user, body.transferId); // allowed even if the Pi was removed
      await cancelTransfer(t);
      return send(res, 200, { ok: true, transfer: transferView(t) });
    }
    if (action === 'retry') {
      const { t } = await ownTransferAndDevice(req, user, body.transferId);
      await rateLimit('transfer-retry', user.id, 60, 3600);
      const { needsUpload } = await retryTransfer(t);
      return send(res, 200, {
        ok: true, transfer: transferView(t), needsUpload, ...(needsUpload && { uploadPathname: uploadPathname(t) }),
      });
    }
    throw httpError(404, 'Unknown action');
  } catch (err) {
    handleError(res, err);
  }
}
