// /api/transfer?action=<action> — send media to a Pi through the cloud relay.
// This is a relay-based transfer (browser → Vercel Blob → Pi), not peer-to-peer.
// Every action needs a logged-in customer who owns the target Pi.
// Metadata: Supabase nsignage.transfers / device_commands. Media: Blob only, temporarily.
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
  send, handleError, httpError, readJsonBody, requireSameOrigin, isOnline, keyHash, DEVICE_ID_RX,
} from './_lib/cloud.js';
import { requireUser, withCustomer, requireOwnedDevice } from './_lib/auth.js';
import { asSystem, rateLimit } from './_lib/db.js';
import { blobConfigured } from './_lib/blobStore.js';
import {
  createTransfer, uploadTokenOptions, uploadPathname, verifyUploadedCopy, commitTransfer, requireOwnTransfer, transferView,
  listTransfers, cancelTransfer, retryTransfer, expireTransfers, deleteRelayCopies,
} from './_lib/transfers.js';

function requireBlob() {
  if (!blobConfigured()) {
    throw httpError(503, 'Media transfer storage is not configured. Connect a Vercel Blob store to this project.', 'blob-not-configured');
  }
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');

    if (req.method === 'GET') {
      if (action !== 'list' && action !== 'status') throw httpError(404, 'Unknown action');
      const result = await withCustomer(req, async (t, { user }) => {
        if (action === 'list') return { ok: true, transfers: await listTransfers(t, user) };
        return { ok: true, transfer: transferView(await requireOwnTransfer(t, user, req.query?.id)) };
      });
      return send(res, 200, result);
    }

    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    requireSameOrigin(req);
    const body = readJsonBody(req);
    const { user } = await requireUser(req);
    let urls = [];

    if (action === 'create') {
      requireBlob();
      await rateLimit('transfer-create', keyHash(user.id), 120, 3600);
      const deviceId = String(body.deviceId || '');
      if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
      // Opportunistic cleanup of a few overdue transfers (the daily cron does the rest)
      try {
        const expired = await asSystem((t) => expireTransfers(t, 5));
        await deleteRelayCopies(expired.deleteAfterCommit);
      } catch (err) {
        console.warn('[N-SIGNAGE TRANSFER] cleanup', err.message);
      }
      const result = await withCustomer(req, async (t, { user: me }) => {
        const device = await requireOwnedDevice(t, me, deviceId);
        const tr = await createTransfer(t, me, device, body);
        return { ok: true, transfer: transferView(tr), uploadPathname: uploadPathname(tr), deviceOnline: isOnline(device) };
      });
      return send(res, 200, result);
    }

    if (action === 'blob-token') {
      requireBlob();
      if (body?.type !== 'blob.generate-client-token') throw httpError(400, 'Unsupported upload event');
      await rateLimit('transfer-token', keyHash(user.id), 300, 3600);
      const out = await handleUpload({
        request: req,
        body,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          let payload;
          try { payload = JSON.parse(clientPayload || '{}'); } catch { throw httpError(400, 'Invalid upload payload'); }
          return withCustomer(req, async (t, { user: me }) => {
            const tr = await requireOwnTransfer(t, me, payload.transferId);
            await requireOwnedDevice(t, me, tr.deviceId);
            return uploadTokenOptions(tr, pathname);
          });
        },
        // No onUploadCompleted webhook: completion is confirmed by action=commit
      });
      return send(res, 200, out);
    }

    if (action === 'retry') await rateLimit('transfer-retry', keyHash(user.id), 60, 3600);

    // Commit: check the relay copy (Blob network calls) with NO database transaction open
    let verifiedPath = null;
    if (action === 'commit') {
      requireBlob();
      const tr = await withCustomer(req, (t, { user: me }) => requireOwnTransfer(t, me, body.transferId));
      verifiedPath = await verifyUploadedCopy(tr, body.url);
    }

    const result = await withCustomer(req, async (t, { user: me }) => {
      const tr = await requireOwnTransfer(t, me, body.transferId);
      if (action === 'commit') {
        const device = await requireOwnedDevice(t, me, tr.deviceId);
        const { transfer, deleteAfterCommit } = await commitTransfer(t, tr, body.url, verifiedPath);
        urls = deleteAfterCommit;
        return { ok: true, transfer: transferView(transfer), deviceOnline: isOnline(device) };
      }
      if (action === 'cancel') {
        // allowed even if the Pi was removed in the meantime
        const { transfer, deleteAfterCommit } = await cancelTransfer(t, tr);
        urls = deleteAfterCommit;
        return { ok: true, transfer: transferView(transfer) };
      }
      if (action === 'retry') {
        await requireOwnedDevice(t, me, tr.deviceId);
        const { transfer, needsUpload } = await retryTransfer(t, tr);
        return { ok: true, transfer: transferView(transfer), needsUpload, ...(needsUpload && { uploadPathname: uploadPathname(transfer) }) };
      }
      throw httpError(404, 'Unknown action');
    });
    if (urls.length) await deleteRelayCopies(urls); // after the commit
    send(res, 200, result);
  } catch (err) {
    handleError(res, err);
  }
}

