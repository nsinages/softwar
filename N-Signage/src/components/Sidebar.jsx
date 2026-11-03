import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Film,
  UploadCloud,
  MonitorPlay,
  Cpu,
  Settings,
  Tv,
} from "lucide-react";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/media", label: "Media", icon: Film },
  { to: "/upload", label: "Upload", icon: UploadCloud },
  { to: "/display", label: "Display", icon: MonitorPlay },
  { to: "/device", label: "Device", icon: Cpu },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand">
        <span className="sidebar-brand-icon">
          <Tv size={20} />
        </span>
        <div>
          <div className="sidebar-brand-name">N Signage</div>
          <div className="sidebar-brand-tag">Digital Signage Control</div>
        </div>
      </div>

      <div className="sidebar-links">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              "sidebar-link" + (isActive ? " sidebar-link-active" : "")
            }
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidebar-footer">
        <span className="text-muted">N Signage v1.0</span>
      </div>
    </nav>
  );
}

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Mobile navigation">
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            "bottom-nav-link" + (isActive ? " bottom-nav-link-active" : "")
          }
        >
          <Icon size={20} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
