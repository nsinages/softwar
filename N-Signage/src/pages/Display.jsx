import { useState } from "react";
import { Link } from "react-router-dom";
import { MonitorPlay, ExternalLink, RefreshCw, Copy, Check } from "lucide-react";
import { useDeviceStatus } from "../hooks/useDeviceStatus";
import { getDisplayURL } from "../services/nSignageApi";

/**
 * The Pi renders the actual signage display; this page only ever opens
 * or links to it in a new tab. It never fetches or embeds the video itself.
 */
export default function DisplayPage() {
  const { status, refresh } = useDeviceStatus();
  const [copied, setCopied] = useState(false);
  const displayURL = getDisplayURL();

  function openDisplay() {
    window.open(displayURL, "_blank", "noopener,noreferrer");
  }

  async function copyURL() {
    try {
      await navigator.clipboard.writeText(displayURL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — non-critical.
    }
  }

  return (
    <div>
      <h1 className="page-title">Display</h1>
      <p className="page-subtitle">The Raspberry Pi renders the signage display, not this website</p>

      {status === "unconfigured" && (
        <div className="alert alert-info">
          No Raspberry Pi configured. Go to <Link to="/settings" style={{ fontWeight: 700 }}>Settings</Link> to connect one.
        </div>
      )}

      {status === "offline" && (
        <div className="alert alert-error">Raspberry Pi is offline. The display link may not load.</div>
      )}

      <div className="card">
        <div className="display-hero">
          <div className="display-hero-icon">
            <MonitorPlay size={32} />
          </div>
          <h2 style={{ margin: "0 0 6px" }}>N Signage Display</h2>
          <p className="text-secondary" style={{ margin: 0, fontSize: 14 }}>
            Opens the live HDMI display output served by your Raspberry Pi in a new tab.
          </p>

          {displayURL && (
            <div className="display-url-box">
              <span className="mono">{displayURL}</span>
              <button className="btn btn-secondary btn-icon" onClick={copyURL} title="Copy display URL">
                {copied ? <Check size={14} color="var(--success)" /> : <Copy size={14} />}
              </button>
            </div>
          )}

          <div className="display-actions">
            <button className="btn btn-primary btn-lg" onClick={openDisplay} disabled={!displayURL}>
              <ExternalLink size={18} />
              OPEN DISPLAY
            </button>
            <button className="btn btn-secondary" onClick={refresh} disabled={!displayURL}>
              <RefreshCw size={16} />
              Refresh Display
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
