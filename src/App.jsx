// =============================================
// N Signage — App Root Shell
//
// Hosted website (cloud mode):
//   public  : /  (home)  /login  /register  /recover
//   private : /  (dashboard)  /devices  /media  /upload  /account (/settings)
//   Opening a private page while logged out → /login?next=<page>.
//   Data is protected by the server (every /api call checks the session);
//   the redirects only decide which screen to show.
//
// LAN mode (localhost / npm start): no customer login, works exactly as before.
// =============================================
import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Compass, Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Media from './pages/Media';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import AuthPage from './pages/Login';
import Home from './pages/Home';
import { getDevices, DEVICES_CHANGED_EVENT } from './data/store';
import { usePiStatus } from './hooks/usePiStatus';
import { isCloudMode } from './api/cloudApi';
import { AuthProvider, useAuth } from './auth/AuthContext';

export default function App() {
  // Light theme only
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  if (!isCloudMode()) {
    return (
      <BrowserRouter>
        <Routes>
          {/* There is no customer login on the local network dashboard */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route path="/recover" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter>
      <AuthProvider>
        <CloudRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

const PRIVATE_PATHS = ['/devices', '/media', '/upload', '/account', '/settings'];

function CloudRoutes() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'checking') {
    return (
      <div className="boot-screen" aria-busy="true">
        <Loader2 size={22} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--accent)' }} />
      </div>
    );
  }
  if (auth.status === 'error') {
    return (
      <div className="boot-screen">
        <div className="card boot-card">
          <div className="alert alert-danger"><AlertTriangle size={15} className="alert-icon" /><span>{auth.error}</span></div>
          <button className="btn btn-secondary" onClick={() => auth.check()}><RotateCw size={14} /> Try again</button>
        </div>
      </div>
    );
  }

  if (auth.status === 'out') {
    const isPrivate = PRIVATE_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`));
    if (isPrivate) {
      const next = `${location.pathname}${location.search}`;
      return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
    }
    return (
      <Routes>
        <Route path="/" element={<Home notice={auth.notice} />} />
        <Route path="/login" element={<AuthPage key="login" mode="login" />} />
        <Route path="/register" element={<AuthPage key="register" mode="register" />} />
        <Route path="/recover" element={<AuthPage key="recover" mode="recover" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // Logged in: the public auth pages lead back into the app
  if (['/login', '/register', '/recover'].includes(location.pathname)) {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} replace />;
  }
  return <Shell user={auth.user} onLogout={auth.logout} loadError={auth.loadError} onRetry={auth.reloadDevices} />;
}

function Shell({ user, onLogout, loadError, onRetry }) {
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

  const devices = getDevices();
  const onlineCount = devices.filter(d => statusMap[d.id]?.ok).length;

  return (
    <div className="app-shell">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        user={user}
        onLogout={onLogout}
      />
      <div className="main-content">
        <TopBar
          username={user?.username}
          onlineCount={onlineCount}
          totalCount={devices.length}
          onMobileMenuToggle={() => setMobileSidebarOpen(o => !o)}
        />
        <main className="page-body">
          {loadError && (
            <div className="alert alert-danger" style={{ marginBottom: 'var(--space-4)', alignItems: 'center' }}>
              <AlertTriangle size={15} className="alert-icon" />
              <span style={{ flex: 1 }}>{loadError}</span>
              {onRetry && (
                <button className="btn btn-secondary btn-sm" onClick={onRetry}>
                  <RotateCw size={13} /> Try again
                </button>
              )}
            </div>
          )}
          <Routes>
            <Route path="/" element={<Dashboard user={user} onLogout={onLogout} />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/media" element={<Media />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/account" element={<Settings user={user} />} />
            <Route path="/settings" element={<Settings user={user} />} />
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
  );
}
