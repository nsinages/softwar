// =============================================
// N Signage — Customer authentication pages (hosted website)
//   /login     Log in with username + password
//   /register  Create an account (no email)
//   /recover   Reset the password with the recovery key
// =============================================
import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn, UserPlus, KeyRound, Loader2, AlertTriangle, Eye, EyeOff, CheckCircle2, Info } from 'lucide-react';
import { login, register, recoverAccount, PASSWORD_MIN, USERNAME_RX } from '../api/authApi';
import { useAuth } from '../auth/AuthContext';
import RecoveryKeyNotice from '../components/RecoveryKeyNotice';
import PublicHeader from '../components/PublicHeader';

const TITLES = {
  login: ['Log in', 'Manage your N-Signage displays from any phone or computer.'],
  register: ['Create your account', 'Choose a username and password. No email address is needed.'],
  recover: ['Reset your password', 'Enter your username and the recovery key you saved when you created the account.'],
};

/** Only allow returning to pages of this site. */
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

export default function AuthPage({ mode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState(null); // { key, user } shown once after register / recover

  const notice = params.get('expired') ? 'Your session ended. Please log in again.' : auth?.notice;

  function validate() {
    const u = username.trim().toLowerCase();
    if (!u) return 'Enter your username.';
    if (mode !== 'login' && !USERNAME_RX.test(u)) {
      return 'Username: 3–32 characters, letters, numbers, ".", "_" or "-", starting and ending with a letter or number.';
    }
    if (!password) return 'Enter your password.';
    if (mode !== 'login') {
      if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
      if (password !== confirm) return 'The two passwords do not match.';
    }
    if (mode === 'recover' && recoveryKey.replace(/[\s-]/g, '').length !== 20) return 'The recovery key has 20 letters and numbers.';
    return '';
  }

  async function finish(user) {
    await auth.enter(user);
    navigate(next, { replace: true });
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
    else await finish(res.user);
  }

  if (newKey) {
    return (
      <div className="public-page">
        <PublicHeader />
        <main className="auth-screen">
          <div className="card auth-card">
            {mode === 'register' && (
              <div className="alert alert-success" style={{ fontSize: 'var(--text-xs)' }}>
                <CheckCircle2 size={14} className="alert-icon" />
                <span>Your account <strong>{newKey.user.username}</strong> was created.</span>
              </div>
            )}
            {mode === 'recover' && (
              <div className="alert alert-success" style={{ fontSize: 'var(--text-xs)' }}>
                <CheckCircle2 size={14} className="alert-icon" />
                <span>Your password was changed and all other sessions were signed out. Your old recovery key no longer works.</span>
              </div>
            )}
            <RecoveryKeyNotice recoveryKey={newKey.key} username={newKey.user.username}
              doneLabel="I have saved it, go to my dashboard" onDone={() => finish(newKey.user)} />
          </div>
        </main>
      </div>
    );
  }

  const [title, subtitle] = TITLES[mode];
  const pwType = showPassword ? 'text' : 'password';
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="auth-screen">
        <form className="card auth-card" onSubmit={submit} noValidate aria-labelledby="auth-title">
          <div>
            <h1 className="auth-title" id="auth-title">{title}</h1>
            <p className="auth-subtitle">{subtitle}</p>
          </div>

          {notice && mode === 'login' && !error && (
            <div className="alert alert-info" role="status" style={{ fontSize: 'var(--text-xs)' }}>
              <Info size={14} className="alert-icon" /><span>{notice}</span>
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="auth-username">Username</label>
            <input id="auth-username" className="form-input" required value={username} maxLength={32}
              autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus
              onChange={(e) => setUsername(e.target.value)} />
            {mode === 'register' && <span className="form-hint">3–32 characters: letters, numbers, ".", "_" or "-". Not case-sensitive.</span>}
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
                aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
                style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {mode !== 'login' && (
              <ul className="pw-rules">
                <li className={password.length >= PASSWORD_MIN ? 'ok' : ''}>At least {PASSWORD_MIN} characters</li>
                <li className={password && !password.toLowerCase().includes(username.trim().toLowerCase() || '\u0000') ? 'ok' : ''}>Does not contain your username</li>
                <li>A short sentence is easy to remember and hard to guess</li>
              </ul>
            )}
          </div>

          {mode !== 'login' && (
            <div className="form-group">
              <label className="form-label" htmlFor="auth-confirm">Confirm password</label>
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
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : mode === 'register' ? 'Create account' : 'Set new password'}
          </button>

          <div className="auth-links">
            {mode === 'login' && (
              <>
                <Link className="btn btn-ghost btn-sm" to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`}>New customer? Create an account</Link>
                <Link className="btn btn-ghost btn-sm" to="/recover">Forgot password?</Link>
              </>
            )}
            {mode === 'register' && <Link className="btn btn-ghost btn-sm" to="/login">Already have an account? Log in</Link>}
            {mode === 'recover' && <Link className="btn btn-ghost btn-sm" to="/login">Back to log in</Link>}
          </div>
        </form>
      </main>
    </div>
  );
}
