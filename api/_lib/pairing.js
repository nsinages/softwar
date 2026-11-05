// =============================================
// N Signage — One-time device pairing codes (Supabase: nsignage.pairing_codes)
//
// The Pi (agent protocol 2, not yet released) asks the cloud for a code over
// its authenticated connection and shows it on the signage screen. The
// customer types it into Add Device. The code proves the customer can see
// that specific display, so it replaces "same Wi-Fi" as ownership proof.
//
//   - 8 characters from a 32-symbol alphabet → 40 random bits
//   - valid 10 minutes, single use (atomic UPDATE … RETURNING), one live code per Pi
//   - only the SHA-256 is stored; redemption is rate limited per account and IP
// All functions take an open transaction in the 'system' RLS context.
// =============================================
import { sha256, httpError } from './cloud.js';
import { randomBase32, normalizeCode } from './password.js';

export const PAIR_TTL_S = 10 * 60;
const CODE_RX = /^[A-HJ-NP-Z2-9]{8}$/;

const codeHash = (code) => sha256(`ns-pair:${normalizeCode(code)}`);

export function formatPairCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Issue a fresh code for a Pi, removing its previous unused code. */
export async function issuePairCode(t, deviceId) {
  await t`delete from nsignage.pairing_codes where device_id = ${deviceId} and used_at is null`;
  const code = randomBase32(8);
  const [r] = await t`
    insert into nsignage.pairing_codes (code_hash, device_id, expires_at)
    values (${codeHash(code)}, ${deviceId}, now() + make_interval(secs => ${PAIR_TTL_S}))
    returning expires_at`;
  return { code: formatPairCode(code), expiresAt: r.expires_at.getTime(), ttlSeconds: PAIR_TTL_S };
}

/**
 * Redeem a code (single use). Returns the deviceId it belongs to.
 * With `expectDeviceId`, a code for a different Pi is rejected and NOT consumed.
 * Runs inside the caller's transaction: if the claim that follows fails, the
 * code is not consumed either.
 */
export async function redeemPairCode(t, rawCode, userId, expectDeviceId = null) {
  const code = normalizeCode(rawCode);
  const invalid = () => httpError(400, 'This pairing code is not valid or has expired. Check the code on the display screen.', 'bad-pair-code');
  if (!CODE_RX.test(code)) throw invalid();
  const [r] = await t`
    update nsignage.pairing_codes
       set used_at = now(), used_by = ${userId}
     where code_hash = ${codeHash(code)} and used_at is null and expires_at > now()
       and (${expectDeviceId}::text is null or device_id = ${expectDeviceId})
    returning device_id`;
  if (!r) throw invalid();
  return r.device_id;
}
