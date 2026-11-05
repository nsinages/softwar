// =============================================
// N Signage — Relay transfers (option A: cloud relay, NOT peer-to-peer)
//
//   browser ──HTTPS──► Vercel Blob (transient copy) ──HTTPS──► Pi (cloud_agent)
//
// Metadata lives in Supabase (nsignage.transfers, nsignage.device_commands);
// the media bytes only ever exist in the temporary Blob copy and on the Pi.
//
//   created ──commit──► queued ──Pi reports ok──► completed   (copy deleted)
//      │                  │  └──Pi reports error──► failed ──retry──► queued
//      │                  │                           └──(copy gone)──► created
//      └──────────────────┴──cancel──► cancelled (copy deleted)
//   any non-final state past expires_at ──► expired (copy deleted)
//
// "completed" is only set when the Pi reports that it saved the file.
// verified=true additionally needs the Pi to report the SHA-256 it computed
// (agent protocol 2); agent 1.0 only confirms the save (verified=false).
//
// Blob copies are deleted AFTER the database transaction commits
// (deleteRelayCopies); if that fails, the record keeps its blob_url and the
// cleanup cron retries. Kept separate from the HTTP layer so a future
// WebRTC/TURN transport can reuse the same records and Pi result handling.
// =============================================
import crypto from 'node:crypto';
import { httpError, hasCapability } from './cloud.js';
import { asSystem, ms } from './db.js';
import { blobStore, blobAccess, blobPathname, safeDelete } from './blobStore.js';
import {
  mediaTypeOf, extOf, safeMediaName, contentMatches, DEFAULT_MAX_UPLOAD_MB,
} from '../../shared/mediaTypes.js';

const MiB = 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.NSIGNAGE_MAX_UPLOAD_MB) || DEFAULT_MAX_UPLOAD_MB) * MiB;
const AGENT_V1_MAX_BYTES = 500 * MiB;      // agent 1.0 refuses files over 500 MB
export const TRANSFER_TTL_S = Math.max(1, Number(process.env.NSIGNAGE_TRANSFER_TTL_HOURS) || 48) * 3600;
const UPLOAD_TOKEN_MS = 6 * 3600 * 1000;   // long enough for a large video on slow mobile data
const PRESIGN_MS = 30 * 60 * 1000;         // private mode: each Pi download URL is valid 30 min
const MAX_ATTEMPTS = 5;
const MAX_ACTIVE_PER_USER = 50;
const STORAGE_MARGIN = 200 * MiB;

const TRANSFER_ID_RX = /^[A-Za-z0-9_-]{22}$/;
const SHA256_RX = /^[a-f0-9]{64}$/;
export const FINAL_STATES = ['completed', 'cancelled', 'expired'];
export const isFinal = (tr) => FINAL_STATES.includes(tr.state);

const newTransferId = () => crypto.randomBytes(16).toString('base64url');
const pathPrefix = (tr) => `transfers/${tr.deviceId}/${tr.id}/`;
export const uploadPathname = (tr) => `${pathPrefix(tr)}${tr.filename}`;

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
    access: r.relay_access,
    state: r.state,
    attempts: r.attempts,
    commandId: r.command_id,
    error: r.error,
    reason: r.reason,
    savedAs: r.saved_as,
    verified: r.verified,
    verification: r.verification,
    receivedBytes: r.received_bytes,
    receivedAt: ms(r.received_at),
    blobUrl: r.blob_url,
    blobPathname: r.blob_pathname,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    expiresAt: ms(r.expires_at),
    completedAt: ms(r.completed_at),
  };
}

