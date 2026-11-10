// Formatting helpers for upload/transfer status (shared by upload components)

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function formatEta(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `${Math.ceil(s)} s left`;
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}

const ACTIVE = ['pending', 'checking', 'hashing', 'uploading', 'confirming'];

/** status: pending | checking | hashing | uploading | confirming | waiting | success | failed | cancelled */
export function statusLabel(state) {
  switch (state.status) {
    case 'pending': return { text: 'Queued', color: 'var(--text-muted)' };
    case 'checking': return { text: 'Checking the display’s upload service…', color: 'var(--accent)' };
    case 'hashing': return { text: `Preparing (checksum) ${state.progress || 0}%`, color: 'var(--accent)' };
    case 'uploading': return { text: `${state.relay ? 'Sending to display (encrypted)' : 'Uploading'} ${state.progress || 0}%`, color: 'var(--accent)' };
    case 'confirming': return { text: 'Display is checking the file…', color: 'var(--accent)' };
    case 'waiting': return { text: 'Waiting for the display', color: 'var(--warning)' };
    case 'success': return { text: '✓ Upload completed successfully', color: 'var(--success)' };
    case 'cancelled': return { text: 'Cancelled', color: 'var(--text-muted)' };
    default: return { text: 'Failed', color: 'var(--danger)' };
  }
}

export const isActive = (state) => ACTIVE.includes(state?.status);

