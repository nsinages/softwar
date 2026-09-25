// =============================================
// N Signage V2 — Device API (local config CRUD)
// Thin wrapper around the localStorage store
// =============================================

export {
  getDevices,
  getDeviceById,
  getDeviceByClassroom,
  saveDevice,
  updateDevice,
  deleteDevice,
  resetDevicesToDefault,
  getClassrooms,
  getUniqueDepartments,
  getBlocksByDepartment,
  getClassroomsByDeptAndBlock,
  getSettings,
  saveSettings,
} from '../data/store';
