// =============================================
// N Signage — Account settings (hosted website): password, sessions, recovery key
// =============================================
import React, { useState } from 'react';
import { UserRound, Check, AlertTriangle, Loader2, LogOut, KeyRound } from 'lucide-react';
import { changePassword, logoutOthers, regenerateRecoveryKey, PASSWORD_MIN } from '../api/authApi';
import RecoveryKeyNotice from './RecoveryKeyNotice';

function Msg({ msg }) {
  if (!msg) return null;
  return (
    <div className={`alert ${msg.ok ? 'alert-success' : 'alert-danger'}`} role="status" style={{ fontSize: 'var(--text-xs)' }}>
      {msg.ok ? <Check size={14} className="alert-icon" /> : <AlertTriangle size={14} className="alert-icon" />}
      <span>{msg.text}</span>
    </div>
  );
}

export default function AccountSettings({ user }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);
  const [sessBusy, setSessBusy] = useState(false);
  const [sessMsg, setSessMsg] = useState(null);
  const [keyPassword, setKeyPassword] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState(null);
  const [newKey, setNewKey] = useState('');

  async function submitPassword(e) {
    e.preventDefault();
    setPwMsg(null);
    if (next.length < PASSWORD_MIN) { setPwMsg({ ok: false, text: `The new password must be at least ${PASSWORD_MIN} characters.` }); return; }
    if (next !== repeat) { setPwMsg({ ok: false, text: 'The two new passwords do not match.' }); return; }
    setPwBusy(true);
    const r = await changePassword(current, next);
    setPwBusy(false);
    if (!r.ok) { setPwMsg({ ok: false, text: r.error }); return; }
    setCurrent(''); setNext(''); setRepeat('');
    setPwMsg({ ok: true, text: `Password changed.${r.revokedSessions ? ` ${r.revokedSessions} other session(s) were signed out.` : ''}` });
  }

  async function signOutOthers() {
    setSessBusy(true);
    setSessMsg(null);
    const r = await logoutOthers();
    setSessBusy(false);
    setSessMsg(r.ok ? { ok: true, text: `${r.revokedSessions} other session(s) signed out.` } : { ok: false, text: r.error });
  }

  async function submitKey(e) {
    e.preventDefault();
    setKeyMsg(null);
    setKeyBusy(true);
    const r = await regenerateRecoveryKey(keyPassword);
    setKeyBusy(false);
    setKeyPassword('');
    if (!r.ok) { setKeyMsg({ ok: false, text: r.error }); return; }
    setNewKey(r.recoveryKey);
  }

  const created = user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—';
  const keyDate = user?.recoveryKeyCreatedAt ? new Date(user.recoveryKeyCreatedAt).toLocaleDateString() : null;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <UserRound size={18} style={{ color: 'var(--accent)' }} />
          <span>Account</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <div className="found-pi-details" style={{ fontSize: 'var(--text-sm)' }}>
          <span>Username</span><span style={{ fontWeight: 'var(--weight-semibold)' }}>{user?.username}</span>
          {user?.displayName && (<><span>Name</span><span>{user.displayName}</span></>)}
          <span>Member since</span><span>{created}</span>
        </div>

        <form onSubmit={submitPassword} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div className="section-label" style={{ margin: 0 }}>Change password</div>
          <input type="text" autoComplete="username" value={user?.username || ''} readOnly hidden />
          <input className="form-input" type="password" placeholder="Current password" autoComplete="current-password"
            value={current} maxLength={128} onChange={(e) => setCurrent(e.target.value)} aria-label="Current password" />
          <input className="form-input" type="password" placeholder={`New password (at least ${PASSWORD_MIN} characters)`} autoComplete="new-password"
            value={next} maxLength={128} onChange={(e) => setNext(e.target.value)} aria-label="New password" />
          <input className="form-input" type="password" placeholder="Repeat new password" autoComplete="new-password"
            value={repeat} maxLength={128} onChange={(e) => setRepeat(e.target.value)} aria-label="Repeat new password" />
          <span className="form-hint">Changing your password signs you out on every other phone and computer.</span>
          <Msg msg={pwMsg} />
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={pwBusy || !current || !next}>
              {pwBusy && <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />} Change password
            </button>
          </div>
        </form>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div className="section-label" style={{ margin: 0 }}>Sessions</div>
          <span className="form-hint">Lost a phone, or logged in on a shared computer? Sign out everywhere except here.</span>
          <Msg msg={sessMsg} />
          <div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={signOutOthers} disabled={sessBusy}>
              {sessBusy ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <LogOut size={13} />} Sign out other sessions
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div className="section-label" style={{ margin: 0 }}>Recovery key</div>
          {newKey ? (
            <RecoveryKeyNotice recoveryKey={newKey} username={user?.username} doneLabel="Done" onDone={() => setNewKey('')} />
          ) : (
            <form onSubmit={submitKey} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <span className="form-hint">
                The recovery key resets your password if you forget it{keyDate ? ` (current key created ${keyDate})` : ''}.
                Lost it? Create a new one. The old key stops working.
              </span>
              <input type="text" autoComplete="username" value={user?.username || ''} readOnly hidden />
              <input className="form-input" type="password" placeholder="Your password" autoComplete="current-password"
                value={keyPassword} maxLength={128} onChange={(e) => setKeyPassword(e.target.value)} aria-label="Password to confirm" />
              <Msg msg={keyMsg} />
              <div>
                <button type="submit" className="btn btn-secondary btn-sm" disabled={keyBusy || !keyPassword}>
                  {keyBusy ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <KeyRound size={13} />} Create new recovery key
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
