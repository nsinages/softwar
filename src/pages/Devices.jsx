// =============================================
// N Signage V2 — Devices Page
// =============================================
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { getDevices, saveDevice, updateDevice, deleteDevice } from '../data/store';
import { getPiStatus } from '../api/piApi';
import StatusBadge from '../components/StatusBadge';
import ConfirmModal from '../components/ConfirmModal';

const EMPTY_FORM = {
  name: '', department: '', block: '', floor: '', classroom: '', ip: '',
};

const DEPARTMENTS = [
  'Artificial Intelligence and Data Science',
  'Artificial Intelligence and Machine Learning',
  'Biomedical Engineering',
  'Chemical Engineering',
  'Civil Engineering',
  'Computer Science and Engineering',
  'Computer Science and Business Systems',
  'CSE (Cyber Security)',
  'Electrical and Electronics Engineering',
  'Electronics and Communication Engineering',
  'Electronics Engineering (VLSI Design and Technology)',
  'Engineering Physics',
  'Information Technology',
  'Mechanical Engineering',
  'Mechatronics Engineering',
  'Other'
];

const DEPT_SHORT = {
  'Artificial Intelligence and Data Science': 'AI&DS',
  'Artificial Intelligence and Machine Learning': 'AI&ML',
  'Biomedical Engineering': 'BME',
  'Chemical Engineering': 'CHEM',
  'Civil Engineering': 'CIVIL',
  'Computer Science and Engineering': 'CSE',
  'Computer Science and Business Systems': 'CSBS',
  'CSE (Cyber Security)': 'CSE-CS',
  'Electrical and Electronics Engineering': 'EEE',
  'Electronics and Communication Engineering': 'ECE',
  'Electronics Engineering (VLSI Design and Technology)': 'VLSI',
  'Engineering Physics': 'ENG-PHYS',
  'Information Technology': 'IT',
  'Mechanical Engineering': 'MECH',
  'Mechatronics Engineering': 'MCTR'
};

