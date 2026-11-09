// =============================================
// N Signage — LAN direct upload for account devices (DEVELOPMENT ONLY)
//
// When the signed-in customer's own registered Pi answers on this network, the
// file goes straight from the browser to the Pi's POST /api/upload: no website,
// no cloud storage, no proxy in between. Otherwise the caller uses the normal
// cloud transfer.
//
// Enabled only when ALL of these hold:
//   - `npm run dev` (import.meta.env.DEV; production builds never include it)
//   - VITE_LAN_DIRECT_UPLOAD=true in the local, git-ignored .env
//   - the page is http: (an https page cannot call an http Pi)
//   - the device is from the customer's account list (owner-checked by /api/devices),
//     verified, with a private IPv4 the Pi itself reported
//   - GET /api/status on that IP answers and its identity matches the account record:
//     device_id when the Pi reports one, otherwise pi_username AND hostname
//     (the current Pi server reports no device_id: acceptable for development only)
// =============================================

import axios from 'axios';

const PROBE_TIMEOUT = 1500;
const UPLOAD_TIMEOUT = 10 * 60 * 1000;
const VERIFY_TIMEOUT = 10000;

const PRIVATE_IPV4_RX = /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/;

export function lanUploadEnabled() {
  const env = import.meta.env || {};
  if (!env.DEV || env.VITE_LAN_DIRECT_UPLOAD !== 'true') return false;
  try {
    return window.location.protocol === 'http:';
  } catch {
    return false;
  }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();

/** Does the Pi answering at the device's IP match the account's record? */
export function identityMatches(device, status) {
  if (!status || typeof status !== 'object') return false;
  if (status.device_id) return status.device_id === device.piDeviceId;
  return same(status.pi_username, device.deviceId) && same(status.hostname, device.hostname);
}

/**
 * Base URL of the device on this network, or null when the LAN shortcut must
 * not be used (feature off, not reachable, or identity does not match).
 */
export async function findLanRoute(device, { signal } = {}) {
  if (!lanUploadEnabled()) return null;
  if (!device?.cloud || !device.piDeviceId || device.registration !== 'verified') return null;
  const ip = String(device.ip || '');
  const port = Number(device.port) || 5000;
  if (!PRIVATE_IPV4_RX.test(ip) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const base = `http://${ip}:${port}`;
  try {
    const res = await axios.get(`${base}/api/status`, { timeout: PROBE_TIMEOUT, signal });
    if (!identityMatches(device, res.data)) {
      console.warn(`[lan-upload] ${base} answered but is not "${device.deviceId}@${device.hostname}": using the cloud transfer`);
      return null;
    }
    return base;
  } catch {
    return null; // not on this network (or the Pi's web server is down): cloud transfer
  }
}

/**
 * Upload the file to the Pi and confirm it was saved (HEAD /media/<name> size
 * equals the file size). Never retries: a failure after the request started is
 * reported to the caller as an error.
 * @returns {Promise<{ok: boolean, savedAs?: string, error?: string, cancelled?: boolean}>}
 */
export async function uploadLan(base, file, { onProgress, signal } = {}) {
  const form = new FormData();
  form.append('file', file);
  let savedAs;
  try {
    const res = await axios.post(`${base}/api/upload`, form, {
      timeout: UPLOAD_TIMEOUT,
      signal,
      onUploadProgress: (e) => { if (e.total) onProgress?.(e.loaded, e.total); },
    });
    savedAs = res.data?.saved || res.data?.filename;
    if (typeof savedAs !== 'string' || !savedAs) {
      return { ok: false, error: 'The display did not say which file it saved. Check its media list before sending again.' };
    }
  } catch (error) {
    if (axios.isCancel(error)) return { ok: false, cancelled: true, error: 'Cancelled. The display may have received part of the file.' };
    const msg = error.response?.data?.error;
    return { ok: false, error: `Local network upload failed${msg ? `: ${msg}` : error.response ? ` (HTTP ${error.response.status})` : ' (connection lost)'}. It was not retried through the cloud.` };
  }
  try {
    const head = await axios.head(`${base}/media/${encodeURIComponent(savedAs)}`, { timeout: VERIFY_TIMEOUT });
    const size = Number(head.headers['content-length']);
    if (size !== file.size) {
      return { ok: false, savedAs, error: `The display saved "${savedAs}" but its size (${size} bytes) does not match the file (${file.size} bytes).` };
    }
  } catch {
    return { ok: false, savedAs, error: `The display reported "${savedAs}" saved, but it could not be checked.` };
  }
  return { ok: true, savedAs };
}
