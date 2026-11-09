// =============================================
// N Signage — direct, end-to-end encrypted transfers (browser → Pi)
//
//   browser ──(ticket from website)──► Pi upload receiver (Cloudflare Tunnel)
//
// The website NEVER stores or relays media bytes, not even temporarily. It
// keeps metadata only (nsignage.transfers) and signs short-lived upload
// tickets. The browser encrypts every chunk with a key derived from the Pi's
// receiver public key (ECDH P-256 + HKDF-SHA256 → AES-256-GCM); the website
// and Cloudflare only ever see public keys and ciphertext.
//
//   created ──Pi reports verified file──► completed
//      │  └──Pi reports an error──► failed ──new ticket (resume)──► created
//      ├──cancel──► cancelled          (the Pi is refused at its next check)
//      └──past expires_at──► expired   (same)
//
// "completed" is set only from the Pi's own authenticated report, after it
// checked size and SHA-256; never from the browser's word.
// =============================================
import crypto from 'node:crypto';
import { httpError, MEDIA_NAME_RX, isOnline } from './cloud.js';
import { ms } from './db.js';
import { signTicket } from './tickets.js';
import { mediaTypeOf, extOf, safeMediaName, DEFAULT_MAX_UPLOAD_MB } from '../../shared/mediaTypes.js';

const MiB = 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(1, Math.min(Number(process.env.NSIGNAGE_MAX_UPLOAD_MB) || DEFAULT_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB)) * MiB;
export const TRANSFER_TTL_S = Math.max(1, Number(process.env.NSIGNAGE_TRANSFER_TTL_HOURS) || 24) * 3600;
export const CHUNK_BYTES = 4 * MiB;                 // plaintext per chunk (Cloudflare Free allows 100 MB per request)
export const RECEIVER_ONLINE_MS = 90_000;           // the receiver heartbeats every 30 s
const MAX_ACTIVE_PER_USER = 50;
const STORAGE_MARGIN = 200 * MiB;

const TRANSFER_ID_RX = /^[A-Za-z0-9_-]{22}$/;
const SHA256_RX = /^[a-f0-9]{64}$/;
const EPK_RX = /^[A-Za-z0-9_-]{87}$/;               // 65-byte uncompressed P-256 point, base64url
export const FINAL_STATES = ['completed', 'cancelled', 'expired'];
export const isFinal = (tr) => FINAL_STATES.includes(tr.state);

const newTransferId = () => crypto.randomBytes(16).toString('base64url');
export const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Receiver hostnames: first-level labels on our zone (free Universal SSL), e.g. p-0123456789abcdef.nsinages.in */
const receiverDomain = () => String(process.env.NSIGNAGE_RECEIVER_DOMAIN || 'nsinages.in').toLowerCase();
export function validReceiverHostname(h) {
  const host = String(h || '').toLowerCase();
  const domain = receiverDomain();
  return host.endsWith(`.${domain}`) && /^p-[a-f0-9]{16}$/.test(host.slice(0, -(domain.length + 1)));
}

/** A browser one-time ECDH public key (raw uncompressed P-256 point, base64url) → its SHA-256, or throws. */
export function epkHash(epk) {
  const s = String(epk || '');
  if (!EPK_RX.test(s)) throw httpError(400, 'Invalid encryption key', 'bad-key');
  const raw = Buffer.from(s, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04) throw httpError(400, 'Invalid encryption key', 'bad-key');
  return sha256hex(raw);
}

/** A receiver public key → its fingerprint (SHA-256 of the raw point), or null when invalid. */
export function receiverKeyFingerprint(pub) {
  const s = String(pub || '');
  if (!EPK_RX.test(s)) return null;
  const raw = Buffer.from(s, 'base64url');
  return raw.length === 65 && raw[0] === 0x04 ? sha256hex(raw) : null;
}

// ---- Records -------------------------------------------------------------------

export function transferFromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id,
    filename: r.filename,
    originalName: r.original_name,
    size: r.size_bytes,
    sha256: r.sha256,
    contentType: r.content_type,
    kind: r.kind,
    method: r.relay_access === 'direct' ? 'direct' : 'relay',
    epkHash: r.epk_hash || null,
    state: r.state,
    attempts: r.attempts,
    error: r.error,
    reason: r.reason,
    savedAs: r.saved_as,
    verified: r.verified,
    verification: r.verification,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    expiresAt: ms(r.expires_at),
    completedAt: ms(r.completed_at),
  };
}

