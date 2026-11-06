// =============================================
// N Signage — Add Device (hosted website)
//
//   Enter details      — name + IP address (+ optional hostname, device UID, pairing code).
//                        Without a pairing code the display is SAVED in the account but not
//                        verified: an IP address alone proves nothing.
//   Find on this Wi-Fi — this phone/computer is on the same network as the display right now
//                        (works with every installed display) → verified.
//   Pairing code       — the display shows a one-time code (needs the Pi update) → verified.
// =============================================
import React, { useState } from 'react';
import { KeyRound, Wifi, Loader2, AlertTriangle, Plus, Info, PencilLine, CheckCircle2 } from 'lucide-react';
import CloudFindPi from './CloudFindPi';
import { cloudPair, cloudSaveDevice, isNetworkClaimAllowed } from '../api/cloudApi';

const CODE_RX = /^[A-HJ-NP-Z2-9]{8}$/;
const normalize = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

const IPV4_RX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RX = /^[0-9a-f:]+$/i;
const UID_RX = /^[a-f0-9]{16}$/;

function DetailsForm({ onAdded }) {
  const [f, setF] = useState({ name: '', ip: '', hostname: '', deviceUid: '', code: '' });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  function validate() {
    const e = {};
    if (!f.name.trim()) e.name = 'Enter a name, for example "Shop Display 01".';
    const ip = f.ip.trim();
    if (!ip) e.ip = 'Enter the IP address, for example 192.168.1.120.';
    else if (!IPV4_RX.test(ip) && !(ip.includes(':') && IPV6_RX.test(ip))) e.ip = 'This is not a valid IP address. Example: 192.168.1.120';
    if (f.hostname.trim() && !/^[a-z0-9.-]{1,253}$/i.test(f.hostname.trim())) e.hostname = 'Letters, numbers, "-" and "." only.';
    if (f.deviceUid.trim() && !UID_RX.test(f.deviceUid.trim().toLowerCase())) e.deviceUid = '16 characters, 0-9 and a-f.';
    if (f.code.trim() && !CODE_RX.test(normalize(f.code))) e.code = 'The pairing code has 8 letters and numbers.';
    return e;
  }

  async function submit(ev) {
    ev.preventDefault();
    const e = validate();
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError('');
    const r = await cloudSaveDevice({
      name: f.name.trim(), ip: f.ip.trim(), hostname: f.hostname.trim(),
      deviceUid: f.deviceUid.trim().toLowerCase(), code: f.code.trim() ? normalize(f.code) : '',
    });
    setBusy(false);
    if (r.ok) onAdded(r.device, { verified: r.verified });
    else setError(r.error);
  }

  const err = (k) => errs[k] && <span className="form-error">{errs[k]}</span>;
  return (
    <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="dev-name">Raspberry Pi name</label>
          <input id="dev-name" className="form-input" maxLength={64} placeholder="Shop Display 01" value={f.name} onChange={set('name')} aria-invalid={Boolean(errs.name)} />
          {err('name')}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="dev-ip">IP address</label>
          <input id="dev-ip" className="form-input" maxLength={45} placeholder="192.168.1.120" inputMode="decimal" style={{ fontFamily: 'var(--font-mono)' }}
            value={f.ip} onChange={set('ip')} aria-invalid={Boolean(errs.ip)} />
          {err('ip')}
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="dev-host">Hostname (optional)</label>
          <input id="dev-host" className="form-input" maxLength={253} placeholder="shop-pi" value={f.hostname} onChange={set('hostname')} />
          {err('hostname')}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="dev-uid">Device UID (optional)</label>
          <input id="dev-uid" className="form-input" maxLength={16} placeholder="16 characters" style={{ fontFamily: 'var(--font-mono)' }} value={f.deviceUid} onChange={set('deviceUid')} />
          {err('deviceUid')}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="dev-code">Pairing code (optional, verifies the display)</label>
        <input id="dev-code" className="form-input" maxLength={9} placeholder="XXXX-XXXX" style={{ fontFamily: 'var(--font-mono)', maxWidth: 200 }} value={f.code} onChange={set('code')} />
        {err('code')}
      </div>
      <div className="alert alert-info" style={{ fontSize: 'var(--text-xs)', alignItems: 'flex-start' }}>
        <Info size={14} className="alert-icon" />
        <span style={{ color: 'var(--text-secondary)' }}>
          The display is saved in your account and appears every time you sign in. Without a pairing code it shows as
          <strong> Saved · not connected</strong> until the display itself is verified (with <strong>Find on this Wi-Fi</strong> or
          its pairing code). An IP address on its own cannot prove which device it is.
        </span>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" /><span>{error}</span>
        </div>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> : <CheckCircle2 size={14} />} Save device
        </button>
      </div>
    </form>
  );
}

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
  const [method, setMethod] = useState('details');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="seg-tabs" role="tablist" aria-label="How to add the display">
        <button type="button" role="tab" className="seg-tab" aria-selected={method === 'details'} onClick={() => setMethod('details')}>
          <PencilLine size={14} /> Enter details
        </button>
        {networkAllowed && (
          <button type="button" role="tab" className="seg-tab" aria-selected={method === 'network'} onClick={() => setMethod('network')}>
            <Wifi size={14} /> Find on this Wi-Fi
          </button>
        )}
        <button type="button" role="tab" className="seg-tab" aria-selected={method === 'code'} onClick={() => setMethod('code')}>
          <KeyRound size={14} /> Pairing code
        </button>
      </div>
      {method === 'details' && <DetailsForm onAdded={onAdded} />}
      {method === 'network' && <CloudFindPi onAdded={onAdded} />}
      {method === 'code' && <PairingCodeForm onAdded={onAdded} />}
    </div>
  );
}
