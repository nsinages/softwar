// =============================================
// N Signage V2 — Local Data Store
// localStorage-backed config for devices/classrooms
// =============================================

const DEVICES_KEY = 'nsignage_devices';
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
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// --- Device CRUD ---
export function getDevices() {
  const list = readJson(DEVICES_KEY, []);
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
  writeJson(DEVICES_KEY, devices);
  return newDevice;
}

export function updateDevice(id, updates) {
  const devices = getDevices();
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) throw new Error('Device not found');
  devices[idx] = { ...devices[idx], ...updates, id, updatedAt: new Date().toISOString() };
  writeJson(DEVICES_KEY, devices);
  return devices[idx];
}

export function deleteDevice(id) {
  writeJson(DEVICES_KEY, getDevices().filter((d) => d.id !== id));
}

export function clearAllDevices() {
  writeJson(DEVICES_KEY, []);
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
