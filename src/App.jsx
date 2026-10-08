// =============================================
// N Signage — App Root Shell
// =============================================
import React, { useState, useEffect, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { ArrowLeft, Compass } from 'lucide-react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Media from './pages/Media';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import { getDevices, getSettings, saveSettings } from './data/store';
import { checkAllDevices } from './api/piApi';

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [theme, setTheme] = useState(() => getSettings().theme || 'light');
  const [statusMap, setStatusMap] = useState({});
  const [lastSync, setLastSync] = useState(null);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Status poll for TopBar & global counters
  useEffect(() => {
    async function poll() {
      const devices = getDevices();
      if (devices.length === 0) return;
      const results = await checkAllDevices(devices);
      setStatusMap(results);
      setLastSync(new Date());
    }
    poll();
    const settings = getSettings();
    const interval = (settings.pollInterval || 30) * 1000;
    const timer = setInterval(poll, interval);
    return () => clearInterval(timer);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    saveSettings({ ...getSettings(), theme: next });
  }

  const devices = useMemo(() => getDevices(), []);
  const onlineCount = Object.values(statusMap).filter(s => s?.ok).length;

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
            theme={theme}
            onThemeToggle={toggleTheme}
            onlineCount={onlineCount}
            totalCount={devices.length}
            lastSync={lastSync}
            onMobileMenuToggle={() => setMobileSidebarOpen(o => !o)}
          />
          <main className="page-body">
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
