// =============================================
// N Signage — Customer dashboard: welcome + the account's displays (hosted website)
// Status comes from each Pi's own heartbeat to the cloud (online = synced in the last minute).
// =============================================
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Settings2, LogOut, Tv, Film, UploadCloud } from 'lucide-react';
import StatusBadge from './StatusBadge';

const VIA = {
  network: 'Added on the same Wi-Fi',
  'pairing-code': 'Added with pairing code',
  'legacy+network': 'Linked from this browser (Wi-Fi verified)',
  'legacy+pairing-code': 'Linked from this browser (code verified)',
  migrated: 'Migrated',
  admin: 'Added by support',
};

function ago(ms) {
  if (!ms) return 'Never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Welcome banner with the main actions (top of the customer dashboard). */
export function WelcomeCard({ user, deviceCount, onLogout }) {
  const navigate = useNavigate();
  const devices = { length: deviceCount };
  return (
    <div className="card welcome-card">
        <div>
          <div className="welcome-title">Welcome, {user.displayName || user.username}</div>
          <div className="welcome-sub">
            Signed in as <strong>{user.username}</strong> · {devices.length} display{devices.length === 1 ? '' : 's'} in your account
          </div>
        </div>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => navigate('/devices', { state: { openAdd: true } })}>
            <Plus size={15} /> Add Device
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/devices')}>
            <Settings2 size={15} /> Manage Devices
          </button>
          <button className="btn btn-ghost" onClick={onLogout}>
            <LogOut size={15} /> Log out
          </button>
        </div>
      </div>
  );
}

export default function CloudDashboardDevices({ devices, statusMap }) {
  const navigate = useNavigate();
  return (
    <>
      {devices.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Tv size={28} /></div>
          <h3>No displays in your account yet</h3>
          <p>Add your Raspberry Pi display: connect this phone or computer to the same Wi-Fi as the display, or use the pairing code shown on its screen.</p>
          <button className="btn btn-primary" onClick={() => navigate('/devices', { state: { openAdd: true } })} style={{ marginTop: 'var(--space-2)' }}>
            <Plus size={15} /> Add Device
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table className="cloud-devices-table">
            <thead>
              <tr>
                <th>Display</th>
                <th>Device ID</th>
                <th>Hostname</th>
                <th>Registration</th>
                <th>Status</th>
                <th>Last connection</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const st = statusMap[d.id];
                const online = st ? st.ok : d.online;
                const lastSeen = st?.lastSeen || d.lastSeen;
                return (
                  <tr key={d.id}>
                    <td data-label="Display"><strong>{d.nickName || d.hostname || d.deviceId}</strong>{d.location ? <div className="muted-sm">{d.location}</div> : null}</td>
                    <td data-label="Device ID" className="mono">{d.piDeviceId}</td>
                    <td data-label="Hostname">{d.hostname || '—'}</td>
                    <td data-label="Registration">
                      <div>{VIA[d.addedVia] || 'Registered'}</div>
                      {d.createdAt && <div className="muted-sm">{new Date(d.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</div>}
                    </td>
                    <td data-label="Status"><StatusBadge status={st === undefined && online === undefined ? 'unknown' : online ? 'online' : 'offline'} /></td>
                    <td data-label="Last connection">{ago(lastSeen)}</td>
                    <td className="row-actions">
                      <button className="btn btn-ghost btn-sm" title="Media on this display" onClick={() => navigate('/media', { state: { deviceId: d.id } })}><Film size={14} /> Media</button>
                      <button className="btn btn-ghost btn-sm" title="Upload to this display" onClick={() => navigate('/upload', { state: { preselectDeviceId: d.id } })}><UploadCloud size={14} /> Upload</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