/** What the browser may see: metadata only (never a key, an owner id or any URL). */
export function transferView(tr) {
  return {
    id: tr.id,
    deviceId: tr.deviceId,
    filename: tr.filename,
    size: tr.size,
    sha256: tr.sha256,
    contentType: tr.contentType,
    kind: tr.kind,
    method: tr.method,
    state: tr.state,
    stage: tr.state === 'created' ? 'uploading' : tr.state,
    createdAt: tr.createdAt,
    updatedAt: tr.updatedAt,
    expiresAt: tr.expiresAt,
    attempts: tr.attempts || 0,
    error: tr.error || null,
    reason: tr.reason || null,
    savedAs: tr.savedAs || null,
    verified: Boolean(tr.verified),
    verification: tr.verification || null,
    completedAt: tr.completedAt || null,
  };
}

/** A transfer of this customer (RLS context 'user'), locked for update. */
export async function requireOwnTransfer(t, user, id) {
  if (!TRANSFER_ID_RX.test(String(id || ''))) throw httpError(404, 'Transfer not found', 'no-transfer');
  const [r] = await t`select * from nsignage.transfers where id = ${id} and user_id = ${user.id} for update`;
  if (!r) throw httpError(404, 'Transfer not found', 'no-transfer');
  return transferFromRow(r);
}

async function update(t, id, fields) {
  const [r] = await t`update nsignage.transfers set ${t(fields)} where id = ${id} returning *`;
  return transferFromRow(r);
}

// ---- Receivers (the Pi side of a direct upload) --------------------------------

export function receiverFromRow(r) {
  if (!r) return null;
  return {
    deviceId: r.device_id,
    publicKey: r.public_key,
    fingerprint: r.key_fingerprint,
    pendingPublicKey: r.pending_public_key || null,
    pendingFingerprint: r.pending_fingerprint || null,
    hostname: r.hostname || null,
    version: r.receiver_version || null,
    freeBytes: r.free_bytes ?? null,
    lastSeen: ms(r.last_seen_at),
  };
}

export const receiverOnline = (rc, now = Date.now()) => Boolean(rc?.lastSeen && now - rc.lastSeen < RECEIVER_ONLINE_MS && rc.hostname);

/** What the browser needs to encrypt for and reach the Pi (public data only). */
export function receiverView(rc, device, now = Date.now()) {
  if (!rc) return { available: false, online: false, reason: 'no-receiver' };
  return {
    available: true,
    online: isOnline(device, now) && receiverOnline(rc, now),
    url: rc.hostname ? `https://${rc.hostname}` : null,
    publicKey: rc.publicKey,
    fingerprint: rc.fingerprint,
    keyChangePending: Boolean(rc.pendingPublicKey),
    pendingFingerprint: rc.pendingFingerprint,
    version: rc.version,
    freeBytes: rc.freeBytes,
    maxBytes: MAX_UPLOAD_BYTES,
    chunkBytes: CHUNK_BYTES,
  };
}

/** The receiver of a Pi this customer owns (RLS 'user' context), or null. */
export async function receiverForOwner(t, deviceId) {
  const [r] = await t`select * from nsignage.device_receivers where device_id = ${deviceId}`;
  return receiverFromRow(r);
}

/**
 * Receiver heartbeat (RLS 'device' context). The first public key is pinned;
 * a different key is only stored as "pending" until the owner confirms it.
 */
