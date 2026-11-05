// =============================================
// N Signage — Relay transfers (option A: cloud relay, NOT peer-to-peer)
//
//   browser ──HTTPS──► Vercel Blob (transient copy) ──HTTPS──► Pi (cloud_agent)
//
// Life of a transfer (metadata in Redis, bytes only in Blob):
//
//   created ──commit──► queued ──Pi reports ok──► completed   (copy deleted)
//      │                  │  └──Pi reports error──► failed ──retry──► queued
//      │                  │                           └──(copy gone)──► created
//      └──────────────────┴──cancel──► cancelled (copy deleted)
//   any non-final state past expiresAt ──► expired (copy deleted)
//
// "completed" is only set when the Pi reports that it saved the file.
// verified=true additionally needs the Pi to report the SHA-256 it computed
// (agent protocol 2); agent 1.0 only confirms the save (verified=false).
//
// Kept separate from the HTTP layer so a future WebRTC/TURN transport can
// reuse the same transfer records, states and Pi result handling.
// =============================================
import crypto from 'node:crypto';
import {
  redis, keys, httpError, parse, enqueueCommand, removeCommand, hasCapability,
} from './cloud.js';
import { blobStore, blobAccess, blobPathname, safeDelete } from './blobStore.js';
import {
  mediaTypeOf, extOf, safeMediaName, contentMatches, DEFAULT_MAX_UPLOAD_MB,
} from '../../shared/mediaTypes.js';

const MiB = 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.NSIGNAGE_MAX_UPLOAD_MB) || DEFAULT_MAX_UPLOAD_MB) * MiB;
// Agent 1.0 refuses files over 500 MB, whatever the website allows
const AGENT_V1_MAX_BYTES = 500 * MiB;
export const TRANSFER_TTL_MS = Math.max(1, Number(process.env.NSIGNAGE_TRANSFER_TTL_HOURS) || 48) * 3600 * 1000;
const RECORD_TTL_S = 14 * 24 * 3600;      // history kept 14 days (metadata only)
const UPLOAD_TOKEN_MS = 6 * 3600 * 1000;  // long enough for a large video on slow mobile data
const PRESIGN_MS = 30 * 60 * 1000;        // private mode: each Pi download URL is valid 30 min
const MAX_ATTEMPTS = 5;
const MAX_ACTIVE_PER_USER = 50;
const HISTORY_PER_USER = 100;
const STORAGE_MARGIN = 200 * MiB;         // leave room on the SD card

const TRANSFER_ID_RX = /^[A-Za-z0-9_-]{22}$/;   // 128 random bits, base64url
const SHA256_RX = /^[a-f0-9]{64}$/;
const FINAL = new Set(['completed', 'cancelled', 'expired']);
export const isFinal = (t) => FINAL.has(t.state);

const newTransferId = () => crypto.randomBytes(16).toString('base64url');
const pathPrefix = (t) => `transfers/${t.deviceId}/${t.id}/`;

// ---- Records -------------------------------------------------------------------

export async function getTransfer(id) {
  if (!TRANSFER_ID_RX.test(id || '')) return null;
  return (await redis().get(keys.transfer(id))) || null;
}

async function saveTransfer(t) {
  t.updatedAt = Date.now();
  await redis().set(keys.transfer(t.id), t, { ex: RECORD_TTL_S });
  return t;
}

/** What the browser may see: never the blob URL, the owner id or any token. */
export function transferView(t, receivedBytes = null) {
  return {
    id: t.id,
    deviceId: t.deviceId,
    filename: t.filename,
    size: t.size,
    sha256: t.sha256,
    contentType: t.contentType,
    kind: t.kind,
    state: t.state,
    relay: 'cloud',               // relay-based transfer, not peer-to-peer
    access: t.access,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    expiresAt: t.expiresAt,
    attempts: t.attempts || 0,
    error: t.error || null,
    reason: t.reason || null,
    savedAs: t.savedAs || null,
    verified: Boolean(t.verified),
    verification: t.verification || null,
    completedAt: t.completedAt || null,
    cloudCopy: Boolean(t.blobUrl),
    ...(receivedBytes !== null && { receivedBytes }),
  };
}

