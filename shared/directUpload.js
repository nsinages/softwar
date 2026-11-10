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
  // ticket checks on the Pi (a fresh ticket is issued on Retry)
  'bad-ticket': 'Upload ticket validation failed on the display (the ticket is invalid or was not signed by the website). Retry the transfer.',
  'unknown-ticket-key': 'Upload ticket validation failed: the display does not know the website\'s current signing key yet. Retry in a minute.',
  'ticket-expired': 'Upload ticket validation failed: the ticket expired (check the display\'s clock and connection). Retry the transfer.',
  'ticket-not-yet-valid': 'Upload ticket validation failed: the ticket is not valid yet (check the display\'s clock). Retry the transfer.',
  'ticket-mismatch': 'Upload ticket validation failed: the ticket does not match this file. Start a new upload.',
  'wrong-transfer': 'Upload ticket validation failed: the ticket belongs to another transfer. Retry the transfer.',
  'wrong-key': 'Upload ticket validation failed: the encryption key does not match the ticket. Retry the transfer.',
  'origin': 'The display only accepts uploads from the official N-Signage website address. Open the website at its normal address and retry.',
  'cloud-unreachable': 'The display could not reach the N-Signage website to authorise the transfer (its internet connection may be down). Retry when it is back.',
  'out-of-order': 'The display expected a different part of the file. Retry: the transfer resumes where it stopped.',
  // readiness probe from the browser (probeReceiver)
  'tunnel-down': 'Cloudflare Tunnel is not connected: the display\'s upload service is running, but its upload address is not reachable through Cloudflare. Nothing was uploaded.',
  'tunnel-unreachable': 'The display\'s upload address cannot be reached from this browser (DNS or network problem). Nothing was uploaded.',
  'wrong-receiver': 'Security check failed: the display\'s upload address leads to a different upload service (wrong tunnel hostname). Nothing was uploaded.',
  'origin-mismatch': 'The display only accepts uploads from the official N-Signage website address, not from this one. Nothing was uploaded.',
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

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

/**
 * Can THIS browser reach the display's receiver through the Cloudflare Tunnel right now?
 * GET https://<hostname>/v1/health (no credentials, no media). The receiver answers it to any
 * origin with its key fingerprint, so a readable answer proves tunnel + receiver + the right Pi.
 * When it is not readable, a no-cors request tells "Cloudflare answered but the tunnel/receiver
 * did not" (tunnel not connected) apart from "nothing answered" (DNS / network).
 *   → { ok: true } | { ok: false, reason, message }
 */
export async function probeReceiver(target, { signal, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const url = `${target.url}/v1/health`;
  const host = hostOf(target.url);
  const attempt = async (init) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetchImpl(url, { method: 'GET', cache: 'no-store', credentials: 'omit', ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const cancelled = () => new DOMException('Cancelled', 'AbortError');
  const fail = (reason, extra = '') => ({ ok: false, reason, message: `${RECEIVER_REASON_TEXT[reason]}${extra}` });
  let res;
  try {
    res = await attempt({ mode: 'cors' });
  } catch {
    if (signal?.aborted) throw cancelled();
    try {
      await attempt({ mode: 'no-cors' });
      // Something (Cloudflare) answered for this hostname, but not our receiver: the tunnel is down,
      // or the receiver behind it is stopped/outdated. The website already knows the receiver is alive.
      return fail('tunnel-down', ` (${host})`);
    } catch {
      if (signal?.aborted) throw cancelled();
      return fail('tunnel-unreachable', ` (${host})`);
    }
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.service !== 'n-signage-upload') {
    return res.status >= 500 ? fail('tunnel-down', ` (${host}, HTTP ${res.status})`) : fail('wrong-receiver', ` (${host})`);
  }
  if (data.fingerprint && target.fingerprint && data.fingerprint !== target.fingerprint) return fail('wrong-receiver', ` (${host})`);
  if (data.originAllowed === false) return fail('origin-mismatch');
  return { ok: true, version: data.version || null };
}
