// =============================================
// N Signage — Multi-Device Upload Page
// =============================================
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  RotateCw,
  Search,
  Tv,
  Film,
  Check,
  Loader2,
  HelpCircle,
  X,
} from 'lucide-react';
import { getDevices } from '../data/store';
import { getPiStatus, uploadMedia } from '../api/piApi';
import { isCloudDevice, isCloudMode } from '../api/cloudApi';
import { sendFileDirect, retryTransferWithFile, precheckFile, checkUploadReadiness } from '../api/transferApi';
import { findLanRoute, uploadLan } from '../api/lanUpload';
import { IMAGE_EXTS, VIDEO_EXTS } from '../../shared/mediaTypes';
import UploadPanel from '../components/UploadPanel';
import TransferStatus from '../components/TransferStatus';
import { isActive } from '../utils/transferFormat';
import RecentTransfers from '../components/RecentTransfers';
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
  const [fileError, setFileError] = useState('');
  const [historyKey, setHistoryKey] = useState(0);
  const controllers = useRef({});   // device id -> AbortController (cloud transfers)
  const speeds = useRef({});        // device id -> { t, b, rate }
  const sentFile = useRef(null);    // the file of the current deployment (for retries)
  const cloud = isCloudMode();

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

    // Cloud displays: also the direct-upload readiness (receiver, tunnel), checked from this browser
    const promises = list.map(async c => {
      const [res, upload] = await Promise.all([
        getPiStatus(c),
        isCloudDevice(c) ? checkUploadReadiness(c.piDeviceId).catch(() => null) : null,
      ]);
      return { id: c.id, status: upload ? { ...res, upload } : res };
    });

    const results = await Promise.all(promises);
    const finalStatuses = {};
    results.forEach(({ id, status }) => {
      finalStatuses[id] = { checking: false, ...status };
    });
    setPiStatuses(finalStatuses);
    setCheckingStatuses(false);
  }, []);

  // Check every registered device once when the page opens
  useEffect(() => {
    fetchAllStatuses(getDevices());
  }, [fetchAllStatuses]);

  const isUploading = step === STEP.UPLOADING;

  function handleDeviceToggle(deviceId) {
    if (isUploading) return;
    setSelectedDevices(prev =>
      prev.includes(deviceId)
        ? prev.filter(r => r !== deviceId)
        : [...prev, deviceId]
    );
  }

  function handleSelectAllToggle(e) {
    if (isUploading) return;
    if (e.target.checked) {
      setSelectedDevices(devicesList.map(c => c.id));
    } else {
      setSelectedDevices([]);
    }
  }

  const canProceedToFile = selectedDevices.length > 0;
  const canUpload = selectedFile && selectedDevices.length > 0 && step !== STEP.UPLOADING;

  function patch(id, u) {
    setUploadStates(prev => ({ ...prev, [id]: { ...prev[id], ...u } }));
  }

  // Map a direct (encrypted) transfer update to this page's per-device state
  function onRelayUpdate(id, u) {
    const next = { relay: true };
    if (u.transferId) next.transferId = u.transferId;
    if (u.error) next.error = u.error;
    switch (u.phase) {
      case 'checking':
        next.status = 'checking';
        next.error = undefined;
        break;
      case 'hashing':
        next.status = 'hashing';
        next.progress = u.total ? Math.round((u.loaded / u.total) * 100) : 0;
        break;
      case 'uploading': {
        next.status = 'uploading';
        if (u.total) {
          const now = performance.now();
          const sp = speeds.current[id] || { t: now, b: 0, rate: 0 };
          const dt = (now - sp.t) / 1000;
          if (dt >= 0.5) {
            const inst = (u.loaded - sp.b) / dt;
            sp.rate = sp.rate ? sp.rate * 0.7 + inst * 0.3 : inst;
            sp.t = now;
            sp.b = u.loaded;
          }
          speeds.current[id] = sp;
          next.progress = Math.round((u.loaded / u.total) * 100);
          next.speed = sp.rate;
          next.eta = sp.rate > 0 ? (u.total - u.loaded) / sp.rate : null;
        }
        break;
      }
      case 'confirming':
        next.status = 'confirming';
        break;
      case 'completed':
        next.status = 'success';
        next.verified = Boolean(u.transfer?.verified);
        next.savedAs = u.transfer?.savedAs;
        next.error = undefined;
        break;
      case 'cancelled':
        next.status = 'cancelled';
        next.error = 'Cancelled. Nothing was saved on the display.';
        break;
      default:
        next.status = 'failed';
    }
    patch(id, next);
  }

  // Final state of a transfer: "success" ONLY when the display confirmed
  function settleRelay(id, r) {
    if (r.ok) {
      patch(id, { status: 'success', verified: Boolean(r.transfer?.verified), savedAs: r.transfer?.savedAs, error: undefined });
    } else if (r.phase === 'waiting') {
      patch(id, { status: 'waiting' });
    } else if (r.phase === 'cancelled') {
      patch(id, { status: 'cancelled', error: 'Cancelled. Nothing was saved on the display.' });
    } else {
      patch(id, {
        status: 'failed',
        error: r.error || (r.phase === 'expired' ? 'The transfer expired.' : 'Transfer failed.'),
        ...(r.transferId && { transferId: r.transferId }),
      });
    }
  }

  async function runRelay(id, device, file, transferId = null) {
    const ac = new AbortController();
    controllers.current[id] = ac;
    speeds.current[id] = null;
    // Development only (VITE_LAN_DIRECT_UPLOAD): the customer's own Pi on this network gets the
    // file straight from the browser. Not reachable / identity mismatch → normal cloud transfer.
    if (!transferId) {
      patch(id, { status: 'pending', progress: 0, error: undefined, lan: false });
      const base = await findLanRoute(device, { signal: ac.signal });
      if (base) {
        await runLanDirect(id, base, file, ac);
        delete controllers.current[id];
        return;
      }
      if (ac.signal.aborted) {
        delete controllers.current[id];
        patch(id, { status: 'cancelled', error: 'Cancelled. Nothing was sent.' });
        return;
      }
    }
    patch(id, { status: 'checking', progress: 0, error: undefined, relay: true, lan: false });
    const opts = { signal: ac.signal, onUpdate: u => onRelayUpdate(id, u) };
    const r = transferId
      ? await retryTransferWithFile(transferId, file, opts)
      : await sendFileDirect(device, file, opts);
    delete controllers.current[id];
    settleRelay(id, r);
    setHistoryKey(k => k + 1);
  }

  // Bytes go browser → Pi only. Once the request has started, a failure is shown as an
  // error and is NOT retried through the cloud (the Pi may already hold part or all of it).
  async function runLanDirect(id, base, file, ac) {
    patch(id, { status: 'uploading', progress: 0, lan: true, relay: false });
    const r = await uploadLan(base, file, {
      signal: ac.signal,
      onProgress: (loaded, total) => onRelayUpdate(id, { phase: 'uploading', loaded, total }),
    });
    if (r.ok) patch(id, { status: 'success', relay: false, lan: true, savedAs: r.savedAs, error: undefined });
    else patch(id, { status: r.cancelled ? 'cancelled' : 'failed', relay: false, lan: true, savedAs: r.savedAs, error: r.error });
  }

  async function runLan(id, device, file) {
    patch(id, { status: 'uploading', progress: 0 });
    const statusRes = await getPiStatus(device);
    if (!statusRes.ok) {
      patch(id, { status: 'failed', error: 'Raspberry Pi is unreachable on local network' });
      return;
    }
    const result = await uploadMedia(device, file, pct => patch(id, { progress: pct }));
    patch(id, { status: result.ok ? 'success' : 'failed', error: result.ok ? undefined : result.error });
  }

  async function handleUpload() {
    if (!selectedFile || selectedDevices.length === 0 || isUploading) return;
    setFileError('');

    // Snapshot targets and file so later UI changes cannot alter a running deployment
    const targets = [...selectedDevices];
    const file = selectedFile;
    const allDevices = getDevices();

    // Cloud: check type, real content (magic bytes) before anything is uploaded
    if (targets.some(id => isCloudDevice(allDevices.find(c => c.id === id)))) {
      const err = await precheckFile(file);
      if (err) { setFileError(err); return; }
    }

    sentFile.current = file;
    setStep(STEP.UPLOADING);
    const initial = {};
    targets.forEach(id => { initial[id] = { progress: 0, status: 'pending' }; });
    setUploadStates(initial);

    // One display at a time, so each upload gets the full connection
    for (const id of targets) {
      if (cancelledAll.current) break;
      const device = allDevices.find(c => c.id === id);
      if (!device) {
        patch(id, { status: 'failed', error: 'Device no longer exists' });
        continue;
      }
      if (isCloudDevice(device)) await runRelay(id, device, file);
      else await runLan(id, device, file);
    }
    cancelledAll.current = false;
    setStep(STEP.RESULT);
  }

  const cancelledAll = useRef(false);

  function cancelOne(id) {
    controllers.current[id]?.abort();
  }

  function cancelAll() {
    cancelledAll.current = true;
    Object.values(controllers.current).forEach(c => c.abort());
    // Displays not started yet are skipped
    setUploadStates(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [
      k, v.status === 'pending' ? { ...v, status: 'cancelled', error: 'Cancelled before it started.' } : v,
    ])));
  }

  async function retryOne(id) {
    const device = getDevices().find(c => c.id === id);
    const state = uploadStates[id] || {};
    const file = sentFile.current || selectedFile;
    if (!device || !file) return;
    if (isCloudDevice(device)) {
      // A failed transfer is resumed where the display stopped (same file, checked by SHA-256);
      // a cancelled one is sent again as a new transfer.
      await runRelay(id, device, file, state.status === 'failed' ? state.transferId : null);
    } else {
      await runLan(id, device, file);
    }
  }

  function handleReset() {
    setSelectedFile(null);
    setUploadStates({});
    setFileError('');
    sentFile.current = null;
    setStep(STEP.SELECT);
  }

  // A pending/waiting display is NOT a success
  const states = Object.values(uploadStates);
  const overallSuccess = states.length > 0 && states.every(st => st.status === 'success');
  const overallFailure = states.length > 0 && states.every(st => ['failed', 'cancelled'].includes(st.status));
  const anyWaiting = states.some(st => st.status === 'waiting' || isActive(st));
  const resultTitle = overallSuccess ? 'Deployment Complete'
    : overallFailure ? 'Deployment Failed'
    : anyWaiting ? 'Waiting for Some Displays'
    : 'Deployment Partially Complete';

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
                        checked={devicesList.length > 0 && devicesList.every(c => selectedDevices.includes(c.id))}
                        disabled={isUploading}
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
                            disabled={isUploading}
                            onChange={() => handleDeviceToggle(c.id)}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                            {statusObj.upload && (
                              <div style={{ fontSize: '11px', marginTop: 2, color: statusObj.upload.ready ? 'var(--success)' : 'var(--warning)' }}>
                                {statusObj.upload.ready ? 'Secure upload ready' : statusObj.upload.message}
                              </div>
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
            <UploadPanel selectedFile={selectedFile} onFileSelect={setSelectedFile} disabled={isUploading} />
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
                  <div className="alert alert-info" style={{ fontSize: 'var(--text-xs)', alignItems: 'center' }}>
                    <Loader2 size={14} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
                    <span style={{ flex: 1 }}>Sending to each display in turn. Please keep this browser window open.</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={cancelAll}><X size={12} /> Cancel all</button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {selectedDevices.map(id => (
                      <TargetRow key={id} id={id} state={uploadStates[id]} onCancel={() => cancelOne(id)} />
                    ))}
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
                  {fileError && (
                    <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
                      <AlertCircle size={14} className="alert-icon" />
                      <span>{fileError}</span>
                    </div>
                  )}
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center' }}>
                    {cloud
                      ? 'Files are encrypted in this browser and sent directly to each display. The N-Signage website never stores or sees your media. Success is shown only after the display confirms it saved the file.'
                      : 'Files are transferred over LAN directly to each display unit.'}
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
                    {resultTitle}
                  </h2>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                    {overallSuccess
                      ? 'Every display confirmed it saved the file. It joins the playlist automatically.'
                      : 'Review individual display results below.'}
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-5)' }}>
                {selectedDevices.map(id => (
                  <TargetRow key={id} id={id} state={uploadStates[id]} onCancel={() => cancelOne(id)} onRetry={() => retryOne(id)} />
                ))}
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

          {cloud && <RecentTransfers file={selectedFile} refreshKey={historyKey} />}

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
                'Click Upload to start the transfer (one display at a time)',
                'Each display adds the file to its playlist once it has saved it',
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
                  {IMAGE_EXTS.map(e => e.toUpperCase()).map(ext => (
                    <span key={ext} className="badge badge-info" style={{ fontSize: '11px' }}>
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
                  {VIDEO_EXTS.map(e => e.toUpperCase()).map(ext => (
                    <span key={ext} className="badge badge-info" style={{ fontSize: '11px' }}>
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

function TargetRow({ id, state = { status: 'pending', progress: 0 }, onCancel, onRetry }) {
  const device = getDevices().find(c => c.id === id);
  return (
    <div className="xfer-row">
      <div className="xfer-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
            {device?.nickName || device?.deviceId || 'Removed device'}
          </span>
          {device?.ip && !isCloudDevice(device) && <span className="ip-chip" style={{ fontSize: '11px' }}>{device.ip}</span>}
          {isCloudDevice(device) && (state.lan
            ? <span className="badge badge-neutral" style={{ fontSize: 10 }}>local network, direct to display</span>
            : <span className="badge badge-neutral" style={{ fontSize: 10 }}>encrypted, direct to display</span>)}
        </div>
      </div>
      <TransferStatus state={state} onCancel={onCancel} onRetry={onRetry} />
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