/** Load a transfer and check it belongs to this customer. */
export async function requireOwnTransfer(user, id) {
  const t = await getTransfer(String(id || ''));
  if (!t || t.userId !== user.id) throw httpError(404, 'Transfer not found', 'no-transfer');
  return t;
}

async function deleteCopy(t) {
  if (!t.blobUrl) return true;
  const ok = await safeDelete(t.blobUrl);
  if (ok) {
    t.blobUrl = null;
    t.blobDeletedAt = Date.now();
  }
  return ok;
}

// ---- Create --------------------------------------------------------------------

function maxBytesFor(device) {
  // Agent protocol 2 may raise its own limit; agent 1.0 stays at 500 MB
  const agentMax = Number.isSafeInteger(device.maxUploadBytes) ? device.maxUploadBytes : AGENT_V1_MAX_BYTES;
  return Math.min(MAX_UPLOAD_BYTES, agentMax);
}

export async function createTransfer(user, device, body) {
  const original = String(body.filename || '');
  const type = mediaTypeOf(original);
  if (!type) throw httpError(415, 'Unsupported file type.', 'unsupported-type');
  const filename = safeMediaName(original);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, 'Invalid file size');
  const max = maxBytesFor(device);
  if (size > max) {
    throw httpError(413, `This file is ${Math.ceil(size / MiB)} MB. The limit for this display is ${Math.floor(max / MiB)} MB.`, 'too-large');
  }
  const sha256 = String(body.sha256 || '').toLowerCase();
  if (!SHA256_RX.test(sha256)) throw httpError(400, 'Missing or invalid SHA-256 checksum', 'bad-checksum');
  if (device.storage && size > device.storage.freeBytes - STORAGE_MARGIN) {
    throw httpError(507, `Not enough free space on the display (${Math.max(0, Math.floor(device.storage.freeBytes / MiB))} MB free).`, 'insufficient-storage');
  }
  const access = blobAccess();
  if (access === 'private' && !hasCapability(device, 'private-blob')) {
    throw httpError(409, 'This display needs a software update before it can receive files (private transfers are enabled).', 'agent-update-required');
  }

  // Abuse limit: open transfers per account
  const r = redis();
  const recent = (await r.zrange(keys.userTransfers(user.id), 0, -1)) || [];
  const records = recent.length ? await r.mget(...recent.map(keys.transfer)) : [];
  const active = records.filter((t) => t && !isFinal(t)).length;
  if (active >= MAX_ACTIVE_PER_USER) {
    throw httpError(429, 'Too many unfinished transfers. Cancel or wait for some to finish first.', 'too-many-transfers');
  }

  const now = Date.now();
  const t = {
    id: newTransferId(),
    userId: user.id,
    deviceId: device.deviceId,
    filename,
    originalName: original.slice(0, 200),
    size,
    sha256,
    contentType: type.mime,
    kind: type.kind,
    access,
    state: 'created',
    attempts: 0,
    createdAt: now,
    expiresAt: now + TRANSFER_TTL_MS,
    blobUrl: null,
    commandId: null,
  };
  await saveTransfer(t);
  await r.zadd(keys.transferIndex(), { score: t.expiresAt, member: t.id });
  await r.zadd(keys.userTransfers(user.id), { score: now, member: t.id });
  await r.zremrangebyrank(keys.userTransfers(user.id), 0, -(HISTORY_PER_USER + 1));
  console.log('[N-SIGNAGE TRANSFER] created', JSON.stringify({ transfer: t.id, user: user.id, deviceId: t.deviceId, size }));
  return t;
}

// ---- Upload token (Vercel Blob client upload) -------------------------------------

/**
 * Called from handleUpload's onBeforeGenerateToken. The browser may only
 * write exactly this transfer's path, with exactly its size and type.
 */
export async function uploadTokenOptions(user, pathname, transferId) {
  const t = await requireOwnTransfer(user, transferId);
  if (t.state !== 'created') throw httpError(409, 'This transfer is not waiting for an upload.', 'bad-state');
  if (Date.now() > t.expiresAt) throw httpError(410, 'This transfer has expired. Start a new upload.', 'expired');
  if (pathname !== `${pathPrefix(t)}${t.filename}`) throw httpError(400, 'Invalid upload path');
  return {
    allowedContentTypes: [t.contentType],
    maximumSizeInBytes: t.size,
    addRandomSuffix: true,
    validUntil: Date.now() + UPLOAD_TOKEN_MS,
    tokenPayload: JSON.stringify({ transferId: t.id }),
  };
}

