// =============================================
// N Signage — Devices Page
// =============================================
import React, { useState, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Plus,
  Search,
  RotateCw,
  Pencil,
  Trash2,
  Tv,
  Film,
  Loader2,
  X,
  Tag,
  Network,
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

export default function Devices() {
  const location = useLocation();
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
  }, [location.state]);

  function openEdit(device) {
    setEditId(device.id);
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
    setForm(EMPTY_FORM);
    setErrors({});
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function validate() {
    const e = {};
    if (!form.deviceId.trim()) e.deviceId = 'Pi Username / Device Identifier is required';

    const ipRx = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!form.ip.trim()) e.ip = 'IP address is required';
    else if (!ipRx.test(form.ip.trim())) e.ip = 'Enter a valid IPv4 address (e.g. 10.10.40.94)';
    return e;
  }

  function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    if (editId) {
      updateDevice(editId, form);
    } else {
      saveDevice(form);
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
    const result = await getPiStatus(device.ip);
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
                    onChange={e => setForm(f => ({ ...f, deviceId: e.target.value }))}
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
                    onChange={e => setForm(f => ({ ...f, nickName: e.target.value }))}
                  />
                </div>

                {/* V3 Discovery Panel */}
                <PiDiscoveryPanel
                  key={form.deviceId.trim()}
                  identifier={form.deviceId}
                  onUseIp={ip => setForm(f => ({ ...f, ip }))}
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
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeForm}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editId ? 'Save Changes' : 'Add Device'}
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
