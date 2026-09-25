// =============================================
// N Signage V2 — DeviceCard Component
// =============================================
import React from 'react';
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

export default function DeviceCard({ device, statusEntry, onEdit, onDelete, onTest, onManageMedia }) {
  const status = getStatus(statusEntry);
  const piData = statusEntry?.data;
  const latency = statusEntry?.latency;
  const checkedAt = statusEntry?.checkedAt;

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${status === 'online' ? 'rgba(63,185,80,0.25)' : status === 'offline' ? 'rgba(248,81,73,0.2)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        transition: 'box-shadow var(--transition-base), transform var(--transition-base)',
        cursor: 'default',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-md)', color: 'var(--text-primary)', marginBottom: 2 }}>
            {device.name}
          </div>
          <span className="ip-chip">
            📍 {device.ip}
          </span>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Location info */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
        <InfoPill icon="🎓" label="Department" value={device.department} />
        <InfoPill icon="🏢" label="Block" value={device.block} />
        <InfoPill icon="📶" label="Floor" value={device.floor} />
        <InfoPill icon="🚪" label="Classroom" value={device.classroom} />
      </div>

      {/* Live Pi data */}
      {status === 'online' && piData && (
        <div
          style={{
            background: 'var(--success-subtle)',
            border: '1px solid rgba(63,185,80,0.2)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success)', fontWeight: 'var(--weight-semibold)' }}>
              🎬 Now Playing
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success)' }}>
              {piData.media_count ?? 0} file{piData.media_count !== 1 ? 's' : ''}
            </span>
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {piData.current_media || '— none —'}
          </div>
        </div>
      )}

      {status === 'offline' && (
        <div className="alert alert-danger" style={{ fontSize: 'var(--text-xs)', padding: '6px 10px' }}>
          ⚠️ {statusEntry?.error || 'Pi is unreachable'}
        </div>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {checkedAt ? `⏱ ${formatCheckedAt(checkedAt)}${latency ? ` · ${formatLatency(latency)}` : ''}` : 'Not checked yet'}
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          <button className="btn btn-ghost btn-sm btn-icon" title="Test connection" onClick={() => onTest(device)}>🔄</button>
          <button className="btn btn-ghost btn-sm btn-icon" title="Manage media" onClick={() => onManageMedia(device)}>🎞️</button>
          <button className="btn btn-ghost btn-sm btn-icon" title="Edit device" onClick={() => onEdit(device)}>✏️</button>
          <button className="btn btn-ghost btn-sm btn-icon" title="Delete device" onClick={() => onDelete(device)} style={{ color: 'var(--danger)' }}>🗑️</button>
        </div>
      </div>
    </div>
  );
}

function InfoPill({ icon, label, value }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', padding: '4px 8px' }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {icon} {value || '—'}
      </div>
    </div>
  );
}
