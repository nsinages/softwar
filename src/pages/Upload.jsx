// =============================================
// N Signage — Multi-Device Upload Page
// =============================================
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  RotateCw,
  Search,
  Tv,
  FileText,
  Film,
  Image as ImageIcon,
  Check,
  ArrowRight,
  Loader2,
  Info,
  HelpCircle,
} from 'lucide-react';
import { getDevices } from '../data/store';
import { getPiStatus, uploadMedia } from '../api/piApi';
import UploadPanel from '../components/UploadPanel';
import StatusBadge from '../components/StatusBadge';

const STEP = { SELECT: 1, FILE: 2, UPLOADING: 3, RESULT: 4 };

export default function Upload() {
  const location = useLocation();
  const navigate = useNavigate();

  const [searchQ, setSearchQ] = useState('');
  const [selectedDevices, setSelectedDevices] = useState(() => {
    const pre = location.state?.preselectDeviceId || location.state?.deviceId;
    return pre ? [pre] : [];
  });
  const [selectedFile, setSelectedFile] = useState(null);

  const [piStatuses, setPiStatuses] = useState({});
  const [checkingStatuses, setCheckingStatuses] = useState(false);

  const [uploadStates, setUploadStates] = useState({});
  const [step, setStep] = useState(STEP.SELECT);

  const devicesList = useMemo(() => {
    let list = getDevices();
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      list = list.filter(
        d =>
          (d.deviceId && d.deviceId.toLowerCase().includes(q)) ||
          (d.nickName && d.nickName.toLowerCase().includes(q)) ||
          (d.ip && d.ip.includes(q))
      );
    }
    return list;
  }, [searchQ]);

  const fetchAllStatuses = useCallback(async list => {
    if (list.length === 0) return;
    setCheckingStatuses(true);

    const loadingStates = {};
    list.forEach(c => {
      loadingStates[c.id] = { checking: true };
    });
    setPiStatuses(loadingStates);

    const promises = list.map(async c => {
      const res = await getPiStatus(c.ip);
      return { id: c.id, status: res };
    });

    const results = await Promise.all(promises);
    const finalStatuses = {};
    results.forEach(({ id, status }) => {
      finalStatuses[id] = { checking: false, ...status };
    });
    setPiStatuses(finalStatuses);
    setCheckingStatuses(false);
  }, []);

  useEffect(() => {
    if (devicesList.length > 0) {
      fetchAllStatuses(devicesList);
    }
  }, [fetchAllStatuses]);

  function handleDeviceToggle(deviceId) {
    setSelectedDevices(prev =>
      prev.includes(deviceId)
        ? prev.filter(r => r !== deviceId)
        : [...prev, deviceId]
    );
  }

  function handleSelectAllToggle(e) {
    if (e.target.checked) {
      setSelectedDevices(devicesList.map(c => c.id));
    } else {
      setSelectedDevices([]);
    }
  }

  const canProceedToFile = selectedDevices.length > 0;
  const canUpload = selectedFile && selectedDevices.length > 0 && step !== STEP.UPLOADING;

  async function handleUpload() {
    if (!selectedFile || selectedDevices.length === 0) return;
    setStep(STEP.UPLOADING);

    const initial = {};
    selectedDevices.forEach(id => {
      initial[id] = { progress: 0, status: 'pending' };
    });
    setUploadStates(initial);

    for (const id of selectedDevices) {
      const device =
        devicesList.find(c => c.id === id) ||
        getDevices().find(c => c.id === id);
      if (!device) continue;

      setUploadStates(prev => ({
        ...prev,
        [id]: { ...prev[id], status: 'uploading' },
      }));

      const statusRes = await getPiStatus(device.ip);
      if (!statusRes.ok) {
        setUploadStates(prev => ({
          ...prev,
          [id]: {
            ...prev[id],
            status: 'failed',
            error: 'Raspberry Pi is unreachable on local network',
          },
        }));
        continue;
      }

      const result = await uploadMedia(device.ip, selectedFile, pct => {
        setUploadStates(prev => ({
          ...prev,
          [id]: { ...prev[id], progress: pct },
        }));
      });

      setUploadStates(prev => ({
        ...prev,
        [id]: {
          ...prev[id],
          status: result.ok ? 'success' : 'failed',
          error: result.ok ? undefined : result.error,
        },
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
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1>Upload Media</h1>
          <p>Deploy image and video content directly to target Raspberry Pi digital displays</p>
        </div>
      </div>

      <div className="upload-layout">
        {/* Left Column: Multi-Step Upload Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {/* Step 1: Device Selection */}
          <div className="card">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-4)',
                paddingBottom: 'var(--space-3)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <StepBadge n={1} active={step === STEP.SELECT || step === STEP.FILE} done={canProceedToFile} />
              <div>
                <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                  Select Target Devices
                </h2>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  Choose one or more Raspberry Pi displays to receive this media file
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div className="search-box">
                <Search size={14} className="search-icon" />
                <input
                  className="form-input"
                  placeholder="Filter devices by ID, nickname, IP…"
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                />
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 'var(--space-2)',
                  }}
                >
                  <span className="section-label" style={{ margin: 0 }}>
                    Displays ({devicesList.length}) · {selectedDevices.length} selected
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => fetchAllStatuses(devicesList)}
                    disabled={checkingStatuses || devicesList.length === 0}
                  >
                    {checkingStatuses ? (
                      <Loader2 size={12} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
                    ) : (
                      <RotateCw size={12} />
                    )}
                    <span>Refresh Status</span>
                  </button>
                </div>

                {devicesList.length === 0 ? (
                  <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)' }}>
                    <AlertCircle size={14} className="alert-icon" />
                    <span>No devices match your filter query.</span>
                  </div>
                ) : (
                  <div
                    style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      maxHeight: '220px',
                      overflowY: 'auto',
                      padding: '4px 0',
                    }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                        fontWeight: 'var(--weight-semibold)',
                        fontSize: 'var(--text-xs)',
                        userSelect: 'none',
                        background: 'var(--bg-card)',
                      }}
                    >
                      <input
                        type="checkbox"
                        style={{ width: 15, height: 15, accentColor: 'var(--accent)' }}
                        checked={selectedDevices.length === devicesList.length && devicesList.length > 0}
                        onChange={handleSelectAllToggle}
                      />
                      <span>Select All ({devicesList.length} devices)</span>
                    </label>

                    {devicesList.map(c => {
                      const statusObj = piStatuses[c.id] || {};
                      const isSelected = selectedDevices.includes(c.id);
                      const status = statusObj.checking
                        ? 'checking'
                        : statusObj.ok !== undefined
                        ? statusObj.ok
                          ? 'online'
                          : 'offline'
                        : 'unknown';

                      return (
                        <label
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            background: isSelected ? 'var(--accent-subtle)' : 'transparent',
                            transition: 'background var(--transition-fast)',
                            userSelect: 'none',
                            borderBottom: '1px solid var(--border-subtle)',
                          }}
                        >
                          <input
                            type="checkbox"
                            style={{ width: 15, height: 15, accentColor: 'var(--accent)' }}
                            checked={isSelected}
                            onChange={() => handleDeviceToggle(c.id)}
                          />
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                              {c.deviceId}
                            </span>
                            <span className="ip-chip" style={{ fontSize: '11px' }}>{c.ip}</span>
                            {c.nickName && (
                              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                                ({c.nickName})
                              </span>
                            )}
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

          {/* Step 2: Media Selection */}
          <div
            className="card"
            style={{
              opacity: canProceedToFile ? 1 : 0.6,
              transition: 'opacity var(--transition-base)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-4)',
                paddingBottom: 'var(--space-3)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <StepBadge n={2} active={canProceedToFile && !selectedFile} done={!!selectedFile} />
              <div>
                <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                  Select Media File
                </h2>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  Choose the high-resolution image or video to display
                </p>
              </div>
            </div>
            <UploadPanel selectedFile={selectedFile} onFileSelect={setSelectedFile} />
          </div>

          {/* Step 3: Sequential Upload Execution */}
          {step !== STEP.RESULT && (
            <div
              className="card"
              style={{
                opacity: canUpload || step === STEP.UPLOADING ? 1 : 0.6,
                transition: 'opacity var(--transition-base)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  marginBottom: 'var(--space-4)',
                  paddingBottom: 'var(--space-3)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <StepBadge n={3} active={step === STEP.UPLOADING} done={step === STEP.RESULT} />
                <div>
                  <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                    Deploy &amp; Display
                  </h2>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    Send file to all selected devices in sequence
                  </p>
                </div>
              </div>

              {step === STEP.UPLOADING ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <div className="alert alert-info" style={{ fontSize: 'var(--text-xs)' }}>
                    <Loader2 size={14} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
                    <span>Sequential deployment in progress. Please keep this browser window open.</span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {selectedDevices.map(id => {
                      const state = uploadStates[id] || { progress: 0, status: 'pending' };
                      const device = getDevices().find(c => c.id === id);

                      return (
                        <div
                          key={id}
                          style={{
                            background: 'var(--bg-elevated)',
                            borderRadius: 'var(--radius-md)',
                            padding: '10px 14px',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
                                {device?.deviceId}
                              </span>
                              <span className="ip-chip" style={{ fontSize: '11px' }}>{device?.ip}</span>
                            </div>

                            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)' }}>
                              {state.status === 'pending' && <span style={{ color: 'var(--text-muted)' }}>Queued</span>}
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
                              {state.error}
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
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <UploadCloud size={18} />
                    <span>Upload to {selectedDevices.length} Device{selectedDevices.length !== 1 ? 's' : ''}</span>
                  </button>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center' }}>
                    Files are transferred over LAN directly to each display unit.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Summary Result */}
          {step === STEP.RESULT && (
            <div
              className="card"
              style={{
                borderColor: overallSuccess
                  ? 'rgba(16, 185, 129, 0.4)'
                  : overallFailure
                  ? 'rgba(239, 68, 68, 0.4)'
                  : 'rgba(245, 158, 11, 0.4)',
                background: overallSuccess
                  ? 'var(--success-subtle)'
                  : overallFailure
                  ? 'var(--danger-subtle)'
                  : 'var(--warning-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: 'var(--space-4)' }}>
                {overallSuccess ? (
                  <CheckCircle2 size={24} style={{ color: 'var(--success)' }} />
                ) : (
                  <AlertCircle size={24} style={{ color: overallFailure ? 'var(--danger)' : 'var(--warning)' }} />
                )}
                <div>
                  <h2
                    style={{
                      fontSize: 'var(--text-lg)',
                      fontWeight: 'var(--weight-bold)',
                      color: overallSuccess
                        ? 'var(--success)'
                        : overallFailure
                        ? 'var(--danger)'
                        : 'var(--warning)',
                    }}
                  >
                    {overallSuccess && 'Deployment Complete'}
                    {overallFailure && 'Deployment Failed'}
                    {!overallSuccess && !overallFailure && 'Deployment Partially Complete'}
                  </h2>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                    {overallSuccess
                      ? 'Media was transferred and is now active on all target displays.'
                      : 'Review individual device results below.'}
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-5)' }}>
                {selectedDevices.map(id => {
                  const state = uploadStates[id] || {};
                  const device = getDevices().find(c => c.id === id);

                  return (
                    <div
                      key={id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 14px',
                        background: 'var(--bg-card)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
                          {device?.deviceId}
                        </div>
                        {state.error && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 2 }}>
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
                  <UploadCloud size={15} /> Upload Another
                </button>
                <button className="btn btn-secondary" onClick={() => navigate('/')}>
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Workflow Summary & Help Cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* Target Summary Card */}
          {selectedDevices.length > 0 && (
            <div className="card" style={{ borderColor: 'rgba(244, 119, 33, 0.3)', background: 'var(--bg-card)' }}>
              <div
                style={{
                  fontWeight: 'var(--weight-semibold)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                  marginBottom: 'var(--space-3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Tv size={16} style={{ color: 'var(--accent)' }} />
                <span>Selected Targets</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Target Displays:</span>
                  <strong style={{ color: 'var(--text-primary)' }}>{selectedDevices.length}</strong>
                </div>
                {selectedFile && (
                  <>
                    <div className="divider" style={{ margin: '4px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>File Name:</span>
                      <span
                        style={{
                          fontWeight: 'var(--weight-medium)',
                          color: 'var(--text-primary)',
                          maxWidth: 160,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={selectedFile.name}
                      >
                        {selectedFile.name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>File Size:</span>
                      <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>
                        {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Workflow Guide */}
          <div className="card">
            <div
              style={{
                fontWeight: 'var(--weight-semibold)',
                fontSize: 'var(--text-sm)',
                marginBottom: 'var(--space-3)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <HelpCircle size={15} style={{ color: 'var(--text-muted)' }} />
              <span>Deployment Guide</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {[
                'Search or filter target display units',
                'Select specific displays or choose "Select All"',
                'Choose your image or video media file',
                'Click Upload & Display to start sequential transfer',
                'Displays will switch to new media immediately upon receipt',
              ].map((text, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '11px',
                      fontWeight: 'var(--weight-semibold)',
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {idx + 1}
                  </div>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {text}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Formats Card */}
          <div className="card">
            <div
              style={{
                fontWeight: 'var(--weight-semibold)',
                fontSize: 'var(--text-sm)',
                marginBottom: 'var(--space-3)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Film size={15} style={{ color: 'var(--text-muted)' }} />
              <span>Supported Media</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div>
                <span className="section-label" style={{ fontSize: '11px', marginBottom: 4 }}>
                  Images
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP'].map(ext => (
                    <span key={ext} className="badge badge-accent" style={{ fontSize: '11px' }}>
                      {ext}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <span className="section-label" style={{ fontSize: '11px', marginBottom: 4 }}>
                  Videos
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {['MP4', 'M4V', 'WEBM', 'MOV'].map(ext => (
                    <span key={ext} className="badge badge-warning" style={{ fontSize: '11px' }}>
                      {ext}
                    </span>
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
        width: 26,
        height: 26,
        borderRadius: 'var(--radius-full)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12px',
        fontWeight: 'var(--weight-bold)',
        background: done ? 'var(--success)' : active ? 'var(--accent)' : 'var(--bg-elevated)',
        color: done || active ? '#ffffff' : 'var(--text-muted)',
        transition: 'all var(--transition-fast)',
      }}
    >
      {done ? <Check size={14} strokeWidth={2.5} /> : n}
    </div>
  );
}
