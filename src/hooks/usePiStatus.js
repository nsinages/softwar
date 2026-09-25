// =============================================
// N Signage V2 — usePiStatus Hook
// Polls all Pi devices on an interval
// =============================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { checkAllDevices, getPiStatus } from '../api/piApi';
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
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    const devices = getDevices();
    if (devices.length === 0) return;
    setIsChecking(true);
    try {
      const results = await checkAllDevices(devices);
      const enriched = {};
      Object.entries(results).forEach(([id, result]) => {
        enriched[id] = { ...result, checkedAt: new Date() };
      });
      setStatusMap(enriched);
      setLastChecked(new Date());
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const settings = getSettings();
    const interval = (overrideInterval ?? settings.pollInterval ?? 30) * 1000;
    timerRef.current = setInterval(refresh, interval);
    return () => clearInterval(timerRef.current);
  }, [refresh, overrideInterval]);

  return { statusMap, isChecking, lastChecked, refresh };
}

/**
 * Check a single device status (one-shot, not polling)
 */
export function useSinglePiStatus(ip) {
  const [status, setStatus] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  const check = useCallback(async () => {
    if (!ip) return;
    setIsChecking(true);
    try {
      const result = await getPiStatus(ip);
      setStatus({ ...result, checkedAt: new Date() });
    } finally {
      setIsChecking(false);
    }
  }, [ip]);

  useEffect(() => {
    check();
  }, [check]);

  return { status, isChecking, recheck: check };
}