/** What the browser may see: never the blob URL, the owner id or any token. */
export function transferView(tr) {
  const progressFresh = tr.state === 'queued' && tr.receivedAt && Date.now() - tr.receivedAt < 10 * 60_000;
  return {
    id: tr.id,
    deviceId: tr.deviceId,
    filename: tr.filename,
    size: tr.size,
    sha256: tr.sha256,
    contentType: tr.contentType,
    kind: tr.kind,
    state: tr.state,
    relay: 'cloud',               // relay-based transfer, not peer-to-peer
    access: tr.access,
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
    cloudCopy: Boolean(tr.blobUrl),
    ...(progressFresh && Number.isFinite(tr.receivedBytes) && { receivedBytes: tr.receivedBytes }),
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

// ---- Create --------------------------------------------------------------------

// Agent protocol 2 may announce a higher limit later; agent 1.0 refuses > 500 MB.
const maxBytesFor = () => Math.min(MAX_UPLOAD_BYTES, AGENT_V1_MAX_BYTES);

export async function createTransfer(t, user, device, body) {
  const original = String(body.filename || '');
  const type = mediaTypeOf(original);
  if (!type) throw httpError(415, 'Unsupported file type.', 'unsupported-type');
  const filename = safeMediaName(original);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, 'Invalid file size');
  const max = maxBytesFor();
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
  const [{ n }] = await t`select count(*)::int as n from nsignage.transfers
                          where user_id = ${user.id} and state in ('created', 'queued', 'failed')`;
  if (n >= MAX_ACTIVE_PER_USER) {
    throw httpError(429, 'Too many unfinished transfers. Cancel or wait for some to finish first.', 'too-many-transfers');
  }
  // RLS (transfers_owner) also requires the device to belong to this customer
  const [r] = await t`
    insert into nsignage.transfers
      (id, user_id, device_id, filename, original_name, size_bytes, sha256, content_type, kind, relay_access, state, expires_at)
    values (${newTransferId()}, ${user.id}, ${device.deviceId}, ${filename}, ${original.slice(0, 200)}, ${size}, ${sha256},
            ${type.mime}, ${type.kind}, ${access}, 'created', now() + make_interval(secs => ${TRANSFER_TTL_S}))
    returning *`;
  const tr = transferFromRow(r);
  console.log('[N-SIGNAGE TRANSFER] created', JSON.stringify({ transfer: tr.id, user: user.id, deviceId: tr.deviceId, size }));
  return tr;
}

// ---- Upload token (Vercel Blob client upload) -------------------------------------

/** The browser may only write exactly this transfer's path, with exactly its size and type. */
export function uploadTokenOptions(tr, pathname) {
  if (tr.state !== 'created') throw httpError(409, 'This transfer is not waiting for an upload.', 'bad-state');
  if (Date.now() > tr.expiresAt) throw httpError(410, 'This transfer has expired. Start a new upload.', 'expired');
  if (pathname !== uploadPathname(tr)) throw httpError(400, 'Invalid upload path');
  return {
    allowedContentTypes: [tr.contentType],
    maximumSizeInBytes: tr.size,
    addRandomSuffix: true,
    validUntil: Date.now() + UPLOAD_TOKEN_MS,
    tokenPayload: JSON.stringify({ transferId: tr.id }),
  };
}

// ---- Commit: the browser finished uploading to the relay ---------------------------

/**
 * Check the uploaded relay copy (path, size, real content). Network calls to
 * Blob only — run this BEFORE opening a database transaction.
 * Returns the blob pathname.
 */
export async function verifyUploadedCopy(tr, url) {
  if (tr.state !== 'created') throw httpError(409, 'This transfer was already submitted.', 'bad-state');
  const pathname = blobPathname(String(url || ''), tr.access);
  if (!pathname || !pathname.startsWith(pathPrefix(tr))) throw httpError(400, 'Invalid upload URL', 'bad-url');
  let info;
  try {
    info = await blobStore.head(url);
  } catch (err) {
    console.error('[N-SIGNAGE TRANSFER] head failed', tr.id, err.message);
    throw httpError(502, 'Could not confirm the upload. Please retry.', 'relay-error');
  }
  if (!info) throw httpError(409, 'The uploaded file was not found. Please upload it again.', 'upload-missing');
  if (info.size !== tr.size) {
    await safeDelete(url);
    throw httpError(422, 'The uploaded file size does not match. Please upload it again.', 'size-mismatch');
  }
  let prefix;
  try {
    prefix = await blobStore.readPrefix(url, 32, tr.access);
  } catch (err) {
    console.error('[N-SIGNAGE TRANSFER] content check failed', tr.id, err.message);
    throw httpError(502, 'Could not check the uploaded file. Please retry.', 'relay-error');
  }
  if (!contentMatches(extOf(tr.filename), prefix)) {
    await safeDelete(url);
    throw httpError(415, `The file content is not a valid ${extOf(tr.filename).toUpperCase()} file.`, 'content-mismatch');
  }
  return pathname;
}

/**
 * Queue a verified upload for the Pi (inside a transaction, with the transfer
 * re-read FOR UPDATE). Returns { transfer, deleteAfterCommit }.
 */
export async function commitTransfer(t, tr, url, pathname) {
  if (tr.state !== 'created') throw httpError(409, 'This transfer was already submitted.', 'bad-state');
  const deleteAfterCommit = tr.blobUrl && tr.blobUrl !== url ? [tr.blobUrl] : [];
  const queued = await queueForPi(t, tr, { blob_url: url, blob_pathname: pathname, error: null, reason: null });
  console.log('[N-SIGNAGE TRANSFER] queued for Pi', JSON.stringify({ transfer: tr.id, deviceId: tr.deviceId }));
  return { transfer: queued, deleteAfterCommit };
}

async function queueForPi(t, tr, extra = {}) {
  const payload = { filename: tr.filename, size: tr.size, sha256: tr.sha256 };
  const [cmd] = await t`
    insert into nsignage.device_commands (device_id, type, payload, transfer_id)
    values (${tr.deviceId}, 'download', ${t.json(payload)}, ${tr.id}) returning id`;
  return update(t, tr.id, { ...extra, state: 'queued', command_id: cmd.id, attempts: (tr.attempts || 0) + 1 });
}

async function withdrawCommand(t, commandId) {
  if (commandId) await t`update nsignage.device_commands set state = 'withdrawn' where id = ${commandId} and state = 'queued'`;
}

// ---- Cancel / retry -------------------------------------------------------------------

/** Returns { transfer, deleteAfterCommit }. */
export async function cancelTransfer(t, tr, reason = 'Cancelled') {
  if (isFinal(tr)) throw httpError(409, `This transfer is already ${tr.state}.`, 'bad-state');
  await withdrawCommand(t, tr.commandId);
  const transfer = await update(t, tr.id, { state: 'cancelled', error: reason.slice(0, 300), reason: 'cancelled' });
  console.log('[N-SIGNAGE TRANSFER] cancelled', JSON.stringify({ transfer: tr.id }));
  return { transfer, deleteAfterCommit: tr.blobUrl ? [tr.blobUrl] : [] };
}

/**
 * Retry a failed transfer. With the relay copy still present the Pi simply
 * downloads it again; otherwise the transfer goes back to "created" and the
 * browser must upload the file again (same checksum).
 */
export async function retryTransfer(t, tr) {
  if (tr.state !== 'failed' && tr.state !== 'created') throw httpError(409, `A ${tr.state} transfer cannot be retried.`, 'bad-state');
  if (Date.now() > tr.expiresAt) throw httpError(410, 'This transfer has expired. Start a new upload.', 'expired');
  if (tr.state === 'created') return { transfer: tr, needsUpload: true };
  if ((tr.attempts || 0) >= MAX_ATTEMPTS) throw httpError(429, 'This transfer failed too many times. Start a new upload.', 'too-many-attempts');
  await withdrawCommand(t, tr.commandId);
  if (tr.blobUrl) return { transfer: await queueForPi(t, tr, { error: null, reason: null }), needsUpload: false };
  const transfer = await update(t, tr.id, { state: 'created', command_id: null, error: null, reason: null });
  return { transfer, needsUpload: true };
}

// ---- Pi side: results, progress, command delivery (RLS context 'device') -------------

/**
 * Record command results reported by a Pi and update their transfers.
 * Returns relay URLs to delete after the transaction commits.
 */
export async function applyCommandResults(t, deviceId, results) {
  const deleteAfterCommit = [];
  for (const res of results) {
    const [cmd] = await t`
      update nsignage.device_commands
         set state = ${res.ok ? 'done' : 'failed'}, error = ${res.error}, completed_at = now(),
             result = ${t.json({ filename: res.filename, sha256: res.sha256, size: res.size, reason: res.reason })}
       where id = ${res.id} and device_id = ${deviceId} and state in ('queued', 'withdrawn')
      returning transfer_id`;
    if (!cmd?.transfer_id) continue;
    const [row] = await t`select * from nsignage.transfers where id = ${cmd.transfer_id} and device_id = ${deviceId} for update`;
    const tr = transferFromRow(row);
    if (!tr || tr.state === 'completed' || tr.state === 'expired') continue;
    if (tr.commandId && res.id !== tr.commandId && tr.state !== 'cancelled') continue; // stale attempt

    let fields;
    if (res.ok) {
      if (res.sha256 && res.sha256 !== tr.sha256) {
        fields = { state: 'failed', error: 'The file arrived damaged on the display (checksum mismatch). Retry the transfer.', reason: 'checksum-mismatch' };
      } else if (res.size !== null && res.size !== tr.size) {
        fields = { state: 'failed', error: 'The file arrived incomplete on the display (size mismatch). Retry the transfer.', reason: 'size-mismatch' };
      } else {
        fields = {
          state: 'completed',
          saved_as: (res.filename || tr.filename).slice(0, 220),
          completed_at: new Date(),
          verified: Boolean(res.sha256),
          verification: res.sha256 ? 'sha256-verified-on-pi' : 'saved-on-pi-unverified',
          error: tr.state === 'cancelled' ? 'The display had already saved the file before the transfer was cancelled.' : null,
          reason: null,
        };
        // The Pi has the file: the relay copy is no longer needed
        if (tr.blobUrl) deleteAfterCommit.push(tr.blobUrl);
      }
    } else if (tr.state !== 'cancelled') {
      fields = { state: 'failed', error: res.error || 'The display could not save the file.', reason: res.reason || 'pi-error' };
    } else {
      continue;
    }
    await update(t, tr.id, fields);
    console.log('[N-SIGNAGE TRANSFER] Pi result', JSON.stringify({ transfer: tr.id, state: fields.state, verified: Boolean(fields.verified), reason: fields.reason }));
  }
  return deleteAfterCommit;
}

/** Agent protocol 2 progress reports: [{ transferId, receivedBytes }]. */
export async function applyTransferProgress(t, deviceId, progress) {
  if (!Array.isArray(progress)) return;
  for (const p of progress.slice(0, 20)) {
    if (!p || !TRANSFER_ID_RX.test(p.transferId || '') || !Number.isSafeInteger(p.receivedBytes) || p.receivedBytes < 0) continue;
    await t`update nsignage.transfers set received_bytes = least(${p.receivedBytes}, size_bytes), received_at = now()
            where id = ${p.transferId} and device_id = ${deviceId} and state = 'queued'`;
  }
}

/**
 * Commands to hand to a Pi. Downloads whose transfer is no longer active are
 * withdrawn; in private mode a fresh short-lived URL is attached.
 */
export async function pendingCommandsForPi(t, deviceId) {
  const rows = await t`
    select c.id, c.type, c.payload, c.transfer_id, c.created_at,
           tr.state as t_state, tr.blob_url, tr.blob_pathname, tr.command_id as t_command, tr.relay_access
    from nsignage.device_commands c
    left join nsignage.transfers tr on tr.id = c.transfer_id
    where c.device_id = ${deviceId} and c.state = 'queued'
    order by c.created_at
    limit 20`;
  const out = [];
  for (const c of rows) {
    const base = { id: c.id, type: c.type, createdAt: c.created_at.getTime() };
    if (c.type === 'delete') { out.push({ ...base, filename: c.payload.filename }); continue; }
    if (!c.transfer_id) {
      // download queued by the pre-transfer flow (imported from Redis): payload carries its own URL
      if (c.payload.url) out.push({ ...base, url: c.payload.url, filename: c.payload.filename, size: c.payload.size || null });
      continue;
    }
    if (c.t_state !== 'queued' || !c.blob_url || c.t_command !== c.id) {
      await t`update nsignage.device_commands set state = 'withdrawn' where id = ${c.id}`; // stale: never hand it out
      continue;
    }
    let url = c.blob_url;
    if (c.relay_access === 'private') {
      try {
        url = await blobStore.presignGet(c.blob_pathname, Date.now() + PRESIGN_MS);
      } catch (err) {
        console.error('[N-SIGNAGE TRANSFER] presign failed', c.transfer_id, err.message);
        continue;
      }
    }
    out.push({ ...base, transferId: c.transfer_id, url, filename: c.payload.filename, size: c.payload.size, sha256: c.payload.sha256 });
  }
  return out;
}

// ---- Lists ------------------------------------------------------------------------------

export async function listTransfers(t, user, limit = 30) {
  const rows = await t`select * from nsignage.transfers where user_id = ${user.id} order by created_at desc limit ${limit}`;
  return rows.map((r) => transferView(transferFromRow(r)));
}

// ---- Cleanup ('system' context) -------------------------------------------------------

/** Expire overdue transfers. Returns { expired, deleteAfterCommit }. */
export async function expireTransfers(t, limit = 100) {
  const rows = await t`
    select * from nsignage.transfers
    where expires_at < now() and (blob_url is not null or state in ('created', 'queued', 'failed'))
    order by expires_at limit ${limit}
    for update skip locked`;
  let expired = 0;
  const deleteAfterCommit = [];
  for (const r of rows) {
    const tr = transferFromRow(r);
    if (!isFinal(tr)) {
      await withdrawCommand(t, tr.commandId);
      await update(t, tr.id, { state: 'expired', error: 'The transfer expired before the display received the file.', reason: 'expired' });
      expired += 1;
    }
    if (tr.blobUrl) deleteAfterCommit.push(tr.blobUrl);
  }
  return { checked: rows.length, expired, deleteAfterCommit };
}

/** Cancel every unfinished transfer to one Pi (device removed). Returns URLs to delete. */
export async function cancelDeviceTransfers(t, deviceId, reason) {
  const rows = await t`select * from nsignage.transfers where device_id = ${deviceId}
                       and (state in ('created', 'queued', 'failed') or blob_url is not null) for update`;
  const urls = [];
  for (const r of rows) {
    const tr = transferFromRow(r);
    if (!isFinal(tr)) {
      await withdrawCommand(t, tr.commandId);
      await update(t, tr.id, { state: 'cancelled', error: reason, reason: 'cancelled' });
    }
    if (tr.blobUrl) urls.push(tr.blobUrl);
  }
  return urls;
}

/**
 * Delete relay copies from Blob AFTER the database commit, then clear their
 * URLs. Anything that fails stays recorded and is retried by the cron.
 */
export async function deleteRelayCopies(urls) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return 0;
  if (!(await safeDelete(list))) return 0;
  await asSystem(async (t) => {
    await t`update nsignage.transfers set blob_url = null, blob_deleted_at = now() where blob_url = any(${list}::text[])`;
    await t`update nsignage.legacy_relay_copies set deleted_at = now() where url = any(${list}::text[]) and deleted_at is null`;
  });
  return list.length;
}