export async function upsertReceiver(t, deviceId, body) {
  const fp = receiverKeyFingerprint(body.publicKey);
  if (!fp) throw httpError(400, 'Invalid receiver public key', 'bad-key');
  const hostname = body.hostname ? String(body.hostname).toLowerCase() : null;
  if (hostname && !validReceiverHostname(hostname)) throw httpError(400, 'Invalid receiver hostname', 'bad-hostname');
  const version = typeof body.version === 'string' ? body.version.slice(0, 20) : null;
  const freeBytes = Number.isSafeInteger(body.freeBytes) && body.freeBytes >= 0 ? body.freeBytes : null;
  const [cur] = await t`select * from nsignage.device_receivers where device_id = ${deviceId} for update`;
  if (!cur) {
    await t`insert into nsignage.device_receivers (device_id, public_key, key_fingerprint, hostname, receiver_version, free_bytes)
            values (${deviceId}, ${body.publicKey}, ${fp}, ${hostname}, ${version}, ${freeBytes})`;
    return { keyStatus: 'pinned' };
  }
  if (cur.public_key === body.publicKey) {
    await t`update nsignage.device_receivers set hostname = ${hostname}, receiver_version = ${version}, free_bytes = ${freeBytes},
              last_seen_at = now(), pending_public_key = null, pending_fingerprint = null, pending_since = null
            where device_id = ${deviceId}`;
    return { keyStatus: 'pinned' };
  }
  // Different key: never used until the owner confirms it on the website
  await t`update nsignage.device_receivers set hostname = ${hostname}, receiver_version = ${version}, free_bytes = ${freeBytes},
            last_seen_at = now(), pending_public_key = ${body.publicKey}, pending_fingerprint = ${fp},
            pending_since = case when pending_public_key is distinct from ${body.publicKey} then now() else pending_since end
          where device_id = ${deviceId}`;
  return { keyStatus: 'pending' };
}

/** The owner accepts a changed receiver key (RLS 'user' context). */
export async function confirmReceiverKey(t, deviceId, fingerprint) {
  const [cur] = await t`select * from nsignage.device_receivers where device_id = ${deviceId} for update`;
  if (!cur?.pending_public_key) throw httpError(409, 'There is no key change to confirm.', 'no-pending-key');
  if (fingerprint !== cur.pending_fingerprint) throw httpError(409, 'The display key changed again. Reload and check the new fingerprint.', 'key-mismatch');
  const [r] = await t`update nsignage.device_receivers set public_key = pending_public_key, key_fingerprint = pending_fingerprint,
                        key_confirmed_at = now(), pending_public_key = null, pending_fingerprint = null, pending_since = null
                      where device_id = ${deviceId} returning *`;
  return receiverFromRow(r);
}

// ---- Create + tickets ------------------------------------------------------------

export function requireReceiverReady(device, rc) {
  if (!rc) {
    throw httpError(409, 'This display cannot receive files from the website yet: its secure upload service is not installed.', 'no-receiver');
  }
  if (rc.pendingPublicKey) {
    throw httpError(409, 'This display reported a new security key. Confirm it on the Devices page before sending files.', 'key-change-pending');
  }
  if (!isOnline(device) || !receiverOnline(rc)) {
    throw httpError(409, 'The display is offline, so the file cannot be sent now. Nothing was uploaded. Try again when the display is online.', 'display-offline');
  }
}

export async function createDirectTransfer(t, user, device, rc, body) {
  const original = String(body.filename || '');
  const type = mediaTypeOf(original);
  if (!type) throw httpError(415, 'Unsupported file type.', 'unsupported-type');
  const filename = safeMediaName(original);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, 'Invalid file size');
  if (size > MAX_UPLOAD_BYTES) {
    throw httpError(413, `This file is ${Math.ceil(size / MiB)} MB. The limit for a display is ${Math.floor(MAX_UPLOAD_BYTES / MiB)} MB.`, 'too-large');
  }
  const sha256 = String(body.sha256 || '').toLowerCase();
  if (!SHA256_RX.test(sha256)) throw httpError(400, 'Missing or invalid SHA-256 checksum', 'bad-checksum');
  const hash = epkHash(body.epk);
  requireReceiverReady(device, rc);
  const free = Math.min(rc.freeBytes ?? Infinity, device.storage?.freeBytes ?? Infinity);
  if (Number.isFinite(free) && size > free - STORAGE_MARGIN) {
    throw httpError(507, `Not enough free space on the display (${Math.max(0, Math.floor(free / MiB))} MB free).`, 'insufficient-storage');
  }
  const [{ n }] = await t`select count(*)::int as n from nsignage.transfers where user_id = ${user.id} and state in ('created', 'queued', 'failed')`;
  if (n >= MAX_ACTIVE_PER_USER) throw httpError(429, 'Too many unfinished transfers. Cancel or wait for some to finish first.', 'too-many-transfers');
  // RLS (transfers_owner) also requires the device to belong to this customer
  const [r] = await t`
    insert into nsignage.transfers
      (id, user_id, device_id, filename, original_name, size_bytes, sha256, content_type, kind, relay_access, epk_hash, state, attempts, expires_at)
    values (${newTransferId()}, ${user.id}, ${device.deviceId}, ${filename}, ${original.slice(0, 200)}, ${size}, ${sha256},
            ${type.mime}, ${type.kind}, 'direct', ${hash}, 'created', 1, now() + make_interval(secs => ${TRANSFER_TTL_S}))
    returning *`;
  const tr = transferFromRow(r);
  console.log('[N-SIGNAGE TRANSFER] direct created', JSON.stringify({ transfer: tr.id, user: user.id, deviceId: tr.deviceId, size }));
  return tr;
}

