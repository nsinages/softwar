// =============================================
// N Signage V2 — Device API (local config CRUD)
// Thin wrapper around the localStorage store
// =============================================

export {
  getDevices,
  getDeviceById,
  getDeviceByDeviceId,
  saveDevice,
  updateDevice,
  deleteDevice,
  resetDevicesToDefault,
  getSettings,
  saveSettings,
} from '../data/store';
