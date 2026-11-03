// =============================================
// N Signage V3 — Pi Discovery API (frontend client)
// Talks to the LAN discovery helper (discovery/piDiscovery.js).
// The browser itself cannot do mDNS or scan the LAN, so it only asks the
// helper running on the same network. Nothing here touches the device store.
// =============================================

import axios from 'axios';
import { isCloudMode, cloudFindPi } from './cloudApi';

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
 * Ask the LAN discovery helper to find a Raspberry Pi by its Linux username.
 * The helper only returns Pis whose OWN reported username matches.
 * @param {string} identifier - Pi Linux username, e.g. "ns"
 * @returns {Promise<{
 *   found: boolean, identifier: string, multiple?: boolean,
 *   devices: Array<{ip, port, username, hostname, deviceId, online, method}>,
 *   ip?: string, port?: number, username?: string, hostname?: string,
 *   deviceId?: string, online?: boolean, method?: string,
 *   otherCount?: number, reason?: string, log: string[]
 * }>}
 */
export async function findPi(identifier) {
  const url = `${DISCOVERY_BASE}/find?identifier=${encodeURIComponent(identifier)}`;
  let result;
  // Hosted website: ask the cloud relay (Pis report to it themselves)
  if (isCloudMode() && !import.meta.env.VITE_DISCOVERY_URL) {
    result = await cloudFindPi(identifier);
  } else try {
    const res = await axios.get(url, { timeout: DISCOVERY_TIMEOUT });
    result = { log: [], devices: [], ...res.data };
  } catch (error) {
    const data = error.response?.data;
    result = {
      found: false,
      identifier,
      reason: data?.reason || 'helper-unavailable',
      error: data?.error,
      devices: [],
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
