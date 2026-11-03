import { useState } from "react";
import { Film, Image as ImageIcon, Trash2, Eye, ExternalLink } from "lucide-react";
import { formatBytes, getMediaKind } from "../utils/validation";
import { getBaseURL } from "../services/nSignageApi";

/**
 * Displays one media file returned by GET /api/media.
 * Video playback always happens on the Pi, never inside the browser here.
 */
export default function MediaCard({ file, onDelete, deleting }) {
  const [showPreview, setShowPreview] = useState(false);
  const kind = getMediaKind(file.type || file.name);
  // Backend endpoint required: GET /media/<filename> serving raw files from the
  // Pi's media directory. See README "Required backend endpoints" if this 404s.
  const fileURL = `${getBaseURL()}/media/${encodeURIComponent(file.name)}`;

  return (
    <div className="card media-card">
      <div className="media-card-thumb">
        {kind === "image" ? (
          showPreview ? (
            <img
              src={fileURL}
              alt={file.name}
              onError={() => setShowPreview(false)}
            />
          ) : (
            <button className="media-thumb-btn" onClick={() => setShowPreview(true)}>
              <ImageIcon size={28} />
              <span>Load preview</span>
            </button>
          )
        ) : (
          <div className="media-thumb-video">
            <Film size={28} />
          </div>
        )}
        <span className={`media-kind-badge media-kind-${kind}`}>{kind}</span>
      </div>

      <div className="media-card-body">
        <div className="media-card-name" title={file.name}>
          {file.name}
        </div>
        <div className="media-card-meta text-muted">{formatBytes(file.size)}</div>
      </div>

      <div className="media-card-actions">
        <a
          className="btn btn-secondary btn-icon"
          href={fileURL}
          target="_blank"
          rel="noreferrer"
          title="Open media on device"
        >
          <ExternalLink size={15} />
        </a>
        {kind === "image" && (
          <button
            className="btn btn-secondary btn-icon"
            onClick={() => setShowPreview((v) => !v)}
            title="Preview image"
          >
            <Eye size={15} />
          </button>
        )}
        <button
          className="btn btn-danger btn-icon"
          onClick={() => onDelete(file.name)}
          disabled={deleting}
          title="Delete media"
        >
          {deleting ? <span className="spinner" /> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  );
}
