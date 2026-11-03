import { Link } from "react-router-dom";
import { RefreshCw, Cpu } from "lucide-react";
import ConnectionStatus from "../components/ConnectionStatus";
import { useDeviceStatus } from "../hooks/useDeviceStatus";
import { getPiIP, getPiPort } from "../services/nSignageApi";

export default function Device() {
  const { status, data, error, lastChecked, refresh } = useDeviceStatus();

  return (
    <div>
      <div className="flex-between">
        <div>
          <h1 className="page-title">Device</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>Raspberry Pi 3 details</p>
        </div>
        <button className="btn btn-secondary" onClick={refresh}>
          <RefreshCw size={15} className={status === "checking" ? "spin-icon" : ""} />
          Refresh Status
        </button>
      </div>

      <div style={{ height: 24 }} />

      {status === "unconfigured" && (
        <div className="alert alert-info">
          No Raspberry Pi configured. Go to <Link to="/settings" style={{ fontWeight: 700 }}>Settings</Link> to connect one.
        </div>
      )}

      {status === "offline" && error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="sidebar-brand-icon">
              <Cpu size={20} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Raspberry Pi 3</div>
              <div className="text-muted" style={{ fontSize: 12 }}>N Signage Device</div>
            </div>
          </div>
          <ConnectionStatus status={status} />
        </div>

        <div className="device-info-grid">
          <div>
            <div className="device-info-item-label">Device</div>
            <div className="device-info-item-value">{data?.device || "Raspberry Pi 3"}</div>
          </div>
          <div>
            <div className="device-info-item-label">Status</div>
            <div className="device-info-item-value">
              {status === "online" ? "Online" : status === "unconfigured" ? "Not configured" : "Offline"}
            </div>
          </div>
          <div>
            <div className="device-info-item-label">IP</div>
            <div className="device-info-item-value mono">{getPiIP() || "—"}</div>
          </div>
          <div>
            <div className="device-info-item-label">Port</div>
            <div className="device-info-item-value mono">{getPiPort()}</div>
          </div>
          <div>
            <div className="device-info-item-label">Server</div>
            <div className="device-info-item-value">Flask</div>
          </div>
          <div>
            <div className="device-info-item-label">Firmware / Application</div>
            <div className="device-info-item-value">N Signage {data?.version ? `v${data.version}` : ""}</div>
          </div>
          <div>
            <div className="device-info-item-label">Connection</div>
            <div className="device-info-item-value">{status === "online" ? "Connected" : "Disconnected"}</div>
          </div>
          <div>
            <div className="device-info-item-label">Last Checked</div>
            <div className="device-info-item-value">
              {lastChecked ? lastChecked.toLocaleTimeString() : "—"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
