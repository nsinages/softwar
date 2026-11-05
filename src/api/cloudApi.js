// =============================================
// N Signage — Cloud relay client
//
// Used when the website is hosted on the internet (e.g. software.nsinages.in).
// A hosted site cannot reach a Raspberry Pi on the customer's Wi-Fi, so it
// talks to the cloud relay (/api/*) instead, and each Pi connects out to the
// same relay (N-Signage/app/cloud_agent.py).
// =============================================
import axios from 'axios';
import { upload } from '@vercel/blob/client';
import { replaceDevices } from '../data/store';

const PRIVATE_HOST_RX = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)|\.local$/i;

/**
 * 'cloud' when the site is served from a public domain, 'lan' when it is
 * opened from this machine or a LAN address (Vite dev / `npm start`).
 * Override at build time with VITE_CONNECTION_MODE=cloud|lan.
 */
export function connectionMode() {
  const forced = import.meta.env.VITE_CONNECTION_MODE;
  if (forced === 'cloud' || forced === 'lan') return forced;
  try {
    return PRIVATE_HOST_RX.test(window.location.hostname) ? 'lan' : 'cloud';
  } catch {
    return 'lan';
  }
}

export const isCloudMode = () => connectionMode() === 'cloud';

/** A Pi registered in the logged-in customer's cloud account. */
export const isCloudDevice = (device) => Boolean(device?.cloud && device?.piDeviceId);

/** Fired when any cloud call reports that the session has ended. */
export const LOGGED_OUT_EVENT = 'nsignage:logged-out';

function cloudError(error, context) {
  const data = error.response?.data;
  if (error.response?.status === 401 && data?.reason === 'not-logged-in') {
    try { window.dispatchEvent(new Event(LOGGED_OUT_EVENT)); } catch { /* non-browser */ }
  }
  if (data?.error) return `${context} failed: ${data.error}`;
  if (error.code === 'ECONNABORTED') return `${context} timed out. Check your internet connection.`;
  if (error.response?.status === 404) return `${context} failed: the cloud service is not available on this website yet.`;
  return `${context} failed: ${error.message || 'Unknown error'}`;
}

const deviceUrl = (device, action, extra = '') =>
  `/api/device?deviceId=${encodeURIComponent(device.piDeviceId)}&action=${action}${extra}`;

// ---- Find, add, rename, remove ---------------------------------------------

/**
 * Pis that synced with the cloud from this browser's network in the last
 * 2 minutes. `identifier` (Pi Linux username) is an optional filter.
 */
export async function cloudFindPi(identifier = '') {
  const q = identifier ? `?identifier=${encodeURIComponent(identifier)}` : '';
  try {
    const res = await axios.get(`/api/find${q}`, { timeout: 15000 });
    return { log: [], devices: [], ...res.data };
  } catch (error) {
    const data = error.response?.data;
    const status = error.response?.status;
    // 503 = relay up but its storage is not configured/reachable; no response = network/timeout
    const reason = data?.reason || (status === 503 ? 'cloud-not-configured' : status ? 'cloud-error' : 'cloud-unreachable');
    console.error(`[PI DISCOVERY] /api/find failed (${status || error.code || 'network'}): ${data?.error || error.message}`);
    return {
      found: false,
      identifier,
      reason,
      status,
      error: data?.error || cloudError(error, 'Cloud search'),
      devices: [],
      log: [...(data?.log || []), cloudError(error, 'Cloud search')],
    };
  }
}

/** Store-shaped record for a Pi in the account (see data/store.js). */
function toStoreDevice(d) {
  return {
    id: `cloud-${d.deviceId}`,
    cloud: true,
    piDeviceId: d.deviceId,
    deviceId: d.username,
    nickName: d.name || '',
    location: d.location || '',
    hostname: d.hostname || undefined,
    ip: d.ip || '',
    port: d.port || 5000,
    online: d.online,
    lastSeen: d.lastSeen,
    createdAt: d.addedAt ? new Date(d.addedAt).toISOString() : undefined,
  };
}

/** Load the account's Pis from the cloud into the local device cache. */
export async function syncCloudDevices() {
  try {
    const res = await axios.get('/api/devices', { timeout: 15000 });
    const list = (res.data.devices || []).map(toStoreDevice);
    replaceDevices(list);
    return { ok: true, devices: list };
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Loading your devices') };
  }
}

