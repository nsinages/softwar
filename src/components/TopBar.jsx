// =============================================
// N Signage V2 — TopBar Component
// =============================================
import React from 'react';

export default function TopBar({ networkOnline, onlineCount, totalCount, onThemeToggle, theme }) {
  const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  return (
    <header
      style={{
        height: 'var(--topbar-height)',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--space-6)',
        gap: 'var(--space-4)',
        position: 'sticky',
        top: 0,
        zIndex: 'var(--z-topbar)',
        flexShrink: 0,
      }}
    >
      {/* Title */}
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>
          N Signage V2
        </span>
        <span style={{ marginLeft: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          College Digital Signage Management
        </span>
      </div>

      {/* Network status */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-full)',
          padding: '4px 12px',
          fontSize: 'var(--text-xs)',
          fontWeight: 'var(--weight-medium)',
        }}
      >
        <span
          className={`dot ${totalCount === 0 ? 'dot-offline' : onlineCount > 0 ? 'dot-online' : 'dot-offline'}`}
        />
        <span style={{ color: 'var(--text-secondary)' }}>
          {onlineCount}/{totalCount} Online
        </span>
      </div>

      {/* Theme toggle */}
      <button
        onClick={onThemeToggle}
        className="btn btn-ghost btn-icon"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        style={{ fontSize: 16 }}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      {/* Admin profile */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: '4px var(--space-3)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-full)',
          fontSize: 'var(--text-sm)',
          cursor: 'default',
        }}
      >
        <span style={{ fontSize: 18 }}>👤</span>
        <span style={{ color: 'var(--text-secondary)', fontWeight: 'var(--weight-medium)' }}>Admin</span>
      </div>
    </header>
  );
}
