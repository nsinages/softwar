import { Link } from "react-router-dom";
import UploadBox from "../components/UploadBox";
import { useDeviceStatus } from "../hooks/useDeviceStatus";

export default function Upload() {
  const { status } = useDeviceStatus();

  return (
    <div>
      <h1 className="page-title">Upload</h1>
      <p className="page-subtitle">Send media directly to your Raspberry Pi</p>

      {status === "unconfigured" && (
        <div className="alert alert-info">
          No Raspberry Pi configured. Go to <Link to="/settings" style={{ fontWeight: 700 }}>Settings</Link> to connect one.
        </div>
      )}

      {status === "offline" && (
        <div className="alert alert-error">Raspberry Pi is offline. Uploads will fail until it's reachable.</div>
      )}

      <div className="card">
        {status === "online" || status === "checking" ? (
          <UploadBox />
        ) : (
          <div className="empty-state">
            <p>Connect your Raspberry Pi before uploading media.</p>
          </div>
        )}
      </div>
    </div>
  );
}
