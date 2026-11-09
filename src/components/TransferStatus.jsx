// =============================================
// N Signage — Status line, progress and actions for one upload target
// =============================================
import React from 'react';
import { RotateCw, X, ShieldCheck, Info } from 'lucide-react';
import { statusLabel, isActive } from '../utils/transferFormat';

export default function TransferStatus({ state, onCancel, onRetry }) {
  const label = statusLabel(state);
  const showBar = ['hashing', 'uploading'].includes(state.status);
  return (
    <>
      <div className="xfer-head">
        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)', color: label.color }}>{label.text}</span>
        <div className="xfer-actions">
          {onCancel && isActive(state) && state.status !== 'pending' && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}><X size={12} /> Cancel</button>
          )}
          {onRetry && ['failed', 'cancelled'].includes(state.status) && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}><RotateCw size={12} /> {state.status === 'cancelled' ? 'Send again' : 'Retry'}</button>
          )}
        </div>
      </div>
      {showBar && (
        <div className="progress-bar-wrap">
          <div className="progress-bar-fill" style={{ width: `${state.progress || 0}%` }} />
        </div>
      )}
      {state.status === 'uploading' && state.speed > 0 && (
        <div className="xfer-meta">
          <span>{formatBytes(state.speed)}/s</span>
          {state.eta && <span>{formatEta(state.eta)}</span>}
        </div>
      )}
      {state.status === 'success' && state.relay && (
        <div className="xfer-meta">
          {state.verified ? (
            <span style={{ color: 'var(--success)', display: 'inline-flex', gap: 4, alignItems: 'center' }}><ShieldCheck size={12} /> Checksum verified by the display</span>
          ) : (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} title="This display's software can confirm the file was saved but cannot verify its checksum yet. Update the Pi software for verified transfers.">
              <Info size={12} /> Saved. Checksum not verified (display software update needed)
            </span>
          )}
          {state.savedAs && <span>as “{state.savedAs}”</span>}
        </div>
      )}
      {state.status === 'success' && state.lan && (
        <div className="xfer-meta">
          <span style={{ color: 'var(--success)', display: 'inline-flex', gap: 4, alignItems: 'center' }}><ShieldCheck size={12} /> Sent over your local network; saved size checked</span>
          {state.savedAs && <span>as “{state.savedAs}”</span>}
        </div>
      )}
      {state.status === 'waiting' && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          The display has not picked up the file yet (it may be offline). It will download it automatically when it
          reconnects, until the transfer expires. Follow it under <strong>Recent transfers</strong>. This is not a success yet.
        </div>
      )}
      {state.error && ['failed', 'cancelled'].includes(state.status) && (
        <div style={{ fontSize: 'var(--text-xs)', color: state.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)' }}>{state.error}</div>
      )}
    </>
  );
}
