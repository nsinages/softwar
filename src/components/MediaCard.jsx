// =============================================
// N Signage — MediaCard Component
// =============================================
import React from 'react';
import {
  Film,
  Image as ImageIcon,
  FileText,
  Play,
  Trash2,
  Eye,
} from 'lucide-react';
import { piMediaUrl } from '../api/piApi';

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp)$/i;
const VIDEO_EXTS = /\.(mp4|m4v|webm|mov)$/i;

function getMediaType(filename) {
  if (IMAGE_EXTS.test(filename)) return 'image';
  if (VIDEO_EXTS.test(filename)) return 'video';
  return 'unknown';
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default function MediaCard({ media, device, isCurrent, onDelete, onPreview }) {
  const mediaType = getMediaType(media.filename || media.name);
  const filename = media.filename || media.name || 'unknown';
  const previewUrl = device ? piMediaUrl(device, filename, media) : null;

  return (
    <div
      className="card"
      style={{
        padding: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderColor: isCurrent ? 'rgba(16, 185, 129, 0.45)' : 'var(--border)',
        boxShadow: isCurrent ? '0 0 0 1px rgba(16, 185, 129, 0.35)' : 'var(--shadow-xs)',
      }}
    >
      {/* Thumbnail Area */}
      <div
        style={{
          height: 140,
          background: 'var(--bg-elevated)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
          cursor: 'pointer',
        }}
        onClick={() => onPreview && onPreview(media, previewUrl)}
        title="Click to preview"
      >
        {mediaType === 'image' && previewUrl ? (
          <img
            src={previewUrl}
            alt={filename}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={e => {
              e.currentTarget.style.display = 'none';
              if (e.currentTarget.nextSibling) {
                e.currentTarget.nextSibling.style.display = 'flex';
              }
            }}
          />
        ) : null}

        <div
          style={{
            display: mediaType === 'image' && previewUrl ? 'none' : 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            color: 'var(--text-muted)',
          }}
        >
          {mediaType === 'video' ? (
            <Film size={36} strokeWidth={1.5} />
          ) : mediaType === 'image' ? (
            <ImageIcon size={36} strokeWidth={1.5} />
          ) : (
            <FileText size={36} strokeWidth={1.5} />
          )}
        </div>

        {/* Video play overlay icon */}
        {mediaType === 'video' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(15, 23, 42, 0.3)',
              color: '#ffffff',
              transition: 'background var(--transition-fast)',
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 'var(--radius-full)',
                background: 'rgba(15, 23, 42, 0.65)',
                backdropFilter: 'blur(2px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                paddingLeft: 2,
              }}
            >
              <Play size={18} fill="#ffffff" />
            </div>
          </div>
        )}

        {/* Playing Now Badge */}
        {isCurrent && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              background: 'var(--success)',
              color: '#ffffff',
              borderRadius: 'var(--radius-full)',
              padding: '3px 8px',
              fontSize: '11px',
              fontWeight: 'var(--weight-semibold)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            }}
          >
            <span className="dot dot-online" style={{ width: 6, height: 6, background: '#ffffff' }} />
            Playing
          </div>
        )}

        {/* Media Type Badge */}
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(4px)',
            color: '#ffffff',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 6px',
            fontSize: '10px',
            fontWeight: 'var(--weight-semibold)',
            letterSpacing: '0.04em',
          }}
        >
          {mediaType.toUpperCase()}
        </div>
      </div>

      {/* Info & Actions */}
      <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <div
          style={{
            fontWeight: 'var(--weight-medium)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={filename}
        >
          {filename}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span>{formatSize(media.size)}</span>
            {media.uploaded_at && (
              <>
                <span>·</span>
                <span>{formatDate(media.uploaded_at)}</span>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: '2px' }}>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => onPreview && onPreview(media, previewUrl)}
              title="Preview file"
              aria-label="Preview file"
            >
              <Eye size={14} />
            </button>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => onDelete && onDelete(media)}
              title="Delete file"
              aria-label="Delete file"
              style={{ color: 'var(--danger)' }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
