// =============================================
// N Signage — Customer authentication pages (hosted website)
//   /  and /login     Sign in with username + password
//   /register         Create an account (no email) — only when self-registration is open
//   /forgot-password  Reset the password with the recovery key
// Split layout: navy brand panel (left) + sign-in panel (right); stacked on phones.
// =============================================
import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LogIn, UserPlus, KeyRound, Loader2, AlertTriangle, Eye, EyeOff, CheckCircle2, Info,
  MonitorPlay, Wifi, ShieldCheck, UploadCloud,
} from 'lucide-react';
import { login, register, recoverAccount, PASSWORD_MIN, USERNAME_RX } from '../api/authApi';
import { useAuth } from '../auth/AuthContext';
import RecoveryKeyNotice from '../components/RecoveryKeyNotice';
import logo from '../assets/logo.png';

const TITLES = {
  login: ['Welcome back', 'Sign in to manage your N-Signage displays.'],
  register: ['Create your account', 'Choose a username and password. No email address is needed.'],
  recover: ['Reset your password', 'Enter your username and the recovery key you saved when the account was created.'],
};

/** Only allow returning to pages of this site. */
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !/^\/(login|register|forgot-password|logout)\b/.test(next)
    ? next : '/dashboard';
}

function BrandPanel() {
  return (
    <aside className="auth-brand" aria-label="N-Signage">
      <img src={logo} alt="N-Sinages — Digital Sinage Solution" className="auth-brand-logo" />
      <div className="auth-brand-copy">
        <h2>Every screen, managed from one place.</h2>
        <p>See which displays are online, add new Raspberry Pi screens and send images and videos to them from anywhere.</p>
      </div>
      <div className="auth-preview" aria-hidden="true">
        <div className="auth-preview-bar"><span /><span /><span /></div>
        <div className="auth-preview-body">
          {[['Shop Display 01', true], ['Reception', true], ['Branch 02', false]].map(([n, on]) => (
            <div className="auth-preview-row" key={n}>
              <MonitorPlay size={14} />
              <span className="auth-preview-name">{n}</span>
              <span className={`auth-preview-dot ${on ? 'on' : ''}`} />
              <span className="auth-preview-state">{on ? 'Online' : 'Offline'}</span>
            </div>
          ))}
          <div className="auth-preview-upload"><UploadCloud size={13} /> menu-board.mp4 <span className="auth-preview-progress"><i /></span></div>
        </div>
      </div>
      <ul className="auth-brand-points">
        <li><Wifi size={15} /> Add a display on the same Wi-Fi or with its pairing code</li>
        <li><UploadCloud size={15} /> Upload media from your phone or computer</li>
        <li><ShieldCheck size={15} /> Private to your account, no email needed</li>
      </ul>
    </aside>
  );
}

