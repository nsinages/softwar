import { Routes, Route } from "react-router-dom";
import { Sidebar, BottomNav } from "./components/Sidebar";
import Header from "./components/Header";
import { DeviceStatusProvider, useDeviceStatus } from "./hooks/useDeviceStatus.jsx";
import Dashboard from "./pages/Dashboard";
import Media from "./pages/Media";
import Upload from "./pages/Upload";
import DisplayPage from "./pages/Display";
import Device from "./pages/Device";
import Settings from "./pages/Settings";

function AppShell() {
  const { status } = useDeviceStatus();

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Header status={status} />
        <div className="app-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/media" element={<Media />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/display" element={<DisplayPage />} />
            <Route path="/device" element={<Device />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <DeviceStatusProvider>
      <AppShell />
    </DeviceStatusProvider>
  );
}
