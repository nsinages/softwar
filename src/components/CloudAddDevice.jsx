// =============================================
// N Signage — Add Device (hosted website)
//
//   1. Pi Name (required) + Nickname (optional) → "Find IP"
//   2. The cloud lists the Raspberry Pi(s) with that name (Linux username OR
//      hostname) that checked in from THIS network in the last 2 minutes. The
//      IP address is the one the Pi reports itself; nobody types it.
//   3. "Add Device" registers the chosen Pi to this account with the
//      single-use search token (bound to this account and this network).
//
// "Enter IP manually" (secondary option): Pi Name + the IP the customer knows →
// "Connect". The Pi must still be checking in from THIS network and report that
// IP and name; an IP alone proves nothing. If no such Pi answers, the customer
// may save the display as "Saved · not connected" (never marked verified).
//
// The nickname is only a label. Browsers cannot send UDP, so the hosted site
// uses the Pis' own cloud check-ins; the local dashboard uses UDP + mDNS.
// =============================================
import React, { useEffect, useRef, useState } from 'react';
import { Search, Loader2, AlertTriangle, CheckCircle2, Plus, RotateCw, Wifi, Link2, Save } from 'lucide-react';
import { cloudFindPi, cloudClaim, cloudSaveDevice } from '../api/cloudApi';
import { isValidPiName, PI_NAME_HINT } from '../../shared/piName';

const SEARCH_SECONDS = 30; // an idle Pi checks in every 15 s; give a just-booted Pi time to appear
const POLL_MS = 3000;
const IPV4_RX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const SAVE_HOSTNAME_RX = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i; // what a saved record accepts as hostname

const FAILURE_TEXT = {
  'cloud-not-configured': 'The N-Signage cloud service is not available right now. This is a website problem, not a problem with your Pi. Please contact support.',
  'cloud-unreachable': 'Could not reach the N-Signage cloud service. Check this phone or computer\'s internet connection.',
  'cloud-error': 'The N-Signage cloud service returned an error. Please try again.',
  'not-logged-in': 'Your login session ended. Please log in again.',
  'rate-limited': 'Too many searches. Wait a minute and try again.',
  'invalid-identifier': PI_NAME_HINT,
  'invalid-ip': 'Enter the Raspberry Pi\'s IP address, for example 192.168.1.120.',
};

function OnlineStatus({ online }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={`dot ${online ? 'dot-online' : 'dot-offline'}`} />
      <span style={{ color: online ? 'var(--success)' : 'var(--warning)', fontWeight: 'var(--weight-medium)' }}>
        {online ? 'Online' : 'Offline'}
      </span>
    </span>
  );
}