const FLOORS = ['Ground Floor', '1st Floor', '2nd Floor', '3rd Floor', '4th Floor'];

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

  // Handle navigation state (e.g. from dashboard)
  useEffect(() => {
    if (location.state?.editId) {
      const d = devices.find(x => x.id === location.state.editId);
      if (d) openEdit(d);
    }
    if (location.state?.deleteId) {
      const d = devices.find(x => x.id === location.state.deleteId);
      if (d) setDeleteTarget(d);
    }
  }, []);

  // Auto-generate name
  useEffect(() => {
    if (!editId && form.department && form.classroom) {
      const dept = DEPT_SHORT[form.department] || form.department.match(/\((\w+)\)/)?.[1] || form.department.split(' ')[0];
      setForm(f => ({ ...f, name: `N Signage - ${dept} - ${form.classroom}` }));
    }
  }, [form.department, form.classroom, editId]);

  function openEdit(device) {
    setEditId(device.id);
    setForm({
      name: device.name,
      department: device.department,
      block: device.block,
      floor: device.floor,
      classroom: device.classroom,
      ip: device.ip,
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
    if (!form.name.trim()) e.name = 'Device name is required';
    if (!form.department.trim()) e.department = 'Department is required';
    if (!form.classroom.trim()) e.classroom = 'Classroom is required';
    const ipRx = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!form.ip.trim()) e.ip = 'IP address is required';
    else if (!ipRx.test(form.ip.trim())) e.ip = 'Enter a valid IP address (e.g. 10.10.40.94)';
    return e;
  }

  function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
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
    }, 300);
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
    return devices.filter(d =>
      d.name?.toLowerCase().includes(q) ||
      d.department?.toLowerCase().includes(q) ||
      d.classroom?.toLowerCase().includes(q) ||
      d.ip?.includes(q)
    );
  }, [devices, searchQ]);

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Devices</h1>
            <p>Manage all Raspberry Pi signage devices</p>
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            + Add Device
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 'var(--space-4)', maxWidth: 340 }}>
        <input
          className="form-input"
          type="text"
          placeholder="🔍 Search by name, department, classroom, IP…"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
        />
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        {[
          { label: 'Total', value: devices.length },
          { label: 'Tested', value: Object.keys(testResults).length },
          { label: 'Online', value: Object.values(testResults).filter(r => r?.ok).length, color: 'var(--success)' },
          { label: 'Offline', value: Object.values(testResults).filter(r => r && !r.ok).length, color: 'var(--danger)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ display: 'flex', flex: 1, minWidth: 100, flexDirection: 'column', gap: 2, padding: 'var(--space-3)', background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
            <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--weight-bold)', color: color || 'var(--text-primary)' }}>{value}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Device Table */}
      {filtered.length === 0 ? (
        <div className="empty-state card">
          <div className="es-icon">{searchQ ? '🔍' : '📡'}</div>
          <h3>{searchQ ? 'No devices match your search' : 'No devices added yet'}</h3>
          <p>{searchQ ? 'Try a different search term.' : 'Add your first Raspberry Pi device to get started.'}</p>
          {!searchQ && <button className="btn btn-primary" onClick={openAdd}>+ Add Device</button>}
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Department</th>
                <th>Location</th>
                <th>IP Address</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(device => {
                const testResult = testResults[device.id];
                const isTesting = testingId === device.id;
                const status = isTesting ? 'checking' : !testResult ? 'unknown' : testResult.ok ? 'online' : 'offline';
                return (
                  <tr key={device.id}>
                    <td>
                      <div style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{device.name}</div>
                    </td>
                    <td>
                      <div style={{ fontSize: 'var(--text-sm)' }}>{device.department}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span className="badge badge-accent" style={{ alignSelf: 'flex-start' }}>{device.classroom}</span>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{device.block} · {device.floor}</span>
                      </div>
                    </td>
                    <td>
                      <span className="ip-chip">{device.ip}</span>
                      {testResult?.latency && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                          {testResult.latency}ms
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={status} />
                      {testResult?.ok && testResult.data?.current_media && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          ▶ {testResult.data.current_media}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleTest(device)}
                          disabled={isTesting}
                          title="Test connection"
                        >
                          {isTesting ? <span className="spinner spinner-sm" /> : '🔄'}
                          Test
                        </button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => openEdit(device)} title="Edit">✏️</button>
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => setDeleteTarget(device)}
                          title="Delete"
                          style={{ color: 'var(--danger)' }}
                        >
                          🗑️
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

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) closeForm(); }}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <h2 className="modal-title">{editId ? '✏️ Edit Device' : '+ Add New Device'}</h2>
              <button className="btn btn-ghost btn-icon" onClick={closeForm}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

                <div className="form-group">
                  <label className="form-label">Device Name</label>
                  <input
                    className={`form-input ${errors.name ? 'border-danger' : ''}`}
                    style={errors.name ? { borderColor: 'var(--danger)' } : {}}
                    placeholder="e.g. N Signage - CSE - A101"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                  {errors.name && <span className="form-error">{errors.name}</span>}
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Department</label>
                    <select
                      className="form-select"
                      value={form.department}
                      onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                      style={errors.department ? { borderColor: 'var(--danger)' } : {}}
                    >
                      <option value="">Select department</option>
                      {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                    {errors.department && <span className="form-error">{errors.department}</span>}
                  </div>

                  <div className="form-group">
                    <label className="form-label">Block (Optional)</label>
                    <input
                      className="form-input"
                      placeholder="e.g. A Block"
                      value={form.block}
                      onChange={e => setForm(f => ({ ...f, block: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Floor (Optional)</label>
                    <select
                      className="form-select"
                      value={form.floor}
                      onChange={e => setForm(f => ({ ...f, floor: e.target.value }))}
                    >
                      <option value="">Select floor</option>
                      {FLOORS.map(fl => <option key={fl} value={fl}>{fl}</option>)}
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Classroom</label>
                    <input
                      className="form-input"
                      placeholder="e.g. A101"
                      value={form.classroom}
                      onChange={e => setForm(f => ({ ...f, classroom: e.target.value }))}
                      style={errors.classroom ? { borderColor: 'var(--danger)' } : {}}
                    />
                    {errors.classroom && <span className="form-error">{errors.classroom}</span>}
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Raspberry Pi IP Address</label>
                  <input
                    className="form-input"
                    placeholder="e.g. 10.10.40.94"
                    value={form.ip}
                    onChange={e => setForm(f => ({ ...f, ip: e.target.value }))}
                    style={{ fontFamily: 'var(--font-mono)', ...(errors.ip ? { borderColor: 'var(--danger)' } : {}) }}
                  />
                  {errors.ip && <span className="form-error">{errors.ip}</span>}
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    LAN IP address of the Raspberry Pi on the college network
                  </span>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeForm}>Cancel</button>
                <button type="submit" className="btn btn-primary">
                  {editId ? '✓ Save Changes' : '+ Add Device'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isLoading={deleteLoading}
        title="Delete Device"
        message={
          <span>
            Are you sure you want to remove <strong>{deleteTarget?.name}</strong>?
            <br /><br />
            This only removes the device from this dashboard. It does <em>not</em> affect the Raspberry Pi itself.
          </span>
        }
        confirmLabel="Delete Device"
        variant="danger"
      />
    </div>
  );
}
