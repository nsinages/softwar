// =============================================
// N Signage — "Pi Name" used by Add Device → Find IP
//
// The customer types the Pi Name; it matches the Raspberry Pi's Linux
// username OR its hostname (case-insensitive; "ns001", "ns001.local" and an
// FQDN whose first label is "ns001" all match hostname "ns001").
// Shared by the hosted search (/api/find), the local UDP/mDNS helper
// (discovery/piDiscovery.js) and the Add Device forms. The nickname is never
// a search key, and neither is an IP address.
// =============================================

/** Letters, digits, "_", "." and "-"; starts with a letter, digit or "_"; ≤ 63 chars. */
export const PI_NAME_RX = /^[a-z0-9_][a-z0-9_.-]{0,62}$/i;

export const PI_NAME_HINT = 'Use the Raspberry Pi\'s name: its Linux username or hostname (letters, numbers, "_", "." or "-"), e.g. ns001.';

export function isValidPiName(name) {
  return typeof name === 'string' && PI_NAME_RX.test(name.trim());
}

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const firstLabel = (h) => h.split('.')[0];

/**
 * How `name` matches a Pi that reported { username, hostname }:
 * 'username' | 'hostname' | null.
 */
export function piNameMatch(name, { username, hostname } = {}) {
  const n = lower(name).replace(/\.local$/, '');
  if (!n) return null;
  if (n === lower(username)) return 'username';
  const h = lower(hostname).replace(/\.local$/, '');
  if (h && (n === h || n === firstLabel(h))) return 'hostname';
  return null;
}
