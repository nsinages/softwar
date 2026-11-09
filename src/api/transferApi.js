// =============================================
// N Signage — direct, end-to-end encrypted transfers to cloud devices
//
//   this browser ──encrypted chunks──► the Pi's upload receiver (Cloudflare Tunnel)
//   this browser ──metadata + tickets──► N-Signage website (never any media bytes)
//
// Every chunk is encrypted in this browser with a key derived from the Pi's
// receiver key (shared/e2eCrypto.js). The website and Cloudflare cannot read
// the file. Nothing is stored in the cloud: if the display is offline the
// transfer is refused, not queued.
//
// Success is reported ONLY when the Pi confirms it saved the file after
// checking its size and SHA-256.
// =============================================
import axios from 'axios';
import { cloudError } from './cloudApi';
import { sha256File, readHead } from '../utils/sha256';
import { checkMediaFile, contentMatches, extOf } from '../../shared/mediaTypes';
import { createUploadSession, deriveChunkKey, receiverFingerprint } from '../../shared/e2eCrypto';
import { uploadChunks, TransferError, RECEIVER_REASON_TEXT } from '../../shared/directUpload';

export const FINAL_STATES = ['completed', 'cancelled', 'expired'];

const REASON_TEXT = {
  ...RECEIVER_REASON_TEXT,
  'too-large': null, // server message is specific
  'unsupported-type': 'This file type is not supported.',
  'insufficient-storage': null,
  'checksum-mismatch': 'The file arrived damaged on the display. Retry the transfer.',
  'decrypt-failed': 'A part of the file was damaged on the way to the display. Retry the transfer.',
  'display-offline': 'The display is offline, so the file cannot be sent now. Nothing was uploaded. Try again when the display is online.',
  'no-receiver': 'This display cannot receive files from the website yet: its secure upload service is not installed.',
  'key-change-pending': 'This display reported a new security key. Confirm it on the Devices page before sending files.',
  'upload-not-configured': 'Sending files is not available right now. Please contact support.',
  'not-allowed': 'The transfer is no longer allowed (it was cancelled, expired, or the display was removed).',
  'wrong-device': 'Security check failed: the ticket was for another display.',
  'not-owner': 'This display is no longer registered to your account.',
  'device-not-verified': null,
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

export async function getUploadTarget(deviceId) {
  const res = await axios.get(`/api/transfer?action=target&deviceId=${encodeURIComponent(deviceId)}`, { timeout: 15000 });
  return res.data.receiver;
}

export async function cancelTransfer(id) {
  try {
    const res = await post('cancel', { transferId: id });
    return { ok: true, transfer: res.data.transfer };
  } catch (error) {
    return { ok: false, error: errorText(error, 'Cancel') };
  }
}

export async function confirmDisplayKey(deviceId, fingerprint) {
  try {
    await post('confirm-key', { deviceId, fingerprint });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error, 'Confirming the display key') };
  }
}

/**
 * Check a file before anything is sent: type, browser MIME, real content
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

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});

/** Receiver details from the website; refuses when the display cannot take the file now. */
async function readyTarget(deviceId) {
  let target;
  try {
    target = await getUploadTarget(deviceId);
  } catch (error) {
    throw new TransferError(errorText(error, 'Checking the display'), { reason: error.response?.data?.reason });
  }
  if (!target?.available) throw new TransferError(REASON_TEXT['no-receiver'], { reason: 'no-receiver' });
  if (target.keyChangePending) throw new TransferError(REASON_TEXT['key-change-pending'], { reason: 'key-change-pending' });
  if (!target.online || !target.url) throw new TransferError(REASON_TEXT['display-offline'], { reason: 'display-offline' });
  if ((await receiverFingerprint(target.publicKey)) !== target.fingerprint) {
    throw new TransferError('Security check failed: the display key does not match its fingerprint.', { reason: 'bad-key' });
  }
  return target;
}

/** After the Pi saved the file it reports to the website; wait briefly for that record. */
async function confirmedTransfer(id, signal) {
  const until = Date.now() + 20000;
  let last = null;
  while (Date.now() < until && !signal?.aborted) {
    try {
      last = await getTransfer(id);
      if (last.state !== 'created') return last;
    } catch { /* keep trying */ }
    await sleep(1000, signal).catch(() => {});
  }
  return last;
}

