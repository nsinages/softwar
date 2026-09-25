// =============================================
// N Signage V2 — Dashboard Page
// =============================================
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePiStatus } from '../hooks/usePiStatus';
import { getDevices } from '../data/store';
import DeviceCard from '../components/DeviceCard';
import StatusBadge from '../components/StatusBadge';

export default function Dashboard() {
  const devices = useMemo(() => getDevices(), []);
  const { statusMap, isChecking, lastChecked, refresh } = usePiStatus();
  const navigate = useNavigate();

  // Derived stats
  const onlineDevices = devices.filter(d => statusMap[d.id]?.ok === true);
  const offlineDevices = devices.filter(d => statusMap[d.id] && statusMap[d.id].ok === false);
  const totalMedia = Object.values(statusMap).reduce(
    (sum, s) => sum + (s?.data?.media_count ?? 0), 0
  );
  const currentlyPlaying = Object.values(statusMap).filter(
    s => s?.ok && s?.data?.current_media
  ).length;

  const recentUploads = useMemo(() => {
    const items = [];
    devices.forEach(d => {
      const s = statusMap[d.id];
      if (s?.ok && s?.data?.current_media) {
        items.push({ device: d, filename: s.data.current_media });
      }
    });
    return items.slice(0, 5);
  }, [statusMap, devices]);

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Dashboard</h1>
            <p>Overview of all Raspberry Pi signage devices on the college network</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {lastChecked && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Last checked: {lastChecked.toLocaleTimeString('en-IN')}
              </span>
            )}
            <button
              className="btn btn-secondary"
              onClick={refresh}
              disabled={isChecking}
            >
              {isChecking ? <span className="spinner spinner-sm" /> : '🔄'}
              {isChecking ? 'Checking…' : 'Refresh Status'}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => navigate('/devices')}
            >
              + Add Device
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <StatCard icon="📡" label="Total Devices" value={devices.length} variant="accent" />
        <StatCard icon="🟢" label="Online" value={onlineDevices.length} variant="success" />
        <StatCard icon="🔴" label="Offline" value={offlineDevices.length} variant="danger" />
        <StatCard icon="🏫" label="Classrooms" value={devices.length} variant="accent" />
        <StatCard icon="🎞️" label="Total Media" value={totalMedia} variant="warning" />
        <StatCard icon="▶️" label="Playing Now" value={currentlyPlaying} variant="success" />
      </div>

      {/* Two column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 'var(--space-6)', alignItems: 'start' }}>

        {/* Device Grid */}
        <div>
          <div style={{ marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>
              Raspberry Pi Devices
            </h2>
            {isChecking && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                <span className="spinner spinner-sm" /> Checking status…
              </div>
            )}
          </div>

          {devices.length === 0 ? (
            <div className="empty-state card">
              <div className="es-icon">📡</div>
              <h3>No devices added yet</h3>
              <p>Add your first Raspberry Pi to start managing classroom signage.</p>
              <button className="btn btn-primary" onClick={() => navigate('/devices')}>
                + Add Device
              </button>
            </div>
          ) : (
            <div className="device-grid">
              {devices.map(device => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  statusEntry={statusMap[device.id]}
                  onEdit={() => navigate('/devices', { state: { editId: device.id } })}
                  onDelete={() => navigate('/devices', { state: { deleteId: device.id } })}
                  onTest={() => refresh()}
                  onManageMedia={() => navigate('/media', { state: { deviceId: device.id } })}
                />
              ))}
            </div>
          )}
        </div>

        {/* Sidebar panels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

          {/* Network summary */}
          <div className="card">
            <div className="card-header">
              <span className="card-title" style={{ fontSize: 'var(--text-base)' }}>Network Summary</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {devices.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No devices configured</p>
              ) : (
                devices.slice(0, 8).map(d => {
                  const s = statusMap[d.id];
                  const status = !s ? 'unknown' : s.ok ? 'online' : 'offline';
                  return (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                          {d.classroom}
                        </div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{d.ip}</div>
                      </div>
                      <StatusBadge status={status} />
                    </div>
                  );
                })
              )}
              {devices.length > 8 && (
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/devices')} style={{ alignSelf: 'flex-start' }}>
                  View all {devices.length} devices →
                </button>
              )}
            </div>
          </div>

          {/* Currently playing */}
          <div className="card">
            <div className="card-header">
              <span className="card-title" style={{ fontSize: 'var(--text-base)' }}>Now Playing</span>
            </div>
            {recentUploads.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No media currently displayed</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {recentUploads.map(({ device, filename }) => (
                  <div key={device.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <span className="dot dot-online" />
                      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>
                        {device.classroom}
                      </span>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', paddingLeft: 'var(--space-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {filename}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick upload */}
          <div className="card" style={{ background: 'var(--accent-subtle)', border: '1px solid rgba(47,129,247,0.25)' }}>
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--accent)' }}>
                ⬆️ Quick Upload
              </div>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                Upload media directly to a classroom Pi
              </p>
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => navigate('/upload')}>
              Open Upload Wizard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, variant }) {
  return (
    <div className={`stat-card ${variant}`}>
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