export const uploadPathname = (t) => `${pathPrefix(t)}${t.filename}`;

// ---- Commit: the browser finished uploading to the relay ---------------------------

export async function commitTransfer(t, device, url) {
  if (t.state !== 'created') throw httpError(409, 'This transfer was already submitted.', 'bad-state');
  const pathname = blobPathname(String(url || ''), t.access);
  if (!pathname || !pathname.startsWith(pathPrefix(t))) throw httpError(400, 'Invalid upload URL', 'bad-url');

  const reject = async (status, message, reason) => {
    await safeDelete(url);
    t.error = message;
    t.reason = reason;
    await saveTransfer(t);
    throw httpError(status, message, reason);
  };

  let info;
  try {
    info = await blobStore.head(url);
  } catch (err) {
    console.error('[N-SIGNAGE TRANSFER] head failed', t.id, err.message);
    throw httpError(502, 'Could not confirm the upload. Please retry.', 'relay-error');
  }
  if (!info) throw httpError(409, 'The uploaded file was not found. Please upload it again.', 'upload-missing');
  if (info.size !== t.size) return reject(422, 'The uploaded file size does not match. Please upload it again.', 'size-mismatch');

  let prefix;
  try {
    prefix = await blobStore.readPrefix(url, 32, t.access);
  } catch (err) {
    console.error('[N-SIGNAGE TRANSFER] content check failed', t.id, err.message);
    throw httpError(502, 'Could not check the uploaded file. Please retry.', 'relay-error');
  }
  if (!contentMatches(extOf(t.filename), prefix)) {
    return reject(415, `The file content is not a valid ${extOf(t.filename).toUpperCase()} file.`, 'content-mismatch');
  }

  // A previous copy (re-upload after a failure) is replaced
  if (t.blobUrl && t.blobUrl !== url) await safeDelete(t.blobUrl);
  t.blobUrl = url;
  t.blobPathname = pathname;
  t.error = null;
  t.reason = null;
  await queueForPi(t);
  console.log('[N-SIGNAGE TRANSFER] queued for Pi', JSON.stringify({ transfer: t.id, deviceId: t.deviceId, online: Boolean(device) }));
  return t;
}

async function queueForPi(t) {
  const cmd = await enqueueCommand(t.deviceId, {
    type: 'download',
    transferId: t.id,
    // Public mode: agent 1.0 reads `url`. Private mode: filled in per sync (presigned).
    ...(t.access === 'public' && { url: t.blobUrl }),
    filename: t.filename,
    size: t.size,
    sha256: t.sha256,
  });
  t.commandId = cmd.id;
  t.state = 'queued';
  t.attempts = (t.attempts || 0) + 1;
  await saveTransfer(t);
}

// ---- Cancel / retry -------------------------------------------------------------------

export async function cancelTransfer(t, reason = 'Cancelled') {
  if (isFinal(t)) throw httpError(409, `This transfer is already ${t.state}.`, 'bad-state');
  if (t.commandId) await removeCommand(t.deviceId, t.commandId);
  await deleteCopy(t);
  t.state = 'cancelled';
  t.error = reason;
  t.reason = 'cancelled';
  await saveTransfer(t);
  await redis().zrem(keys.transferIndex(), t.id);
  console.log('[N-SIGNAGE TRANSFER] cancelled', JSON.stringify({ transfer: t.id }));
  return t;
}

/**
 * Retry a failed transfer. With the relay copy still present the Pi simply
 * downloads it again; otherwise the transfer goes back to "created" and the
 * browser must upload the file again (same checksum).
 */
