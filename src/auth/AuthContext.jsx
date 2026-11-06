// =============================================
// N Signage — Customer session state for the hosted website (cloud mode)
//
// The session itself is an HttpOnly cookie set by /api/auth; JavaScript never
// sees it. This context only knows WHO is logged in (from /api/auth?action=me)
// and reacts when the server says the session ended (401 not-logged-in).
// =============================================
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getMe, getAuthConfig, logout as apiLogout, LOGGED_OUT_EVENT } from '../api/authApi';
import { syncCloudDevices } from '../api/cloudApi';
import { replaceDevices } from '../data/store';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // state: checking | in | out | error
  const [state, setState] = useState({ status: 'checking', user: null, error: '', loadError: '', notice: '' });
  const [registration, setRegistration] = useState('open');

  /** Logged in: load this account's devices, then show the app. */
  const enter = useCallback(async (user) => {
    const res = await syncCloudDevices();
    if (!res.ok) replaceDevices([]); // never show a stale or previous user's list
    setState({ status: 'in', user, error: '', loadError: res.ok ? '' : res.error, notice: '' });
  }, []);

  const check = useCallback(async () => {
    setState((s) => ({ ...s, status: 'checking' }));
    const me = await getMe();
    if (me.ok) await enter(me.user);
    else if (me.loggedOut) {
      replaceDevices([]);
      setState({ status: 'out', user: null, error: '', loadError: '', notice: '' });
    } else setState({ status: 'error', user: null, error: me.error, loadError: '', notice: '' });
  }, [enter]);

  const logout = useCallback(async () => {
    await apiLogout();
    replaceDevices([]);
    setState({ status: 'out', user: null, error: '', loadError: '', notice: 'You have been logged out.' });
  }, []);

  const reloadDevices = useCallback(async () => {
    const res = await syncCloudDevices();
    setState((s) => ({ ...s, loadError: res.ok ? '' : res.error }));
  }, []);

  useEffect(() => {
    getAuthConfig().then((c) => setRegistration(c.registration));
    check();
    // Session expired or revoked (logout elsewhere, password changed): back to login
    const onLoggedOut = () => {
      replaceDevices([]);
      setState({ status: 'out', user: null, error: '', loadError: '', notice: 'Your session ended. Please log in again.' });
    };
    window.addEventListener(LOGGED_OUT_EVENT, onLoggedOut);
    return () => window.removeEventListener(LOGGED_OUT_EVENT, onLoggedOut);
  }, [check]);

  const value = useMemo(() => ({ ...state, registration, enter, check, logout, reloadDevices }), [state, registration, enter, check, logout, reloadDevices]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Null in LAN mode (no AuthProvider): there is no customer login there. */
export function useAuth() {
  return useContext(AuthContext);
}
