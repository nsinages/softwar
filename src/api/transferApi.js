// =============================================
// N Signage — Relay transfers to cloud devices (hosted website)
//
// This is a RELAY transfer, not peer-to-peer:
//   this browser ──► N-Signage cloud relay (temporary copy) ──► the Pi
// The temporary copy is deleted when the Pi confirms it saved the file, or
// when the transfer is cancelled or expires (48 h by default).
//
// Success is reported ONLY when the Pi confirms the file is saved. If the
// display is offline, the transfer waits in the queue and the UI says so.
// =============================================
import axios from 'axios';
import { upload } from '@vercel/blob/client';
import { cloudError } from './cloudApi';
import { sha256File, readHead } from '../utils/sha256';
import { checkMediaFile, contentMatches, extOf, mediaTypeOf } from '../../shared/mediaTypes';

const MULTIPART_OVER = 20 * 1024 * 1024; // Vercel Blob multipart (parallel, retried parts)
const POLL_MS = 2500;

export const FINAL_STATES = ['completed', 'cancelled', 'expired'];

const REASON_TEXT = {
  'too-large': null, // server message is specific
  'unsupported-type': 'This file type is not supported.',
  'insufficient-storage': null,
  'checksum-mismatch': 'The file arrived damaged on the display. Retry the transfer.',
  'size-mismatch': 'The upload was incomplete. Retry the transfer.',
  'content-mismatch': null,
  'agent-update-required': null,
  'blob-not-configured': 'File transfer is not available right now (server storage not configured). Please contact support.',
  'not-owner': 'This display is no longer registered to your account.',
};

