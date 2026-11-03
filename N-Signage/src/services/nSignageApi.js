// Central API client for talking to the Raspberry Pi's Flask backend.
// Every network call the app makes goes through here so the base URL,
// error mapping, and endpoint paths live in exactly one place.

import { isPrivateOrLocalIP, isValidPort } from "../utils/validation";

const IP_STORAGE_KEY = "n_signage_pi_ip";
const PORT_STORAGE_KEY = "n_signage_pi_port";
const DEFAULT_PI_IP = "10.10.40.94";
const DEFAULT_PORT = "5000";
const REQUEST_TIMEOUT_MS = 6000;

/** A typed error so UI code can show a friendly message instead of a raw exception. */
export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ApiError";
    this.code = code; // e.g. 'OFFLINE' | 'TIMEOUT' | 'CORS' | 'INVALID_IP' | 'NOT_FOUND' | 'SERVER_ERROR'
  }
}

export function getPiIP() {
  return localStorage.getItem(IP_STORAGE_KEY) || DEFAULT_PI_IP;
}

export function setPiIP(ip) {
  localStorage.setItem(IP_STORAGE_KEY, ip.trim());
}

export function getPiPort() {
  return localStorage.getItem(PORT_STORAGE_KEY) || DEFAULT_PORT;
}

export function setPiPort(port) {
  localStorage.setItem(PORT_STORAGE_KEY, String(port).trim());
}

export function clearPiConnection() {
  localStorage.removeItem(IP_STORAGE_KEY);
  localStorage.removeItem(PORT_STORAGE_KEY);
}

export function getBaseURL() {
  const ip = getPiIP();
  const port = getPiPort();
  if (!ip) return "";
  return `http://${ip}:${port}`;
}

export function getDisplayURL() {
  const base = getBaseURL();
  return base ? `${base}/display` : "";
}

export { DEFAULT_PI_IP, DEFAULT_PORT };

/**
 * Wraps fetch with a timeout and translates network failures into
 * ApiError codes the UI can turn into a specific, honest message.
 */
async function request(path, options = {}) {
  const base = getBaseURL();
  if (!base) {
    throw new ApiError("No Raspberry Pi configured.", "NO_DEVICE");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError("Connection timed out.", "TIMEOUT");
    }
    // A bare "Failed to fetch" from the browser covers offline devices,
    // refused connections, and CORS-blocked requests alike — we can't
    // reliably tell them apart, so we surface the most actionable guess.
    throw new ApiError(
      "Unable to connect to Raspberry Pi. It may be offline, unreachable on this network, or blocking the request (CORS).",
      "OFFLINE"
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new ApiError("Requested resource was not found on the device.", "NOT_FOUND");
    }
    if (response.status >= 500) {
      throw new ApiError("Raspberry Pi server error.", "SERVER_ERROR");
    }
    throw new ApiError(`Request failed (HTTP ${response.status}).`, "HTTP_ERROR");
  }

  return response;
}

export async function getStatus() {
  const res = await request("/api/status");
  return res.json();
}

export async function getMedia() {
  const res = await request("/api/media");
  const data = await res.json();
  if (Array.isArray(data.media)) return data.media;
  if (Array.isArray(data.files)) return data.files;
  return [];
}

export async function uploadMedia(file, onProgress) {
  const base = getBaseURL();
  if (!base) {
    throw new ApiError("No Raspberry Pi configured.", "NO_DEVICE");
  }

  const formData = new FormData();
  formData.append("file", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/upload`);
    xhr.timeout = 5 * 60 * 1000; // large video uploads can take a while

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({});
        }
      } else if (xhr.status === 413) {
        reject(new ApiError("File too large.", "FILE_TOO_LARGE"));
      } else if (xhr.status === 415) {
        reject(new ApiError("Invalid file type.", "INVALID_TYPE"));
      } else {
        reject(new ApiError(`Upload failed (HTTP ${xhr.status}).`, "UPLOAD_FAILED"));
      }
    };

    xhr.onerror = () => {
      reject(new ApiError("Upload failed. Check your connection to the Raspberry Pi.", "OFFLINE"));
    };

    xhr.ontimeout = () => {
      reject(new ApiError("Upload timed out.", "TIMEOUT"));
    };

    xhr.send(formData);
  });
}

export async function deleteMedia(filename) {
  const res = await request(`/api/media/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Human-readable message for any error this module can throw or that fetch can raise.
 */
export function describeApiError(err) {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "NO_DEVICE":
        return "No Raspberry Pi configured. Go to Settings to connect one.";
      case "OFFLINE":
        return "Unable to connect to Raspberry Pi. Make sure it's powered on and on the same network.";
      case "TIMEOUT":
        return "Connection timeout. The Raspberry Pi did not respond in time.";
      case "NOT_FOUND":
        return "Media not found on the device.";
      case "SERVER_ERROR":
        return "Raspberry Pi server error. Check the Flask service on the device.";
      case "FILE_TOO_LARGE":
        return "File too large.";
      case "INVALID_TYPE":
        return "Invalid file type.";
      default:
        return err.message || "Something went wrong.";
    }
  }
  return "Unexpected error. See console for details.";
}

export function isConfigValid() {
  return isPrivateOrLocalIP(getPiIP()) && isValidPort(getPiPort());
}
