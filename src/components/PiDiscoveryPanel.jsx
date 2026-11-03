// =============================================
// N Signage V3 — Pi Discovery Panel Component
// Find Raspberry Pi on local network
// =============================================
import React, { useState, useRef, useEffect } from 'react';
import {
  Wifi,
  Search,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Loader2,
  Terminal,
  ArrowRight,
} from 'lucide-react';
import { findPi, isDiscoveryDebug } from '../api/discoveryApi';

// Linux username (same rule as the LAN helper)
const IDENTIFIER_RX = /^[a-z0-9_][a-z0-9_.-]{0,31}$/i;

const resultCardStyle = (border) => ({
  background: 'var(--bg-card)',
  border: `1px solid ${border}`,
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
});

const detailGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '6px 14px',
  fontSize: 'var(--text-xs)',
  background: 'var(--bg-elevated)',
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
};

function OnlineStatus({ online }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span className={`dot ${online ? 'dot-online' : 'dot-offline'}`} />
      <span style={{ color: online ? 'var(--success)' : 'var(--warning)', fontWeight: 'var(--weight-medium)' }}>
        {online ? 'Online' : 'Found, but the N-Signage API is not responding'}
      </span>
    </div>
  );
}

/**
 * @param {string}   identifier - Pi Linux username typed in the form
 * @param {function} onUseIp    - called with the verified IP to fill the IP field
 * @param {function} [onFound]  - called with the verified device (or null on a new search)
 */
export default function PiDiscoveryPanel({ identifier, onUseIp, onFound }) {
  const [state, setState] = useState('idle'); // idle | searching | found | multiple | notfound | invalid
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(null);
  const mounted = useRef(true);
  const debug = isDiscoveryDebug();
  const trimmed = (identifier || '').trim();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function choose(device) {
    setSelected(device);
    setState('found');
    onUseIp?.(device.ip);
    onFound?.(device);
  }

  async function handleFind() {
    if (!IDENTIFIER_RX.test(trimmed)) {
      setState('invalid');
      setResult(null);
      return;
    }
    setState('searching');
    setResult(null);
    setSelected(null);
    onFound?.(null);
    const r = await findPi(trimmed);
    // Username changed (panel remounted) while searching — drop the stale result
    if (!mounted.current) return;
    setResult(r);

    if (!r.found) {
      // Never touch the IP field when discovery fails
      setState(r.reason === 'invalid-identifier' ? 'invalid' : 'notfound');
    } else if (r.devices.length === 1) {
      choose(r.devices[0]);
    } else {
      setState('multiple');
    }
  }

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      {/* Header Info */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-subtle)',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          <Wifi size={16} />
        </div>
        <div>
          <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
            Find Raspberry Pi (V3 Discovery)
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
            Make sure your computer or phone and the Raspberry Pi are connected to the same Wi-Fi network.
          </p>
        </div>
      </div>

      {/* Action Button */}
      <div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleFind}
          disabled={state === 'searching' || !trimmed}
          style={{
            fontWeight: 'var(--weight-semibold)',
          }}
        >
          {state === 'searching' ? (
            <>
              <Loader2 size={13} className="spinner" style={{ border: 'none', animation: 'spin 0.8s linear infinite' }} />
              Searching for Raspberry Pi...
            </>
          ) : (
            <>
              <Search size={13} />
              Find Pi
            </>
          )}
        </button>
      </div>

      {/* Invalid Identifier Error */}
      {state === 'invalid' && (
        <div className="alert alert-warning" style={{ fontSize: 'var(--text-xs)' }}>
          <AlertTriangle size={14} className="alert-icon" />
          <span>Enter the Raspberry Pi's Linux username using letters, numbers, <code>_</code>, <code>.</code> or <code>-</code> (e.g. <code>ns</code>).</span>
        </div>
      )}

      {/* Success Result */}
      {state === 'found' && selected && (
        <div style={resultCardStyle('rgba(16, 185, 129, 0.3)')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            <CheckCircle2 size={18} />
            <span>Raspberry Pi found!</span>
          </div>

          <div style={detailGridStyle}>
            <span style={{ color: 'var(--text-muted)' }}>Username:</span>
            <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{selected.username}</span>

            <span style={{ color: 'var(--text-muted)' }}>Hostname:</span>
            <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{selected.hostname || '—'}</span>

            <span style={{ color: 'var(--text-muted)' }}>IP Address:</span>
            <div>
              <span className="ip-chip">{selected.ip}</span>
            </div>

            <span style={{ color: 'var(--text-muted)' }}>Status:</span>
            <OnlineStatus online={selected.online} />
          </div>

          <span className="form-hint">
            The IP address has been filled in below. You can still edit it if needed.
          </span>
        </div>
      )}

      {/* Several Pis report this username — let the customer pick theirs */}
      {state === 'multiple' && result && (
        <div style={resultCardStyle('rgba(16, 185, 129, 0.3)')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            <CheckCircle2 size={18} />
            <span>{result.devices.length} Raspberry Pis found with username "{trimmed}"</span>
          </div>
          <span className="form-hint">Choose your Raspberry Pi by its hostname.</span>

          {result.devices.map((d) => (
            <div
              key={d.deviceId || d.ip}
              style={{ ...detailGridStyle, gridTemplateColumns: '1fr auto', alignItems: 'center' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{d.hostname || d.username}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="ip-chip">{d.ip}</span>
                  <OnlineStatus online={d.online} />
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => choose(d)}>
                Use <ArrowRight size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Not Found Result */}
      {state === 'notfound' && (
        <div style={resultCardStyle('rgba(239, 68, 68, 0.25)')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            <AlertTriangle size={16} />
            <span>Raspberry Pi not found.</span>
          </div>

          {result?.reason === 'other-network' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              A Raspberry Pi with the username <strong>{trimmed}</strong> is connected to the cloud, but from a
              different network. Connect this computer or phone to the same Wi-Fi as the Pi, then try again.
            </div>
          )}

          {result?.reason === 'username-mismatch' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              {result.otherCount} N-Signage Raspberry Pi{result.otherCount === 1 ? '' : 's'} answered on this network,
              but none use the username <strong>{trimmed}</strong>. Check the username and try again.
            </div>
          )}

          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            <div style={{ fontWeight: 'var(--weight-medium)', marginBottom: 4, color: 'var(--text-primary)' }}>
              Make sure:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <li>Both devices are connected to the same Wi-Fi network.</li>
              <li>The Raspberry Pi is powered on.</li>
              <li>The N-Signage cloud and discovery services are running on the Pi, and it has internet access.</li>
              <li>The username is the Pi's Linux username (e.g. <code>ns</code>).</li>
            </ul>
          </div>

          {result?.reason === 'helper-unavailable' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>
              The search timed out or the local network discovery helper is currently unreachable.
            </div>
          )}

          <div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleFind}
            >
              <RotateCw size={12} /> Try Again
            </button>
          </div>
        </div>
      )}

      {/* Debug details if enabled */}
      {debug && result?.log?.length > 0 && (
        <details style={{ fontSize: 'var(--text-xs)' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Terminal size={12} />
            <span>Debug log ({result.method || result.reason || 'multiple'}{result.durationMs ? `, ${result.durationMs}ms` : ''})</span>
          </summary>
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'pre-wrap',
              background: 'var(--bg-base)',
              padding: '8px',
              borderRadius: 'var(--radius-sm)',
              marginTop: '6px',
              maxHeight: 160,
              overflow: 'auto',
              border: '1px solid var(--border)',
            }}
          >
            {result.log.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
