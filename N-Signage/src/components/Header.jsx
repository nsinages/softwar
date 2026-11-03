import { Tv } from "lucide-react";
import ConnectionStatus from "./ConnectionStatus";

/**
 * Compact top header shown on mobile/tablet in place of the desktop sidebar.
 */
export default function Header({ status }) {
  return (
    <header className="mobile-header">
      <div className="mobile-header-brand">
        <span className="sidebar-brand-icon sidebar-brand-icon-sm">
          <Tv size={16} />
        </span>
        <span className="mobile-header-name">N Signage</span>
      </div>
      <ConnectionStatus status={status} size="sm" />
    </header>
  );
}