async function runUpload({ file, deviceId, start, emit, signal, fetchImpl }) {
  const target = await readyTarget(deviceId);
  const session = await createUploadSession({ receiverPublicKey: target.publicKey, deviceId });
  let info;
  try {
    info = await start(session.epk);
  } catch (error) {
    throw new TransferError(errorText(error, 'Starting the transfer'), { reason: error.response?.data?.reason });
  }
  const { transfer } = info;
  emit({ transferId: transfer.id, transfer });
  const keyed = await deriveChunkKey(session, transfer.id);
  emit({ phase: 'uploading', loaded: 0, total: transfer.size });
  const renew = async () => (await post('ticket', { transferId: transfer.id, epk: session.epk })).data.ticket;
  const result = await uploadChunks({
    file, transfer, ticket: info.ticket, uploadUrl: info.uploadUrl, chunkBytes: info.chunkBytes, keyed, signal, renew, fetchImpl,
    onProgress: (loaded) => emit({ phase: 'uploading', loaded, total: transfer.size }),
  });
  emit({ phase: 'confirming' });
  const recorded = await confirmedTransfer(transfer.id, signal);
  return { transfer: recorded || transfer, savedAs: result.savedAs };
}

/**
 * Send one file to one cloud device, directly and encrypted.
 * onUpdate({ phase, loaded, total, transfer, error })   phase: hashing | uploading | confirming | completed | failed | cancelled
 */
export async function sendFileDirect(device, file, { onUpdate, signal, fetchImpl } = {}) {
  let transferId = null;
  const emit = (u) => { if (u.transferId) transferId = u.transferId; onUpdate?.({ transferId, ...u }); };
  try {
    emit({ phase: 'hashing', loaded: 0, total: file.size });
    const sha256 = await fileChecksum(file, { signal, onProgress: (f) => emit({ phase: 'hashing', loaded: f * file.size, total: file.size }) });
    const { transfer, savedAs } = await runUpload({
      file, deviceId: device.piDeviceId, emit, signal, fetchImpl,
      start: async (epk) => (await post('create', { deviceId: device.piDeviceId, filename: file.name, size: file.size, sha256, epk })).data,
    });
    return finish(transfer, savedAs, emit, transferId);
  } catch (error) {
    return failure(error, emit, transferId, signal);
  }
}

/**
 * Retry or resume an unfinished transfer (also after a page reload): the
 * customer re-selects the same file (checked by SHA-256); a new one-time key
 * and ticket are used and the Pi continues from the next chunk it needs.
 */
export async function retryTransferWithFile(transferId, file, { onUpdate, signal, fetchImpl } = {}) {
  const emit = (u) => onUpdate?.({ transferId, ...u });
  try {
    const current = await getTransfer(transferId);
    if (current.method !== 'direct') throw new TransferError('This older transfer cannot be resumed. Send the file again.', { reason: 'bad-method' });
    if (!file) {
      emit({ phase: 'failed', error: 'Select the same file again to resume this transfer.', needsFile: true });
      return { ok: false, phase: 'failed', needsFile: true, transferId };
    }
    emit({ phase: 'hashing', loaded: 0, total: file.size });
    const sha = await fileChecksum(file, { signal });
    if (sha !== current.sha256 || file.size !== current.size) {
      throw new TransferError('This is not the same file as the original transfer. Start a new upload instead.', { reason: 'different-file' });
    }
    const { transfer, savedAs } = await runUpload({
      file, deviceId: current.deviceId, emit, signal, fetchImpl,
      start: async (epk) => (await post('ticket', { transferId, epk })).data,
    });
    return finish(transfer, savedAs, emit, transferId);
  } catch (error) {
    return failure(error, emit, transferId, signal);
  }
}

function finish(transfer, savedAs, emit, transferId) {
  if (transfer?.state === 'completed') {
    emit({ phase: 'completed', transfer });
    return { ok: true, phase: 'completed', transfer, transferId };
  }
  const msg = transfer?.error || `The display saved the file${savedAs ? ` as "${savedAs}"` : ''}, but the website has not recorded it yet. Check Recent transfers in a moment.`;
  emit({ phase: transfer?.state === 'failed' ? 'failed' : 'confirming', transfer, error: msg });
  return { ok: false, phase: transfer?.state || 'failed', transfer, error: msg, transferId };
}

async function failure(error, emit, transferId, signal) {
  if (signal?.aborted || error?.name === 'AbortError') {
    if (transferId) await cancelTransfer(transferId);
    emit({ phase: 'cancelled' });
    return { ok: false, phase: 'cancelled', error: 'Cancelled', transferId };
  }
  const msg = error?.message || 'Transfer failed';
  emit({ phase: 'failed', error: msg, retryable: Boolean(error?.retryable) });
  return { ok: false, phase: 'failed', error: msg, reason: error?.reason, transferId, retryable: Boolean(error?.retryable) };
}
