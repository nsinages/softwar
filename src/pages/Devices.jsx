// =============================================
// N Signage — Devices Page
// =============================================
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  RotateCw,
  Pencil,
  Trash2,
  Tv,
  Loader2,
  X,
  Tag,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { getDevices, saveDevice, updateDevice, deleteDevice } from '../data/store';
import { getPiStatus } from '../api/piApi';
import StatusBadge from '../components/StatusBadge';
import ConfirmModal from '../components/ConfirmModal';
import PiDiscoveryPanel from '../components/PiDiscoveryPanel';

const EMPTY_FORM = {
  deviceId: '',
  nickName: '',
  ip: '',
};

// Linux username (same rule as the discovery helper) and a strict IPv4 check
const USERNAME_RX = /^[a-z0-9_][a-z0-9_.-]{0,31}$/i;
const IPV4_RX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const sameUser = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export default function Devices() {
  const location = useLocation();
  const navigate = useNavigate();
  const [devices, setDevices] = useState(() => getDevices());
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [testResults, setTestResults] = useState({});
  const [testingId, setTestingId] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [discovered, setDiscovered] = useState(null); // Pi verified by Find Pi
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const formSession = useRef(0);

  const reload = () => setDevices(getDevices());

  // Handle navigation state (e.g. from dashboard or direct route)
  useEffect(() => {
    if (location.state?.openAdd) {
      openAdd();
    }
    if (location.state?.editId) {
      const d = devices.find(x => x.id === location.state.editId);
      if (d) openEdit(d);
    }
    if (location.state?.deleteId) {
      const d = devices.find(x => x.id === location.state.deleteId);
      if (d) setDeleteTarget(d);
    }
    // Consume the one-shot navigation state so a page refresh does not re-open it
    if (location.state) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function openEdit(device) {
    setEditId(device.id);
    setDiscovered(null);
    setFormError('');
    setSubmitting(false);
    formSession.current += 1;
    setForm({
      deviceId: device.deviceId || '',
      nickName: device.nickName || '',
      ip: device.ip || '',
    });
    setErrors({});
    setShowForm(true);
  }

  function openAdd() {
    setEditId(null);
    setDiscovered(null);
    setFormError('');
    setSubmitting(false);
    formSession.current += 1;
    setForm(EMPTY_FORM);
    setErrors({});
    setShowForm(true);
  }

  function closeForm() {
    formSession.current += 1; // abandon any Add Device verification in flight
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setDiscovered(null);
    setSubmitting(false);
    setFormError('');
  }

  function validate() {
    const e = {};
    if (!form.deviceId.trim()) e.deviceId = 'Pi Username / Device Identifier is required';
    else if (!USERNAME_RX.test(form.deviceId.trim()))
      e.deviceId = 'Enter the Pi\'s Linux username (letters, numbers, "_", "." or "-"), e.g. ns';

    if (form.nickName.trim().length > 64) e.nickName = 'Nickname must be 64 characters or fewer';

    if (!form.ip.trim()) e.ip = 'IP address is required';
    else if (!IPV4_RX.test(form.ip.trim()))
      e.ip = 'Enter a valid IPv4 address (e.g. 10.10.40.94)';
    else if (getDevices().some(d => d.id !== editId && d.ip?.trim() === form.ip.trim()))
      e.ip = 'Another device is already registered with this IP address';
    return e;
  }

  // Add Device: confirm the Pi at this IP is reachable and really is the
  // entered Linux user before using the existing registration (saveDevice).
  async function registerNewDevice() {
    const username = form.deviceId.trim();
    const ip = form.ip.trim();
    const session = formSession.current;
    const current = getDevices();

    const sameIp = current.find(d => d.ip?.trim() === ip);
    if (sameIp) {
      setFormError(`A device with IP ${ip} is already registered (${sameIp.nickName || sameIp.deviceId}).`);
      return;
    }

    setSubmitting(true);
    setFormError('');
    const status = await getPiStatus({ ip });
    if (session !== formSession.current) return; // form was closed meanwhile

    if (!status.ok) {
      setSubmitting(false);
      setFormError(`Could not reach the Raspberry Pi at ${ip}. Check that it is powered on, on the same Wi-Fi, and that the IP address is correct. (${status.error})`);
      return;
    }

    // Username must come from the Pi itself: /api/status, or the Find Pi
    // broadcast reply for this exact IP (Pis running older N-Signage builds).
    const reported = status.data?.pi_username;
    const verifiedByDiscovery = discovered && discovered.ip === ip && sameUser(discovered.username, username);
    if (reported ? !sameUser(reported, username) : !verifiedByDiscovery) {
      setSubmitting(false);
      setFormError(
        reported
          ? `The Raspberry Pi at ${ip} reports the username "${reported}", not "${username}". Check the username or the IP address.`
          : `The Raspberry Pi at ${ip} did not confirm its username. Use Find Pi, or update the N-Signage software on the Pi.`
      );
      return;
    }

    const piDeviceId = status.data?.device_id || (verifiedByDiscovery ? discovered.deviceId : undefined);
    const sameHardware = piDeviceId && current.find(d => d.piDeviceId === piDeviceId);
    if (sameHardware) {
      setSubmitting(false);
      setFormError(`This Raspberry Pi is already registered as "${sameHardware.nickName || sameHardware.deviceId}" (${sameHardware.ip}). Edit that device to change its IP address.`);
      return;
    }

    const hostname = status.data?.hostname || (verifiedByDiscovery ? discovered.hostname : undefined);
    const saved = saveDevice({
      deviceId: reported || discovered.username,
      nickName: form.nickName.trim(),
      ip,
      ...(hostname && { hostname }),
      ...(piDeviceId && { piDeviceId }),
    });
    reload();
    closeForm();
    setSuccessMsg(`${saved.nickName || saved.deviceId} (${saved.ip}) was added successfully.`);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    if (editId) {
      updateDevice(editId, {
        deviceId: form.deviceId.trim(),
        nickName: form.nickName.trim(),
        ip: form.ip.trim(),
      });
    } else {
      registerNewDevice();
      return;
    }
    reload();
    closeForm();
  }

  function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setTimeout(() => {
      deleteDevice(deleteTarget.id);
      reload();
      setDeleteTarget(null);
      setDeleteLoading(false);
    }, 250);
  }

  async function handleTest(device) {
    setTestingId(device.id);
    setTestResults(r => ({ ...r, [device.id]: null }));
    const result = await getPiStatus(device);
    setTestResults(r => ({ ...r, [device.id]: result }));
    setTestingId(null);
  }

  const filtered = useMemo(() => {
    if (!searchQ.trim()) return devices;
    const q = searchQ.toLowerCase();
    return devices.filter(
      d =>
        d.deviceId?.toLowerCase().includes(q) ||
        d.nickName?.toLowerCase().includes(q) ||
        d.ip?.includes(q)
    );
  }, [devices, searchQ]);

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Devices</h1>
            <p>Manage and monitor your Raspberry Pi signage devices</p>
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            <Plus size={15} />
            <span>Add Device</span>
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="alert alert-success" style={{ marginBottom: 'var(--space-4)' }}>
          <CheckCircle2 size={15} className="alert-icon" />
          <span style={{ flex: 1 }}>{successMsg}</span>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setSuccessMsg('')}
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Filter and Stats Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-5)',
          flexWrap: 'wrap',
        }}
      >
        <div className="search-box" style={{ width: 320, maxWidth: '100%' }}>
          <Search size={15} className="search-icon" />
          <input
            className="form-input"
            type="text"
            placeholder="Search by ID, nickname, IP…"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
          />
          {searchQ && (
            <button
              onClick={() => setSearchQ('')}
              className="btn btn-ghost btn-icon btn-sm"
              style={{ position: 'absolute', right: 6 }}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Quick Stats Pills */}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <div
            style={{
              padding: '6px 14px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-full)',
              fontSize: 'var(--text-xs)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span style={{ color: 'var(--text-muted)' }}>Total:</span>
            <strong style={{ color: 'var(--text-primary)' }}>{devices.length}</strong>
          </div>

          <div
            style={{
              padding: '6px 14px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-full)',
              fontSize: 'var(--text-xs)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span style={{ color: 'var(--text-muted)' }}>Tested:</span>
            <strong style={{ color: 'var(--text-primary)' }}>{Object.keys(testResults).length}</strong>
          </div>

          <div
            style={{
              padding: '6px 14px',
              background: 'var(--bg-card)',
              border: '1px solid rgba(16, 185, 129, 0.2)',
              borderRadius: 'var(--radius-full)',
              fontSize: 'var(--text-xs)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span className="dot dot-online" style={{ width: 6, height: 6 }} />
            <span style={{ color: 'var(--text-muted)' }}>Online:</span>
            <strong style={{ color: 'var(--success)' }}>
              {Object.values(testResults).filter(r => r?.ok).length}
            </strong>
          </div>

          <div
            style={{
              padding: '6px 14px',
              background: 'var(--bg-card)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: 'var(--radius-full)',
              fontSize: 'var(--text-xs)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span className="dot dot-offline" style={{ width: 6, height: 6 }} />
            <span style={{ color: 'var(--text-muted)' }}>Offline:</span>
            <strong style={{ color: 'var(--danger)' }}>
              {Object.values(testResults).filter(r => r && !r.ok).length}
            </strong>
          </div>
        </div>
      </div>

      {/* Device Table */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Tv size={26} />
          </div>
          <h3>{searchQ ? 'No Devices Found' : 'No Devices Configured'}</h3>
          <p>
            {searchQ
              ? `No devices matched "${searchQ}". Try searching with a different keyword.`
              : 'Add your first Raspberry Pi device to start controlling digital displays.'}
          </p>
          {!searchQ && (
            <button className="btn btn-primary" onClick={openAdd} style={{ marginTop: 'var(--space-2)' }}>
              <Plus size={15} /> Add Device
            </button>
          )}
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th style={{ width: '25%' }}>Device</th>
                <th style={{ width: '20%' }}>Nickname</th>
                <th style={{ width: '22%' }}>IP Address</th>
                <th style={{ width: '18%' }}>Status</th>
                <th style={{ width: '15%', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(device => {
                const testResult = testResults[device.id];
                const isTesting = testingId === device.id;
                const status = isTesting
                  ? 'checking'
                  : !testResult
                  ? 'unknown'
                  : testResult.ok
                  ? 'online'
                  : 'offline';

                return (
                  <tr key={device.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--bg-elevated)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--accent)',
                            flexShrink: 0,
                          }}
                        >
                          <Tv size={16} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                            {device.deviceId}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td>
                      {device.nickName ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)' }}>
                          <Tag size={12} style={{ color: 'var(--text-muted)' }} />
                          <span>{device.nickName}</span>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>

                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className="ip-chip">{device.ip}</span>
                        {testResult?.latency && (
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            {testResult.latency}ms
                          </span>
                        )}
                      </div>
                    </td>

                    <td>
                      <StatusBadge status={status} />
                      {testResult?.ok && testResult.data?.current_media && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                            marginTop: 3,
                            maxWidth: 160,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontFamily: 'var(--font-mono)',
                          }}
                          title={testResult.data.current_media}
                        >
                          ▶ {testResult.data.current_media}
                        </div>
                      )}
                    </td>

                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleTest(device)}
                          disabled={isTesting}
                          title="Test connection"
                        >
                          {isTesting ? (
                            <Loader2
                              size={12}
                              className="spinner"
                              style={{ border: 'none', animation: 'spin 0.8s linear infinite' }}
                            />
                          ) : (
                            <RotateCw size={12} />
                          )}
                          <span>Test</span>
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => openEdit(device)}
                          title="Edit device"
                          aria-label="Edit device"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => setDeleteTarget(device)}
                          title="Delete device"
                          aria-label="Delete device"
                          style={{ color: 'var(--danger)' }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit Device Modal */}
      {showForm && (
        <div
          className="modal-overlay"
          onClick={e => {
            if (e.target === e.currentTarget) closeForm();
          }}
        >
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <div className="modal-title">
                <Tv size={18} style={{ color: 'var(--accent)' }} />
                <span>{editId ? 'Edit Device' : 'Add New Device'}</span>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={closeForm}
                aria-label="Close form"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {/* Device Identifier */}
                <div className="form-group">
                  <label className="form-label">Pi Username / Device Identifier</label>
                  <input
                    className="form-input"
                    placeholder="e.g. n-sinage"
                    value={form.deviceId}
                    onChange={e => {
                      setForm(f => ({ ...f, deviceId: e.target.value }));
                      setDiscovered(null);
                    }}
                  />
                  {errors.deviceId && <span className="form-error">{errors.deviceId}</span>}
                  <span className="form-hint">Host identifier configured on your Raspberry Pi</span>
                </div>

                {/* Nickname */}
                <div className="form-group">
                  <label className="form-label">Nickname (Optional)</label>
                  <input
                    className="form-input"
                    placeholder="e.g. Main Lobby Display, Room 101"
                    value={form.nickName}
                    maxLength={64}
                    onChange={e => setForm(f => ({ ...f, nickName: e.target.value }))}
                  />
                  {errors.nickName && <span className="form-error">{errors.nickName}</span>}
                </div>

                {/* V3 Discovery Panel */}
                <PiDiscoveryPanel
                  key={form.deviceId.trim()}
                  identifier={form.deviceId}
                  onUseIp={ip => setForm(f => ({ ...f, ip }))}
                  onFound={setDiscovered}
                />

                {/* IP Address */}
                <div className="form-group">
                  <label className="form-label">Raspberry Pi IP Address</label>
                  <input
                    className="form-input"
                    placeholder="e.g. 10.10.40.94"
                    value={form.ip}
                    onChange={e => setForm(f => ({ ...f, ip: e.target.value }))}
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                  {errors.ip && <span className="form-error">{errors.ip}</span>}
                  <span className="form-hint">Static or DHCP assigned local IPv4 address</span>
                </div>

                {formError && (
                  <div className="alert alert-danger" style={{ fontSize: 'var(--text-xs)' }}>
                    <AlertTriangle size={14} className="alert-icon" />
                    <span>{formError}</span>
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeForm}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 size={14} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
                      Verifying Raspberry Pi...
                    </>
                  ) : editId ? 'Save Changes' : 'Add Device'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isLoading={deleteLoading}
        title="Delete Device"
        message={
          <span>
            Are you sure you want to remove <strong>{deleteTarget?.deviceId}</strong>?
            <br /><br />
            This will remove the display from this management dashboard. The physical Raspberry Pi and its stored files will remain unaffected.
          </span>
        }
        confirmLabel="Delete Device"
        variant="danger"
      />
    </div>
  );
}
