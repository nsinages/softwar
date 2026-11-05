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

  const start = useCallback(async (initial = false) => {
    if (!initial) setBoot({ state: 'starting' });
    const session = await ensureSession();
    if (!session.ok) { setBoot({ state: 'error', error: session.error }); return; }
    const res = await syncCloudDevices();
    if (!res.ok) replaceDevices([]); // never show a stale cached list
    setBoot({ state: 'ready', error: res.ok ? '' : res.error });
  }, []);

  useEffect(() => {
    if (!cloud) return undefined;
    start(true);
    // Session cookie gone (cleared or expired): get a new one silently
    const onLost = () => start();
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
  if (boot.state === 'error') {
    return (
      <div className="boot-screen">
        <div className="card boot-card">
          <div className="alert alert-danger"><AlertTriangle size={15} className="alert-icon" /><span>{boot.error}</span></div>
          <button className="btn btn-secondary" onClick={() => start()}><RotateCw size={14} /> Try again</button>
        </div>
      </div>
    );
  }
  return <Shell loadError={boot.error} />;
}

function Shell({ loadError }) {
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