export async function retryTransfer(t) {
  if (t.state !== 'failed' && t.state !== 'created') throw httpError(409, `A ${t.state} transfer cannot be retried.`, 'bad-state');
  if (Date.now() > t.expiresAt) throw httpError(410, 'This transfer has expired. Start a new upload.', 'expired');
  if (t.state === 'created') return { transfer: t, needsUpload: true };
  if ((t.attempts || 0) >= MAX_ATTEMPTS) {
    throw httpError(429, 'This transfer failed too many times. Start a new upload.', 'too-many-attempts');
  }
  if (t.commandId) await removeCommand(t.deviceId, t.commandId);
  if (t.blobUrl) {
    t.error = null;
    t.reason = null;
    await queueForPi(t);
    return { transfer: t, needsUpload: false };
  }
  t.state = 'created';
  t.commandId = null;
  t.error = null;
  t.reason = null;
  await saveTransfer(t);
  return { transfer: t, needsUpload: true };
}

// ---- Pi side: results, progress, command delivery -------------------------------------

/** Apply results reported by a Pi on /api/pi/sync (cleaned by completeCommands). */
export async function applyTransferResults(deviceId, results) {
  for (const res of results || []) {
    if (!res.transferId) continue;
    const t = await getTransfer(res.transferId);
    if (!t || t.deviceId !== deviceId) continue;
    if (t.state === 'completed' || t.state === 'expired') continue;
    if (t.commandId && res.id !== t.commandId && t.state !== 'cancelled') continue; // stale attempt

    if (res.ok) {
      if (res.sha256 && res.sha256 !== t.sha256) {
        failTransfer(t, 'The file arrived damaged on the display (checksum mismatch). Retry the transfer.', 'checksum-mismatch');
      } else if (res.size !== undefined && res.size !== t.size) {
        failTransfer(t, 'The file arrived incomplete on the display (size mismatch). Retry the transfer.', 'size-mismatch');
      } else {
        const wasCancelled = t.state === 'cancelled';
        t.state = 'completed';
        t.savedAs = res.filename || t.filename;
        t.completedAt = Date.now();
        t.verified = Boolean(res.sha256);
        t.verification = res.sha256 ? 'sha256-verified-on-pi' : 'saved-on-pi-unverified';
        t.error = wasCancelled ? 'The display had already saved the file before the transfer was cancelled.' : null;
        t.reason = null;
        // The Pi has the file: the relay copy is no longer needed
        await deleteCopy(t);
        await redis().zrem(keys.transferIndex(), t.id);
      }
    } else if (t.state !== 'cancelled') {
      failTransfer(t, res.error || 'The display could not save the file.', res.reason || 'pi-error');
    } else {
      continue;
    }
    await saveTransfer(t);
    console.log('[N-SIGNAGE TRANSFER] Pi result', JSON.stringify({ transfer: t.id, state: t.state, verified: t.verified, reason: t.reason }));
  }
}

function failTransfer(t, message, reason) {
  t.state = 'failed';
  t.error = String(message).slice(0, 300);
  t.reason = reason;
}

/** Agent protocol 2 progress reports: [{ transferId, receivedBytes }]. */
export async function applyTransferProgress(deviceId, progress) {
  if (!Array.isArray(progress)) return;
  for (const p of progress.slice(0, 20)) {
    if (!p || !TRANSFER_ID_RX.test(p.transferId || '') || !Number.isSafeInteger(p.receivedBytes) || p.receivedBytes < 0) continue;
    const t = await getTransfer(p.transferId);
    if (!t || t.deviceId !== deviceId || t.state !== 'queued') continue;
    await redis().set(keys.transferProgress(t.id), Math.min(p.receivedBytes, t.size), { ex: 600 });
  }
}

