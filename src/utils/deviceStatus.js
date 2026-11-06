// =============================================
// N Signage — one rule for "is this display online?" used by every counter
// and table, so they never disagree.
//
//   1. a live status check (usePiStatus statusMap) wins when it exists;
//   2. otherwise the server-reported heartbeat (cloud mode: device.online);
//   3. a saved name + IP record (registration 'saved') is neither online nor offline.
// In LAN mode device.online is undefined, so only live checks count (unchanged).
// =============================================

/** 'online' | 'offline' | 'saved' | 'unknown' */
export function deviceState(device, statusMap = {}) {
  if (device.registration === 'saved') return 'saved';
  const st = statusMap[device.id];
  if (st) return st.ok ? 'online' : 'offline';
  if (typeof device.online === 'boolean') return device.online ? 'online' : 'offline';
  return 'unknown';
}

export const isOnline = (device, statusMap) => deviceState(device, statusMap) === 'online';
export const isOffline = (device, statusMap) => deviceState(device, statusMap) === 'offline';
