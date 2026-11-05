// =============================================
// N Signage — Find Pi + Add Device for the hosted website (cloud mode)
//
// Browsers cannot send UDP/mDNS or call http://192.168.x.x from an HTTPS
// page, so discovery runs through the cloud: every Pi syncs with the website,
// and the website lists the Pis that synced from this browser's network
// (same Wi-Fi → same public IP). Nothing is added until the customer clicks
// "Add Device" on a specific Pi.
// =============================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Wifi, Search, CheckCircle2, AlertTriangle, RotateCw, Loader2, Plus, Terminal,
} from 'lucide-react';
import { cloudFindPi, cloudClaim } from '../api/cloudApi';
import { isDiscoveryDebug } from '../api/discoveryApi';

const SEARCH_SECONDS = 30;  // Pis sync every 5 s; give a just-booted Pi time to appear
const POLL_MS = 3000;
const USERNAME_RX = /^[a-z0-9_][a-z0-9_.-]{0,31}$/i;

const FAILURE_TEXT = {
  'cloud-not-configured': 'The N-Signage cloud service is not available right now (server storage is not configured). This is a website problem, not a problem with your Pi — please contact support.',
  'cloud-unreachable': 'Could not reach the N-Signage cloud service. Check this phone or computer\'s internet connection.',
  'cloud-error': 'The N-Signage cloud service returned an error.',
  'not-logged-in': 'Your login session ended. Please log in again.',
  'rate-limited': 'Too many searches. Wait a minute and try again.',
};

function Status({ online }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={`dot ${online ? 'dot-online' : 'dot-offline'}`} />
      <span style={{ color: online ? 'var(--success)' : 'var(--warning)', fontWeight: 'var(--weight-medium)' }}>
        {online ? 'Online' : 'Offline'}
      </span>
    </span>
  );
}

/**
 * @param {function} onAdded - called with the store-shaped device after it was registered
 */
