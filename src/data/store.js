// =============================================
// N Signage V2 — Local Data Store
// localStorage-backed config for devices/classrooms
// =============================================

const DEVICES_KEY = 'nsignage_devices';
const SETTINGS_KEY = 'nsignage_settings';

// --- Seed / default devices ---
const SEED_DEVICES = [];

// --- Helpers ---
function generateId() {
  return 'dev-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
}

function initDevices() {
  const existing = localStorage.getItem(DEVICES_KEY);
  if (!existing) {
    localStorage.setItem(DEVICES_KEY, JSON.stringify(SEED_DEVICES));
  }
}

// --- Device CRUD ---
export function getDevices() {
  initDevices();
  try {
    return JSON.parse(localStorage.getItem(DEVICES_KEY)) || [];
  } catch {
    return [];
  }
}

export function getDeviceById(id) {
  return getDevices().find((d) => d.id === id) || null;
}

export function getDeviceByDeviceId(deviceId) {
  return getDevices().find((d) => d.deviceId === deviceId) || null;
}

export function saveDevice(deviceData) {
  const devices = getDevices();
  const newDevice = {
    ...deviceData,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  devices.push(newDevice);
  localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
  return newDevice;
}

export function updateDevice(id, updates) {
  const devices = getDevices();
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) throw new Error('Device not found');
  devices[idx] = { ...devices[idx], ...updates, updatedAt: new Date().toISOString() };
  localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
  return devices[idx];
}

export function deleteDevice(id) {
  const devices = getDevices().filter((d) => d.id !== id);
  localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
}

export function resetDevicesToDefault() {
  localStorage.setItem(DEVICES_KEY, JSON.stringify(SEED_DEVICES));
}



// --- Settings ---
export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function defaultSettings() {
  return {
    theme: 'light',
    pollInterval: 30,      // seconds
    uploadSizeWarning: 500, // MB
    apiPort: 5000,
  };
}
