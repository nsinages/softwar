import { useState } from "react";
import { Wifi, Info, CheckCircle2, XCircle } from "lucide-react";
import { getPiIP, getPiPort, setPiIP, setPiPort, DEFAULT_PI_IP, DEFAULT_PORT } from "../services/nSignageApi";
import { isValidIP, isPrivateOrLocalIP, isValidPort } from "../utils/validation";
import { useDeviceStatus } from "../hooks/useDeviceStatus.jsx";

export default function Settings() {
  const { refresh } = useDeviceStatus();
  const [ip, setIpInput] = useState(getPiIP() || DEFAULT_PI_IP);
  const [port, setPortInput] = useState(getPiPort() || DEFAULT_PORT);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // { ok: bool, message: string }
  const [validationError, setValidationError] = useState("");

  async function handleConnect() {
    setResult(null);
    setValidationError("");

    const trimmedIP = ip.trim();

    if (!isValidIP(trimmedIP)) {
      setValidationError("Enter a valid IP address, e.g. 10.10.40.94");
      return;
    }
    if (!isPrivateOrLocalIP(trimmedIP)) {
      setValidationError("IP must be a local network address (10.x, 192.168.x, 172.16-31.x) or localhost.");
      return;
    }
    if (!isValidPort(port)) {
      setValidationError("Enter a valid port number (1-65535).");
      return;
    }

    // Persist first so the API layer builds the base URL from these values.
    setPiIP(trimmedIP);
    setPiPort(port);

    setTesting(true);
    // Drive the shared status context so the sidebar, dashboard, and device
    // page all reflect the new connection immediately instead of waiting
    // for the next poll interval.
    const outcome = await refresh();
    setTesting(false);

    if (outcome.ok) {
      setResult({ ok: true, message: `Connected — device reports "${outcome.data?.status || "online"}".` });
    } else {
      setResult({ ok: false, message: outcome.message || "Unable to connect to Raspberry Pi." });
    }
  }

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Connect and configure your Raspberry Pi</p>

      <div className="card settings-card">
        <h2 className="section-title">
          <Wifi size={16} />
          Raspberry Pi Connection
        </h2>

        <div className="field-row">
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="pi-ip">Raspberry Pi IP Address</label>
            <input
              id="pi-ip"
              type="text"
              placeholder="10.10.40.94"
              value={ip}
              onChange={(e) => setIpInput(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pi-port">Port</label>
            <input
              id="pi-port"
              type="text"
              inputMode="numeric"
              placeholder="5000"
              value={port}
              onChange={(e) => setPortInput(e.target.value)}
            />
          </div>
        </div>

        {validationError && <div className="field-error" style={{ marginBottom: 16 }}>{validationError}</div>}

        <button className="btn btn-primary btn-block" onClick={handleConnect} disabled={testing}>
          {testing ? <span className="spinner" /> : <Wifi size={16} />}
          {testing ? "Connecting..." : "Connect Device"}
        </button>

        {result && (
          <div className={"alert " + (result.ok ? "alert-success" : "alert-error")} style={{ marginTop: 20, marginBottom: 0 }}>
            {result.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            {result.message}
          </div>
        )}

        <div className="network-note">
          <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            For direct device control, your computer and Raspberry Pi must be on the same local network.
            Make sure your laptop and Raspberry Pi are connected to the same network. If this site is
            served over HTTPS, browsers may block requests to the Pi's HTTP address (mixed content) —
            use this control panel over HTTP on your LAN, or access it directly at its local address.
          </span>
        </div>
      </div>
    </div>
  );
}
