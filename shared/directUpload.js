// =============================================
// N Signage — chunk upload to a Pi's receiver (browser and Node; no dependencies)
//
// Sends the encrypted chunks of one transfer straight to the Pi receiver
// (https://p-<id>.nsinages.in → Cloudflare Tunnel → 127.0.0.1 on the Pi).
// Resumes from the Pi's next expected chunk, retries network errors and
// temporary HTTP errors, and renews an expired ticket. Never touches the website
// with media bytes. Used by src/api/transferApi.js and by the tests.
// =============================================
import { encryptChunk } from './e2eCrypto.js';

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 15000, 30000, 30000];
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export const RECEIVER_REASON_TEXT = {
  'checksum-mismatch': 'The file arrived damaged on the display. Retry the transfer.',
  'decrypt-failed': 'A part of the file was damaged on the way to the display. Retry the transfer.',
  'insufficient-storage': 'Not enough free space on the display.',
  'not-allowed': 'The transfer is no longer allowed (it was cancelled, expired, or the display was removed).',
  'wrong-device': 'Security check failed: the ticket was for another display.',
  'unsupported-type': 'This file type is not supported.',
};

export class TransferError extends Error {
  constructor(message, { reason, retryable = false } = {}) { super(message); this.reason = reason; this.retryable = retryable; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});

/**
 * @param {object} o
 * @param {Blob} o.file                 the plaintext file (read chunk by chunk, never whole)
 * @param {{id,size,sha256}} o.transfer
 * @param {string} o.ticket, o.uploadUrl  from the website
 * @param {number} o.chunkBytes
 * @param {object} o.keyed               from deriveChunkKey()
 * @param {function} o.renew             → new ticket string (same browser key)
 * @returns {Promise<{done:true, savedAs:string, sha256:string}>}
 */
export async function uploadChunks({ file, transfer, ticket: firstTicket, uploadUrl, chunkBytes, keyed, onProgress, signal, renew, fetchImpl = globalThis.fetch, delays = RETRY_DELAYS_MS }) {
  let ticket = firstTicket;
  const base = `${uploadUrl}/v1/transfers/${encodeURIComponent(transfer.id)}`;
  const n = Math.ceil(transfer.size / chunkBytes);

  async function request(method, url, body) {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      let res; let data = {};
      try {
        res = await fetchImpl(url, {
          method, signal, body,
          headers: { Authorization: `Bearer ${ticket}`, 'X-NS-EPK': keyed.epk, ...(body && { 'Content-Type': 'application/octet-stream' }) },
        });
        data = await res.json().catch(() => ({}));
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        if (attempt >= delays.length) {
          throw new TransferError('The connection to the display was lost. You can retry: the transfer resumes where it stopped.', { reason: 'network', retryable: true });
        }
        await sleep(delays[attempt], signal);
        continue;
      }
      if (res.ok) return data;
      if (res.status === 409 && Number.isInteger(data.nextIndex)) return { ...data, resync: true };
      if (res.status === 401 && ['ticket-expired', 'ticket-not-yet-valid', 'unknown-ticket-key'].includes(data.reason) && attempt < 3) {
        ticket = await renew();
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < delays.length) {
        await sleep(delays[attempt], signal);
        continue;
      }
      throw new TransferError(RECEIVER_REASON_TEXT[data.reason] || data.error || `The display refused the transfer (HTTP ${res.status}).`,
        { reason: data.reason, retryable: RETRYABLE_STATUS.has(res.status) });
    }
  }

  const status = await request('GET', base);
  if (status.done) return status;
  let i = status.nextIndex || 0;
  onProgress?.(status.receivedBytes || 0);
  while (i < n) {
    const start = i * chunkBytes;
    const plain = new Uint8Array(await file.slice(start, Math.min(transfer.size, start + chunkBytes)).arrayBuffer());
    const body = await encryptChunk(keyed, { index: i, plain, size: transfer.size, sha256: transfer.sha256 });
    const r = await request('PUT', `${base}/chunks/${i}`, body);
    if (r.done) { onProgress?.(transfer.size); return r; }
    i = r.nextIndex;
    onProgress?.(r.receivedBytes ?? Math.min(transfer.size, i * chunkBytes));
  }
  const final = await request('GET', base);
  if (!final.done) throw new TransferError('The display did not confirm the file. Retry the transfer.', { reason: 'not-confirmed', retryable: true });
  return final;
}
