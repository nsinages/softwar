// =============================================
// N Signage V2 — Local Data Store
// localStorage-backed config for devices/classrooms
// =============================================

const DEVICES_KEY = 'nsignage_devices';
const SETTINGS_KEY = 'nsignage_settings';

// --- Seed / default devices ---
const SEED_DEVICES = [
  {
    id: 'dev-1',
    name: 'N Signage - CSE - A101',
    department: 'Computer Science and Engineering',
    block: 'A Block',
    floor: '1st Floor',
    classroom: 'A101',
    ip: '10.10.40.94',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-2',
    name: 'N Signage - CSE - A102',
    department: 'Computer Science and Engineering',
    block: 'A Block',
    floor: '1st Floor',
    classroom: 'A102',
    ip: '10.10.40.95',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-3',
    name: 'N Signage - ECE - B101',
    department: 'Electronics and Communication Engineering',
    block: 'B Block',
    floor: '1st Floor',
    classroom: 'B101',
    ip: '10.10.40.96',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-4',
    name: 'N Signage - ECE - B102',
    department: 'Electronics and Communication Engineering',
    block: 'B Block',
    floor: '1st Floor',
    classroom: 'B102',
    ip: '10.10.40.97',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-5',
    name: 'N Signage - MECH - C201',
    department: 'Mechanical Engineering',
    block: 'C Block',
    floor: '2nd Floor',
    classroom: 'C201',
    ip: '10.10.40.98',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-6',
    name: 'N Signage - AI&DS - D101',
    department: 'Artificial Intelligence and Data Science',
    block: 'D Block',
    floor: '1st Floor',
    classroom: 'D101',
    ip: '10.10.40.99',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-7',
    name: 'N Signage - AI&ML - D102',
    department: 'Artificial Intelligence and Machine Learning',
    block: 'D Block',
    floor: '1st Floor',
    classroom: 'D102',
    ip: '10.10.40.100',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-8',
    name: 'N Signage - IT - E301',
    department: 'Information Technology',
    block: 'E Block',
    floor: '3rd Floor',
    classroom: 'E301',
    ip: '10.10.40.101',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-9',
    name: 'N Signage - BME - F201',
    department: 'Biomedical Engineering',
    block: 'F Block',
    floor: '2nd Floor',
    classroom: 'F201',
    ip: '10.10.40.102',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'dev-10',
    name: 'N Signage - CIVIL - LH1',
    department: 'Civil Engineering',
    block: '',
    floor: '',
    classroom: 'LH1',
    ip: '10.10.40.103',
    createdAt: new Date().toISOString(),
  },
];

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

export function getDeviceByClassroom(department, block, classroom) {
  return (
    getDevices().find(
      (d) =>
        d.department === department &&
        d.block === block &&
        d.classroom === classroom
    ) || null
  );
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

// --- Classroom helpers (derived from devices) ---
export function getClassrooms() {
  return getDevices().map((d) => ({
    id: d.id,
    department: d.department,
    block: d.block,
    floor: d.floor,
    classroom: d.classroom,
    ip: d.ip,
    deviceName: d.name,
  }));
}

export function getUniqueDepartments() {
  return [...new Set(getDevices().map((d) => d.department))].sort();
}

export function getBlocksByDepartment(department) {
  return [
    ...new Set(
      getDevices()
        .filter((d) => d.department === department)
        .map((d) => d.block)
    ),
  ].sort();
}

export function getClassroomsByDeptAndBlock(department, block) {
  return getDevices()
    .filter((d) => d.department === department && d.block === block)
    .map((d) => d.classroom)
    .sort();
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
    theme: 'dark',
    pollInterval: 30,      // seconds
    uploadSizeWarning: 500, // MB
    apiPort: 5000,
  };
}
