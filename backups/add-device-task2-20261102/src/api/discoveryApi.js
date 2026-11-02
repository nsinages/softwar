// =============================================
// N Signage V3 — Pi Discovery API (frontend client)
// Talks to the LAN discovery helper (discovery/piDiscovery.js).
// The browser itself cannot do mDNS or scan the LAN, so it only asks the
// helper running on the same network. Nothing here touches the device store.
// =============================================

import axios from 'axios';

// Same-origin when served by Vite dev/preview; override for static builds
// e.g. VITE_DISCOVERY_URL=http://192.168.1.10:5055/discovery-api
const DISCOVERY_BASE = import.meta.env.VITE_DISCOVERY_URL || '/discovery-api';
const DISCOVERY_TIMEOUT = 20000;

/**
 * Developer/debug mode: add ?debug=1 to the URL, or run
 * localStorage.setItem('nsignage_debug', '1') in the console.
 */
export function isDiscoveryDebug() {
  try {
    return (
      new URLSearchParams(window.location.search).get('debug') === '1' ||
      localStorage.getItem('nsignage_debug') === '1'
    );
  } catch {
    return false;
  }
}

/**
 * Ask the LAN discovery helper to find a Raspberry Pi by its username/hostname.
 * @param {string} identifier - Pi username / device identifier, e.g. "n-sinage"
 * @returns {Promise<{
 *   found: boolean, identifier: string, ip?: string, port?: number,
 *   online?: boolean, method?: string, identityVerified?: boolean,
 *   reason?: string, log: string[]
 * }>}
 */
export async function findPi(identifier) {
  const url = `${DISCOVERY_BASE}/find?identifier=${encodeURIComponent(identifier)}`;
  let result;
  try {
    const res = await axios.get(url, { timeout: DISCOVERY_TIMEOUT });
    result = { log: [], ...res.data };
  } catch (error) {
    const data = error.response?.data;
    result = {
      found: false,
      identifier,
      reason: data?.reason || 'helper-unavailable',
      error: data?.error,
      log: [...(data?.log || []), `Discovery helper request failed: ${error.message} (${url})`],
    };
  }

  if (isDiscoveryDebug()) {
    console.groupCollapsed(`[PI DISCOVERY] ${identifier} → ${result.found ? result.ip : result.reason}`);
    result.log.forEach((line) => console.debug(line));
    console.debug(result);
    console.groupEnd();
  }
  return result;
}