/**
 * Delete relay blobs that no active transfer points to (e.g. uploaded but
 * never committed). Only touches the transfers/ prefix, plus old media/
 * copies listed in legacy_relay_copies when NSIGNAGE_PURGE_LEGACY_BLOBS=1.
 */
export async function sweepOrphanBlobs({ now = Date.now(), graceMs = 2 * 3600 * 1000 } = {}) {
  let deleted = 0;
  let cursor = null;
  do {
    const page = await blobStore.list('transfers/', cursor);
    cursor = page.cursor;
    const old = page.blobs.filter((b) => now - b.uploadedAt >= graceMs);
    if (old.length) {
      const ids = [...new Set(old.map((b) => b.pathname.split('/')[2]).filter((id) => TRANSFER_ID_RX.test(id || '')))];
      const keep = new Set(
        (await asSystem((t) => t`select blob_url from nsignage.transfers
                                  where id = any(${ids}::text[]) and blob_url is not null
                                    and state in ('created', 'queued', 'failed') and expires_at > now()`)).map((r) => r.blob_url),
      );
      const stale = old.map((b) => b.url).filter((u) => !keep.has(u));
      if (stale.length && (await safeDelete(stale))) deleted += stale.length;
    }
  } while (cursor);

  let legacyDeleted = 0;
  if (process.env.NSIGNAGE_PURGE_LEGACY_BLOBS === '1') {
    const legacy = (await asSystem((t) => t`select url from nsignage.legacy_relay_copies where deleted_at is null limit 1000`)).map((r) => r.url);
    legacyDeleted = await deleteRelayCopies(legacy);
  }
  return { orphanCopiesDeleted: deleted, legacyCopiesDeleted: legacyDeleted };
}