/** @param {function} onAdded - called with the store-shaped device after it was registered */
export default function CloudAddDevice({ onAdded }) {
  const [piName, setPiName] = useState('');
  const [nickName, setNickName] = useState('');
  const [nameError, setNameError] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | searching | found | notfound | error
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [manual, setManual] = useState(false);   // "Enter IP manually"
  const [ip, setIp] = useState('');
  const [ipError, setIpError] = useState('');
  const [saving, setSaving] = useState(false);
  const run = useRef(0);

  useEffect(() => () => { run.current += 1; }, []); // stop polling when closed

  async function findIp(e) {
    e?.preventDefault();
    const name = piName.trim();
    if (!isValidPiName(name)) { setNameError(name ? PI_NAME_HINT : 'Enter the Pi Name, for example ns001.'); return; }
    setNameError('');
    const manualIp = manual ? ip.trim() : '';
    if (manual && !IPV4_RX.test(manualIp)) { setIpError('Enter the IP address, for example 192.168.1.120.'); return; }
    setIpError('');
    const id = ++run.current;
    setPhase('searching');
    setResult(null);
    setSelectedId(null);
    setAddError('');
    setElapsed(0);
    const started = Date.now();
    for (;;) {
      const r = await cloudFindPi(name, { ip: manualIp });
      if (id !== run.current) return; // superseded or closed
      setResult(r);
      if (r.reason && r.reason !== 'not-found') { setPhase('error'); return; }
      if (r.devices.length) {
        const pick = r.devices.find((d) => d.ownership === 'available' && d.claimNonce) || r.devices[0];
        setSelectedId(pick.deviceId);
        setPhase('found');
        return;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      setElapsed(secs);
      if (secs >= SEARCH_SECONDS) { setPhase('notfound'); return; }
      await new Promise((res) => setTimeout(res, POLL_MS));
      if (id !== run.current) return;
    }
  }

  const devices = result?.devices || [];
  const selected = devices.find((d) => d.deviceId === selectedId) || null;

  // Manual IP, no matching Pi checked in: keep it in the account as "Saved · not connected"
  async function saveUnverified() {
    if (saving) return;
    setSaving(true);
    setAddError('');
    const name = piName.trim();
    const r = await cloudSaveDevice({
      name: nickName.trim() || name, ip: ip.trim(), ...(SAVE_HOSTNAME_RX.test(name) && { hostname: name }),
    });
    setSaving(false);
    if (r.ok) onAdded?.(r.device, { verified: false });
    else setAddError(r.error);
  }

  function switchMode(next) {
    run.current += 1;
    setManual(next);
    setPhase('idle');
    setResult(null);
    setIpError('');
    setAddError('');
  }

  async function add() {
    if (!selected?.claimNonce || adding) return;
    setAdding(true);
    setAddError('');
    const res = await cloudClaim(selected.claimNonce, { name: nickName.trim() });
    setAdding(false);
    if (res.ok) { onAdded?.(res.device); return; }
    setAddError(res.error);
    if (['nonce-expired', 'network-changed', 'pi-offline', 'duplicate'].includes(res.reason)) setPhase('idle');
  }

  const canAdd = selected && selected.ownership === 'available' && Boolean(selected.claimNonce);

  return (
    <form onSubmit={findIp} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="add-pi-name">Pi Name</label>
          <input id="add-pi-name" className="form-input" maxLength={63} placeholder="e.g. ns001" autoCapitalize="none"
            autoCorrect="off" spellCheck={false} required value={piName} aria-invalid={Boolean(nameError)}
            onChange={(e) => { setPiName(e.target.value); setNameError(''); if (phase !== 'searching') { setPhase('idle'); setResult(null); } }} />
          {nameError
            ? <span className="form-error">{nameError}</span>
            : <span className="form-hint">The Raspberry Pi's username or hostname</span>}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="add-nickname">Nickname (optional)</label>
          <input id="add-nickname" className="form-input" maxLength={64} placeholder="e.g. Main Lobby Display"
            value={nickName} onChange={(e) => setNickName(e.target.value)} />
          <span className="form-hint">Only a label for you; not used to find the Pi</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
        <Wifi size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Connect this phone or computer to the <strong>same Wi-Fi</strong> as the Raspberry Pi. The Pi must be powered on and online.</span>
      </div>

      {manual && (
        <div className="form-group">
          <label className="form-label" htmlFor="add-ip">IP address</label>
          <input id="add-ip" className="form-input" maxLength={15} placeholder="e.g. 192.168.1.120" inputMode="decimal"
            style={{ fontFamily: 'var(--font-mono)', maxWidth: 260 }} value={ip} aria-invalid={Boolean(ipError)}
            onChange={(e) => { setIp(e.target.value); setIpError(''); if (phase !== 'searching') { setPhase('idle'); setResult(null); } }} />
          {ipError
            ? <span className="form-error">{ipError}</span>
            : <span className="form-hint">The Raspberry Pi's address on your Wi-Fi. It is checked against what the Pi reports.</span>}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-secondary" disabled={phase === 'searching'}>
          {phase === 'searching'
            ? <><Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> {manual ? 'Connecting…' : 'Searching…'} {elapsed}s</>
            : manual ? <><Link2 size={14} /> Connect</> : <><Search size={14} /> Find IP</>}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => switchMode(!manual)} disabled={phase === 'searching'}>
          {manual ? 'Use Find IP instead' : 'Enter IP manually'}
        </button>
      </div>

      {phase === 'found' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {devices.length === 1 && devices[0].ownership === 'mine' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
              <CheckCircle2 size={17} /> This Raspberry Pi is already in your account. Nothing more to do.
            </div>
          ) : devices.length === 1 && devices[0].ownership === 'other' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
              <AlertTriangle size={17} /> This Raspberry Pi is registered to another account
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
              <CheckCircle2 size={17} />
              {devices.length === 1 ? 'Raspberry Pi found' : `${devices.length} Raspberry Pis named "${piName.trim()}" found. Choose yours by hostname.`}
            </div>
          )}
          {devices.map((d) => (
            <label key={d.deviceId} className="found-pi" style={{ cursor: devices.length > 1 ? 'pointer' : 'default' }}>
              {devices.length > 1 && (
                <input type="radio" name="found-pi" checked={selectedId === d.deviceId} onChange={() => setSelectedId(d.deviceId)}
                  style={{ accentColor: 'var(--accent)' }} />
              )}
              <div className="found-pi-details">
                <span>Pi Name:</span><span>{d.matchedBy === 'hostname' ? d.hostname : d.username}</span>
                <span>Hostname:</span><span>{d.hostname || '—'}</span>
                <span>Username:</span><span>{d.username}</span>
                {d.ip && <><span>IP address:</span><span><span className="ip-chip">{d.ip}</span></span></>}
                <span>Status:</span><span><OnlineStatus online={d.online} /></span>
              </div>
              {d.ownership === 'mine' && <span className="form-hint" style={{ color: 'var(--success)' }}>Already in your account</span>}
              {d.ownership === 'other' && <span className="form-hint">Registered to another account</span>}
            </label>
          ))}
          {selected?.ownership === 'available' && !selected.claimNonce && (
            <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)' }}>
              <AlertTriangle size={14} className="alert-icon" />
              <span>Adding displays found on this Wi-Fi is turned off on this website. Please contact support.</span>
            </div>
          )}
        </div>
      )}

      {phase === 'notfound' && (
        <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)', alignItems: 'flex-start' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <div style={{ color: 'var(--text-secondary)' }}>
            <strong>
              {manual
                ? `No Raspberry Pi named "${piName.trim()}" with IP ${ip.trim()} is checking in from this Wi-Fi.`
                : `No Raspberry Pi named "${piName.trim()}" was found on this Wi-Fi.`}
            </strong>
            {result?.otherCount > 0 && (
              <div style={{ marginTop: 4 }}>
                {result.otherCount} other N-Signage Pi{result.otherCount === 1 ? ' is' : 's are'} online on this network. Check the Pi Name{manual ? ' and the IP address' : ''}.
              </div>
            )}
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Check the Pi Name: the Raspberry Pi's username or hostname.</li>
              {manual && <li>Check the IP address, or use Find IP instead.</li>}
              <li>This device and the Pi must use the same Wi-Fi (not mobile data).</li>
              <li>Just switched the Pi on? Wait one minute, then press {manual ? 'Connect' : 'Find IP'} again.</li>
            </ul>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <span>{FAILURE_TEXT[result?.reason] || result?.error || 'The search failed. Please try again.'}</span>
        </div>
      )}

      {addError && (
        <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <span>{addError}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {(phase === 'notfound' || phase === 'error') && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={findIp}><RotateCw size={13} /> Try again</button>
        )}
        {manual && phase === 'notfound' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={saveUnverified} disabled={saving}
            title="Keeps the display in your account as Saved · not connected until it is found on its Wi-Fi">
            {saving ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Save size={13} />} Save without connecting
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={add} disabled={!canAdd || adding}>
          {adding ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Plus size={14} />} Add Device
        </button>
      </div>
    </form>
  );
}
