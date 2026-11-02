// =============================================
// N Signage V3 — Pi Discovery Panel Component
// Find Raspberry Pi on local network
// =============================================
import React, { useState } from 'react';
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

const IDENTIFIER_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export default function PiDiscoveryPanel({ identifier, onUseIp }) {
  const [state, setState] = useState('idle'); // idle | searching | found | notfound | invalid
  const [result, setResult] = useState(null);
  const debug = isDiscoveryDebug();
  const trimmed = (identifier || '').trim();

  async function handleFind() {
    if (!IDENTIFIER_RX.test(trimmed)) {
      setState('invalid');
      setResult(null);
      return;
    }
    setState('searching');
    setResult(null);
    const r = await findPi(trimmed);
    setResult(r);
    setState(r.found ? 'found' : r.reason === 'invalid-identifier' ? 'invalid' : 'notfound');
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
              Searching for Raspberry Pi…
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
          <span>Enter the Pi device identifier using letters, numbers and hyphens (e.g. <code>n-sinage</code>).</span>
        </div>
      )}

      {/* Success Result */}
      {state === 'found' && result && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            <CheckCircle2 size={18} />
            <span>Raspberry Pi Found</span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 14px',
              fontSize: 'var(--text-xs)',
              background: 'var(--bg-elevated)',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <span style={{ color: 'var(--text-muted)' }}>Device ID:</span>
            <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{result.identifier}</span>

            <span style={{ color: 'var(--text-muted)' }}>IP Address:</span>
            <div>
              <span className="ip-chip">{result.ip}</span>
            </div>

            <span style={{ color: 'var(--text-muted)' }}>Status:</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className={`dot ${result.online ? 'dot-online' : 'dot-offline'}`} />
              <span style={{ color: result.online ? 'var(--success)' : 'var(--warning)', fontWeight: 'var(--weight-medium)' }}>
                {result.online ? 'Online (Service Responding)' : 'Discovered, but service is not responding'}
              </span>
            </div>
          </div>

          {onUseIp && result.ip && (
            <div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onUseIp(result.ip)}
              >
                Use This Device IP <ArrowRight size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Not Found Result */}
      {state === 'notfound' && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            <AlertTriangle size={16} />
            <span>Raspberry Pi Not Found</span>
          </div>

          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            <div style={{ fontWeight: 'var(--weight-medium)', marginBottom: 4, color: 'var(--text-primary)' }}>
              Make sure:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <li>The Raspberry Pi is powered on.</li>
              <li>Your device and the Raspberry Pi are connected to the same Wi-Fi network.</li>
              <li>The device identifier is correct.</li>
            </ul>
          </div>

          {result?.reason === 'helper-unavailable' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>
              Local network discovery helper service is currently unreachable.
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
            <span>Debug log ({result.method || result.reason}{result.durationMs ? `, ${result.durationMs}ms` : ''})</span>
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
