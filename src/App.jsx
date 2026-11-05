// =============================================
// N Signage — App Root Shell
// =============================================
import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { ArrowLeft, Compass, Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Media from './pages/Media';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import Login from './pages/Login';
import { getDevices, replaceDevices, DEVICES_CHANGED_EVENT } from './data/store';
import { usePiStatus } from './hooks/usePiStatus';
import { isCloudMode, syncCloudDevices, LOGGED_OUT_EVENT } from './api/cloudApi';
import { getMe, logout } from './api/authApi';

/**
 * Hosted website (cloud mode): customers log in, and their Raspberry Pis are
 * loaded from their account before the dashboard renders.
 * LAN mode (localhost / npm start) needs no login, exactly as before.
 */
export default function App() {
  const cloud = isCloudMode();
  const [auth, setAuth] = useState(cloud ? { state: 'checking' } : { state: 'lan' });

  const enter = useCallback(async (account) => {
    setAuth({ state: 'loading', account });
    const res = await syncCloudDevices();
    if (!res.ok) replaceDevices([]); // never show a previous user's cached list
    setAuth({ state: 'in', account, error: res.ok ? '' : res.error });
  }, []);

  const check = useCallback(async (initial = false) => {
    if (!initial) setAuth({ state: 'checking' });
    const me = await getMe();
    if (me.ok) enter(me.account);
    else if (me.loggedOut) { replaceDevices([]); setAuth({ state: 'out' }); }
    else setAuth({ state: 'error', error: me.error });
  }, [enter]);

  useEffect(() => {
    if (!cloud) return undefined;
    check(true);
    const onLoggedOut = () => { replaceDevices([]); setAuth({ state: 'out' }); };
    window.addEventListener(LOGGED_OUT_EVENT, onLoggedOut);
    return () => window.removeEventListener(LOGGED_OUT_EVENT, onLoggedOut);
  }, [cloud, check]);

  async function handleLogout() {
    await logout();
    replaceDevices([]);
    setAuth({ state: 'out' });
  }

  if (auth.state === 'out') return <Login onLoggedIn={enter} />;
  if (auth.state === 'checking' || auth.state === 'loading') {
    return (
      <div className="auth-screen">
        <Loader2 size={22} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--accent)' }} />
      </div>
    );
  }
  if (auth.state === 'error') {
    return (
      <div className="auth-screen">
        <div className="card auth-card">
          <div className="alert alert-danger"><AlertTriangle size={15} className="alert-icon" /><span>{auth.error}</span></div>
          <button className="btn btn-secondary" onClick={() => check()}><RotateCw size={14} /> Try again</button>
        </div>
      </div>
    );
  }
  return <Shell account={auth.account} onLogout={cloud ? handleLogout : undefined} loadError={auth.error} />;
}

function Shell({ account, onLogout, loadError }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { statusMap } = usePiStatus();
  const [, setDevicesVersion] = useState(0);

  // Re-render counts when the device list changes (add/remove, cloud sync)
  useEffect(() => {
    const bump = () => setDevicesVersion(v => v + 1);
    window.addEventListener(DEVICES_CHANGED_EVENT, bump);
    return () => window.removeEventListener(DEVICES_CHANGED_EVENT, bump);
  }, []);

  // Light theme only
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  const devices = getDevices();
  const onlineCount = devices.filter(d => statusMap[d.id]?.ok).length;

  return (
    <BrowserRouter>
      <div className="app-shell">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(c => !c)}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          account={account}
          onLogout={onLogout}
        />
        <div className="main-content">
          <TopBar
            onlineCount={onlineCount}
            totalCount={devices.length}
            onMobileMenuToggle={() => setMobileSidebarOpen(o => !o)}
          />
          <main className="page-body">
            {loadError && (
              <div className="alert alert-danger" style={{ marginBottom: 'var(--space-4)' }}>
                <AlertTriangle size={15} className="alert-icon" /><span>{loadError}</span>
              </div>
            )}
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/devices" element={<Devices />} />
              <Route path="/media" element={<Media />} />
              <Route path="/upload" element={<Upload />} />
              <Route path="/settings" element={<Settings />} />
              <Route
                path="*"
                element={
                  <div className="panel blank" style={{ maxWidth: 640 }}>
                    <div className="blank-icon"><Compass size={18} /></div>
                    <div className="blank-body">
                      <div className="blank-title">Page not found</div>
                      <div className="blank-text">The requested page does not exist or has been moved.</div>
                    </div>
                    <Link className="btn btn-secondary" to="/">
                      <ArrowLeft size={14} /> Back to overview
                    </Link>
                  </div>
                }
              />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
