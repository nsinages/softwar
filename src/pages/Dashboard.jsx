// =============================================
// N Signage — Dashboard Page
// =============================================
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Tv,
  CheckCircle2,
  AlertCircle,
  Film,
  Plus,
  RotateCw,
  Clock,
  Loader2,
} from 'lucide-react';
import { usePiStatus } from '../hooks/usePiStatus';
import { getDevices } from '../data/store';
import DeviceCard from '../components/DeviceCard';
import CloudDashboardDevices, { WelcomeCard } from '../components/CloudDashboardDevices';

export default function Dashboard({ user, onLogout }) {
  const devices = useMemo(() => getDevices(), []);
  const { statusMap, isChecking, lastChecked, refresh } = usePiStatus();
  const navigate = useNavigate();

  // Derived stats
  const onlineDevices = devices.filter(d => statusMap[d.id]?.ok === true);
  // saved records (name + IP, not connected yet) are neither online nor offline
  const offlineDevices = devices.filter(d => d.registration !== 'saved' && statusMap[d.id] && statusMap[d.id].ok === false);
  const totalMediaFiles = useMemo(() => {
    return Object.values(statusMap).reduce((acc, curr) => {
      return acc + (curr?.data?.media_count || 0);
    }, 0);
  }, [statusMap]);

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Dashboard</h1>
            <p>{user ? 'Your Raspberry Pi signage displays' : 'Overview of all Raspberry Pi signage displays across your network'}</p>
          </div>
          <div className="page-header-actions">
            {lastChecked && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)',
                }}
              >
                <Clock size={13} />
                <span>Last checked: {lastChecked.toLocaleTimeString('en-IN')}</span>
              </div>
            )}
            <button
              className="btn btn-secondary"
              onClick={refresh}
              disabled={isChecking}
              title="Refresh status of all devices"
            >
              {isChecking ? (
                <Loader2
                  size={14}
                  className="spinner"
                  style={{ border: 'none', animation: 'spin 0.8s linear infinite' }}
                />
              ) : (
                <RotateCw size={14} />
              )}
              <span>{isChecking ? 'Checking…' : 'Refresh Status'}</span>
            </button>
            {!user && (
              <button
                className="btn btn-primary"
                onClick={() => navigate('/devices', { state: { openAdd: true } })}
              >
                <Plus size={15} />
                <span>Add Device</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {user && <WelcomeCard user={user} deviceCount={devices.length} onLogout={onLogout} />}

      {/* Metric Summary Cards */}
      <div className="stat-grid">
        <div className="stat-card accent">
          <div className="stat-content">
            <span className="stat-label">Total Devices</span>
            <div className="stat-value">{devices.length}</div>
            <span className="stat-subtext">Configured displays</span>
          </div>
          <div className="stat-icon-wrapper">
            <Tv size={22} />
          </div>
        </div>

        <div className="stat-card success">
          <div className="stat-content">
            <span className="stat-label">Online</span>
            <div className="stat-value" style={{ color: 'var(--success)' }}>
              {onlineDevices.length}
            </div>
            <span className="stat-subtext">Responding on network</span>
          </div>
          <div className="stat-icon-wrapper">
            <CheckCircle2 size={22} />
          </div>
        </div>

        <div className="stat-card danger">
          <div className="stat-content">
            <span className="stat-label">Offline</span>
            <div className="stat-value" style={{ color: offlineDevices.length > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
              {offlineDevices.length}
            </div>
            <span className="stat-subtext">Unreachable / inactive</span>
          </div>
          <div className="stat-icon-wrapper">
            <AlertCircle size={22} />
          </div>
        </div>

        <div className="stat-card info">
          <div className="stat-content">
            <span className="stat-label">Media Files</span>
            <div className="stat-value" style={{ color: 'var(--info)' }}>
              {totalMediaFiles}
            </div>
            <span className="stat-subtext">Stored on active Pis</span>
          </div>
          <div className="stat-icon-wrapper">
            <Film size={22} />
          </div>
        </div>
      </div>

      {/* Devices Section */}
      <div>
        <div
          style={{
            marginBottom: 'var(--space-4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
              Raspberry Pi Displays
            </h2>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              Active signage units reporting hardware and playback status
            </p>
          </div>
          {isChecking && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-xs)',
              }}
            >
              <Loader2 size={13} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
              <span>Polling fleet status…</span>
            </div>
          )}
        </div>

        {user ? (
          <CloudDashboardDevices devices={devices} statusMap={statusMap} />
        ) : devices.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Tv size={28} />
            </div>
            <h3>No Devices Configured</h3>
            <p>Add your first Raspberry Pi digital signage device to begin managing and broadcasting media.</p>
            <button
              className="btn btn-primary"
              onClick={() => navigate('/devices', { state: { openAdd: true } })}
              style={{ marginTop: 'var(--space-2)' }}
            >
              <Plus size={15} /> Add Device
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
    </div>
  );
}
