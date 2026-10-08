// =============================================
// N Signage — DeviceCard Component
// =============================================
import React from 'react';
import {
  RotateCw,
  Film,
  Pencil,
  Trash2,
  Tv,
  Clock,
  Tag,
  AlertCircle,
  Play,
} from 'lucide-react';
import StatusBadge from './StatusBadge';

function getStatus(statusEntry) {
  if (!statusEntry) return 'unknown';
  if (statusEntry.ok) return 'online';
  return 'offline';
}

function formatLatency(ms) {
  if (!ms) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCheckedAt(date) {
  if (!date) return 'Never';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function DeviceCard({
  device,
  statusEntry,
  onEdit,
  onDelete,
  onTest,
  onManageMedia,
}) {
  const status = getStatus(statusEntry);
  const piData = statusEntry?.data;
  const latency = statusEntry?.latency;
  const checkedAt = statusEntry?.checkedAt;

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        borderColor:
          status === 'online'
            ? 'rgba(16, 185, 129, 0.3)'
            : status === 'offline'
            ? 'rgba(239, 68, 68, 0.25)'
            : 'var(--border)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <div style={{ minWidth: 0, display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-elevated)',
              color: status === 'online' ? 'var(--accent)' : 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Tv size={20} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 'var(--weight-semibold)',
                fontSize: 'var(--text-md)',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={device.deviceId}
            >
              {device.deviceId}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: 2 }}>
              <span className="ip-chip">{device.ip}</span>
            </div>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Nickname pill */}
      {device.nickName && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)',
            background: 'var(--bg-elevated)',
            padding: '5px 10px',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <Tag size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-muted)' }}>Nickname:</span>
          <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {device.nickName}
          </span>
        </div>
      )}

      {/* Live Pi Data Banner */}
      {status === 'online' && piData && (
        <div
          style={{
            background: 'var(--success-subtle)',
            border: '1px solid rgba(16, 185, 129, 0.2)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-xs)', color: 'var(--success)', fontWeight: 'var(--weight-semibold)' }}>
              <Play size={11} fill="currentColor" />
              <span>Now Playing</span>
            </div>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              {piData.media_count ?? 0} file{piData.media_count !== 1 ? 's' : ''}
            </span>
          </div>
          <div
            style={{
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
              fontWeight: 'var(--weight-medium)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={piData.current_media || 'No media active'}
          >
            {piData.current_media || '— Idle / No media —'}
          </div>
        </div>
      )}

      {status === 'offline' && (
        <div className="alert alert-danger" style={{ padding: '8px 10px', fontSize: 'var(--text-xs)' }}>
          <AlertCircle size={14} className="alert-icon" />
          <span>{statusEntry?.error || 'Device unreachable on LAN'}</span>
        </div>
      )}

      {/* Footer & Actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 'auto',
          paddingTop: 'var(--space-3)',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <div
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <Clock size={12} />
          <span>
            {checkedAt ? `${formatCheckedAt(checkedAt)}${latency ? ` (${formatLatency(latency)})` : ''}` : 'Pending test'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Test connection"
            aria-label="Test connection"
            onClick={() => onTest && onTest(device)}
          >
            <RotateCw size={14} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Manage media"
            aria-label="Manage media"
            onClick={() => onManageMedia && onManageMedia(device)}
          >
            <Film size={14} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Edit device"
            aria-label="Edit device"
            onClick={() => onEdit && onEdit(device)}
          >
            <Pencil size={14} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Delete device"
            aria-label="Delete device"
            onClick={() => onDelete && onDelete(device)}
            style={{ color: 'var(--danger)' }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
