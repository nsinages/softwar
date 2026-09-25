// =============================================
// N Signage V2 — Classrooms Page
// =============================================
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDevices } from '../data/store';
import { getPiStatus } from '../api/piApi';
import StatusBadge from '../components/StatusBadge';

function groupByDeptBlock(devices) {
  const map = {};
  devices.forEach(d => {
    if (!map[d.department]) map[d.department] = {};
    const bKey = d.block || 'No Block';
    if (!map[d.department][bKey]) map[d.department][bKey] = [];
    map[d.department][bKey].push(d);
  });
  return map;
}

export default function Classrooms() {
  const devices = useMemo(() => getDevices(), []);
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState({});
  const [statusMap, setStatusMap] = useState({});
  const [checkingId, setCheckingId] = useState(null);
  const [view, setView] = useState('tree'); // 'tree' | 'table'

  const tree = useMemo(() => groupByDeptBlock(devices), [devices]);

  function toggleExpand(key) {
    setExpanded(e => ({ ...e, [key]: !e[key] }));
  }

  async function checkStatus(device) {
    setCheckingId(device.id);
    const result = await getPiStatus(device.ip);
    setStatusMap(m => ({ ...m, [device.id]: result }));
    setCheckingId(null);
  }

  function getStatus(device) {
    if (checkingId === device.id) return 'checking';
    const s = statusMap[device.id];
    if (!s) return 'unknown';
    return s.ok ? 'online' : 'offline';
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Classrooms</h1>
            <p>All classrooms and their assigned Raspberry Pi devices</p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button
              className={`btn ${view === 'tree' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView('tree')}
            >
              🌳 Tree View
            </button>
            <button
              className={`btn ${view === 'table' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView('table')}
            >
              📋 Table View
            </button>
          </div>
        </div>
      </div>

      {devices.length === 0 ? (
        <div className="empty-state card">
          <div className="es-icon">🏫</div>
          <h3>No classrooms configured</h3>
          <p>Add a Raspberry Pi device to a classroom to see it here.</p>
          <button className="btn btn-primary" onClick={() => navigate('/devices')}>+ Add Device</button>
        </div>
      ) : view === 'tree' ? (
        <TreeView tree={tree} devices={devices} statusMap={statusMap} checkingId={checkingId} getStatus={getStatus} checkStatus={checkStatus} expanded={expanded} toggleExpand={toggleExpand} navigate={navigate} />
      ) : (
        <TableView devices={devices} getStatus={getStatus} checkStatus={checkStatus} statusMap={statusMap} navigate={navigate} />
      )}
    </div>
  );
}

function TreeView({ tree, devices, statusMap, checkingId, getStatus, checkStatus, expanded, toggleExpand, navigate }) {
  const depts = Object.keys(tree).sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {depts.map(dept => {
        const deptKey = `dept-${dept}`;
        const isDeptOpen = expanded[deptKey] !== false; // open by default
        const blocks = Object.keys(tree[dept]).sort();
        const deptDevices = devices.filter(d => d.department === dept);
        const deptOnline = deptDevices.filter(d => statusMap[d.id]?.ok).length;

        return (
          <div key={dept} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Department header */}
            <div
              onClick={() => toggleExpand(deptKey)}
              style={{
                padding: 'var(--space-4) var(--space-5)',
                display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                cursor: 'pointer', background: 'var(--bg-elevated)',
                borderBottom: isDeptOpen ? '1px solid var(--border)' : 'none',
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: 20 }}>🎓</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>
                  {dept}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {deptDevices.length} classroom{deptDevices.length !== 1 ? 's' : ''} · {blocks.length} block{blocks.length !== 1 ? 's' : ''}
                  {deptOnline > 0 && <span style={{ color: 'var(--success)', marginLeft: 8 }}>· {deptOnline} online</span>}
                </div>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-lg)', transition: 'transform 200ms', transform: isDeptOpen ? 'rotate(90deg)' : 'none' }}>
                ›
              </span>
            </div>

            {isDeptOpen && (
              <div style={{ padding: 'var(--space-4) var(--space-5)' }}>
                {blocks.map(block => {
                  const blockKey = `block-${dept}-${block}`;
                  const isBlockOpen = expanded[blockKey] !== false;
                  const blockDevices = tree[dept][block];

                  return (
                    <div key={block} style={{ marginBottom: 'var(--space-3)' }}>
                      {/* Block header */}
                      <div
                        onClick={() => toggleExpand(blockKey)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                          padding: 'var(--space-2) var(--space-3)',
                          borderRadius: 'var(--radius-md)',
                          cursor: 'pointer',
                          background: 'var(--bg-hover)',
                          marginBottom: isBlockOpen ? 'var(--space-2)' : 0,
                          userSelect: 'none',
                        }}
                      >
                        <span>🏢</span>
                        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                          {block}
                        </span>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginLeft: 'auto', marginRight: 4 }}>
                          {blockDevices.length} room{blockDevices.length !== 1 ? 's' : ''}
                        </span>
                        <span style={{ color: 'var(--text-muted)', transition: 'transform 200ms', transform: isBlockOpen ? 'rotate(90deg)' : 'none' }}>›</span>
                      </div>

                      {isBlockOpen && (
                        <div style={{ paddingLeft: 'var(--space-5)', borderLeft: '2px solid var(--border-subtle)', marginLeft: 'var(--space-3)' }}>
                          {blockDevices.sort((a, b) => a.classroom.localeCompare(b.classroom)).map(device => {
                            const status = checkingId === device.id ? 'checking' : !statusMap[device.id] ? 'unknown' : statusMap[device.id].ok ? 'online' : 'offline';
                            const piData = statusMap[device.id]?.data;

                            return (
                              <div
                                key={device.id}
                                style={{
                                  display: 'flex', alignItems: 'center',
                                  padding: 'var(--space-3)',
                                  marginBottom: 2,
                                  borderRadius: 'var(--radius-md)',
                                  background: 'var(--bg-card)',
                                  border: '1px solid var(--border-subtle)',
                                  gap: 'var(--space-3)',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span style={{ fontSize: 18 }}>🚪</span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
                                    {device.classroom}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                                    <span className="ip-chip">{device.ip}</span>
                                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{device.floor}</span>
                                    {piData?.current_media && (
                                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                                        ▶ {piData.current_media}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <StatusBadge status={status} />
                                <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                                  <button
                                    className="btn btn-ghost btn-sm btn-icon"
                                    onClick={() => checkStatus(device)}
                                    disabled={checkingId === device.id}
                                    title="Check status"
                                  >
                                    {checkingId === device.id ? <span className="spinner spinner-sm" /> : '🔄'}
                                  </button>
                                  <button
                                    className="btn btn-ghost btn-sm btn-icon"
                                    onClick={() => navigate('/media', { state: { deviceId: device.id } })}
                                    title="Manage media"
                                  >
                                    🎞️
                                  </button>
                                  <button
                                    className="btn btn-ghost btn-sm btn-icon"
                                    onClick={() => navigate('/upload', { state: { department: device.department, block: device.block, classroom: device.classroom } })}
                                    title="Upload media"
                                  >
                                    ⬆️
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableView({ devices, getStatus, checkStatus, statusMap, navigate }) {
  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>Classroom</th>
            <th>Department</th>
            <th>Block</th>
            <th>Floor</th>
            <th>Pi IP</th>
            <th>Status</th>
            <th>Current Media</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map(device => {
            const status = getStatus(device);
            const piData = statusMap[device.id]?.data;
            return (
              <tr key={device.id}>
                <td><span className="badge badge-accent">{device.classroom}</span></td>
                <td>{device.department}</td>
                <td>{device.block || '—'}</td>
                <td>{device.floor || '—'}</td>
                <td><span className="ip-chip">{device.ip}</span></td>
                <td><StatusBadge status={status} /></td>
                <td>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', maxWidth: 140, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {piData?.current_media || '—'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => checkStatus(device)} title="Check">🔄</button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => navigate('/upload', { state: { department: device.department, block: device.block, classroom: device.classroom } })} title="Upload">⬆️</button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => navigate('/media', { state: { deviceId: device.id } })} title="Media">🎞️</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