export default function AuthPage({ mode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const registrationOpen = auth?.registration !== 'closed';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [newKey, setNewKey] = useState(null); // { key, user } shown once after register / recover

  const notice = params.get('expired') ? 'Your session ended. Please sign in again.' : auth?.notice;

  function validate() {
    const errs = {};
    const u = username.trim().toLowerCase();
    if (!u) errs.username = 'Enter your username.';
    else if (mode !== 'login' && !USERNAME_RX.test(u)) errs.username = '3–32 characters: letters, numbers, ".", "_" or "-", starting and ending with a letter or number.';
    if (!password) errs.password = mode === 'recover' ? 'Choose a new password.' : 'Enter your password.';
    else if (mode !== 'login' && password.length < PASSWORD_MIN) errs.password = `At least ${PASSWORD_MIN} characters.`;
    if (mode !== 'login' && password && password !== confirm) errs.confirm = 'The two passwords do not match.';
    if (mode === 'recover' && recoveryKey.replace(/[\s-]/g, '').length !== 20) errs.recoveryKey = 'The recovery key has 20 letters and numbers.';
    return errs;
  }

  async function finish(user) {
    await auth.enter(user);
    navigate(next, { replace: true });
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length) { setError(''); return; }
    setError('');
    setBusy(true);
    const u = username.trim();
    const res = mode === 'login'
      ? await login(u, password, remember)
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

  const fieldError = (name) => fieldErrors[name] && <span className="form-error" id={`${name}-err`}>{fieldErrors[name]}</span>;
  const [title, subtitle] = TITLES[mode];
  const pwType = showPassword ? 'text' : 'password';

  let panel;
  if (newKey) {
    panel = (
      <div className="auth-form">
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
    );
  } else if (mode === 'register' && !registrationOpen) {
    panel = (
      <div className="auth-form">
        <h1 className="auth-title" id="auth-title">Accounts are created by N-Signage</h1>
        <p className="auth-subtitle">Please contact N-Signage support to get your username. You will receive a one-time key to choose your own password.</p>
        <Link className="btn btn-primary btn-lg auth-submit" to="/login"><LogIn size={16} /> Back to sign in</Link>
      </div>
    );
  } else {
    panel = (
      <form className="auth-form" onSubmit={submit} noValidate aria-labelledby="auth-title">
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
          <input id="auth-username" className="form-input auth-input" required value={username} maxLength={32}
            autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus
            aria-invalid={Boolean(fieldErrors.username)} aria-describedby={fieldErrors.username ? 'username-err' : undefined}
            onChange={(e) => setUsername(e.target.value)} />
          {fieldError('username')}
          {mode === 'register' && !fieldErrors.username && <span className="form-hint">3–32 characters: letters, numbers, ".", "_" or "-". Not case-sensitive.</span>}
        </div>

        {mode === 'register' && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-name">Business or display name (optional)</label>
            <input id="auth-name" className="form-input auth-input" value={displayName} maxLength={80}
              autoComplete="organization" onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        )}

        {mode === 'recover' && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-recovery">Recovery key</label>
            <input id="auth-recovery" className="form-input auth-input" required value={recoveryKey} maxLength={40}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false}
              aria-invalid={Boolean(fieldErrors.recoveryKey)} style={{ fontFamily: 'var(--font-mono)' }}
              onChange={(e) => setRecoveryKey(e.target.value)} />
            {fieldError('recoveryKey')}
            {!fieldErrors.recoveryKey && <span className="form-hint">Lost your recovery key too? Contact N-Signage support to verify your account and get a new key.</span>}
          </div>
        )}

        <div className="form-group">
          <div className="auth-label-row">
            <label className="form-label" htmlFor="auth-password">{mode === 'recover' ? 'New password' : 'Password'}</label>
            {mode === 'login' && <Link className="auth-inline-link" to="/forgot-password">Forgot password?</Link>}
          </div>
          <div style={{ position: 'relative' }}>
            <input id="auth-password" className="form-input auth-input" type={pwType} required value={password}
              maxLength={128} style={{ paddingRight: 44 }}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? 'password-err' : undefined}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn-ghost btn-icon btn-sm auth-eye" onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {fieldError('password')}
          {mode !== 'login' && (
            <ul className="pw-rules">
              <li className={password.length >= PASSWORD_MIN ? 'ok' : ''}>At least {PASSWORD_MIN} characters</li>
              <li className={password && (!username.trim() || !password.toLowerCase().includes(username.trim().toLowerCase())) ? 'ok' : ''}>Does not contain your username</li>
              <li>A short sentence is easy to remember and hard to guess</li>
            </ul>
          )}
        </div>

        {mode !== 'login' && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-confirm">Confirm password</label>
            <input id="auth-confirm" className="form-input auth-input" type={pwType} required value={confirm} maxLength={128}
              autoComplete="new-password" aria-invalid={Boolean(fieldErrors.confirm)} onChange={(e) => setConfirm(e.target.value)} />
            {fieldError('confirm')}
          </div>
        )}

        {mode === 'login' && (
          <label className="auth-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Keep me signed in for 30 days <small>(only on your own device)</small></span>
          </label>
        )}

        {error && (
          <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
            <AlertTriangle size={14} className="alert-icon" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={busy}>
          {busy ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} />
            : mode === 'login' ? <LogIn size={16} /> : mode === 'register' ? <UserPlus size={16} /> : <KeyRound size={16} />}
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Set new password'}
        </button>

        <div className="auth-switch">
          {mode === 'login' && registrationOpen && (
            <span>New to N-Signage? <Link to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`}>Create an account</Link></span>
          )}
          {mode === 'login' && !registrationOpen && <span>Need an account? Contact N-Signage support.</span>}
          {mode === 'register' && <span>Already have an account? <Link to="/login">Sign in</Link></span>}
          {mode === 'recover' && <span>Remembered it? <Link to="/login">Back to sign in</Link></span>}
        </div>
      </form>
    );
  }

  return (
    <div className="auth-split">
      <BrandPanel />
      <main className="auth-panel">
        <img src={logo} alt="N-Sinages" className="auth-panel-logo" />
        {panel}
        <footer className="auth-footer">© {new Date().getFullYear()} N-Sinages · Digital Signage Solution</footer>
      </main>
    </div>
  );
}
