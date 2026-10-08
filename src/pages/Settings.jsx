// =============================================
// N Signage — Settings Page
// =============================================
import React, { useState } from 'react';
import {
  Settings as SettingsIcon,
  Globe,
  UploadCloud,
  Palette,
  Info,
  RotateCw,
  Check,
  Sun,
  Moon,
  AlertTriangle,
  Server,
  Shield,
} from 'lucide-react';
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
    if (
      window.confirm(
        'Are you sure you want to reset all devices to default seed data? This will overwrite your current configuration.'
      )
    ) {
      resetDevicesToDefault();
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
                min={5}
                max={300}
                onChange={e => handleChange('pollInterval', parseInt(e.target.value) || 30)}
              />
              <span className="form-hint">
                How often the dashboard checks each Raspberry Pi's online status (Recommended: 30s)
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">Raspberry Pi Flask API Port</label>
              <input
                type="number"
                className="form-input"
                style={{ fontFamily: 'var(--font-mono)' }}
                value={settings.apiPort}
                min={1}
                max={65535}
                onChange={e => handleChange('apiPort', parseInt(e.target.value) || 5000)}
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
              min={10}
              max={5000}
              onChange={e => handleChange('uploadSizeWarning', parseInt(e.target.value) || 500)}
            />
            <span className="form-hint">
              Warn user prior to transferring files exceeding this size limit
            </span>
          </div>
        </div>

        {/* Appearance */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Palette size={18} style={{ color: 'var(--accent)' }} />
              <span>Theme &amp; Appearance</span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Interface Theme</label>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              {[
                { id: 'light', label: 'Light Mode', icon: Sun },
                { id: 'dark', label: 'Dark Mode', icon: Moon },
              ].map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`btn ${settings.theme === id ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    handleChange('theme', id);
                    document.documentElement.setAttribute('data-theme', id);
                  }}
                  style={{ flex: 1 }}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
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
              <span>Reset Configuration</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Reset stored device data back to initial seed default state. Use this if you need a fresh start or want to re-initialize classroom displays.
            </p>
            <div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleResetData}
              >
                <RotateCw size={13} /> Reset Device Store
              </button>
            </div>
            {resetSaved && (
              <span className="badge badge-success" style={{ alignSelf: 'flex-start' }}>
                <Check size={12} /> Database reset successfully. Reloading…
              </span>
            )}
          </div>
        </div>

        {/* Save Settings Action Bar */}
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
          <button type="button" className="btn btn-primary btn-lg" onClick={handleSave}>
            <Check size={16} /> Save Settings
          </button>
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
