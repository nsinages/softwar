// =============================================
// N Signage — App Root Shell
// =============================================
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { ArrowLeft, Compass, Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Media from './pages/Media';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import { getDevices, replaceDevices, DEVICES_CHANGED_EVENT } from './data/store';
import { usePiStatus } from './hooks/usePiStatus';
import { isCloudMode, syncCloudDevices, SESSION_LOST_EVENT } from './api/cloudApi';
import { ensureSession } from './api/authApi';

/**
 * Hosted website (cloud mode): no login. The browser gets an anonymous
 * session automatically, and the Raspberry Pis added in this browser are
 * loaded before the dashboard renders.
 * LAN mode (localhost / npm start) works exactly as before.
 */
export default function App() {
  const cloud = isCloudMode();
  const [boot, setBoot] = useState(cloud ? { state: 'starting' } : { state: 'ready' });
  const sessionOk = useRef(false);   // true once the cloud gave this browser a session
  const lastRecovery = useRef(0);

  const start = useCallback(async (initial = false) => {
    if (!initial) setBoot({ state: 'starting' });
    const session = await ensureSession();
    sessionOk.current = session.ok;
    if (!session.ok) {
      // Cloud unavailable: still show the dashboard, with the reason as a banner
      replaceDevices([]);
      setBoot({ state: 'ready', error: session.error });
      return;
    }
    const res = await syncCloudDevices();
    if (!res.ok) replaceDevices([]); // never show a stale cached list
    setBoot({ state: 'ready', error: res.ok ? '' : res.error });
  }, []);

  useEffect(() => {
    if (!cloud) return undefined;
    start(true);
    // Session cookie gone (cleared or expired) after it had worked: get a new
    // one silently — at most once per 30 s, and never when the cloud itself is
    // down (that would loop: no session → retry → no session …).
    const onLost = () => {
      const now = Date.now();
      if (!sessionOk.current || now - lastRecovery.current < 30000) return;
      lastRecovery.current = now;
      sessionOk.current = false;
      start();
    };
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    return () => window.removeEventListener(SESSION_LOST_EVENT, onLost);
  }, [cloud, start]);

  if (boot.state === 'starting') {
    return (
      <div className="boot-screen">
        <Loader2 size={22} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--accent)' }} />
      </div>
    );
  }
  return <Shell loadError={boot.error} onRetry={cloud ? () => start() : undefined} />;
}

function Shell({ loadError, onRetry }) {
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
        />
        <div className="main-content">
          <TopBar
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
