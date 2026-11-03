// =============================================
// N Signage — TopBar Header Component
// =============================================
import React from 'react';
import { useLocation } from 'react-router-dom';
import { User, Menu } from 'lucide-react';

const PAGE_TITLES = {
  '/': { title: 'Dashboard', subtitle: 'Overview of all digital signage devices' },
  '/devices': { title: 'Devices', subtitle: 'Manage and monitor your Raspberry Pi signage devices' },
  '/media': { title: 'Media Library', subtitle: 'Browse and manage files on Raspberry Pi storage' },
  '/upload': { title: 'Upload Media', subtitle: 'Deploy images and videos directly to signage displays' },
  '/settings': { title: 'Settings', subtitle: 'System preferences and network configuration' },
};

export default function TopBar({
  onlineCount = 0,
  totalCount = 0,
  onMobileMenuToggle,
}) {
  const location = useLocation();
  const pageInfo = PAGE_TITLES[location.pathname] || {
    title: 'N-Signage',
    subtitle: 'Digital Signage Management Platform',
  };

  const isAllOnline = totalCount > 0 && onlineCount === totalCount;
  const isPartiallyOnline = onlineCount > 0 && onlineCount < totalCount;

  return (
    <header className="topbar">
      {/* Left: Hamburger button (phone/tablet) + Page Title */}
      <div className="topbar-left">
        <button
          onClick={onMobileMenuToggle}
          className="btn btn-ghost btn-icon mobile-menu-btn"
          aria-label="Toggle navigation menu"
        >
          <Menu size={20} />
        </button>

        <div className="topbar-title-wrap">
          <div className="topbar-title">{pageInfo.title}</div>
          <div className="topbar-subtitle">{pageInfo.subtitle}</div>
        </div>
      </div>

      {/* Right: Fleet Health & Profile */}
      <div className="topbar-right">
        {/* Live Network Status Chip */}
        <div
          className="topbar-network-pill"
          title={`${onlineCount} of ${totalCount} devices online`}
        >
          <span
            className={`dot ${
              totalCount === 0
                ? 'dot-offline'
                : isAllOnline || isPartiallyOnline
                ? 'dot-online'
                : 'dot-offline'
            }`}
          />
          <span className="network-pill-text">
            <strong>{onlineCount}</strong>
            <span className="network-pill-total">/{totalCount}</span> Online
          </span>
        </div>

        {/* User Badge */}
        <div className="topbar-user-badge">
          <User size={13} className="user-badge-icon" />
          <span className="user-badge-label">Admin</span>
        </div>
      </div>
    </header>
  );
}
