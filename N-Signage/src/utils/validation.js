// Validation helpers for the N Signage control panel.

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Validates that a string is a plausible LAN IPv4 address (or localhost),
 * so we never fetch() an arbitrary user-typed URL.
 */
export function isValidIP(value) {
  if (!value || typeof value !== "string") return false;
  const ip = value.trim();

  if (ip === "localhost") return true;

  const match = ip.match(IPV4_PATTERN);
  if (!match) return false;

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return false;

  return true;
}

/**
 * Restricts connections to private/local network ranges (or localhost),
 * matching the "same LAN" architecture this control panel assumes.
 */
export function isPrivateOrLocalIP(value) {
  if (!isValidIP(value)) return false;
  const ip = value.trim();
  if (ip === "localhost") return true;

  const [a, b] = ip.split(".").map(Number);

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 127) return true; // loopback

  return false;
}

export function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

const ALLOWED_EXTENSIONS = [
  "mp4",
  "webm",
  "mov",
  "jpg",
  "jpeg",
  "png",
  "webp",
];

export function isAllowedMediaFile(file) {
  if (!file || !file.name) return false;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

export function getMediaKind(nameOrType) {
  const value = (nameOrType || "").toLowerCase();
  const videoExts = ["mp4", "webm", "mov", "video"];
  const imageExts = ["jpg", "jpeg", "png", "webp", "image"];

  const ext = value.split(".").pop();
  if (videoExts.includes(ext) || videoExts.includes(value)) return "video";
  if (imageExts.includes(ext) || imageExts.includes(value)) return "image";
  return "unknown";
}

export function formatBytes(bytes) {
  if (bytes === 0 || bytes === undefined || bytes === null) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export { ALLOWED_EXTENSIONS };
