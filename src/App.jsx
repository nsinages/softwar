// =============================================
// N Signage V2 — App Root
// =============================================
import React, { useState, useEffect, useMemo } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Classrooms from './pages/Classrooms';
import Media from './pages/Media';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import { getDevices, getSettings, saveSettings } from './data/store';
import { checkAllDevices } from './api/piApi';

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => getSettings().theme || 'dark');
  const [statusMap, setStatusMap] = useState({});

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Simple status poll for TopBar counter
  useEffect(() => {
    async function poll() {
      const devices = getDevices();
      if (devices.length === 0) return;
      const results = await checkAllDevices(devices);
      setStatusMap(results);
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
        />
        <div className="main-content">
          <TopBar
            theme={theme}
            onThemeToggle={toggleTheme}
            onlineCount={onlineCount}
            totalCount={devices.length}
          />
          <main className="page-body">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/devices" element={<Devices />} />
              <Route path="/classrooms" element={<Classrooms />} />
              <Route path="/media" element={<Media />} />
              <Route path="/upload" element={<Upload />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={
                <div className="empty-state">
                  <div className="es-icon">🔍</div>
                  <h3>Page Not Found</h3>
                  <p>The page you're looking for doesn't exist.</p>
                  <a className="btn btn-primary" href="/">Back to Dashboard</a>
                </div>
              } />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
