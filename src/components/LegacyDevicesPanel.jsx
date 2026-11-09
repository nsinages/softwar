// =============================================
// N Signage — One-time link of displays added before customer accounts
//
// Older versions of the website saved displays per browser (no login). This
// panel appears only in a browser that still has that old session. Nothing
// is moved automatically: each display is linked only after a second proof
// of control: being on the display's Wi-Fi now (same check as Find IP).
// =============================================
import React, { useCallback, useEffect, useState } from 'react';
import { History, Link2, Loader2, CheckCircle2, AlertTriangle, RotateCw } from 'lucide-react';
import { cloudLegacyDevices, cloudLinkLegacy } from '../api/cloudApi';

const STATUS_TEXT = {
  linked: 'In your account',
  'other-account': 'Registered to another account',
  missing: 'No longer connected to the cloud',
  removed: 'Removed from this browser earlier',
};

export default function LegacyDevicesPanel({ onLinked }) {
  const [state, setState] = useState({ loading: true, devices: [] });
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const r = await cloudLegacyDevices();
    setState({ loading: false, available: r.ok && r.available, devices: r.devices || [], error: r.ok ? '' : r.error });
  }, []);

  useEffect(() => { load(); }, [load]);

  async function link(d) {
    setBusyId(d.deviceId);
    setMsg(null);
    const r = await cloudLinkLegacy(d.deviceId);
    setBusyId(null);
    if (r.ok) {
      setMsg({ ok: true, text: `${d.name || d.hostname || d.deviceId} is now in your account.` });
      onLinked?.();
      load();
    } else {
      setMsg({ ok: false, text: r.error, id: d.deviceId });
    }
  }

  const pending = state.devices.filter((d) => d.status === 'linkable');
  if (state.loading || !state.available || state.devices.length === 0) return null;
  if (pending.length === 0 && !msg) return null;

  return (
    <div className="card" style={{ marginBottom: 'var(--space-5)', borderColor: 'rgba(244, 119, 33, 0.3)' }}>
      <div className="card-header">
        <div className="card-title">
          <History size={18} style={{ color: 'var(--accent)' }} />
          <span>Displays added in this browser before accounts</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load}><RotateCw size={13} /> Refresh</button>
      </div>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 'var(--space-3)' }}>
        These displays were added in this browser before customer accounts existed. To move one into your account,
        confirm it is yours: connect this phone or computer to <strong>the same Wi-Fi as the display</strong> and press
        Link.
      </p>
      {msg && (
        <div className={`alert ${msg.ok ? 'alert-success' : 'alert-danger'}`} style={{ fontSize: 'var(--text-xs)', marginBottom: 'var(--space-3)' }}>
          {msg.ok ? <CheckCircle2 size={14} className="alert-icon" /> : <AlertTriangle size={14} className="alert-icon" />}
          <span>{msg.text}</span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {state.devices.map((d) => (
          <div key={d.deviceId} className="found-pi">
            <div className="found-pi-details">
              <span>Name:</span><span>{d.name || '—'}</span>
              <span>Hostname:</span><span>{d.hostname || '—'}</span>
              <span>Device ID:</span><span style={{ fontFamily: 'var(--font-mono)' }}>{d.deviceId}</span>
              <span>Status:</span>
              <span>
                {d.status === 'linkable'
                  ? (d.sameNetwork ? <span style={{ color: 'var(--success)' }}>On your Wi-Fi now: ready to link</span> : 'Not on this Wi-Fi')
                  : STATUS_TEXT[d.status]}
              </span>
            </div>
            {d.status === 'linkable' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => link(d)} disabled={Boolean(busyId) || !d.sameNetwork}>
                  {busyId === d.deviceId ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Link2 size={13} />} Link to my account
                </button>
              </div>
            ) : (
              <span style={{ fontSize: 'var(--text-xs)', color: d.status === 'linked' ? 'var(--success)' : 'var(--text-muted)' }}>
                {STATUS_TEXT[d.status]}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
