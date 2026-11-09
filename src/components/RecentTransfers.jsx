// =============================================
// N Signage — Recent transfers of this account (hosted website): metadata only
// Shows the real state reported by the cloud: nothing is "done" until the
// display confirmed it saved the file.
// =============================================
import React, { useCallback, useEffect, useState } from 'react';
import { History, RotateCw, X, Loader2 } from 'lucide-react';
import { listTransfers, cancelTransfer, retryTransferWithFile, FINAL_STATES } from '../api/transferApi';
import { getDevices } from '../data/store';
import { formatBytes } from '../utils/transferFormat';

const BADGE = {
  created: ['badge-neutral', 'Upload not finished'],
  queued: ['badge-warning', 'Waiting for display'],
  downloading: ['badge-info', 'Display downloading'],
  completed: ['badge-success', 'Saved on display'],
  failed: ['badge-danger', 'Failed'],
  cancelled: ['badge-neutral', 'Cancelled'],
  expired: ['badge-neutral', 'Expired'],
};

export default function RecentTransfers({ file, refreshKey }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const r = await listTransfers();
    if (r.ok) { setItems(r.transfers); setError(''); } else setError(r.error);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Poll while something is still in progress
  const active = items.some((t) => !FINAL_STATES.includes(t.state) && t.state !== 'failed');
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [active, load]);

  const names = Object.fromEntries(getDevices().filter((d) => d.piDeviceId).map((d) => [d.piDeviceId, d.nickName || d.hostname || d.deviceId]));

  async function cancel(t) {
    setBusy(t.id);
    const r = await cancelTransfer(t.id);
    setBusy(null);
    setNotice(r.ok ? '' : r.error);
    load();
  }

  async function retry(t) {
    setBusy(t.id);
    setNotice('');
    const r = await retryTransferWithFile(t.id, file && file.size === t.size ? file : null, { waitMs: 0 });
    setBusy(null);
    if (r.needsFile) setNotice(`To retry "${t.filename}", select the same file in step 2, then press Retry again.`);
    else if (!r.ok && r.phase === 'failed') setNotice(r.error || 'Retry failed.');
    load();
  }

  if (!items.length && !error) return null;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
        <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <History size={15} style={{ color: 'var(--text-muted)' }} /> Recent transfers
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} aria-label="Refresh transfers"><RotateCw size={12} /></button>
      </div>
      {error && <div className="alert alert-danger" style={{ fontSize: 'var(--text-xs)' }}>{error}</div>}
      {notice && <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)', marginBottom: 8 }}>{notice}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
        {items.slice(0, 15).map((t) => {
          const [cls, label] = BADGE[t.stage === 'downloading' ? 'downloading' : t.state] || ['badge-neutral', t.state];
          return (
            <div key={t.id} className="xfer-row" style={{ padding: '8px 10px' }}>
              <div className="xfer-head">
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{t.filename}</span>
                <span className={`badge ${cls}`} style={{ fontSize: 10 }}>{label}</span>
              </div>
              <div className="xfer-meta">
                <span>{names[t.deviceId] || t.deviceId}</span>
                <span>{formatBytes(t.size)}</span>
                <span>{new Date(t.createdAt).toLocaleString()}</span>
                {t.state === 'completed' && <span>{t.verified ? 'checksum verified' : 'not checksum-verified'}</span>}
              </div>
              {t.error && t.state !== 'completed' && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.error}</div>}
              {(!FINAL_STATES.includes(t.state) || t.state === 'failed') && (
                <div className="xfer-actions">
                  {busy === t.id ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : (
                    <>
                      {['failed', 'created'].includes(t.state) && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => retry(t)}><RotateCw size={11} /> Retry</button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancel(t)}><X size={11} /> Cancel</button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
        Files go straight from your browser to the display, encrypted. The N-Signage website keeps only
        the file name, size and checksum, never the file itself.
      </p>
    </div>
  );
}
