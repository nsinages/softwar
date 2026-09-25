// =============================================
// N Signage V2 — UploadPanel Component
// =============================================
import React, { useRef, useState } from 'react';

const ALLOWED_EXTS = /\.(jpg|jpeg|png|gif|webp|mp4|m4v|webm|mov)$/i;
const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime',
];
const WARN_SIZE_MB = 500;

/**
 * @param {function} onFileSelect - called with the File object
 * @param {File|null} selectedFile
 */
export default function UploadPanel({ onFileSelect, selectedFile }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');

  function validateAndSelect(file) {
    if (!file) return;
    setError('');
    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTS.test(file.name)) {
      setError(`Unsupported file: "${file.name}". Allowed: JPG, PNG, GIF, WEBP, MP4, M4V, WEBM, MOV`);
      return;
    }
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > WARN_SIZE_MB) {
      setError(`⚠️ Large file (${sizeMB.toFixed(0)} MB). Upload may take a while.`);
      // still allow — just warn
    }
    onFileSelect(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    validateAndSelect(file);
  }

  function handleChange(e) {
    validateAndSelect(e.target.files?.[0]);
  }

  if (selectedFile) {
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(selectedFile.name);
    const isVideo = /\.(mp4|m4v|webm|mov)$/i.test(selectedFile.name);
    const previewUrl = URL.createObjectURL(selectedFile);
    const sizeMB = (selectedFile.size / (1024 * 1024)).toFixed(2);

    return (
      <div>
        {/* Preview */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            marginBottom: 'var(--space-3)',
          }}
        >
          {isImage && (
            <img
              src={previewUrl}
              alt="Preview"
              style={{ width: '100%', maxHeight: 260, objectFit: 'contain', display: 'block', background: '#000' }}
            />
          )}
          {isVideo && (
            <video
              src={previewUrl}
              controls
              style={{ width: '100%', maxHeight: 260, background: '#000', display: 'block' }}
            />
          )}
          {!isImage && !isVideo && (
            <div style={{ height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40 }}>
              📄
            </div>
          )}
        </div>

        {/* File info */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
          }}
        >
          <div>
            <div style={{ fontWeight: 'var(--weight-medium)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
              {selectedFile.name}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {sizeMB} MB · {selectedFile.type || 'Unknown type'}
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { onFileSelect(null); inputRef.current.value = ''; }}
            style={{ color: 'var(--danger)' }}
          >
            ✕ Remove
          </button>
        </div>

        {error && <div className="alert alert-warning" style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div>
      <div
        className={`dropzone ${dragOver ? 'drag-over' : ''}`}
        onClick={() => inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="dz-icon">📁</div>
        <p><strong>Click to select</strong> or drag &amp; drop media here</p>
        <p style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          JPG · PNG · GIF · WEBP · MP4 · M4V · WEBM · MOV
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.gif,.webp,.mp4,.m4v,.webm,.mov"
        style={{ display: 'none' }}
        onChange={handleChange}
      />
      {error && <div className="alert alert-danger" style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>{error}</div>}
    </div>
  );
}