export default function CloudFindPi({ onAdded }) {
  const [phase, setPhase] = useState('searching'); // searching | done | error
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('');
  const [nickName, setNickName] = useState('');
  const [location, setLocation] = useState('');
  const [addingId, setAddingId] = useState(null);
  const [addError, setAddError] = useState('');
  const run = useRef(0);
  const debug = isDiscoveryDebug();

  const search = useCallback(async () => {
    const id = ++run.current;
    const username = filter.trim();
    if (username && !USERNAME_RX.test(username)) {
      setResult({ found: false, reason: 'invalid-identifier', devices: [], log: [] });
      setPhase('error');
      return;
    }
    setPhase('searching');
    setResult(null);
    setAddError('');
    setElapsed(0);
    const started = Date.now();
    for (;;) {
      const r = await cloudFindPi(username);
      if (id !== run.current) return; // superseded or unmounted
      setResult(r);
      const hard = r.reason && r.reason !== 'not-found';
      if (hard) { setPhase('error'); return; }
      if (r.devices.some((d) => d.ownership === 'available')) { setPhase('done'); return; }
      const secs = Math.round((Date.now() - started) / 1000);
      setElapsed(secs);
      if (secs >= SEARCH_SECONDS) { setPhase('done'); return; }
      await new Promise((res) => setTimeout(res, POLL_MS));
      if (id !== run.current) return;
    }
  }, [filter]);

  // Find Pi starts automatically when the panel opens
  useEffect(() => {
    search();
    return () => { run.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Progress counter while searching
  useEffect(() => {
    if (phase !== 'searching') return undefined;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.min(SEARCH_SECONDS, Math.round((Date.now() - started) / 1000))), 1000);
    return () => clearInterval(t);
  }, [phase]);

  async function add(device) {
    if (addingId) return;
    setAddingId(device.deviceId);
    setAddError('');
    const res = await cloudClaim(device.claimNonce, { name: nickName.trim(), location: location.trim() });
    setAddingId(null);
    if (res.ok) { onAdded?.(res.device); return; }
    setAddError(res.error);
    if (res.reason === 'nonce-expired' || res.reason === 'duplicate') search();
  }

  const devices = result?.devices || [];
  const available = devices.filter((d) => d.ownership === 'available');
  const reason = result?.reason;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius-sm)', background: 'var(--accent-subtle)',
          color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Wifi size={16} />
        </div>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Connect this phone or computer to the <strong>same Wi-Fi</strong> as the Raspberry Pi (mobile data will not
          work). The Pi must be powered on and connected to the internet.
        </p>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="cf-name">Display name (optional)</label>
          <input id="cf-name" className="form-input" maxLength={64} placeholder="e.g. Main Lobby Display"
            value={nickName} onChange={(e) => setNickName(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="cf-loc">Location (optional)</label>
          <input id="cf-loc" className="form-input" maxLength={80} placeholder="e.g. Block A, Room 101"
            value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
      </div>

      {phase === 'searching' && (
        <div className="alert alert-info" role="status" aria-live="polite">
          <Loader2 size={14} className="alert-icon" style={{ animation: 'spin 0.8s linear infinite' }} />
          <div style={{ flex: 1 }}>
            <div>Searching for Raspberry Pis on your Wi-Fi… {elapsed}s</div>
            <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 4, marginTop: 6, overflow: 'hidden' }}>
              <div style={{ width: `${(elapsed / SEARCH_SECONDS) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 1s linear' }} />
            </div>
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {phase !== 'searching' && available.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
              <CheckCircle2 size={17} />
              {available.length === 1 ? 'Raspberry Pi found' : `${available.length} Raspberry Pis found — choose yours by hostname`}
            </div>
          )}
          {devices.map((d) => (
            <div key={d.deviceId} className="found-pi">
                  <div className="found-pi-details">
                    <span>Username:</span><span>{d.username}</span>
                    <span>Hostname:</span><span>{d.hostname || '—'}</span>
                    <span>Device ID:</span><span style={{ fontFamily: 'var(--font-mono)' }}>{d.deviceId}</span>
                    <span>IP address:</span><span><span className="ip-chip">{d.ip || '—'}</span></span>
                    <span>API port:</span><span>{d.port}</span>
                    <span>Status:</span><span><Status online={d.online} /></span>
                  </div>
                  {d.ownership === 'mine' ? (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <CheckCircle2 size={13} /> In your account
                    </span>
                  ) : d.ownership === 'other' ? (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      Registered to another account
                    </span>
                  ) : !d.claimNonce ? (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      Use the pairing code shown on this display
                    </span>
                  ) : (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => add(d)} disabled={Boolean(addingId)}>
                      {addingId === d.deviceId
                        ? <><Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> Adding…</>
                        : <><Plus size={13} /> Add Device</>}
                    </button>
                  )}
            </div>
          ))}
        </div>
      )}

      {addError && (
        <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <span>{addError}</span>
        </div>
      )}

      {phase !== 'searching' && available.length === 0 && (
        <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)', alignItems: 'flex-start' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <div style={{ color: 'var(--text-secondary)' }}>
            {reason === 'invalid-identifier' ? (
              <strong>The Pi username may only contain letters, numbers, "_", "." or "-".</strong>
            ) : FAILURE_TEXT[reason] ? (
              <>
                <strong style={{ color: 'var(--text-primary)' }}>Search failed.</strong> {FAILURE_TEXT[reason]}
                {result?.error && <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)' }}>{result.status ? `HTTP ${result.status}: ` : ''}{result.error}</div>}
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--text-primary)' }}>
                  {devices.length ? 'No new Raspberry Pi to add on this network.' : 'No Raspberry Pi found on this network.'}
                </strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <li>This phone/computer and the Pi are on the same Wi-Fi (turn off mobile data and VPN).</li>
                  <li>The Pi is powered on and its screen shows N-Signage.</li>
                  <li>The Pi has internet access (it must reach software.nsinages.in).</li>
                  <li>Just switched on? Wait one minute, then try again.</li>
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={search} disabled={phase === 'searching'}>
          {phase === 'searching' ? <Search size={13} /> : <RotateCw size={13} />}
          {phase === 'searching' ? 'Searching…' : 'Find Pi again'}
        </button>
        <details style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          <summary style={{ cursor: 'pointer' }}>Filter by Pi username</summary>
          <input className="form-input" style={{ marginTop: 6, maxWidth: 220 }} placeholder="e.g. ns"
            value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Pi username filter" />
        </details>
      </div>

      {debug && result?.log?.length > 0 && (
        <details style={{ fontSize: 'var(--text-xs)' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Terminal size={12} /> Debug log
          </summary>
          <pre style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', background: 'var(--bg-base)', padding: 8, marginTop: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            {result.log.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
