// =============================================
// N Signage — Log in / Create account / Forgot password (hosted website only)
// Username + password. No email is used anywhere.
// =============================================
import React, { useState } from 'react';
import { LogIn, UserPlus, KeyRound, Loader2, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { login, register, recoverAccount, PASSWORD_MIN, USERNAME_RX } from '../api/authApi';
import RecoveryKeyNotice from '../components/RecoveryKeyNotice';
import logo from '../assets/logo.png';

const TITLES = {
  login: ['Log in', 'Manage your N-Signage displays from any phone or computer.'],
  register: ['Create your account', 'Your displays are saved to this account and available wherever you log in.'],
  recover: ['Reset your password', 'Enter your username and the recovery key you saved when you created the account.'],
};

export default function Login({ onLoggedIn, notice }) {
  const [mode, setMode] = useState('login'); // login | register | recover
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState(null); // { key, user } shown once after register / recover

  function switchMode(m) {
    setMode(m);
    setError('');
    setPassword('');
    setConfirm('');
  }

  function validate() {
    const u = username.trim().toLowerCase();
    if (mode !== 'login' && !USERNAME_RX.test(u)) {
      return 'Username: 3–32 characters, letters, numbers, ".", "_" or "-", starting and ending with a letter or number.';
    }
    if (mode !== 'login') {
      if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
      if (password !== confirm) return 'The two passwords do not match.';
    }
    if (mode === 'recover' && recoveryKey.replace(/[\s-]/g, '').length !== 20) return 'The recovery key has 20 letters and numbers.';
    return '';
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const v = validate();
    if (v) { setError(v); return; }
    setError('');
    setBusy(true);
    const u = username.trim();
    const res = mode === 'login'
      ? await login(u, password)
      : mode === 'register'
        ? await register(u, password, displayName.trim())
        : await recoverAccount(u, recoveryKey, password);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setPassword('');
    setConfirm('');
    if (res.recoveryKey) setNewKey({ key: res.recoveryKey, user: res.user });
    else onLoggedIn(res.user);
  }

  if (newKey) {
    return (
      <div className="auth-screen">
        <div className="card auth-card">
          <img src={logo} alt="N-Sinages" className="auth-logo" />
          {mode === 'recover' && (
            <div className="alert alert-success" style={{ fontSize: 'var(--text-xs)' }}>
              Your password was changed and all other sessions were signed out. Your old recovery key no longer works.
            </div>
          )}
          <RecoveryKeyNotice recoveryKey={newKey.key} username={newKey.user.username} onDone={() => onLoggedIn(newKey.user)} />
        </div>
      </div>
    );
  }

  const [title, subtitle] = TITLES[mode];
  const pwType = showPassword ? 'text' : 'password';
  return (
    <div className="auth-screen">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <img src={logo} alt="N-Sinages" className="auth-logo" />
        <div>
          <h1 className="auth-title">{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>
        </div>

        {notice && mode === 'login' && !error && (
          <div className="alert alert-info" role="status" style={{ fontSize: 'var(--text-xs)' }}>{notice}</div>
        )}

        <div className="form-group">
          <label className="form-label" htmlFor="auth-username">Username</label>
          <input id="auth-username" className="form-input" required value={username} maxLength={32}
            autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={(e) => setUsername(e.target.value)} />
          {mode === 'register' && <span className="form-hint">3–32 characters: letters, numbers, ".", "_" or "-".</span>}
        </div>

        {mode === 'register' && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-name">Business or display name (optional)</label>
            <input id="auth-name" className="form-input" value={displayName} maxLength={80}
              autoComplete="organization" onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        )}

        {mode === 'recover' && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-recovery">Recovery key</label>
            <input id="auth-recovery" className="form-input" required value={recoveryKey} maxLength={40}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)' }} onChange={(e) => setRecoveryKey(e.target.value)} />
            <span className="form-hint">Lost your recovery key too? Contact N-Signage support. We will verify that you own the account and issue a new key.</span>
          </div>
        )}

        <div className="form-group">
          <label className="form-label" htmlFor="auth-password">{mode === 'recover' ? 'New password' : 'Password'}</label>
          <div style={{ position: 'relative' }}>
            <input id="auth-password" className="form-input" type={pwType} required value={password}
              maxLength={128} style={{ paddingRight: 40 }}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}>
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {mode !== 'login' && <span className="form-hint">At least {PASSWORD_MIN} characters. A short sentence is easy to remember and hard to guess.</span>}
        </div>

        {mode !== 'login' && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-confirm">Repeat password</label>
            <input id="auth-confirm" className="form-input" type={pwType} required value={confirm} maxLength={128}
              autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
          </div>
        )}

        {error && (
          <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
            <AlertTriangle size={14} className="alert-icon" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-lg" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
            : mode === 'login' ? <LogIn size={15} /> : mode === 'register' ? <UserPlus size={15} /> : <KeyRound size={15} />}
          {mode === 'login' ? 'Log in' : mode === 'register' ? 'Create account' : 'Set new password'}
        </button>

        <div className="auth-links">
          {mode === 'login' ? (
            <>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => switchMode('register')}>New customer? Create an account</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => switchMode('recover')}>Forgot password?</button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => switchMode('login')}>Back to log in</button>
          )}
        </div>
      </form>
    </div>
  );
}
