// =============================================
// N Signage — One-time device pairing codes
//
// The Pi (agent protocol 2, not yet released) asks the cloud for a code over
// its authenticated connection and shows it on the signage screen. The
// customer types it into Add Device. The code proves the customer can see
// that specific display, so it replaces "same Wi-Fi" as ownership proof.
//
//   - 8 characters from a 32-symbol alphabet → 40 random bits
//   - valid for 10 minutes, single use (GETDEL), one live code per Pi
//   - only the SHA-256 is stored; redemption is rate limited per account and IP
// =============================================
import { redis, keys, sha256, httpError } from './cloud.js';
import { randomBase32, normalizeCode } from './password.js';

export const PAIR_TTL_S = 10 * 60;
const CODE_RX = /^[A-HJ-NP-Z2-9]{8}$/;

const codeHash = (code) => sha256(`ns-pair:${normalizeCode(code)}`);

export function formatPairCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Issue a fresh code for a Pi, invalidating its previous one. */
export async function issuePairCode(deviceId) {
  const r = redis();
  const previous = await r.get(keys.pairDevice(deviceId));
  if (previous) await r.del(keys.pairCode(String(previous)));
  const code = randomBase32(8);
  const hash = codeHash(code);
  const now = Date.now();
  await r.set(keys.pairCode(hash), { deviceId, createdAt: now }, { ex: PAIR_TTL_S });
  await r.set(keys.pairDevice(deviceId), hash, { ex: PAIR_TTL_S });
  return { code: formatPairCode(code), expiresAt: now + PAIR_TTL_S * 1000, ttlSeconds: PAIR_TTL_S };
}

/**
 * Redeem a code (single use). Returns the deviceId it belongs to.
 * With `expectDeviceId`, a code for a different Pi is rejected and NOT consumed.
 */
export async function redeemPairCode(rawCode, expectDeviceId = null) {
  const code = normalizeCode(rawCode);
  const invalid = () => httpError(400, 'This pairing code is not valid or has expired. Check the code on the display screen.', 'bad-pair-code');
  if (!CODE_RX.test(code)) throw invalid();
  const r = redis();
  const hash = codeHash(code);
  if (expectDeviceId) {
    const peek = await r.get(keys.pairCode(hash));
    if (!peek || peek.deviceId !== expectDeviceId) throw invalid();
  }
  const grant = await r.getdel(keys.pairCode(hash));
  if (!grant?.deviceId) throw invalid();
  await r.del(keys.pairDevice(grant.deviceId));
  return String(grant.deviceId);
}