/** Add Device: register a Pi found by cloudFindPi in this account. */
export async function cloudClaim(claimNonce, { name, location } = {}) {
  try {
    const res = await axios.post('/api/devices', { claimNonce, name, location }, { timeout: 15000 });
    await syncCloudDevices();
    return { ok: true, device: toStoreDevice(res.data.device) };
  } catch (error) {
    return { ok: false, reason: error.response?.data?.reason, error: cloudError(error, 'Adding the device') };
  }
}

export async function cloudRename(device, { name, location }) {
  try {
    await axios.patch(`/api/devices?deviceId=${encodeURIComponent(device.piDeviceId)}`, { name, location }, { timeout: 15000 });
    await syncCloudDevices();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Saving the device') };
  }
}

export async function cloudRemove(device) {
  try {
    await axios.delete(`/api/devices?deviceId=${encodeURIComponent(device.piDeviceId)}`, { timeout: 20000 });
    await syncCloudDevices();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Removing the device') };
  }
}

// ---- Device actions (same result shapes as piApi.js) ------------------------

export async function cloudStatus(device) {
  const start = Date.now();
  try {
    const res = await axios.get(deviceUrl(device, 'status'), { timeout: 10000 });
    const latency = Date.now() - start;
    return res.data.ok
      ? { ok: true, data: res.data.data, latency, lastSeen: res.data.lastSeen }
      : { ok: false, error: res.data.error, data: res.data.data, latency, lastSeen: res.data.lastSeen };
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Status check'), latency: Date.now() - start };
  }
}

export async function cloudMedia(device) {
  try {
    const res = await axios.get(deviceUrl(device, 'media'), { timeout: 15000 });
    return { ok: true, data: res.data.media || [], pending: res.data.pending || [], online: res.data.online };
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Fetch media') };
  }
}

async function sendCommand(device, command) {
  const res = await axios.post(deviceUrl(device, 'command'), command, { timeout: 15000 });
  return res.data.command;
}

async function commandResult(device, id) {
  const res = await axios.get(deviceUrl(device, 'result', `&id=${encodeURIComponent(id)}`), { timeout: 10000 });
  return res.data;
}

/** Wait until the Pi reports a command as done/failed (or give up). */
async function waitForCommand(device, id, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const { result } = await commandResult(device, id);
      if (result.state === 'done' || result.state === 'failed') return result;
    } catch {
      // transient network error — keep waiting
    }
  }
  return { state: 'queued' };
}

const safeName = (name) =>
  name.replace(/[^A-Za-z0-9._ ()-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(-180) || 'media';

/**
 * Upload a file to the cloud, then ask the Pi to download it.
 * Progress: 0–90 % = upload to cloud, 90–100 % = Pi downloading.
 */
export async function cloudUpload(device, file, onProgress) {
  const filename = safeName(file.name);
  let blob;
  try {
    blob = await upload(`media/${device.piDeviceId}/${filename}`, file, {
      access: 'public',
      handleUploadUrl: '/api/device?action=upload',
      clientPayload: JSON.stringify({ deviceId: device.piDeviceId }),
      multipart: file.size > 20 * 1024 * 1024,
      contentType: file.type || undefined,
      onUploadProgress: ({ percentage }) => onProgress?.(Math.round(percentage * 0.9)),
    });
  } catch (error) {
    return { ok: false, error: `Upload to cloud failed: ${error.message || 'unknown error'}` };
  }

  let cmd;
  try {
    cmd = await sendCommand(device, { type: 'download', url: blob.url, filename, size: file.size });
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Sending to the Raspberry Pi') };
  }

  // Large videos take a while for a Pi to download; allow ~1 min + 10 s/MB
  const result = await waitForCommand(device, cmd.id, 60000 + (file.size / (1024 * 1024)) * 10000);
  onProgress?.(100);
  if (result.state === 'done') return { ok: true, data: { filename: result.filename || filename } };
  if (result.state === 'failed') return { ok: false, error: `The Raspberry Pi could not save the file: ${result.error}` };
  return {
    ok: true,
    data: { filename, queued: true },
    message: 'Uploaded to the cloud. The Raspberry Pi will download it as soon as it is online.',
  };
}

export async function cloudDelete(device, filename) {
  try {
    const cmd = await sendCommand(device, { type: 'delete', filename });
    const result = await waitForCommand(device, cmd.id, 20000);
    if (result.state === 'failed') return { ok: false, error: `Delete failed on the Raspberry Pi: ${result.error}` };
    return { ok: true, data: { queued: result.state !== 'done' } };
  } catch (error) {
    return { ok: false, error: cloudError(error, 'Delete') };
  }
}
