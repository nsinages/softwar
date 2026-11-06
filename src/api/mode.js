// =============================================
// N Signage — which website this is (no dependencies, safe to import anywhere)
//   'cloud' : hosted customer website (public domain, or `npm run dev`)
//   'lan'   : local-network dashboard (localhost / LAN address, `npm run dev:lan`, `npm start`)
// Override at build time with VITE_CONNECTION_MODE=cloud|lan.
// =============================================
const PRIVATE_HOST_RX = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)|\.local$/i;

export function connectionMode() {
  const forced = import.meta.env.VITE_CONNECTION_MODE;
  if (forced === 'cloud' || forced === 'lan') return forced;
  try {
    return PRIVATE_HOST_RX.test(window.location.hostname) ? 'lan' : 'cloud';
  } catch {
    return 'lan';
  }
}

export const isCloudMode = () => connectionMode() === 'cloud';
