import { Loader2, WifiOff } from "lucide-react";

/**
 * Small badge showing real connection state. Never fabricates "connected".
 */
export default function ConnectionStatus({ status, size = "md" }) {
  if (status === "unconfigured") {
    return (
      <span className="badge badge-offline">
        <WifiOff size={size === "sm" ? 12 : 14} />
        Not configured
      </span>
    );
  }

  if (status === "checking") {
    return (
      <span className="badge badge-checking">
        <Loader2 size={size === "sm" ? 12 : 14} className="spin-icon" />
        Checking...
      </span>
    );
  }

  if (status === "online") {
    return (
      <span className="badge badge-online">
        <span className="badge-dot" />
        Online
      </span>
    );
  }

  return (
    <span className="badge badge-offline">
      <span className="badge-dot" />
      Offline
    </span>
  );
}
