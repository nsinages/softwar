// =============================================
// N Signage — Sidebar Navigation Component
// =============================================
import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Cpu,
  Film,
  UploadCloud,
  Settings,
  ChevronLeft,
  ChevronRight,
  X,
  LogOut,
} from 'lucide-react';
import logo from '../assets/logo.png';
import logoIcon from '../assets/logo-icon.png';

const MAIN_NAV = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices', icon: Cpu, label: 'Devices' },
  { to: '/media', icon: Film, label: 'Media' },
  { to: '/upload', icon: UploadCloud, label: 'Upload' },
];

const BOTTOM_NAV = [
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose, account, onLogout }) {
  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={`mobile-backdrop ${mobileOpen ? 'open' : ''}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />

      <aside
        className={`sidebar ${mobileOpen ? 'mobile-open' : ''} ${collapsed ? 'collapsed' : ''}`}
      >
        {/* Brand Header */}
        <div className="sidebar-brand">
          {/* Full logo when expanded, square logo when collapsed */}
          <img src={logo} alt="N-Sinages — Digital Sinage Solution" className="brand-logo-img" />
          <img src={logoIcon} alt="N-Sinages" className="brand-logo-icon" />

          {/* Close button visible only on mobile drawer */}
          <button
            onClick={onMobileClose}
            className="btn btn-ghost btn-icon btn-sm sidebar-mobile-close"
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        {/* Main Nav Items */}
        <nav className="sidebar-nav">
          <div className="sidebar-section-title">Menu</div>

          {MAIN_NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onMobileClose}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              title={label}
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={18}
                    strokeWidth={isActive ? 2.2 : 1.75}
                    className="sidebar-icon"
                  />
                  <span className="sidebar-label">{label}</span>
                </>
              )}
            </NavLink>
          ))}

          <div className="sidebar-divider" />

          <div className="sidebar-section-title">System</div>

          {BOTTOM_NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onMobileClose}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              title={label}
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={18}
                    strokeWidth={isActive ? 2.2 : 1.75}
                    className="sidebar-icon"
                  />
                  <span className="sidebar-label">{label}</span>
                </>
              )}
            </NavLink>
          ))}

          {onLogout && (
            <button
              type="button"
              onClick={() => { onMobileClose?.(); onLogout(); }}
              className="sidebar-link"
              title={account?.email ? `Log out (${account.email})` : 'Log out'}
              style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
            >
              <LogOut size={18} strokeWidth={1.75} className="sidebar-icon" />
              <span className="sidebar-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Log out{account?.email ? ` · ${account.email}` : ''}
              </span>
            </button>
          )}
        </nav>

        {/* Sidebar Footer / Collapse toggle (desktop only) */}
        <div className="sidebar-footer">
          <button
            onClick={onToggle}
            className="btn btn-ghost sidebar-collapse-btn"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            <span className="sidebar-collapse-label">Collapse</span>
          </button>
        </div>
      </aside>
    </>
  );
}
