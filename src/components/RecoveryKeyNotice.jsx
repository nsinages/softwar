// =============================================
// N Signage — One-time display of a new recovery key
// The key replaces email password reset. It is shown only here, once.
// =============================================
import React, { useState } from 'react';
import { KeyRound, Copy, Check, Download } from 'lucide-react';

export default function RecoveryKeyNotice({ recoveryKey, username, onDone, doneLabel = 'I have saved it — continue' }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the key is still visible to write down */ }
  }

  function download() {
    const text = `N-Signage account recovery key\n\nUsername: ${username}\nRecovery key: ${recoveryKey}\n\nUse it on the login page ("Forgot password?") to set a new password.\nKeep it private. It can be used once; a new key is shown after each use.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `n-signage-recovery-${username}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <KeyRound size={20} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
        <div>
          <div style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>Save your recovery key</div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 4 }}>
            If you forget your password, this key lets you set a new one. N-Signage does not use email, so
            this key is the only way to recover your account yourself. It is shown <strong>only now</strong>.
          </p>
        </div>
      </div>

      <div className="recovery-key" aria-label="Recovery key">{recoveryKey}</div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>
          <Download size={13} /> Download as file
        </button>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
          style={{ width: 15, height: 15, accentColor: 'var(--accent)', marginTop: 1 }} />
        I have written down or saved my recovery key somewhere safe.
      </label>

      <button type="button" className="btn btn-primary" disabled={!confirmed} onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}
