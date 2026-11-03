// =============================================
// N Signage — UploadPanel Component
// =============================================
import React, { useEffect, useRef, useState } from 'react';
import {
  UploadCloud,
  File,
  X,
  AlertTriangle,
  FileText,
  Film,
  Image as ImageIcon,
} from 'lucide-react';
import { ALLOWED_EXT, ALLOWED_TYPES } from '../api/piApi';
import { getSettings } from '../data/store';

export default function UploadPanel({ onFileSelect, selectedFile, disabled = false }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const warnSizeMB = getSettings().uploadSizeWarning;

  // One object URL per selected file, released when the file changes
  useEffect(() => {
    if (!selectedFile) return undefined;
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreviewUrl('');
    };
  }, [selectedFile]);

  function validateAndSelect(file) {
    if (!file || disabled) return;
    setError('');
    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXT.test(file.name)) {
      setError(`Unsupported format: "${file.name}". Allowed: JPG, PNG, GIF, WEBP, MP4, M4V, WEBM, MOV`);
      return;
    }
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > warnSizeMB) {
      setError(`Large file warning (${sizeMB.toFixed(0)} MB). Upload to local Pi might take longer.`);
    }
    onFileSelect(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    validateAndSelect(file);
  }

  function handleChange(e) {
    validateAndSelect(e.target.files?.[0]);
  }

  if (selectedFile) {
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(selectedFile.name);
    const isVideo = /\.(mp4|m4v|webm|mov)$/i.test(selectedFile.name);
    const sizeMB = (selectedFile.size / (1024 * 1024)).toFixed(2);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {/* Preview Frame */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            maxHeight: 280,
          }}
        >
          {isImage && previewUrl && (
            <img
              src={previewUrl}
              alt="Selected Preview"
              style={{
                width: '100%',
                maxHeight: 280,
                objectFit: 'contain',
                display: 'block',
                background: '#090d16',
              }}
            />
          )}
          {isVideo && previewUrl && (
            <video
              src={previewUrl}
              controls
              style={{
                width: '100%',
                maxHeight: 280,
                background: '#090d16',
                display: 'block',
              }}
            />
          )}
          {!isImage && !isVideo && (
            <div style={{ padding: 'var(--space-8)', color: 'var(--text-muted)' }}>
              <FileText size={48} />
            </div>
          )}
        </div>

        {/* Selected File Details Strip */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <div style={{ color: 'var(--accent)', flexShrink: 0 }}>
              {isImage ? <ImageIcon size={18} /> : isVideo ? <Film size={18} /> : <File size={18} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 'var(--weight-semibold)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedFile.name}
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {sizeMB} MB · {selectedFile.type || 'File'}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            onClick={() => {
              onFileSelect(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            style={{ color: 'var(--danger)', flexShrink: 0 }}
          >
            <X size={14} /> Remove
          </button>
        </div>

        {error && (
          <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)' }}>
            <AlertTriangle size={14} className="alert-icon" />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        className={`dropzone ${dragOver ? 'drag-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone-icon">
          <UploadCloud size={24} />
        </div>
        <p style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
          Click to browse or drag &amp; drop media here
        </p>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Supported: JPG, PNG, GIF, WEBP, MP4, M4V, WEBM, MOV
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.gif,.webp,.mp4,.m4v,.webm,.mov"
        style={{ display: 'none' }}
        onChange={handleChange}
      />

      {error && (
        <div className="alert alert-danger" style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
