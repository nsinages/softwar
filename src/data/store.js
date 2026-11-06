// =============================================
// N Signage V2 — Local Data Store
// LAN dashboard: devices and settings are kept in this browser's localStorage.
// Customer website (cloud mode): the device list lives IN MEMORY only. It is
// loaded from the server (Supabase) after sign-in and on every page load, and
// is never written to browser storage, so nothing about a customer's displays
// stays in the browser after the tab is closed.
// =============================================
import { isCloudMode } from '../api/mode';

const DEVICES_KEY = 'nsignage_devices';
export const DEVICES_CHANGED_EVENT = 'nsignage:devices-changed';
const SETTINGS_KEY = 'nsignage_settings';

// --- Helpers ---
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `dev-${crypto.randomUUID()}`;
  return 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    throw new Error(`Could not save to browser storage: ${err.message}`);
  }
  if (key === DEVICES_KEY) {
    try { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); } catch { /* non-browser */ }
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// --- Device list storage: memory (cloud) or localStorage (LAN) ---
let memoryDevices = [];

function readDevices() {
  return isCloudMode() ? memoryDevices : readJson(DEVICES_KEY, []);
}

function writeDevices(list) {
  if (!isCloudMode()) { writeJson(DEVICES_KEY, list); return; }
  memoryDevices = list;
  try { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); } catch { /* non-browser */ }
}

// --- Device CRUD ---
export function getDevices() {
  const list = readDevices();
  return Array.isArray(list) ? list.filter((d) => d && typeof d === 'object' && d.id) : [];
}

export function saveDevice(deviceData) {
  const devices = getDevices();
  const newDevice = {
    ...deviceData,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  devices.push(newDevice);
  writeDevices(devices);
  return newDevice;
}

export function updateDevice(id, updates) {
  const devices = getDevices();
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) throw new Error('Device not found');
  devices[idx] = { ...devices[idx], ...updates, id, updatedAt: new Date().toISOString() };
  writeDevices(devices);
  return devices[idx];
}

export function deleteDevice(id) {
  writeDevices(getDevices().filter((d) => d.id !== id));
}

export function clearAllDevices() {
  writeDevices([]);
}

/** Replace the whole list (cloud mode: this account's devices from the server). */
export function replaceDevices(list) {
  writeDevices(Array.isArray(list) ? list : []);
}

// --- Settings ---
export const SETTINGS_LIMITS = {
  pollInterval: { min: 5, max: 300 },
  uploadSizeWarning: { min: 10, max: 5000 },
  apiPort: { min: 1, max: 65535 },
};

function defaultSettings() {
  return {
    pollInterval: 30,       // seconds
    uploadSizeWarning: 500, // MB
    apiPort: 5000,
    apiKey: '',             // must match NSIGNAGE_API_KEY on the Pis (optional)
  };
}

function normalizeSettings(s) {
  const d = defaultSettings();
  const L = SETTINGS_LIMITS;
  return {
    pollInterval: clampInt(s?.pollInterval, L.pollInterval.min, L.pollInterval.max, d.pollInterval),
    uploadSizeWarning: clampInt(s?.uploadSizeWarning, L.uploadSizeWarning.min, L.uploadSizeWarning.max, d.uploadSizeWarning),
    apiPort: clampInt(s?.apiPort, L.apiPort.min, L.apiPort.max, d.apiPort),
    apiKey: typeof s?.apiKey === 'string' ? s.apiKey.trim() : d.apiKey,
  };
}

export function getSettings() {
  return normalizeSettings(readJson(SETTINGS_KEY, {}));
}

export function saveSettings(settings) {
  const clean = normalizeSettings(settings);
  writeJson(SETTINGS_KEY, clean);
  return clean;
}