export async function transferProgress(t) {
  const v = await redis().get(keys.transferProgress(t.id));
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Commands about to be handed to a Pi: drop downloads whose transfer is no
 * longer active and, in private mode, attach a fresh short-lived URL.
 */
export async function prepareCommandsForDevice(deviceId, commands) {
  const out = [];
  for (const cmd of commands) {
    if (cmd.type !== 'download' || !cmd.transferId) { out.push(cmd); continue; }
    const t = await getTransfer(cmd.transferId);
    if (!t || t.state !== 'queued' || !t.blobUrl || t.commandId !== cmd.id) {
      await removeCommand(deviceId, cmd.id); // stale: never hand it to the Pi
      continue;
    }
    if (t.access === 'private') {
      try {
        out.push({ ...cmd, url: await blobStore.presignGet(t.blobPathname, Date.now() + PRESIGN_MS) });
      } catch (err) {
        console.error('[N-SIGNAGE TRANSFER] presign failed', t.id, err.message);
      }
    } else {
      out.push(cmd);
    }
  }
  return out;
}

// ---- Lists, cleanup --------------------------------------------------------------------

export async function listTransfers(user, limit = 30) {
  const r = redis();
  const ids = ((await r.zrange(keys.userTransfers(user.id), 0, -1)) || []).reverse().slice(0, limit);
  if (!ids.length) return [];
  const records = await r.mget(...ids.map(keys.transfer));
  const out = [];
  for (const t of records) {
    if (!t) continue;
    out.push(transferView(t, t.state === 'queued' ? await transferProgress(t) : null));
  }
  return out;
}

/** Expire transfers past their deadline and delete their relay copies. */
export async function expireTransfers({ now = Date.now(), limit = 100 } = {}) {
  const r = redis();
  const ids = ((await r.zrange(keys.transferIndex(), 0, now, { byScore: true })) || []).slice(0, limit);
  let expired = 0;
  let copiesDeleted = 0;
  for (const id of ids) {
    const t = await getTransfer(String(id));
    if (t && !isFinal(t)) {
      if (t.commandId) await removeCommand(t.deviceId, t.commandId);
      t.state = 'expired';
      t.error = 'The transfer expired before the display received the file.';
      t.reason = 'expired';
      expired += 1;
    }
    if (t?.blobUrl) {
      if (await deleteCopy(t)) copiesDeleted += 1;
      else continue; // keep it indexed; try again next time
    }
    if (t) await saveTransfer(t);
    await r.zrem(keys.transferIndex(), String(id));
  }
  return { checked: ids.length, expired, copiesDeleted };
}

/**
 * Delete relay blobs that no active transfer points to (e.g. an upload that
 * finished but was never committed). Only touches the transfers/ prefix,
 * plus the old media/ prefix when NSIGNAGE_PURGE_LEGACY_BLOBS=1.
 */
export async function sweepOrphanBlobs({ now = Date.now(), graceMs = 2 * 3600 * 1000 } = {}) {
  let deleted = 0;
  let cursor = null;
  do {
    const page = await blobStore.list('transfers/', cursor);
    cursor = page.cursor;
    const stale = [];
    for (const b of page.blobs) {
      if (now - b.uploadedAt < graceMs) continue;
      const id = b.pathname.split('/')[2];
      const t = await getTransfer(id);
      if (!t || isFinal(t) || t.blobUrl !== b.url || now > t.expiresAt) stale.push(b.url);
    }
    if (stale.length && (await safeDelete(stale))) deleted += stale.length;
  } while (cursor);

  let legacyDeleted = 0;
  if (process.env.NSIGNAGE_PURGE_LEGACY_BLOBS === '1') {
    cursor = null;
    do {
      const page = await blobStore.list('media/', cursor);
      cursor = page.cursor;
      const urls = page.blobs.map((b) => b.url);
      if (urls.length && (await safeDelete(urls))) legacyDeleted += urls.length;
    } while (cursor);
  }
  return { orphanCopiesDeleted: deleted, legacyCopiesDeleted: legacyDeleted };
}

/** Cancel every unfinished transfer of this account to one Pi (device removed). */
export async function cancelDeviceTransfers(userId, deviceId, reason) {
  const r = redis();
  const ids = (await r.zrange(keys.userTransfers(userId), 0, -1)) || [];
  let n = 0;
  for (const id of ids) {
    const t = await getTransfer(String(id));
    if (!t || t.deviceId !== deviceId) continue;
    if (!isFinal(t)) {
      await cancelTransfer(t, reason);
      n += 1;
    } else if (t.blobUrl) {
      await deleteCopy(t);
      await saveTransfer(t);
    }
  }
  return n;
}

/** Cloud copies made by the pre-transfer upload flow (ns:blob:<deviceId>). */
export async function deleteLegacyBlobs(deviceId) {
  const r = redis();
  const blobs = (await r.hgetall(keys.blobs(deviceId))) || {};
  const urls = Object.values(blobs).map((b) => parse(b).url).filter(Boolean);
  if (urls.length) await safeDelete(urls);
  await r.del(keys.blobs(deviceId));
  return urls.length;
}

