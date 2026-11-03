import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getStatus, isConfigValid, describeApiError } from "../services/nSignageApi";

const DeviceStatusContext = createContext(null);

/**
 * Polls the real Raspberry Pi /api/status endpoint once for the whole app
 * and shares the result, so the sidebar, header, dashboard, and device page
 * don't each open their own independent polling loop.
 */
export function DeviceStatusProvider({ children, pollIntervalMs = 15000 }) {
  const [status, setStatus] = useState("checking"); // 'checking' | 'online' | 'offline' | 'unconfigured'
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [lastChecked, setLastChecked] = useState(null);
  const timerRef = useRef(null);

  const check = useCallback(async () => {
    if (!isConfigValid()) {
      setStatus("unconfigured");
      setData(null);
      setError("");
      return { ok: false, status: "unconfigured" };
    }

    setStatus((prev) => (prev === "online" ? prev : "checking"));
    try {
      const result = await getStatus();
      setData(result);
      setStatus("online");
      setError("");
      return { ok: true, status: "online", data: result };
    } catch (err) {
      const message = describeApiError(err);
      setStatus("offline");
      setData(null);
      setError(message);
      return { ok: false, status: "offline", message };
    } finally {
      setLastChecked(new Date());
    }
  }, []);

  useEffect(() => {
    check();
    if (pollIntervalMs > 0) {
      timerRef.current = setInterval(check, pollIntervalMs);
      return () => clearInterval(timerRef.current);
    }
  }, [check, pollIntervalMs]);

  return (
    <DeviceStatusContext.Provider value={{ status, data, error, lastChecked, refresh: check }}>
      {children}
    </DeviceStatusContext.Provider>
  );
}

export function useDeviceStatus() {
  const ctx = useContext(DeviceStatusContext);
  if (!ctx) {
    throw new Error("useDeviceStatus must be used within a DeviceStatusProvider");
  }
  return ctx;
}
