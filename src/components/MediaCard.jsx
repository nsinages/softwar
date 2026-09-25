// =============================================
// N Signage V2 — MediaCard Component
// =============================================
import React, { useState } from 'react';

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
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

/**
 * @param {{ filename, size, uploaded_at, type }} media
 * @param {string} piIp
 * @param {boolean} isCurrent - is this the currently playing file
 * @param {function} onDelete
 * @param {function} onPreview
 */
export default function MediaCard({ media, piIp, isCurrent, onDelete, onPreview }) {
  const mediaType = getMediaType(media.filename || media.name);
  const filename = media.filename || media.name || 'unknown';
  const previewUrl = piIp ? `http://${piIp}:5000/media/${encodeURIComponent(filename)}` : null;

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${isCurrent ? 'rgba(63,185,80,0.4)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        transition: 'transform var(--transition-base), box-shadow var(--transition-base)',
        position: 'relative',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      {/* Thumbnail */}
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
      >
        {mediaType === 'image' && previewUrl ? (
          <img
            src={previewUrl}
            alt={filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
          />
        ) : null}
        <div
          style={{
            display: mediaType === 'image' && previewUrl ? 'none' : 'flex',
            alignItems: 'center', justifyContent: 'center',
            width: '100%', height: '100%',
            fontSize: 40,
          }}
        >
          {mediaType === 'video' ? '🎬' : mediaType === 'image' ? '🖼️' : '📄'}
        </div>

        {/* Play overlay for video */}
        {mediaType === 'video' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: 36, opacity: 0.8 }}>▶️</div>
          </div>
        )}

        {/* Currently playing badge */}
        {isCurrent && (
          <div style={{
            position: 'absolute', top: 8, left: 8,
            background: 'var(--success)', color: '#fff',
            borderRadius: 'var(--radius-full)', padding: '2px 8px',
            fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span className="dot dot-online" style={{ width: 6, height: 6 }} />
            Playing
          </div>
        )}

        {/* Type badge */}
        <div style={{
          position: 'absolute', top: 8, right: 8,
          background: 'rgba(0,0,0,0.6)', color: '#fff',
          borderRadius: 'var(--radius-sm)', padding: '2px 6px',
          fontSize: 'var(--text-xs)',
        }}>
          {mediaType.toUpperCase()}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: 'var(--space-3)' }}>
        <div
          style={{
            fontWeight: 'var(--weight-medium)', fontSize: 'var(--text-sm)',
            color: 'var(--text-primary)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4,
          }}
          title={filename}
        >
          {filename}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', gap: 'var(--space-2)' }}>
            <span>{formatSize(media.size)}</span>
            {media.uploaded_at && <><span>·</span><span>{formatDate(media.uploaded_at)}</span></>}
          </div>
          <button
            className="btn btn-ghost btn-sm btn-icon"
            onClick={() => onDelete && onDelete(media)}
            title="Delete"
            style={{ color: 'var(--danger)', padding: '2px 6px' }}
          >
            🗑️
          </button>
        </div>
      </div>
    </div>
  );
}