/** A signed ticket for this transfer and browser key. */
export function ticketFor(tr, hash) {
  return signTicket({
    aud: tr.deviceId,
    tid: tr.id,
    name: tr.filename,
    size: tr.size,
    sha256: tr.sha256,
    chunk: CHUNK_BYTES,
    epk: hash,
    dl: Math.floor(tr.expiresAt / 1000),
  });
}

/**
 * New ticket for an unfinished transfer (expired ticket, retry, or a resume
 * after a page reload with a NEW browser key). Ownership was checked by the caller.
 */
export async function renewTicket(t, tr, device, rc, epk) {
  if (!['created', 'failed'].includes(tr.state)) throw httpError(409, `A ${tr.state} transfer cannot be resumed.`, 'bad-state');
  if (tr.method !== 'direct') throw httpError(409, 'This older transfer cannot be resumed. Send the file again.', 'bad-method');
  if (Date.now() > tr.expiresAt) throw httpError(410, 'This transfer has expired. Start a new upload.', 'expired');
  requireReceiverReady(device, rc);
  const hash = epkHash(epk);
  const fields = { epk_hash: hash };
  if (tr.state === 'failed') Object.assign(fields, { state: 'created', error: null, reason: null, attempts: Math.min(20, (tr.attempts || 0) + 1) });
  const updated = await update(t, tr.id, fields);
  return { transfer: updated, ...ticketFor(updated, hash) };
}

/** Returns the cancelled transfer. */
export async function cancelTransfer(t, tr, reason = 'Cancelled') {
  if (isFinal(tr)) throw httpError(409, `This transfer is already ${tr.state}.`, 'bad-state');
  const transfer = await update(t, tr.id, { state: 'cancelled', error: reason.slice(0, 300), reason: 'cancelled' });
  console.log('[N-SIGNAGE TRANSFER] cancelled', JSON.stringify({ transfer: tr.id }));
  return transfer;
}

// ---- Pi receiver: online authorisation and results (RLS 'device' context) ---------------

/**
 * Is this transfer still allowed for this Pi right now? Called by the receiver
 * at the first chunk and before saving the file. The receiver passes what its
 * ticket says; every value must match the website's record.
 */
export async function receiverCheck(t, deviceId, body) {
  const tid = String(body.transferId || '');
  if (!TRANSFER_ID_RX.test(tid)) throw httpError(400, 'Invalid transfer id');
  const [r] = await t`select tr.*, d.owner_id as device_owner from nsignage.transfers tr join nsignage.devices d on d.id = tr.device_id
                      where tr.id = ${tid} and tr.device_id = ${deviceId}`;
  const deny = (reason, message) => ({ allowed: false, reason, message });
  if (!r) return deny('no-transfer', 'Unknown transfer');
  const tr = transferFromRow(r);
  if (tr.method !== 'direct') return deny('bad-method', 'Not a direct transfer');
  if (r.device_owner !== tr.userId) return deny('not-owner', 'The display no longer belongs to this account');
  if (tr.state !== 'created') return deny(tr.state, `Transfer ${tr.state}`);
  if (Date.now() > tr.expiresAt) return deny('expired', 'Transfer expired');
  if (body.size !== tr.size || String(body.sha256 || '') !== tr.sha256 || String(body.epk || '') !== tr.epkHash) {
    return deny('mismatch', 'Ticket does not match the transfer');
  }
  return { allowed: true };
}

