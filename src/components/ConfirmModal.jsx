// =============================================
// N Signage V2 — ConfirmModal Component
// =============================================
import React from 'react';

/**
 * @param {boolean} isOpen
 * @param {function} onClose
 * @param {function} onConfirm
 * @param {string} title
 * @param {string|React.ReactNode} message
 * @param {string} [confirmLabel]
 * @param {boolean} [isLoading]
 */
export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = 'Confirm Action',
  message,
  confirmLabel = 'Confirm',
  isLoading = false,
  variant = 'danger',
}) {
  if (!isOpen) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h2 className="modal-title" style={{ fontSize: 'var(--text-lg)' }}>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} disabled={isLoading}>
            ✕
          </button>
        </div>

        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>
          {message}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button
            className={`btn btn-${variant}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading && <span className="spinner spinner-sm" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
