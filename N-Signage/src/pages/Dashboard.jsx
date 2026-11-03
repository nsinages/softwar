import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Film,
  Image as ImageIcon,
  HardDrive,
  Boxes,
  UploadCloud,
  MonitorPlay,
  RefreshCw,
  FolderOpen,
} from "lucide-react";
import ConnectionStatus from "../components/ConnectionStatus";
import StatusCard from "../components/StatusCard";
import { useDeviceStatus } from "../hooks/useDeviceStatus";
import {
  getPiIP,
  getPiPort,
  getMedia,
  describeApiError,
  isConfigValid,
} from "../services/nSignageApi";
import { formatBytes, getMediaKind } from "../utils/validation";

export default function Dashboard() {
  const navigate = useNavigate();
  const { status, refresh } = useDeviceStatus();
  const [media, setMedia] = useState([]);
  const [mediaError, setMediaError] = useState("");
  const [loadingMedia, setLoadingMedia] = useState(false);

  const configured = isConfigValid();

  useEffect(() => {
    if (status === "online") {
      loadMedia();
    } else {
      setMedia([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function loadMedia() {
    setLoadingMedia(true);
    setMediaError("");
    try {
      const files = await getMedia();
      setMedia(files);
    } catch (err) {
      setMediaError(describeApiError(err));
    } finally {
      setLoadingMedia(false);
    }
  }

  const videos = media.filter((f) => getMediaKind(f.type || f.name) === "video");
  const images = media.filter((f) => getMediaKind(f.type || f.name) === "image");
  const totalBytes = media.reduce((sum, f) => sum + (f.size || 0), 0);
  const recent = [...media].slice(-5).reverse();

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-subtitle">Simple Digital Signage Management</p>

      {!configured && (
        <div className="alert alert-info">
          No Raspberry Pi connected yet. Go to{" "}
          <Link to="/settings" style={{ fontWeight: 700 }}>
            Settings
          </Link>{" "}
          to connect your device.
        </div>
      )}

      <div className="card card-section">
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <h2 className="section-title" style={{ margin: 0 }}>Device Status</h2>
          <ConnectionStatus status={status} />
        </div>
        <div className="device-info-grid">
          <div>
            <div className="device-info-item-label">Raspberry Pi</div>
            <div className="device-info-item-value">
              {status === "online" ? "Connected" : "Not connected"}
            </div>
          </div>
          <div>
            <div className="device-info-item-label">IP Address</div>
            <div className="device-info-item-value mono">{getPiIP() || "—"}</div>
          </div>
          <div>
            <div className="device-info-item-label">Server</div>
            <div className="device-info-item-value">Flask</div>
          </div>
          <div>
            <div className="device-info-item-label">Device</div>
            <div className="device-info-item-value">Raspberry Pi 3</div>
          </div>
          <div>
            <div className="device-info-item-label">Port</div>
            <div className="device-info-item-value mono">{getPiPort()}</div>
          </div>
        </div>
      </div>

      <div className="card-section">
        <h2 className="section-title">Statistics</h2>
        <div className="grid grid-4">
          <StatusCard icon={Boxes} label="Total Media" value={status === "online" ? media.length : "—"} accent="primary" />
          <StatusCard icon={Film} label="Videos" value={status === "online" ? videos.length : "—"} accent="secondary" />
          <StatusCard icon={ImageIcon} label="Images" value={status === "online" ? images.length : "—"} accent="success" />
          <StatusCard
            icon={HardDrive}
            label="Storage Used"
            value={status === "online" ? formatBytes(totalBytes) : "—"}
            accent="warning"
          />
        </div>
      </div>

      <div className="card-section">
        <h2 className="section-title">Quick Actions</h2>
        <div className="quick-actions">
          <div className="card quick-action" onClick={() => navigate("/upload")}>
            <div className="quick-action-icon"><UploadCloud size={20} /></div>
            <div className="quick-action-label">Upload Media</div>
          </div>
          <div className="card quick-action" onClick={() => navigate("/display")}>
            <div className="quick-action-icon"><MonitorPlay size={20} /></div>
            <div className="quick-action-label">Open Display</div>
          </div>
          <div className="card quick-action" onClick={refresh}>
            <div className="quick-action-icon"><RefreshCw size={20} /></div>
            <div className="quick-action-label">Refresh Device</div>
          </div>
          <div className="card quick-action" onClick={() => navigate("/media")}>
            <div className="quick-action-icon"><FolderOpen size={20} /></div>
            <div className="quick-action-label">Manage Media</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">Recent Media</h2>
        {status !== "online" && (
          <div className="empty-state">
            <Boxes size={32} />
            <p>Connect your Raspberry Pi to see recent media.</p>
          </div>
        )}
        {status === "online" && loadingMedia && (
          <div className="empty-state">
            <span className="spinner" />
            <p>Loading media...</p>
          </div>
        )}
        {status === "online" && !loadingMedia && mediaError && (
          <div className="alert alert-error">{mediaError}</div>
        )}
        {status === "online" && !loadingMedia && !mediaError && recent.length === 0 && (
          <div className="empty-state">
            <FolderOpen size={32} />
            <p>No media uploaded yet.</p>
          </div>
        )}
        {status === "online" && !loadingMedia && recent.length > 0 && (
          <div className="recent-media-list">
            {recent.map((file) => {
              const kind = getMediaKind(file.type || file.name);
              const Icon = kind === "video" ? Film : ImageIcon;
              return (
                <div className="recent-media-row" key={file.name}>
                  <div className="recent-media-icon">
                    <Icon size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="recent-media-name">{file.name}</div>
                    <div className="recent-media-meta">{formatBytes(file.size)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
