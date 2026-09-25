// =============================================
// N Signage V2 — StatusBadge Component
// =============================================
import React from 'react';

/**
 * @param {'online'|'offline'|'checking'|'unknown'} status
 * @param {boolean} [showLabel]
 * @param {string} [className]
 */
export default function StatusBadge({ status, showLabel = true, className = '' }) {
  const cfg = {
    online:   { dot: 'dot dot-online',   cls: 'badge badge-success', label: 'Online' },
    offline:  { dot: 'dot dot-offline',  cls: 'badge badge-danger',  label: 'Offline' },
    checking: { dot: 'dot dot-checking', cls: 'badge badge-warning', label: 'Checking…' },
    unknown:  { dot: 'dot',              cls: 'badge badge-neutral',  label: 'Unknown' },
  }[status] ?? { dot: 'dot', cls: 'badge badge-neutral', label: 'Unknown' };

  return (
    <span className={`${cfg.cls} ${className}`}>
      <span className={cfg.dot} />
      {showLabel && cfg.label}
    </span>
  );
}
