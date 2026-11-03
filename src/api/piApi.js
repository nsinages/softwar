// =============================================
// N Signage V2 — Raspberry Pi API Service
// Communicates with Pi Flask APIs over LAN
// =============================================

import axios from 'axios';
import { getSettings } from '../data/store';

const STATUS_TIMEOUT = 5000;    // 5s for status checks
const UPLOAD_TIMEOUT = 600000;  // 10min for uploads (large videos over Wi-Fi)
const DEFAULT_TIMEOUT = 10000;  // 10s for other calls

// Requests go through the same-origin proxy (/pi-proxy, served by Vite in
// development and by server/index.js in production). Set VITE_PI_DIRECT=true
// only when the site is hosted elsewhere and every Pi has CORS enabled.
const PI_DIRECT = import.meta.env.VITE_PI_DIRECT === 'true';

export const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|m4v|webm|mov)$/i;
export const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime',
];

/** Port of a device, falling back to the port configured in Settings. */
export function devicePort(device) {
  const port = Number(device?.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : getSettings().apiPort;
}

function piUrl(ip, port) {
  return PI_DIRECT ? `http://${ip}:${port}` : `/pi-proxy/${ip}/${port}`;
}

function authHeaders() {
  const { apiKey } = getSettings();
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

/** URL of a media file on a Pi, usable in <img>/<video> src. */
export function piMediaUrl(device, filename) {
  return `${piUrl(device.ip, devicePort(device))}/media/${encodeURIComponent(filename)}`;
}

/**
 * Normalize errors into a user-friendly message
 */
function normalizeError(error, context = 'Operation') {
  if (axios.isCancel(error)) {
    return `${context} cancelled.`;
  }
  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return `${context} timed out. The Raspberry Pi may be offline or unreachable.`;
  }
  if (error.code === 'ERR_NETWORK' || error.message?.includes('Network Error')) {
    return `${context} failed: Network error. Check that the Pi is online and reachable at this IP.`;
  }
  if (error.response) {
    const status = error.response.status;
    const data = error.response.data;
    const msg = typeof data === 'string' ? data.slice(0, 200) : data?.error || data?.message;
    if (status === 401) return `${context} failed: The Pi rejected the API key. Set the correct key in Settings.`;
    if (status === 403) return `${context} failed: ${msg || 'Access denied'}.`;
    if (status === 404) return `${context} failed: Not found on the Pi (HTTP 404). Ensure the Pi is running the latest N-Signage server.`;
    if (status === 413) return `${context} failed: File too large for the Pi to accept.`;
    if (status === 502) return `${context} failed: The Raspberry Pi is unreachable.`;
    if (status >= 500) return `${context} failed: Pi server error — ${msg || 'unknown error'}.`;
    return `${context} failed (HTTP ${status}): ${msg || 'Unknown server error'}.`;
  }
  return `${context} failed: ${error.message || 'Unknown error'}`;
}

// =============================================
// GET /api/status
// =============================================
/**
 * Get the current status of a Raspberry Pi.
 * @param {{ip: string, port?: number}} device
 * @returns {Promise<{ok: boolean, data?: object, error?: string, latency?: number}>}
 */
export async function getPiStatus(device) {
  const start = Date.now();
  try {
    const res = await axios.get(`${piUrl(device.ip, devicePort(device))}/api/status`, {
      timeout: STATUS_TIMEOUT,
    });
    return {
      ok: true,
      data: res.data,
      latency: Date.now() - start,
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizeError(error, 'Status check'),
      latency: Date.now() - start,
    };
  }
}

// =============================================
// GET /api/media
// =============================================
/**
 * Get the list of media files on a Raspberry Pi.
 * @param {{ip: string, port?: number}} device
 * @returns {Promise<{ok: boolean, data?: Array, error?: string}>}
 */
export async function getPiMedia(device) {
  try {
    const res = await axios.get(`${piUrl(device.ip, devicePort(device))}/api/media`, {
      timeout: DEFAULT_TIMEOUT,
    });
    // Accept array or { media: [...] } shaped responses
    const rawList = Array.isArray(res.data)
      ? res.data
      : res.data?.media || res.data?.files || [];
    // Older Pi servers return plain filename strings — normalize to objects
    const mediaList = rawList
      .map((m) => (typeof m === 'string' ? { name: m } : m))
      .filter((m) => m && typeof (m.filename || m.name) === 'string');
    return { ok: true, data: mediaList };
  } catch (error) {
    return { ok: false, error: normalizeError(error, 'Fetch media') };
  }
}

// =============================================
// POST /api/upload
// =============================================
/**
 * Upload a media file to a Raspberry Pi.
 * @param {{ip: string, port?: number}} device
 * @param {File} file - File object from input
 * @param {function} [onProgress] - Progress callback (0–100)
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
export async function uploadMedia(device, file, onProgress = null) {
  if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXT.test(file.name)) {
    return {
      ok: false,
      error: `Unsupported file type: "${file.type || file.name}". Allowed: JPG, PNG, GIF, WEBP, MP4, M4V, WEBM, MOV`,
    };
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await axios.post(`${piUrl(device.ip, devicePort(device))}/api/upload`, formData, {
      timeout: UPLOAD_TIMEOUT,
      headers: authHeaders(),
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const pct = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(pct);
        }
      },
    });
    return { ok: true, data: res.data };
  } catch (error) {
    return { ok: false, error: normalizeError(error, 'Upload') };
  }
}

// =============================================
// DELETE /api/media/<filename>
// =============================================
/**
 * Delete a media file from a Raspberry Pi.
 * @param {{ip: string, port?: number}} device
 * @param {string} filename - Filename to delete
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
export async function deleteMedia(device, filename) {
  if (!filename) return { ok: false, error: 'No filename provided.' };
  try {
    const res = await axios.delete(
      `${piUrl(device.ip, devicePort(device))}/api/media/${encodeURIComponent(filename)}`,
      { timeout: DEFAULT_TIMEOUT, headers: authHeaders() }
    );
    return { ok: true, data: res.data };
  } catch (error) {
    return { ok: false, error: normalizeError(error, 'Delete') };
  }
}

// =============================================
// Batch status check
// =============================================
/**
 * Check the status of multiple Pis in parallel.
 * @param {Array<{id, ip, port?}>} devices
 * @returns {Promise<Object>} map of id -> status result
 */
export async function checkAllDevices(devices) {
  const results = await Promise.all(
    devices.map((d) => getPiStatus(d).then((r) => ({ id: d.id, ...r })))
  );
  const map = {};
  results.forEach((r) => {
    map[r.id] = r;
  });
  return map;
}
