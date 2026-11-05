// =============================================
// N Signage — Login / Create account (hosted website only)
// =============================================
import React, { useState } from 'react';
import { LogIn, UserPlus, Loader2, AlertTriangle } from 'lucide-react';
import { login, register } from '../api/authApi';
import logo from '../assets/logo.png';

export default function Login({ onLoggedIn }) {
  const [mode, setMode] = useState('login'); // login | register
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    const res = mode === 'login' ? await login(email, password) : await register(email, password, name);
    setBusy(false);
    if (res.ok) onLoggedIn(res.account);
    else setError(res.error);
  }

  const isLogin = mode === 'login';
  return (
    <div className="auth-screen">
      <form className="card auth-card" onSubmit={submit}>
        <img src={logo} alt="N-Sinages" className="auth-logo" />
        <div>
          <h1 className="auth-title">{isLogin ? 'Log in' : 'Create your account'}</h1>
          <p className="auth-subtitle">
            {isLogin
              ? 'Manage your N-Signage displays from any phone or computer.'
              : 'Your displays are saved to this account and available on every device you log in from.'}
          </p>
        </div>

        {!isLogin && (
          <div className="form-group">
            <label className="form-label" htmlFor="auth-name">Name or company (optional)</label>
            <input id="auth-name" className="form-input" value={name} maxLength={80}
              autoComplete="organization" onChange={(e) => setName(e.target.value)} />
          </div>
        )}

        <div className="form-group">
          <label className="form-label" htmlFor="auth-email">Email</label>
          <input id="auth-email" className="form-input" type="email" required value={email}
            autoComplete="email" inputMode="email" onChange={(e) => setEmail(e.target.value)} />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="auth-password">Password</label>
          <input id="auth-password" className="form-input" type="password" required value={password}
            minLength={isLogin ? undefined : 8} maxLength={200}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)} />
          {!isLogin && <span className="form-hint">At least 8 characters.</span>}
        </div>

        {error && (
          <div className="alert alert-danger" role="alert" style={{ fontSize: 'var(--text-xs)' }}>
            <AlertTriangle size={14} className="alert-icon" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-lg" disabled={busy} style={{ width: '100%' }}>
          {busy ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
            : isLogin ? <LogIn size={15} /> : <UserPlus size={15} />}
          {isLogin ? 'Log in' : 'Create account'}
        </button>

        <button type="button" className="btn btn-ghost" disabled={busy}
          onClick={() => { setMode(isLogin ? 'register' : 'login'); setError(''); }}>
          {isLogin ? 'New customer? Create an account' : 'Already have an account? Log in'}
        </button>
      </form>
    </div>
  );
}
