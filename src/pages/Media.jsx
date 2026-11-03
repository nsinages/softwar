// =============================================
// N Signage — Media Library Page
// =============================================
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Film,
  Image as ImageIcon,
  UploadCloud,
  RotateCw,
  Search,
  X,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { getDevices } from '../data/store';
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
      getPiStatus(selectedDevice),
      getPiMedia(selectedDevice),
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
    else {
      setMediaList([]);
      setPiStatus(null);
      setError('');
    }
  }, [fetchAll, selectedDevice]);

  async function handleDelete() {
    if (!deleteTarget || !selectedDevice) return;
    setDeleteLoading(true);
    const filename = deleteTarget.filename || deleteTarget.name;
    const result = await deleteMedia(selectedDevice, filename);
    setDeleteLoading(false);
    if (!result.ok) {
      setError(result.error);
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    setMediaList(ml => ml.filter(m => (m.filename || m.name) !== filename));
    // Refresh status to update media count
    const statusResult = await getPiStatus(selectedDevice);
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
      {/* Page Header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Media Library</h1>
            <p>Browse and manage images and video files stored on Raspberry Pi devices</p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() =>
              navigate('/upload', {
                state: { preselectDeviceId: selectedDevice?.id },
              })
            }
          >
            <UploadCloud size={15} />
            <span>Upload Media</span>
          </button>
        </div>
      </div>

      {/* Target Device Selector Card */}
      <div
        className="card"
        style={{
          marginBottom: 'var(--space-5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flex: 1, minWidth: 260, flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: 1, minWidth: 240, margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Target Signage Display
            </label>
            <select
              className="form-select"
              value={selectedDeviceId}
              onChange={e => setSelectedDeviceId(e.target.value)}
            >
              <option value="">— Select a Raspberry Pi ({devices.length} available) —</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>
                  {d.deviceId} {d.nickName ? `(${d.nickName})` : ''} · {d.ip}
                </option>
              ))}
            </select>
          </div>

          {selectedDevice && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>IP Address</span>
                <span className="ip-chip">{selectedDevice.ip}</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Status</span>
                <StatusBadge status={piStatusStr} />
              </div>

              {piStatus?.ok && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Files on Pi</span>
                  <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                    {piStatus.data?.media_count ?? mediaList.length}
                  </strong>
                </div>
              )}
            </div>
          )}
        </div>

        {selectedDevice && (
          <button
            className="btn btn-secondary"
            onClick={fetchAll}
            disabled={loading}
            title="Refresh media files from this Pi"
          >
            {loading ? (
              <Loader2 size={14} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
            ) : (
              <RotateCw size={14} />
            )}
            <span>Refresh</span>
          </button>
        )}
      </div>

      {/* Main Content Area */}
      {!selectedDevice ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Film size={26} />
          </div>
          <h3>Select a Device</h3>
          <p>Choose a Raspberry Pi display from the dropdown menu above to inspect and manage its stored media files.</p>
        </div>
      ) : loading ? (
        <div className="empty-state">
          <Loader2 size={32} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite', color: 'var(--accent)' }} />
          <p style={{ color: 'var(--text-muted)' }}>Fetching media library from {selectedDevice.ip}…</p>
        </div>
      ) : error ? (
        <div className="alert alert-danger" style={{ marginBottom: 'var(--space-4)' }}>
          <AlertTriangle size={16} className="alert-icon" />
          <div style={{ flex: 1 }}>
            <strong>Connection Error:</strong> {error}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={fetchAll}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Filter Toolbar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <div className="search-box" style={{ width: 240 }}>
                <Search size={14} className="search-icon" />
                <input
                  className="form-input"
                  placeholder="Search filenames…"
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                />
                {searchQ && (
                  <button
                    onClick={() => setSearchQ('')}
                    className="btn btn-ghost btn-icon btn-sm"
                    style={{ position: 'absolute', right: 4 }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Filter Tabs */}
              <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-card)', padding: '3px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <button
                  className={`btn btn-sm ${filterType === 'all' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setFilterType('all')}
                >
                  All
                </button>
                <button
                  className={`btn btn-sm ${filterType === 'image' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setFilterType('image')}
                >
                  <ImageIcon size={12} /> Images
                </button>
                <button
                  className={`btn btn-sm ${filterType === 'video' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setFilterType('video')}
                >
                  <Film size={12} /> Videos
                </button>
              </div>
            </div>

            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Showing {filteredMedia.length} of {mediaList.length} file{mediaList.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Media Grid */}
          {filteredMedia.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Film size={26} />
              </div>
              <h3>{searchQ || filterType !== 'all' ? 'No Matching Media Files' : 'No Media Files on Pi'}</h3>
              <p>
                {searchQ || filterType !== 'all'
                  ? 'Try clearing the search query or changing the filter type.'
                  : `There are currently no media files stored on ${selectedDevice.deviceId}.`}
              </p>
              {!searchQ && filterType === 'all' && (
                <button
                  className="btn btn-primary"
                  onClick={() => navigate('/upload', { state: { preselectDeviceId: selectedDevice.id } })}
                  style={{ marginTop: 'var(--space-2)' }}
                >
                  <UploadCloud size={15} /> Upload Media
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
                    device={selectedDevice}
                    isCurrent={currentMedia === filename}
                    onDelete={m => setDeleteTarget(m)}
                    onPreview={(m, url) => {
                      setPreviewMedia(m);
                      setPreviewUrl(url);
                    }}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isLoading={deleteLoading}
        title="Delete Media File"
        message={
          <span>
            Are you sure you want to delete{' '}
            <strong>{deleteTarget?.filename || deleteTarget?.name}</strong> from{' '}
            <strong>{selectedDevice?.deviceId}</strong>?
            <br /><br />
            This will permanently remove the file from the Raspberry Pi storage.
          </span>
        }
        confirmLabel="Delete File"
        variant="danger"
      />

      {/* High-Resolution Preview Modal */}
      {previewMedia && (
        <div
          className="modal-overlay"
          onClick={() => setPreviewMedia(null)}
          style={{ alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            className="modal"
            style={{
              maxWidth: '90vw',
              width: 'auto',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
              padding: 'var(--space-4)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                borderBottom: '1px solid var(--border-subtle)',
                paddingBottom: 'var(--space-2)',
              }}
            >
              <span
                style={{
                  fontWeight: 'var(--weight-semibold)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {previewMedia.filename || previewMedia.name}
              </span>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => setPreviewMedia(null)}
                aria-label="Close preview"
              >
                <X size={16} />
              </button>
            </div>

            {/\.(jpg|jpeg|png|gif|webp)$/i.test(previewMedia.filename || previewMedia.name) ? (
              <img
                src={previewUrl}
                alt="Full Preview"
                style={{
                  maxWidth: '82vw',
                  maxHeight: '74vh',
                  objectFit: 'contain',
                  borderRadius: 'var(--radius-md)',
                  background: '#090d16',
                }}
              />
            ) : (
              <video
                src={previewUrl}
                controls
                autoPlay
                style={{
                  maxWidth: '82vw',
                  maxHeight: '74vh',
                  borderRadius: 'var(--radius-md)',
                  background: '#090d16',
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
