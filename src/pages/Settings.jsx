// =============================================
// N Signage V2 — Settings Page
// =============================================
import React, { useState } from 'react';
import { getSettings, saveSettings, resetDevicesToDefault } from '../data/store';

export default function Settings() {
  const [settings, setSettings] = useState(() => getSettings());
  const [saved, setSaved] = useState(false);
  const [resetSaved, setResetSaved] = useState(false);

  function handleChange(key, value) {
    setSettings(s => ({ ...s, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function handleResetData() {
    if (window.confirm('Are you sure you want to reset all devices to default seed data? This will overwrite your current configuration.')) {
      resetDevicesToDefault();
      setResetSaved(true);
      setTimeout(() => {
        setResetSaved(false);
        window.location.reload();
      }, 1500);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Configure dashboard behavior and preferences</p>
        </div>
      </div>

      <div style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>

        {/* Network */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">🌐 Network</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="form-group">
              <label className="form-label">Status Poll Interval (seconds)</label>
              <input
                type="number"
                className="form-input"
                value={settings.pollInterval}
                min={5}
                max={300}
                onChange={e => handleChange('pollInterval', parseInt(e.target.value) || 30)}
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                How often the dashboard checks each Pi's status. Minimum: 5s. Recommended: 30s.
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">Raspberry Pi API Port</label>
              <input
                type="number"
                className="form-input"
                style={{ fontFamily: 'var(--font-mono)' }}
                value={settings.apiPort}
                min={1}
                max={65535}
                onChange={e => handleChange('apiPort', parseInt(e.target.value) || 5000)}
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Flask API port on all Raspberry Pi devices. Default: 5000.
              </span>
            </div>
          </div>
        </div>

        {/* Upload */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">⬆️ Upload</h2>
          </div>
          <div className="form-group">
            <label className="form-label">Large File Warning Threshold (MB)</label>
            <input
              type="number"
              className="form-input"
              value={settings.uploadSizeWarning}
              min={10}
              max={5000}
              onChange={e => handleChange('uploadSizeWarning', parseInt(e.target.value) || 500)}
            />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Show a warning when uploading files larger than this size.
            </span>
          </div>
        </div>

        {/* Appearance */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">🎨 Appearance</h2>
          </div>
          <div className="form-group">
            <label className="form-label">Theme</label>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              {['dark', 'light'].map(t => (
                <button
                  key={t}
                  className={`btn ${settings.theme === t ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    handleChange('theme', t);
                    document.documentElement.setAttribute('data-theme', t);
                  }}
                >
                  {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* App Info */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">ℹ️ About</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {[
              ['Application', 'N Signage V2'],
              ['Version', '1.0.0'],
              ['Architecture', 'Central Dashboard + Raspberry Pi Fleet'],
              ['Protocol', 'REST API over LAN'],
              ['Storage', 'localStorage (device config) + Pi (media)'],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{label}</span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)' }}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Reset Database */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">🔄 Reset Data</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Restore device configurations to default seed test data (10 classroom devices). This will overwrite any manual changes you have made.
            </p>
            <button
              className="btn btn-danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={handleResetData}
            >
              Reset to 10 Default Devices
            </button>
            {resetSaved && (
              <span className="badge badge-success" style={{ alignSelf: 'flex-start', marginTop: 'var(--space-2)' }}>
                ✓ Database reset successfully! Reloading…
              </span>
            )}
          </div>
        </div>

        {/* Save */}
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <button className="btn btn-primary btn-lg" onClick={handleSave}>
            ✓ Save Settings
          </button>
          {saved && (
            <span className="badge badge-success" style={{ fontSize: 'var(--text-sm)', padding: '4px 12px' }}>
              ✓ Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
