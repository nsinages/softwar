// /api/transfer?action=<action> — send media to a Pi DIRECTLY (browser → Pi receiver),
// end-to-end encrypted. The website never receives, stores or relays media bytes:
// it checks ownership, records metadata and signs short-lived upload tickets.
// Every action needs the logged-in customer who owns the target Pi.
//
//   GET  action=target&deviceId=   → { receiver }   Pi receiver URL, public key, online, limits
//   POST action=create   { deviceId, filename, size, sha256, epk }  → { transfer, ticket, uploadUrl, chunkBytes }
//   POST action=ticket   { transferId, epk }   new ticket (expired ticket, retry, resume with a new browser key)
//   GET  action=status&id= → { transfer }       state: created|completed|failed|cancelled|expired
//   GET  action=list     → { transfers }
//   POST action=cancel   { transferId }
//   POST action=confirm-key { deviceId, fingerprint }   owner accepts a changed receiver key
//
// epk = the browser's one-time ECDH P-256 public key (public; its hash goes into the ticket).
// "completed" is set only by the Pi's own report (api/pi/receiver.js).
import {
  send, handleError, httpError, readJsonBody, requireSameOrigin, keyHash, DEVICE_ID_RX, SAVED_ID_RX,
} from './_lib/cloud.js';
import { requireUser, withCustomer, requireOwnedDevice } from './_lib/auth.js';
import { asSystem, rateLimit } from './_lib/db.js';
import { ticketsConfigured } from './_lib/tickets.js';
import {
  createDirectTransfer, ticketFor, renewTicket, requireOwnTransfer, transferView, listTransfers, cancelTransfer,
  expireTransfers, receiverForOwner, receiverView, confirmReceiverKey, epkHash,
} from './_lib/transfers.js';

function requireTickets() {
  if (!ticketsConfigured()) {
    console.error('[N-SIGNAGE UPLOAD] NSIGNAGE_TICKET_KEY is not configured');
    throw httpError(503, 'Sending files is not available right now (upload signing is not configured on the server).', 'upload-not-configured');
  }
}

function checkDeviceId(deviceId) {
  if (SAVED_ID_RX.test(deviceId)) {
    throw httpError(409, 'This display is saved in your account but not connected yet, so files cannot be sent to it. Add it with Find IP first.', 'device-not-verified');
  }
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
}

const ticketResponse = (transfer, rc, { ticket, claims }) => ({
  ok: true, transfer: transferView(transfer), ticket, ticketExpiresAt: claims.exp * 1000,
  uploadUrl: `https://${rc.hostname}`, chunkBytes: claims.chunk,
});

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');

    if (req.method === 'GET') {
      if (!['list', 'status', 'target'].includes(action)) throw httpError(404, 'Unknown action');
      const result = await withCustomer(req, async (t, { user }) => {
        if (action === 'list') return { ok: true, transfers: await listTransfers(t, user) };
        if (action === 'status') return { ok: true, transfer: transferView(await requireOwnTransfer(t, user, req.query?.id)) };
        const deviceId = String(req.query?.deviceId || '');
        checkDeviceId(deviceId);
        const device = await requireOwnedDevice(t, user, deviceId);
        return { ok: true, receiver: receiverView(await receiverForOwner(t, deviceId), device) };
      });
      return send(res, 200, result);
    }

    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    requireSameOrigin(req);
    const body = readJsonBody(req);
    const { user } = await requireUser(req);

    if (action === 'create') {
      requireTickets();
      await rateLimit('transfer-create', keyHash(user.id), 120, 3600);
      const deviceId = String(body.deviceId || '');
      checkDeviceId(deviceId);
      try { // opportunistic cleanup; the daily cron does the rest
        await asSystem((t) => expireTransfers(t, 5));
      } catch (err) {
        console.warn('[N-SIGNAGE TRANSFER] cleanup', err.message);
      }
      const result = await withCustomer(req, async (t, { user: me }) => {
        const device = await requireOwnedDevice(t, me, deviceId);
        const rc = await receiverForOwner(t, deviceId);
        const tr = await createDirectTransfer(t, me, device, rc, body);
        return ticketResponse(tr, rc, ticketFor(tr, epkHash(body.epk)));
      });
      return send(res, 200, result);
    }

    if (action === 'ticket' || action === 'retry') {
      requireTickets();
      await rateLimit('transfer-ticket', keyHash(user.id), 600, 3600);
      const result = await withCustomer(req, async (t, { user: me }) => {
        const tr = await requireOwnTransfer(t, me, body.transferId);
        const device = await requireOwnedDevice(t, me, tr.deviceId);
        const rc = await receiverForOwner(t, tr.deviceId);
        const { transfer, ticket, claims } = await renewTicket(t, tr, device, rc, body.epk);
        return ticketResponse(transfer, rc, { ticket, claims });
      });
      return send(res, 200, result);
    }

    if (action === 'cancel') {
      const result = await withCustomer(req, async (t, { user: me }) => {
        const tr = await requireOwnTransfer(t, me, body.transferId); // allowed even if the Pi was removed meanwhile
        return { ok: true, transfer: transferView(await cancelTransfer(t, tr)) };
      });
      return send(res, 200, result);
    }

    if (action === 'confirm-key') {
      const deviceId = String(body.deviceId || '');
      checkDeviceId(deviceId);
      const result = await withCustomer(req, async (t, { user: me }) => {
        const device = await requireOwnedDevice(t, me, deviceId);
        const rc = await confirmReceiverKey(t, deviceId, String(body.fingerprint || ''));
        console.log('[N-SIGNAGE UPLOAD] receiver key confirmed', JSON.stringify({ user: me.id, deviceId }));
        return { ok: true, receiver: receiverView(rc, device) };
      });
      return send(res, 200, result);
    }

    throw httpError(404, 'Unknown action');
  } catch (err) {
    handleError(res, err);
  }
}
