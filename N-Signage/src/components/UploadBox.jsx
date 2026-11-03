import { useCallback, useRef, useState } from "react";
import { UploadCloud, FileVideo, FileImage, X, CheckCircle2, XCircle } from "lucide-react";
import { isAllowedMediaFile, formatBytes, ALLOWED_EXTENSIONS } from "../utils/validation";
import { uploadMedia, describeApiError } from "../services/nSignageApi";

const ACCEPT = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

/**
 * Drag-and-drop / click-to-browse uploader that reports real XHR progress
 * and posts directly to the Pi's /api/upload endpoint.
 */
export default function UploadBox({ onUploaded }) {
  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState([]); // { id, file, progress, state, error }
  const inputRef = useRef(null);

  function updateItem(id, patch) {
    setQueue((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  const startUpload = useCallback(
    async (item) => {
      updateItem(item.id, { state: "uploading", progress: 0 });
      try {
        await uploadMedia(item.file, (pct) => updateItem(item.id, { progress: pct }));
        updateItem(item.id, { state: "done", progress: 100 });
        onUploaded?.();
      } catch (err) {
        updateItem(item.id, { state: "failed", error: describeApiError(err) });
      }
    },
    [onUploaded]
  );

  const addFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList);
      const items = files.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        progress: 0,
        state: isAllowedMediaFile(file) ? "pending" : "invalid",
        error: isAllowedMediaFile(file) ? "" : "Invalid file type",
      }));

      setQueue((prev) => [...prev, ...items]);

      items.filter((item) => item.state === "pending").forEach((item) => startUpload(item));
    },
    [startUpload]
  );

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  function removeItem(id) {
    setQueue((prev) => prev.filter((it) => it.id !== id));
  }

  return (
    <div>
      <div
        className={"upload-dropzone" + (dragActive ? " upload-dropzone-active" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <UploadCloud size={36} />
        <p className="upload-dropzone-title">Drag & drop media here, or click to browse</p>
        <p className="upload-dropzone-sub text-muted">
          MP4, WebM, MOV, JPG, JPEG, PNG, WEBP
        </p>
      </div>

      {queue.length > 0 && (
        <div className="upload-queue">
          {queue.map((item) => (
            <UploadQueueItem key={item.id} item={item} onRemove={() => removeItem(item.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadQueueItem({ item, onRemove }) {
  const { file, progress, state, error } = item;
  const isVideo = file.type.startsWith("video") || /\.(mp4|webm|mov)$/i.test(file.name);
  const Icon = isVideo ? FileVideo : FileImage;

  return (
    <div className="upload-queue-item">
      <div className="upload-queue-icon">
        <Icon size={18} />
      </div>
      <div className="upload-queue-info">
        <div className="upload-queue-name" title={file.name}>
          {file.name}
        </div>
        <div className="upload-queue-meta text-muted">{formatBytes(file.size)}</div>

        {state === "uploading" && (
          <div className="upload-progress-track">
            <div className="upload-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {state === "invalid" && <div className="field-error">{error}</div>}
        {state === "failed" && <div className="field-error">{error}</div>}
        {state === "done" && <div className="upload-queue-status upload-queue-status-ok">Upload complete</div>}
        {state === "uploading" && (
          <div className="upload-queue-status">Uploading... {progress}%</div>
        )}
      </div>

      <div className="upload-queue-state">
        {state === "done" && <CheckCircle2 size={18} color="var(--success)" />}
        {(state === "failed" || state === "invalid") && (
          <XCircle size={18} color="var(--danger)" />
        )}
        <button className="upload-queue-remove" onClick={onRemove} title="Remove from list">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
