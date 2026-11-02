// =============================================
// N Signage V2 — Raspberry Pi API Service
// Communicates directly with Pi Flask APIs over LAN
// =============================================

import axios from 'axios';

const DEFAULT_PORT = 5000;
const STATUS_TIMEOUT = 5000;  // 5s for status checks
const UPLOAD_TIMEOUT = 120000; // 2min for uploads
const DEFAULT_TIMEOUT = 10000; // 10s for other calls

/**
 * Build the base URL for a Pi.
 * In development, route through the Vite dev-server proxy to avoid CORS.
 * In production, use the Pi's direct IP (Flask must have CORS enabled there).
 */
function piUrl(ip, port = DEFAULT_PORT) {
  if (import.meta.env.DEV) {
    // Vite proxy: /pi-proxy/<ip>/<port>/... → http://<ip>:<port>/...
    return `/pi-proxy/${ip}/${port}`;
  }
  return `http://${ip}:${port}`;
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
    const msg = data?.error || data?.message || data;
    if (status === 404) return `${context} failed: The upload endpoint (/api/upload) was not found on the Pi (HTTP 404). Ensure the Pi is running the latest N-Signage Flask server.`;
    if (status === 500) return `${context} failed: Pi server error — ${msg || 'unknown error'}.`;
    if (status === 413) return `${context} failed: File too large for the Pi to accept.`;
    return `${context} failed (HTTP ${status}): ${msg || 'Unknown server error'}.`;
  }
  return `${context} failed: ${error.message || 'Unknown error'}`;
}

// =============================================
// GET /api/status
// =============================================
/**
 * Get the current status of a Raspberry Pi.
 * @param {string} ip - Pi LAN IP address
 * @param {number} [port] - Flask API port (default 5000)
 * @returns {Promise<{ok: boolean, data?: object, error?: string, latency?: number}>}
 */
export async function getPiStatus(ip, port = DEFAULT_PORT) {
  const start = Date.now();
  try {
    const res = await axios.get(`${piUrl(ip, port)}/api/status`, {
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
 * @param {string} ip - Pi LAN IP address
 * @param {number} [port]
 * @returns {Promise<{ok: boolean, data?: Array, error?: string}>}
 */
export async function getPiMedia(ip, port = DEFAULT_PORT) {
  try {
    const res = await axios.get(`${piUrl(ip, port)}/api/media`, {
      timeout: DEFAULT_TIMEOUT,
    });
    // Accept array or { media: [...] } shaped responses
    const rawList = Array.isArray(res.data)
      ? res.data
      : res.data?.media || res.data?.files || [];
    // Older Pi servers return plain filename strings — normalize to objects
    const mediaList = rawList.map((m) => (typeof m === 'string' ? { name: m } : m));
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
 * @param {string} ip - Pi LAN IP address
 * @param {File} file - File object from input
 * @param {function} [onProgress] - Progress callback (0–100)
 * @param {number} [port]
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
export async function uploadMedia(ip, file, onProgress = null, port = DEFAULT_PORT) {
  // Validate file type
  const ALLOWED_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime',
  ];
  const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|m4v|webm|mov)$/i;

  if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXT.test(file.name)) {
    return {
      ok: false,
      error: `Unsupported file type: "${file.type || file.name}". Allowed: JPG, PNG, GIF, WEBP, MP4, M4V, WEBM, MOV`,
    };
  }

  const formData = new FormData();
  formData.append('file', file);

  const uploadUrl = `${piUrl(ip, port)}/api/upload`;

  try {
    console.log(`[piApi] Uploading to: ${uploadUrl} (file: ${file.name}, size: ${file.size})`);
    const res = await axios.post(uploadUrl, formData, {
      timeout: UPLOAD_TIMEOUT,
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const pct = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(pct);
        }
      },
    });
    console.log(`[piApi] Upload success:`, res.data);
    return { ok: true, data: res.data };
  } catch (error) {
    console.error(`[piApi] Upload failed:`, {
      url: uploadUrl,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      code: error.code,
    });
    return { ok: false, error: normalizeError(error, 'Upload') };
  }
}

// =============================================
// DELETE /api/media/<filename>
// =============================================
/**
 * Delete a media file from a Raspberry Pi.
 * @param {string} ip - Pi LAN IP address
 * @param {string} filename - Filename to delete
 * @param {number} [port]
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
export async function deleteMedia(ip, filename, port = DEFAULT_PORT) {
  if (!filename) return { ok: false, error: 'No filename provided.' };
  const encoded = encodeURIComponent(filename);
  try {
    const res = await axios.delete(`${piUrl(ip, port)}/api/media/${encoded}`, {
      timeout: DEFAULT_TIMEOUT,
    });
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
 * @param {Array<{id, ip}>} devices
 * @returns {Promise<Object>} map of id -> status result
 */
export async function checkAllDevices(devices) {
  const results = await Promise.allSettled(
    devices.map((d) => getPiStatus(d.ip).then((r) => ({ id: d.id, ...r })))
  );
  const map = {};
  results.forEach((r) => {
    if (r.status === 'fulfilled') {
      map[r.value.id] = r.value;
    }
  });
  return map;
}
