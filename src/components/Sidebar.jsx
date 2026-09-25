// =============================================
// N Signage V2 — Sidebar Component
// =============================================
import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/',           icon: '⊞',   label: 'Dashboard' },
  { to: '/devices',    icon: '📡',  label: 'Devices' },
  { to: '/classrooms', icon: '🏫',  label: 'Classrooms' },
  { to: '/media',      icon: '🎞️', label: 'Media' },
  { to: '/upload',     icon: '⬆️', label: 'Upload' },
  { to: '/settings',   icon: '⚙️', label: 'Settings' },
];

export default function Sidebar({ collapsed, onToggle }) {
  const location = useLocation();

  return (
    <aside
      className="sidebar"
      style={{
        width: collapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-width)',
        transition: 'width var(--transition-slow)',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        zIndex: 'var(--z-sidebar)',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Logo */}
      <div
        style={{
          height: 'var(--topbar-height)',
          display: 'flex',
          alignItems: 'center',
          padding: collapsed ? '0 var(--space-4)' : '0 var(--space-5)',
          borderBottom: '1px solid var(--border)',
          gap: 'var(--space-3)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 32, height: 32,
            borderRadius: 'var(--radius-md)',
            background: 'linear-gradient(135deg, var(--accent) 0%, #60a5fa 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: 700, color: '#fff',
            flexShrink: 0,
          }}
        >
          N
        </div>
        {!collapsed && (
          <div style={{ overflow: 'hidden' }}>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
              N Signage
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              V2
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: 'var(--space-3) var(--space-2)', overflowY: 'auto' }}>
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV_ITEMS.map(({ to, icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: collapsed ? 'var(--space-3)' : 'var(--space-3) var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-subtle)' : 'transparent',
                  fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-normal)',
                  fontSize: 'var(--text-sm)',
                  transition: 'all var(--transition-fast)',
                  textDecoration: 'none',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  position: 'relative',
                })}
              >
                <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
                {!collapsed && <span>{label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Collapse toggle */}
      <div
        style={{
          padding: 'var(--space-3)',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onToggle}
          className="btn btn-ghost"
          style={{
            width: '100%',
            justifyContent: collapsed ? 'center' : 'flex-start',
            fontSize: 'var(--text-sm)',
            gap: 'var(--space-2)',
          }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span style={{ fontSize: 16 }}>{collapsed ? '→' : '←'}</span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
