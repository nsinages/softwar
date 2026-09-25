import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDevices, getUniqueDepartments } from '../data/store';
import { getPiMedia, getPiStatus, deleteMedia } from '../api/piApi';
import MediaCard from '../components/MediaCard';
import ConfirmModal from '../components/ConfirmModal';
import StatusBadge from '../components/StatusBadge';

export default function Media() {
  const location = useLocation();
  const navigate = useNavigate();
  const devices = useMemo(() => getDevices(), []);

  // Preselect device from navigation state
  const initialDeviceId = location.state?.deviceId || '';
  const [selectedDeviceId, setSelectedDeviceId] = useState(initialDeviceId);
  
  const [deptFilter, setDeptFilter] = useState('');
  const [blockFilter, setBlockFilter] = useState('');

  const departments = useMemo(() => getUniqueDepartments(), []);
  const blocks = useMemo(() => {
    return [...new Set(devices.map(d => d.block).filter(Boolean))].sort();
  }, [devices]);

  // Synchronize filters when selectedDeviceId changes (e.g. from nav link)
  useEffect(() => {
    if (selectedDeviceId) {
      const dev = devices.find(d => d.id === selectedDeviceId);
      if (dev) {
        setDeptFilter(dev.department);
        setBlockFilter(dev.block);
      }
    }
  }, [selectedDeviceId, devices]);

  const filteredClassrooms = useMemo(() => {
    let list = devices;
    if (deptFilter) list = list.filter(d => d.department === deptFilter);
    if (blockFilter) list = list.filter(d => d.block === blockFilter);
    return list;
  }, [devices, deptFilter, blockFilter]);

  const handleDeptFilterChange = (val) => {
    setDeptFilter(val);
    const list = devices.filter(d => {
      const matchDept = !val || d.department === val;
      const matchBlock = !blockFilter || d.block === blockFilter;
      return matchDept && matchBlock;
    });
    if (!list.some(d => d.id === selectedDeviceId)) {
      setSelectedDeviceId('');
    }
  };

  const handleBlockFilterChange = (val) => {
    setBlockFilter(val);
    const list = devices.filter(d => {
      const matchDept = !deptFilter || d.department === deptFilter;
      const matchBlock = !val || d.block === val;
      return matchDept && matchBlock;
    });
    if (!list.some(d => d.id === selectedDeviceId)) {
      setSelectedDeviceId('');
    }
  };

  const selectedDevice = devices.find(d => d.id === selectedDeviceId) || null;

  const [mediaList, setMediaList] = useState([]);
  const [piStatus, setPiStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [searchQ, setSearchQ] = useState('');

  const fetchAll = useCallback(async () => {
    if (!selectedDevice) return;
    setLoading(true);
    setError('');
    const [statusResult, mediaResult] = await Promise.all([
      getPiStatus(selectedDevice.ip),
      getPiMedia(selectedDevice.ip),
    ]);
    setPiStatus(statusResult);
    if (!mediaResult.ok) {
      setError(mediaResult.error);
      setMediaList([]);
    } else {
      setMediaList(mediaResult.data || []);
    }
    setLoading(false);
  }, [selectedDevice]);

  useEffect(() => {
    if (selectedDevice) fetchAll();
    else { setMediaList([]); setPiStatus(null); setError(''); }
  }, [fetchAll]);

  async function handleDelete() {
    if (!deleteTarget || !selectedDevice) return;
    setDeleteLoading(true);
    const filename = deleteTarget.filename || deleteTarget.name;
    const result = await deleteMedia(selectedDevice.ip, filename);
    setDeleteLoading(false);
    if (!result.ok) {
      setError(result.error);
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    setMediaList(ml => ml.filter(m => (m.filename || m.name) !== filename));
    // Refresh status to update media count
    const statusResult = await getPiStatus(selectedDevice.ip);
    setPiStatus(statusResult);
  }

  const filteredMedia = useMemo(() => {
    let list = mediaList;
    if (filterType !== 'all') {
      list = list.filter(m => {
        const f = m.filename || m.name || '';
        if (filterType === 'image') return /\.(jpg|jpeg|png|gif|webp)$/i.test(f);
        if (filterType === 'video') return /\.(mp4|m4v|webm|mov)$/i.test(f);
        return true;
      });
    }
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      list = list.filter(m => (m.filename || m.name || '').toLowerCase().includes(q));
    }
    return list;
  }, [mediaList, filterType, searchQ]);

  const currentMedia = piStatus?.data?.current_media;
  const piStatusStr = !piStatus ? 'unknown' : piStatus.ok ? 'online' : 'offline';

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Media Library</h1>
            <p>Browse and manage media files on Raspberry Pi devices</p>
          </div>
          <button className="btn btn-primary" onClick={() => navigate('/upload')}>
            ⬆️ Upload Media
          </button>
        </div>
      </div>

      {/* Device selector */}
      <div
        className="card"
        style={{ marginBottom: 'var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}
      >
         {/* Concurrent Filters & Classroom Selector */}
        <div style={{ display: 'flex', gap: 'var(--space-3)', flex: 2, flexWrap: 'wrap', width: '100%' }}>
          <div className="form-group" style={{ flex: 1, minWidth: 180, margin: 0 }}>
            <label className="form-label">Filter Department</label>
            <select className="form-select" value={deptFilter} onChange={e => handleDeptFilterChange(e.target.value)}>
              <option value="">— All Departments —</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div className="form-group" style={{ flex: 1, minWidth: 140, margin: 0 }}>
            <label className="form-label">Filter Block</label>
            <select className="form-select" value={blockFilter} onChange={e => handleBlockFilterChange(e.target.value)}>
              <option value="">— All Blocks —</option>
              {blocks.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div className="form-group" style={{ flex: 1.5, minWidth: 180, margin: 0 }}>
            <label className="form-label">Select Classroom / Device</label>
            <select
              className="form-select"
              value={selectedDeviceId}
              onChange={e => setSelectedDeviceId(e.target.value)}
            >
              <option value="">— Choose a classroom ({filteredClassrooms.length}) —</option>
              {filteredClassrooms.map(d => (
                <option key={d.id} value={d.id}>
                  {d.classroom} — {d.department.split(' ')[0]} ({d.ip})
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedDevice && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Raspberry Pi</span>
              <span className="ip-chip" style={{ fontSize: 'var(--text-sm)' }}>{selectedDevice.ip}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Status</span>
              <StatusBadge status={piStatusStr} />
            </div>
            {piStatus?.ok && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Files</span>
                <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>
                  {piStatus.data?.media_count ?? mediaList.length}
                </span>
              </div>
            )}
            <button
              className="btn btn-secondary"
              onClick={fetchAll}
              disabled={loading}
            >
              {loading ? <span className="spinner spinner-sm" /> : '🔄'}
              Refresh
            </button>
          </>
        )}
      </div>

      {!selectedDevice ? (
        <div className="empty-state card">
          <div className="es-icon">🎞️</div>
          <h3>Select a classroom to view media</h3>
          <p>Choose a classroom from the dropdown above to browse its Raspberry Pi media library.</p>
        </div>
      ) : loading ? (
        <div className="empty-state" style={{ padding: 'var(--space-10)' }}>
          <span className="spinner spinner-lg" />
          <p style={{ color: 'var(--text-muted)' }}>Fetching media from {selectedDevice.ip}…</p>
        </div>
      ) : error ? (
        <div className="alert alert-danger" style={{ marginBottom: 'var(--space-4)' }}>
          ⚠️ {error}
          <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'var(--space-3)' }} onClick={fetchAll}>Retry</button>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
            <input
              className="form-input"
              style={{ maxWidth: 240 }}
              placeholder="🔍 Search files…"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
              {['all', 'image', 'video'].map(t => (
                <button
                  key={t}
                  className={`btn btn-sm ${filterType === t ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFilterType(t)}
                >
                  {t === 'all' ? 'All' : t === 'image' ? '🖼️ Images' : '🎬 Videos'}
                </button>
              ))}
            </div>
            <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {filteredMedia.length} file{filteredMedia.length !== 1 ? 's' : ''}
            </span>
          </div>

          {filteredMedia.length === 0 ? (
            <div className="empty-state card">
              <div className="es-icon">📂</div>
              <h3>{searchQ || filterType !== 'all' ? 'No files match your filter' : 'No media on this Pi'}</h3>
              <p>
                {searchQ || filterType !== 'all'
                  ? 'Try clearing your search or filter.'
                  : 'Upload media to this classroom Pi using the Upload page.'}
              </p>
              {!searchQ && filterType === 'all' && (
                <button className="btn btn-primary" onClick={() => navigate('/upload', { state: { deviceId: selectedDevice.id } })}>
                  ⬆️ Upload Media
                </button>
              )}
            </div>
          ) : (
            <div className="media-grid">
              {filteredMedia.map((media, idx) => {
                const filename = media.filename || media.name;
                return (
                  <MediaCard
                    key={`${filename}-${idx}`}
                    media={media}
                    piIp={selectedDevice.ip}
                    isCurrent={currentMedia === filename}
                    onDelete={m => setDeleteTarget(m)}
                    onPreview={(m, url) => { setPreviewMedia(m); setPreviewUrl(url); }}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Delete confirm */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isLoading={deleteLoading}
        title="Delete Media"
        message={
          <span>
            Are you sure you want to delete <strong>{deleteTarget?.filename || deleteTarget?.name}</strong> from the Raspberry Pi?
            <br /><br />
            This will remove the file from the Pi's storage and stop it from being displayed.
          </span>
        }
        confirmLabel="Delete File"
        variant="danger"
      />

      {/* Preview modal */}
      {previewMedia && (
        <div
          className="modal-overlay"
          onClick={() => setPreviewMedia(null)}
          style={{ alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-xl)',
              padding: 'var(--space-4)',
              maxWidth: '90vw',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
              <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {previewMedia.filename || previewMedia.name}
              </span>
              <button className="btn btn-ghost btn-icon" onClick={() => setPreviewMedia(null)}>✕</button>
            </div>
            {/\.(jpg|jpeg|png|gif|webp)$/i.test(previewMedia.filename || previewMedia.name) ? (
              <img src={previewUrl} alt="preview" style={{ maxWidth: '80vw', maxHeight: '75vh', objectFit: 'contain', borderRadius: 'var(--radius-md)' }} />
            ) : (
              <video src={previewUrl} controls style={{ maxWidth: '80vw', maxHeight: '75vh', borderRadius: 'var(--radius-md)' }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