/** The Pi's final report. Completed only if size, SHA-256 and the saved name check out. */
export async function applyReceiverResult(t, deviceId, body) {
  const tid = String(body.transferId || '');
  if (!TRANSFER_ID_RX.test(tid)) throw httpError(400, 'Invalid transfer id');
  const [r] = await t`select * from nsignage.transfers where id = ${tid} and device_id = ${deviceId} for update`;
  const tr = transferFromRow(r);
  if (!tr || tr.method !== 'direct') throw httpError(404, 'Transfer not found', 'no-transfer');
  if (body.ok === true) {
    if (tr.state === 'completed') return { transfer: tr, duplicate: true };
    const saved = String(body.savedAs || '');
    if (!MEDIA_NAME_RX.test(saved) || extOf(saved) !== extOf(tr.filename)) throw httpError(400, 'Invalid saved file name', 'bad-filename');
    if (body.size !== tr.size || String(body.sha256 || '').toLowerCase() !== tr.sha256) {
      const failed = await update(t, tr.id, { state: 'failed', error: 'The display reported a file that does not match the transfer.', reason: 'checksum-mismatch' });
      return { transfer: failed };
    }
    const done = await update(t, tr.id, {
      state: 'completed', saved_as: saved, completed_at: new Date(), verified: true, verification: 'sha256-verified-on-pi',
      error: tr.state === 'cancelled' ? 'The display had already saved the file before the transfer was cancelled.' : null, reason: null,
    });
    console.log('[N-SIGNAGE TRANSFER] direct completed', JSON.stringify({ transfer: tr.id, deviceId }));
    return { transfer: done };
  }
  if (isFinal(tr)) return { transfer: tr, duplicate: true };
  const failed = await update(t, tr.id, {
    state: 'failed',
    error: String(body.error || 'The display could not save the file.').slice(0, 300),
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 40) : 'receiver-error',
  });
  return { transfer: failed };
}

// ---- Device commands still delivered through /api/pi/sync (delete only) ----------------

/** Record results of commands a Pi ran (delete). Idempotent. */
export async function applyCommandResults(t, deviceId, results) {
  for (const res of results) {
    await t`
      update nsignage.device_commands
         set state = ${res.ok ? 'done' : 'failed'}, error = ${res.error}, completed_at = now(),
             result = ${t.json({ filename: res.filename, reason: res.reason })}
       where id = ${res.id} and device_id = ${deviceId} and state in ('queued', 'withdrawn')`;
  }
}

/** Commands to hand to a Pi. Download commands no longer exist (no relay copies): any left over are withdrawn. */
export async function pendingCommandsForPi(t, deviceId) {
  const rows = await t`
    select id, type, payload, created_at from nsignage.device_commands
    where device_id = ${deviceId} and state = 'queued' order by created_at limit 20`;
  const out = [];
  for (const c of rows) {
    if (c.type === 'delete') out.push({ id: c.id, type: 'delete', filename: c.payload.filename, createdAt: c.created_at.getTime() });
    else await t`update nsignage.device_commands set state = 'withdrawn' where id = ${c.id}`;
  }
  return out;
}

// ---- Lists and cleanup ---------------------------------------------------------------------

export async function listTransfers(t, user, limit = 30) {
  const rows = await t`select * from nsignage.transfers where user_id = ${user.id} order by created_at desc limit ${limit}`;
  return rows.map((r) => transferView(transferFromRow(r)));
}

/** Expire overdue unfinished transfers ('system' context). */
export async function expireTransfers(t, limit = 100) {
  const rows = await t`
    select id from nsignage.transfers
    where expires_at < now() and state in ('created', 'queued', 'failed')
    order by expires_at limit ${limit} for update skip locked`;
  for (const r of rows) {
    await t`update nsignage.transfers set state = 'expired', error = 'The transfer expired before the display received the file.', reason = 'expired' where id = ${r.id}`;
  }
  await t`update nsignage.device_commands set state = 'withdrawn' where type = 'download' and state = 'queued'`;
  return { checked: rows.length, expired: rows.length };
}

/** Cancel every unfinished transfer to one Pi (device removed). */
export async function cancelDeviceTransfers(t, deviceId, reason) {
  await t`update nsignage.transfers set state = 'cancelled', error = ${reason}, reason = 'cancelled'
          where device_id = ${deviceId} and state in ('created', 'queued', 'failed')`;
}
