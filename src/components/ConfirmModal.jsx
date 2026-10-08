// =============================================
// N Signage — ConfirmModal Component
// =============================================
import React from 'react';
import { X, AlertTriangle, Loader2 } from 'lucide-react';

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

  const handleOverlayClick = e => {
    if (e.target === e.currentTarget && !isLoading) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <div className="modal-title">
            <AlertTriangle
              size={18}
              style={{
                color: variant === 'danger' ? 'var(--danger)' : 'var(--warning)',
              }}
            />
            <span>{title}</span>
          </div>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.6,
          }}
        >
          {message}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn-${variant}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading && (
              <Loader2
                size={14}
                className="spinner"
                style={{ border: 'none', animation: 'spin 0.8s linear infinite' }}
              />
            )}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