function errorText(error, context) {
  const reason = error.response?.data?.reason;
  if (reason && REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (error.response?.data?.error) return error.response.data.error;
  return cloudError(error, context);
}

const post = (action, body, timeout = 20000) => axios.post(`/api/transfer?action=${action}`, body, { timeout });

export async function listTransfers() {
  try {
    const res = await axios.get('/api/transfer?action=list', { timeout: 15000 });
    return { ok: true, transfers: res.data.transfers || [] };
  } catch (error) {
    return { ok: false, error: errorText(error, 'Loading transfers') };
  }
}

export async function getTransfer(id) {
  const res = await axios.get(`/api/transfer?action=status&id=${encodeURIComponent(id)}`, { timeout: 15000 });
  return res.data.transfer;
}

export async function cancelTransfer(id) {
  try {
    const res = await post('cancel', { transferId: id });
    return { ok: true, transfer: res.data.transfer };
  } catch (error) {
    return { ok: false, error: errorText(error, 'Cancel') };
  }
}

/**
 * Check a file before anything is uploaded: type, browser MIME, real content
 * (magic bytes) and size limit. Returns an error message or ''.
 */
export async function precheckFile(file, maxBytes) {
  const typeError = checkMediaFile(file.name, file.type);
  if (typeError) return typeError;
  if (file.size === 0) return 'The file is empty.';
  if (maxBytes && file.size > maxBytes) {
    return `This file is ${Math.ceil(file.size / 1048576)} MB. The limit is ${Math.floor(maxBytes / 1048576)} MB.`;
  }
  try {
    if (!contentMatches(extOf(file.name), await readHead(file, 32))) {
      return `"${file.name}" is not a valid ${extOf(file.name).toUpperCase()} file (its content does not match the extension).`;
    }
  } catch {
    return 'Could not read the file.';
  }
  return '';
}

/** Checksum cache so one file sent to several displays is hashed once. */
const hashCache = new WeakMap();
export async function fileChecksum(file, opts) {
  if (hashCache.has(file)) return hashCache.get(file);
  const p = sha256File(file, opts);
  hashCache.set(file, p);
  try {
    return await p;
  } catch (err) {
    hashCache.delete(file);
    throw err;
  }
}

async function uploadToRelay(file, transferId, pathname, { onProgress, signal }) {
  // The SDK throttles progress events; a trailing one can fire after the
  // upload finished. Ignore anything that arrives after this call returned.
  let finished = false;
  try {
    const blob = await upload(pathname, file, {
      access: 'public',
      handleUploadUrl: '/api/transfer?action=blob-token',
      clientPayload: JSON.stringify({ transferId }),
      multipart: file.size > MULTIPART_OVER,
      contentType: mediaTypeOf(file.name)?.mime,
      abortSignal: signal,
      onUploadProgress: ({ loaded, total }) => { if (!finished) onProgress?.(loaded, total || file.size); },
    });
    return blob.url;
  } finally {
    finished = true;
  }
}

/**
 * Wait until the Pi confirms (or the transfer fails / is cancelled / expires),
 * or until `waitMs` passes — then the transfer simply stays queued.
 */
export async function waitForTransfer(id, { onUpdate, signal, waitMs = 10 * 60 * 1000 } = {}) {
  const until = Date.now() + waitMs;
  let last = null;
  while (!signal?.aborted) {
    try {
      last = await getTransfer(id);
      onUpdate?.(last);
      if (FINAL_STATES.includes(last.state) || last.state === 'failed') return last;
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 404) throw new Error(errorText(error, 'Status'));
      // transient network problem: keep waiting
    }
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return last;
}

/**
 * Send one file to one cloud device.
 * onUpdate({ phase, loaded, total, transfer, error })
 *   phase: hashing | uploading | confirming | waiting | completed | failed | cancelled | expired
 * @returns {Promise<{ ok: boolean, transfer?: object, error?: string, phase: string }>}
 */
export async function sendFileViaRelay(device, file, { onUpdate, signal, waitMs } = {}) {
  let transferId = null;
  const emit = (u) => onUpdate?.({ transferId, ...u });
  try {
    emit({ phase: 'hashing', loaded: 0, total: file.size });
    const sha256 = await fileChecksum(file, { signal, onProgress: (f) => emit({ phase: 'hashing', loaded: f * file.size, total: file.size }) });

    let created;
    try {
      created = await post('create', { deviceId: device.piDeviceId, filename: file.name, size: file.size, sha256 });
    } catch (error) {
      return fail(errorText(error, 'Starting the transfer'));
    }
    transferId = created.data.transfer.id;
    return await uploadAndWait(file, created.data.transfer, created.data.uploadPathname, { emit, signal, waitMs });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return cancelled(transferId, emit);
    return fail(error?.message || 'Transfer failed');
  }

  function fail(msg) {
    emit({ phase: 'failed', error: msg });
    return { ok: false, phase: 'failed', error: msg, transferId };
  }
}

async function cancelled(transferId, emit) {
  if (transferId) await cancelTransfer(transferId);
  emit({ phase: 'cancelled' });
  return { ok: false, phase: 'cancelled', error: 'Cancelled', transferId };
}

async function uploadAndWait(file, transfer, pathname, { emit, signal, waitMs }) {
  const transferId = transfer.id;
  emit({ phase: 'uploading', loaded: 0, total: file.size, transfer });
  let url;
  try {
    url = await uploadToRelay(file, transferId, pathname, {
      signal,
      onProgress: (loaded, total) => emit({ phase: 'uploading', loaded, total }),
    });
  } catch (error) {
    if (signal?.aborted) return cancelled(transferId, emit);
    const msg = `Upload to the relay failed: ${error.message || 'network error'}. You can retry.`;
    emit({ phase: 'failed', error: msg, retryable: true });
    return { ok: false, phase: 'failed', error: msg, transferId, needsUpload: true };
  }

  emit({ phase: 'confirming' });
  let committed;
  try {
    committed = await post('commit', { transferId, url }, 60000);
  } catch (error) {
    const msg = errorText(error, 'Confirming the upload');
    emit({ phase: 'failed', error: msg, retryable: true });
    return { ok: false, phase: 'failed', error: msg, transferId };
  }
  emit({ phase: 'waiting', transfer: committed.data.transfer, deviceOnline: committed.data.deviceOnline });

  const final = await waitForTransfer(transferId, {
    signal,
    waitMs,
    onUpdate: (t) => emit({ phase: t.state === 'queued' ? 'waiting' : t.state, transfer: t, error: t.error, loaded: t.receivedBytes, total: t.size }),
  });
  if (signal?.aborted) return cancelled(transferId, emit);
  if (final?.state === 'completed') return { ok: true, phase: 'completed', transfer: final, transferId };
  if (final?.state === 'queued') return { ok: false, phase: 'waiting', transfer: final, transferId };
  return { ok: false, phase: final?.state || 'failed', transfer: final, error: final?.error, transferId };
}

/**
 * Retry a failed transfer. If the relay copy still exists the Pi downloads it
 * again; otherwise `file` (re-selected by the customer if the page was
 * reloaded) is uploaded again — it must have the same checksum.
 */
export async function retryTransferWithFile(transferId, file, { onUpdate, signal, waitMs } = {}) {
  const emit = (u) => onUpdate?.({ transferId, ...u });
  let res;
  try {
    res = await post('retry', { transferId });
  } catch (error) {
    const msg = errorText(error, 'Retry');
    emit({ phase: 'failed', error: msg });
    return { ok: false, phase: 'failed', error: msg, transferId };
  }
  const t = res.data.transfer;
  if (!res.data.needsUpload) {
    emit({ phase: 'waiting', transfer: t });
    const final = await waitForTransfer(transferId, {
      signal, waitMs, onUpdate: (x) => emit({ phase: x.state === 'queued' ? 'waiting' : x.state, transfer: x, error: x.error }),
    });
    return { ok: final?.state === 'completed', phase: final?.state === 'queued' ? 'waiting' : final?.state, transfer: final, error: final?.error, transferId };
  }
  if (!file) {
    emit({ phase: 'failed', error: 'Select the same file again to resume this transfer.', needsFile: true });
    return { ok: false, phase: 'failed', needsFile: true, transferId };
  }
  emit({ phase: 'hashing', loaded: 0, total: file.size });
  const sha = await fileChecksum(file, { signal });
  if (sha !== t.sha256 || file.size !== t.size) {
    const msg = 'This is not the same file as the original transfer. Start a new upload instead.';
    emit({ phase: 'failed', error: msg });
    return { ok: false, phase: 'failed', error: msg, transferId };
  }
  return uploadAndWait(file, t, res.data.uploadPathname, { emit, signal, waitMs });
}
