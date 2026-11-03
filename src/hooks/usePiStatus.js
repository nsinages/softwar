// =============================================
// N Signage V2 — usePiStatus Hook
// Polls all Pi devices on an interval
// =============================================

import { useState, useEffect, useCallback } from 'react';
import { checkAllDevices } from '../api/piApi';
import { getDevices, getSettings } from '../data/store';

/**
 * @param {number} [overrideInterval] - Override poll interval in seconds
 * @returns {{
 *   statusMap: Object,   // device id -> { ok, data, error, latency, checkedAt }
 *   isChecking: boolean,
 *   lastChecked: Date|null,
 *   refresh: function
 * }}
 */
export function usePiStatus(overrideInterval = null) {
  const [statusMap, setStatusMap] = useState({});
  const [isChecking, setIsChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);

  const refresh = useCallback(async () => {
    const devices = getDevices();
    if (devices.length === 0) return;
    setIsChecking(true);
    try {
      const results = await checkAllDevices(devices);
      const checkedAt = new Date();
      const enriched = {};
      Object.entries(results).forEach(([id, result]) => {
        enriched[id] = { ...result, checkedAt };
      });
      setStatusMap(enriched);
      setLastChecked(checkedAt);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    const interval = (overrideInterval ?? getSettings().pollInterval) * 1000;
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, interval);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, overrideInterval]);

  return { statusMap, isChecking, lastChecked, refresh };
}
