// =============================================
// N Signage — Add Device (hosted website)
//
// Two ways to prove the display is yours:
//   1. Pairing code — the display shows a one-time code on its screen
//      (needs the N-Signage Pi software update; works from any network).
//   2. Find on this Wi-Fi — this phone/computer is on the same network as
//      the display right now (works with every installed display).
// =============================================
import React, { useState } from 'react';
import { KeyRound, Wifi, Loader2, AlertTriangle, Plus, Info } from 'lucide-react';
import CloudFindPi from './CloudFindPi';
import { cloudPair, isNetworkClaimAllowed } from '../api/cloudApi';

const CODE_RX = /^[A-HJ-NP-Z2-9]{8}$/;
const normalize = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

function PairingCodeForm({ onAdded }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function onCodeChange(v) {
    const n = normalize(v).slice(0, 8);
    setCode(n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n);
  }

  async function submit(e) {
    e.preventDefault();
    const n = normalize(code);
    if (!CODE_RX.test(n)) { setError('The pairing code has 8 letters and numbers, e.g. K7QM-3XPA.'); return; }
    setBusy(true);
    setError('');
    const r = await cloudPair(n, { name: name.trim(), location: location.trim() });
    setBusy(false);
    if (r.ok) onAdded(r.device);
    else setError(r.error);
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Your display shows a one-time <strong>pairing code</strong> on its screen. Enter it here. This works from
        any network, including mobile data. A code is valid for 10 minutes and can be used once.
      </p>
      <div className="form-group">
        <label className="form-label" htmlFor="pair-code">Pairing code</label>
        <input id="pair-code" className="form-input pair-code-input" value={code} placeholder="XXXX-XXXX"
          autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} inputMode="text"
          onChange={(e) => onCodeChange(e.target.value)} />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="pair-name">Display name (optional)</label>
          <input id="pair-name" className="form-input" maxLength={64} placeholder="e.g. Shop Display"
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="pair-loc">Location (optional)</label>
          <input id="pair-loc" className="form-input" maxLength={80} placeholder="e.g. Branch 02"
            value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" /><span>{error}</span>
        </div>
      )}
      <div className="alert alert-info" style={{ fontSize: 'var(--text-xs)', alignItems: 'flex-start' }}>
        <Info size={14} className="alert-icon" />
        <span style={{ color: 'var(--text-secondary)' }}>
          No code on the screen? Your display needs the latest N-Signage software for pairing codes.
          Until then, use <strong>Find on this Wi-Fi</strong>.
        </span>
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy || normalize(code).length !== 8}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Plus size={14} />} Add Device
        </button>
      </div>
    </form>
  );
}

export default function CloudAddDevice({ onAdded }) {
  const networkAllowed = isNetworkClaimAllowed();
  // Every installed display can be found on its Wi-Fi today; pairing codes need the Pi update
  const [method, setMethod] = useState(networkAllowed ? 'network' : 'code');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {networkAllowed && (
        <div className="seg-tabs" role="tablist" aria-label="How to add the display">
          <button type="button" role="tab" className="seg-tab" aria-selected={method === 'network'} onClick={() => setMethod('network')}>
            <Wifi size={14} /> Find on this Wi-Fi
          </button>
          <button type="button" role="tab" className="seg-tab" aria-selected={method === 'code'} onClick={() => setMethod('code')}>
            <KeyRound size={14} /> Pairing code
          </button>
        </div>
      )}
      {method === 'code' ? <PairingCodeForm onAdded={onAdded} /> : <CloudFindPi onAdded={onAdded} />}
    </div>
  );
}
