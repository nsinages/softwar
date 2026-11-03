import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import MediaCard from "../components/MediaCard";
import { useDeviceStatus } from "../hooks/useDeviceStatus";
import { getMedia, deleteMedia, describeApiError } from "../services/nSignageApi";

export default function Media() {
  const { status } = useDeviceStatus();
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deletingName, setDeletingName] = useState(null);
  const [confirmName, setConfirmName] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const files = await getMedia();
      setMedia(files);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "online") load();
    if (status === "offline" || status === "unconfigured") setMedia([]);
  }, [status, load]);

  async function handleConfirmDelete() {
    const name = confirmName;
    setConfirmName(null);
    setDeletingName(name);
    try {
      await deleteMedia(name);
      // Only remove from UI after the server confirms deletion.
      await load();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 4 }}>
        <div>
          <h1 className="page-title">Media</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Files stored on the Raspberry Pi
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={status !== "online" || loading}>
          <RefreshCw size={15} className={loading ? "spin-icon" : ""} />
          Refresh
        </button>
      </div>

      <div style={{ height: 24 }} />

      {status === "unconfigured" && (
        <div className="alert alert-info">
          No Raspberry Pi configured. Go to <Link to="/settings" style={{ fontWeight: 700 }}>Settings</Link> to connect one.
        </div>
      )}

      {status === "offline" && (
        <div className="alert alert-error">Raspberry Pi is offline. Media can't be loaded right now.</div>
      )}

      {error && status === "online" && <div className="alert alert-error">{error}</div>}

      {status === "online" && loading && (
        <div className="empty-state">
          <span className="spinner" />
          <p>Loading media...</p>
        </div>
      )}

      {status === "online" && !loading && !error && media.length === 0 && (
        <div className="empty-state">
          <FolderOpen size={36} />
          <p>No media uploaded yet.</p>
        </div>
      )}

      {status === "online" && !loading && media.length > 0 && (
        <div className="media-grid">
          {media.map((file) => (
            <MediaCard
              key={file.name}
              file={file}
              deleting={deletingName === file.name}
              onDelete={(name) => setConfirmName(name)}
            />
          ))}
        </div>
      )}

      {confirmName && (
        <div className="modal-overlay" onClick={() => setConfirmName(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 8px" }}>Delete this media file?</h3>
            <p className="text-secondary" style={{ margin: "0 0 20px", fontSize: 14 }}>
              "{confirmName}" will be permanently removed from the Raspberry Pi.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={() => setConfirmName(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleConfirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
