// =============================================
// N Signage — App Root Shell
// =============================================
import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { ArrowLeft, Compass } from 'lucide-react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Media from './pages/Media';
import Upload from './pages/Upload';
import Settings from './pages/Settings';
import { getDevices } from './data/store';
import { usePiStatus } from './hooks/usePiStatus';

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { statusMap } = usePiStatus();

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
