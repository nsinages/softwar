// =============================================
// N Signage — Settings Page
// =============================================
import React, { useState } from 'react';
import {
  Globe,
  UploadCloud,
  Info,
  Trash2,
  Check,
  AlertTriangle,
  KeyRound,
} from 'lucide-react';
import { getSettings, saveSettings, clearAllDevices, SETTINGS_LIMITS } from '../data/store';

export default function Settings() {
  const [settings, setSettings] = useState(() => getSettings());
  const [saved, setSaved] = useState(false);
  const [resetSaved, setResetSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  function handleChange(key, value) {
    setSettings(s => ({ ...s, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    try {
      setSettings(saveSettings(settings));
      setSaveError('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err.message);
    }
  }

  function handleResetData() {
    if (
      window.confirm(
        'Remove ALL devices from this dashboard? Files on the Raspberry Pis are not affected. This cannot be undone.'
      )
    ) {
      clearAllDevices();
      setResetSaved(true);
      setTimeout(() => {
        setResetSaved(false);
        window.location.reload();
      }, 1200);
    }
  }

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Configure network parameters, polling intervals, and application preferences</p>
        </div>
      </div>

      <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {/* Network Settings */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Globe size={18} style={{ color: 'var(--accent)' }} />
              <span>Network Configuration</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="form-group">
              <label className="form-label">Status Poll Interval (seconds)</label>
              <input
                type="number"
                className="form-input"
                value={settings.pollInterval}
                min={SETTINGS_LIMITS.pollInterval.min}
                max={SETTINGS_LIMITS.pollInterval.max}
                onChange={e => handleChange('pollInterval', e.target.value)}
              />
              <span className="form-hint">
                How often the dashboard checks each Raspberry Pi's online status, 5–300 s (Recommended: 30s). Applies after reload.
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">Raspberry Pi Flask API Port</label>
              <input
                type="number"
                className="form-input"
                style={{ fontFamily: 'var(--font-mono)' }}
                value={settings.apiPort}
                min={SETTINGS_LIMITS.apiPort.min}
                max={SETTINGS_LIMITS.apiPort.max}
                onChange={e => handleChange('apiPort', e.target.value)}
              />
              <span className="form-hint">
                Default REST API service port running on digital signage units (Default: 5000)
              </span>
            </div>
          </div>
        </div>

        {/* Upload Preferences */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <UploadCloud size={18} style={{ color: 'var(--accent)' }} />
              <span>Upload Preferences</span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Large File Warning Threshold (MB)</label>
            <input
              type="number"
              className="form-input"
              value={settings.uploadSizeWarning}
              min={SETTINGS_LIMITS.uploadSizeWarning.min}
              max={SETTINGS_LIMITS.uploadSizeWarning.max}
              onChange={e => handleChange('uploadSizeWarning', e.target.value)}
            />
            <span className="form-hint">
              Warn user prior to transferring files exceeding this size limit
            </span>
          </div>
        </div>

        {/* Security */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <KeyRound size={18} style={{ color: 'var(--accent)' }} />
              <span>Security</span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Pi API Key</label>
            <input
              type="password"
              className="form-input"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={settings.apiKey}
              autoComplete="off"
              maxLength={256}
              placeholder="Leave empty if the Pis have no key configured"
              onChange={e => handleChange('apiKey', e.target.value)}
            />
            <span className="form-hint">
              Must match NSIGNAGE_API_KEY on each Raspberry Pi. Required to upload or delete media when a key is set on the Pi. Stored only in this browser.
            </span>
          </div>
        </div>

        {/* System & Architecture Info */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Info size={18} style={{ color: 'var(--accent)' }} />
              <span>System Information</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {[
              ['Platform', 'N-Signage Digital Signage System'],
              ['Version', '2.4.0 (V3 Discovery Enabled)'],
              ['Architecture', 'Decentralized Edge Nodes + Central Management Console'],
              ['Communication Protocol', 'Direct REST API over LAN / Wi-Fi'],
              ['Device Storage', 'Client-side LocalStorage + Raspberry Pi FS'],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 'var(--text-xs)',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)' }}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Reset Database Section */}
        <div className="card" style={{ borderColor: 'rgba(239, 68, 68, 0.25)' }}>
          <div className="card-header">
            <div className="card-title" style={{ color: 'var(--danger)' }}>
              <AlertTriangle size={18} />
              <span>Remove All Devices</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Remove every registered device from this dashboard (stored in this browser). The Raspberry Pis and their media files are not affected.
            </p>
            <div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleResetData}
              >
                <Trash2 size={13} /> Remove All Devices
              </button>
            </div>
            {resetSaved && (
              <span className="badge badge-success" style={{ alignSelf: 'flex-start' }}>
                <Check size={12} /> All devices removed. Reloading…
              </span>
            )}
          </div>
        </div>

        {/* Save Settings Action Bar */}
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
          <button type="button" className="btn btn-primary btn-lg" onClick={handleSave}>
            <Check size={16} /> Save Settings
          </button>
          {saveError && (
            <span className="badge badge-danger" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }}>
              {saveError}
            </span>
          )}
          {saved && (
            <span className="badge badge-success" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }}>
              <Check size={13} /> Settings Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
