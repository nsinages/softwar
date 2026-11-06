// =============================================
// N Signage — StatusBadge Component
// Accessible, professional status indicator
// =============================================
import React from 'react';

/**
 * @param {'online'|'offline'|'checking'|'unknown'} status
 * @param {boolean} [showLabel]
 * @param {string} [className]
 */
export default function StatusBadge({ status = 'unknown', showLabel = true, className = '' }) {
  const cfg = {
    online: {
      dot: 'dot dot-online',
      cls: 'badge badge-success',
      label: 'Online',
    },
    offline: {
      dot: 'dot dot-offline',
      cls: 'badge badge-danger',
      label: 'Offline',
    },
    checking: {
      dot: 'dot dot-checking',
      cls: 'badge badge-warning',
      label: 'Checking…',
    },
    unknown: {
      dot: 'dot',
      cls: 'badge badge-neutral',
      label: 'Unknown',
    },
    // a device record the customer saved (name + IP) that no Pi has confirmed yet
    saved: {
      dot: 'dot',
      cls: 'badge badge-warning',
      label: 'Saved · not connected',
    },
  }[status] ?? {
    dot: 'dot',
    cls: 'badge badge-neutral',
    label: 'Unknown',
  };

  return (
    <span className={`${cfg.cls} ${className}`} title={`Status: ${cfg.label}`}>
      <span className={cfg.dot} aria-hidden="true" />
      {showLabel && <span>{cfg.label}</span>}
    </span>
  );
}
