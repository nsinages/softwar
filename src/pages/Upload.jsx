// =============================================
// N Signage V2 — Upload Page
// Classroom-targeted multi-upload workflow
// =============================================
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUniqueDepartments, getDevices } from '../data/store';
import { getPiStatus, uploadMedia } from '../api/piApi';
import UploadPanel from '../components/UploadPanel';
import StatusBadge from '../components/StatusBadge';

const STEP = { SELECT: 1, FILE: 2, UPLOADING: 3, RESULT: 4 };

export default function Upload() {
  const navigate = useNavigate();

  const [department, setDepartment] = useState('');
  const [block, setBlock] = useState('');
  const [classroomNum, setClassroomNum] = useState('');
  const [selectedClassrooms, setSelectedClassrooms] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);

  const [piStatuses, setPiStatuses] = useState({}); // room -> { ok, data, checking, error }
  const [checkingStatuses, setCheckingStatuses] = useState(false);

  const [uploadStates, setUploadStates] = useState({}); // room -> { progress, status, error }
  const [step, setStep] = useState(STEP.SELECT);

  // Extract all unique filter options directly from devices list
  const departments = useMemo(() => getUniqueDepartments(), []);
  
  const blocks = useMemo(() => {
    return [...new Set(getDevices().map(d => d.block).filter(Boolean))].sort();
  }, []);

  const classroomNums = useMemo(() => {
    return [...new Set(getDevices().map(d => d.classroom).filter(Boolean))].sort();
  }, []);

  // Filter classrooms list based on concurrent filters
  const classroomsList = useMemo(() => {
    let list = getDevices();
    if (department) {
      list = list.filter(d => d.department === department);
    }
    if (block) {
      list = list.filter(d => d.block === block);
    }
    if (classroomNum) {
      list = list.filter(d => d.classroom === classroomNum);
    }
    return list;
  }, [department, block, classroomNum]);

  // Fetch statuses of classrooms
  const fetchAllStatuses = useCallback(async (list) => {
    if (list.length === 0) return;
    setCheckingStatuses(true);
    
    // Set all to checking
    const loadingStates = {};
    list.forEach(c => {
      loadingStates[c.classroom] = { checking: true };
    });
    setPiStatuses(loadingStates);

    const promises = list.map(async (c) => {
      const res = await getPiStatus(c.ip);
      return { room: c.classroom, status: res };
    });

    const results = await Promise.all(promises);
    const finalStatuses = {};
    results.forEach(({ room, status }) => {
      finalStatuses[room] = { checking: false, ...status };
    });
    setPiStatuses(finalStatuses);
    setCheckingStatuses(false);
  }, []);

  // Update statuses when classrooms list changes
  useEffect(() => {
    if (classroomsList.length > 0) {
      fetchAllStatuses(classroomsList);
      setSelectedClassrooms([]); // Reset selection on filter change
    } else {
      setPiStatuses({});
      setSelectedClassrooms([]);
    }
  }, [classroomsList, fetchAllStatuses]);

  function handleClassroomToggle(roomName) {
    setSelectedClassrooms(prev =>
      prev.includes(roomName)
        ? prev.filter(r => r !== roomName)
        : [...prev, roomName]
    );
  }

  function handleSelectAllToggle(e) {
    if (e.target.checked) {
      setSelectedClassrooms(classroomsList.map(c => c.classroom));
    } else {
      setSelectedClassrooms([]);
    }
  }

  const canProceedToFile = selectedClassrooms.length > 0;
  const canUpload = selectedFile && selectedClassrooms.length > 0 && step !== STEP.UPLOADING;

  async function handleUpload() {
    if (!selectedFile || selectedClassrooms.length === 0) return;
    setStep(STEP.UPLOADING);

    // Initialize upload statuses
    const initial = {};
    selectedClassrooms.forEach(room => {
      initial[room] = { progress: 0, status: 'pending' };
    });
    setUploadStates(initial);

    // Upload sequentially to each target Pi
    for (const room of selectedClassrooms) {
      const device = classroomsList.find(c => c.classroom === room);
      if (!device) continue;

      setUploadStates(prev => ({
        ...prev,
        [room]: { ...prev[room], status: 'uploading' }
      }));

      // Live status check first
      const statusRes = await getPiStatus(device.ip);
      if (!statusRes.ok) {
        setUploadStates(prev => ({
          ...prev,
          [room]: {
            ...prev[room],
            status: 'failed',
            error: 'Raspberry Pi is offline or unreachable'
          }
        }));
        continue;
      }

      // Perform upload
      const result = await uploadMedia(
        device.ip,
        selectedFile,
        (pct) => {
          setUploadStates(prev => ({
            ...prev,
            [room]: { ...prev[room], progress: pct }
          }));
        }
      );

      setUploadStates(prev => ({
        ...prev,
        [room]: {
          ...prev[room],
          status: result.ok ? 'success' : 'failed',
          error: result.ok ? undefined : result.error
        }
      }));
    }

    setStep(STEP.RESULT);
  }

  function handleReset() {
    setSelectedFile(null);
    setUploadStates({});
    setStep(STEP.SELECT);
  }

  const overallSuccess = Object.values(uploadStates).every(s => s.status === 'success');
  const overallFailure = Object.values(uploadStates).every(s => s.status === 'failed');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Upload Media</h1>
          <p>Filter classrooms and upload media directly to their Raspberry Pi devices</p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 380px',
          gap: 'var(--space-6)',
          alignItems: 'start',
        }}
      >
        {/* Main upload column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>

          {/* Step 1: Classroom target selection */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
              <StepBadge n={1} active={step === STEP.SELECT || step === STEP.FILE} done={canProceedToFile} />
              <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>
                Select Target Classrooms
              </h2>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              
              {/* Three Concurrent Filters */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
                <div className="form-group">
                  <label className="form-label">Department</label>
                  <select className="form-select" value={department} onChange={e => setDepartment(e.target.value)}>
                    <option value="">— All Departments —</option>
                    {departments.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Block</label>
                  <select className="form-select" value={block} onChange={e => setBlock(e.target.value)}>
                    <option value="">— All Blocks —</option>
                    {blocks.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Classroom Number</label>
                  <select className="form-select" value={classroomNum} onChange={e => setClassroomNum(e.target.value)}>
                    <option value="">— All Numbers —</option>
                    {classroomNums.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>

              {/* Classrooms checklist */}
              <div style={{ marginTop: 'var(--space-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
                  <span className="section-label" style={{ margin: 0 }}>Classrooms ({classroomsList.length})</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => fetchAllStatuses(classroomsList)}
                    disabled={checkingStatuses || classroomsList.length === 0}
                  >
                    {checkingStatuses ? <span className="spinner spinner-sm" /> : '🔄'} Refresh Status
                  </button>
                </div>

                {classroomsList.length === 0 ? (
                  <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)' }}>
                    ⚠️ No classrooms match current filter combination.
                  </div>
                ) : (
                  <div
                    style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      maxHeight: '220px',
                      overflowY: 'auto',
                      padding: 'var(--space-2) 0',
                    }}
                  >
                    {/* Select All */}
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        padding: '8px var(--space-4)',
                        borderBottom: '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                        fontWeight: 'var(--weight-semibold)',
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        style={{ width: 16, height: 16 }}
                        checked={selectedClassrooms.length === classroomsList.length && classroomsList.length > 0}
                        onChange={handleSelectAllToggle}
                      />
                      <span>Select All ({classroomsList.length})</span>
                    </label>

                    {/* Classrooms List */}
                    {classroomsList.map(c => {
                      const statusObj = piStatuses[c.classroom] || {};
                      const isSelected = selectedClassrooms.includes(c.classroom);
                      const status = statusObj.checking
                        ? 'checking'
                        : statusObj.ok !== undefined
                          ? (statusObj.ok ? 'online' : 'offline')
                          : 'unknown';

                      return (
                        <label
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-3)',
                            padding: '8px var(--space-4)',
                            cursor: 'pointer',
                            background: isSelected ? 'var(--accent-subtle)' : 'transparent',
                            transition: 'background 150ms',
                            userSelect: 'none',
                          }}
                        >
                          <input
                            type="checkbox"
                            style={{ width: 16, height: 16 }}
                            checked={isSelected}
                            onChange={() => handleClassroomToggle(c.classroom)}
                          />
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                            <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                              {c.classroom}
                            </span>
                            <span className="ip-chip" style={{ fontSize: 'var(--text-xs)' }}>{c.ip}</span>
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                              {c.department.split(' ')[0]} {c.block ? `· ${c.block}` : ''}
                            </span>
                          </div>
                          <StatusBadge status={status} showLabel={false} />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Step 2: File selection */}
          <div className="card" style={{ opacity: canProceedToFile ? 1 : 0.5, pointerEvents: canProceedToFile ? 'auto' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
              <StepBadge n={2} active={canProceedToFile && !selectedFile} done={!!selectedFile} />
              <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>
                Select Media File
              </h2>
            </div>
            <UploadPanel selectedFile={selectedFile} onFileSelect={setSelectedFile} />
          </div>

          {/* Step 3: Upload progress tracker */}
          {step !== STEP.RESULT && (
            <div className="card" style={{ opacity: canUpload || step === STEP.UPLOADING ? 1 : 0.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
                <StepBadge n={3} active={step === STEP.UPLOADING} done={step === STEP.RESULT} />
                <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>
                  Upload &amp; Display
                </h2>
              </div>

              {step === STEP.UPLOADING ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 2 }}>
                    Sequential upload in progress. Do not close this page.
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                    {selectedClassrooms.map(room => {
                      const state = uploadStates[room] || { progress: 0, status: 'pending' };
                      const device = classroomsList.find(c => c.classroom === room);
                      
                      return (
                        <div
                          key={room}
                          style={{
                            background: 'var(--bg-elevated)',
                            borderRadius: 'var(--radius-md)',
                            padding: 'var(--space-3)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                              <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
                                {room}
                              </span>
                              <span className="ip-chip" style={{ fontSize: 'var(--text-xs)' }}>{device?.ip}</span>
                            </div>
                            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)' }}>
                              {state.status === 'pending' && <span style={{ color: 'var(--text-muted)' }}>Pending</span>}
                              {state.status === 'uploading' && <span style={{ color: 'var(--accent)' }}>Uploading {state.progress}%</span>}
                              {state.status === 'success' && <span style={{ color: 'var(--success)' }}>✓ Complete</span>}
                              {state.status === 'failed' && <span style={{ color: 'var(--danger)' }}>⚠️ Failed</span>}
                            </span>
                          </div>
                          
                          {state.status === 'uploading' && (
                            <div className="progress-bar-wrap">
                              <div className="progress-bar-fill" style={{ width: `${state.progress}%` }} />
                            </div>
                          )}
                          {state.error && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 4 }}>
                              Error: {state.error}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <button
                    className="btn btn-primary btn-lg"
                    onClick={handleUpload}
                    disabled={!canUpload}
                    style={{ width: '100%', justifyContent: 'center', fontSize: 'var(--text-md)' }}
                  >
                    ⬆️ Upload to {selectedClassrooms.length} Classroom{selectedClassrooms.length !== 1 ? 's' : ''}
                  </button>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center' }}>
                    Media file will be uploaded directly to the local LAN IP of each checked classroom.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Batch Result summary */}
          {step === STEP.RESULT && (
            <div className="upload-result" style={{ background: overallFailure ? 'var(--danger-subtle)' : undefined, borderColor: overallFailure ? 'rgba(248,81,73,0.2)' : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
                <span className="checkmark" style={{ fontSize: 24 }}>
                  {overallSuccess ? '✅' : overallFailure ? '❌' : '⚠️'}
                </span>
                <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-bold)', color: overallSuccess ? 'var(--success)' : overallFailure ? 'var(--danger)' : 'var(--warning)' }}>
                  {overallSuccess && 'Upload Complete'}
                  {overallFailure && 'Upload Failed'}
                  {!overallSuccess && !overallFailure && 'Upload Partially Succeeded'}
                </h2>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
                {selectedClassrooms.map(room => {
                  const state = uploadStates[room] || {};
                  return (
                    <div
                      key={room}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px var(--space-4)',
                        background: 'var(--bg-elevated)',
                        borderRadius: 'var(--radius-md)',
                        border: `1px solid ${state.status === 'success' ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)'}`,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
                          {room}
                        </div>
                        {state.error && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-danger)', marginTop: 2 }}>
                            {state.error}
                          </div>
                        )}
                      </div>
                      <span className={`badge ${state.status === 'success' ? 'badge-success' : 'badge-danger'}`}>
                        {state.status === 'success' ? 'Success' : 'Failed'}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <button className="btn btn-primary" onClick={handleReset}>
                  ⬆️ Upload Another
                </button>
                <button className="btn btn-secondary" onClick={() => navigate('/')}>
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Info sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

          {/* Target summary */}
          {selectedClassrooms.length > 0 && (
            <div className="card" style={{ background: 'var(--accent-subtle)', border: '1px solid rgba(47,129,247,0.2)' }}>
              <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)', color: 'var(--accent)', marginBottom: 'var(--space-3)' }}>
                🎯 Selected Targets
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {department && <Row label="Department" value={department} />}
                {block && <Row label="Block" value={block} />}
                {classroomNum && <Row label="Classroom Num" value={classroomNum} />}
                <Row label="Total Target Pis" value={selectedClassrooms.length} />
                <div className="divider" style={{ margin: '4px 0' }} />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                  <strong>Classrooms:</strong> {selectedClassrooms.join(', ')}
                </div>
                {selectedFile && (
                  <>
                    <div className="divider" style={{ margin: '4px 0' }} />
                    <Row label="File" value={selectedFile.name} />
                    <Row label="Size" value={`${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB`} />
                  </>
                )}
              </div>
            </div>
          )}

          {/* How it works */}
          <div className="card">
            <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)', marginBottom: 'var(--space-4)' }}>
              📖 How It Works
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {[
                { n: 1, text: 'Filter by Department, Block, or Classroom number' },
                { n: 2, text: 'Select specific classrooms or click "Select All"' },
                { n: 3, text: 'Choose your image or video file' },
                { n: 4, text: 'Click Upload & Display to start batch upload' },
                { n: 5, text: 'Each Pi will be updated in sequence and immediately display the media' },
              ].map(({ n, text }) => (
                <div key={n} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--accent-subtle)', color: 'var(--accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-bold)',
                  }}>
                    {n}
                  </div>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Supported formats */}
          <div className="card">
            <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)', marginBottom: 'var(--space-4)' }}>
              📁 Supported Formats
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div>
                <div className="section-label">Images</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
                  {['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP'].map(ext => (
                    <span key={ext} className="badge badge-accent">{ext}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="section-label">Videos</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
                  {['MP4', 'M4V', 'WEBM', 'MOV'].map(ext => (
                    <span key={ext} className="badge badge-warning">{ext}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBadge({ n, active, done }) {
  return (
    <div
      style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-bold)',
        background: done ? 'var(--success)' : active ? 'var(--accent)' : 'var(--bg-hover)',
        color: done || active ? '#fff' : 'var(--text-muted)',
        transition: 'all 200ms',
      }}
    >
      {done ? '✓' : n}
    </div>
  );
}

function ResultRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--success)', fontFamily: mono ? 'var(--font-mono)' : undefined }}>
        {value}
      </span>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', textAlign: 'right', fontFamily: mono ? 'var(--font-mono)' : undefined }}>
        {value}
      </span>
    </div>
  );
}
