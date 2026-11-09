// =============================================
// N Signage — upload tickets (website → browser → Pi)
//
// A ticket authorises ONE browser to send ONE file to ONE Pi for a short
// time. The website signs it (Ed25519, key only in Vercel); the Pi verifies it
// with the website's public key, which it receives in its authenticated
// receiver heartbeat over verified TLS. The ticket carries no secret: it binds
// device, transfer, file name, size, SHA-256, chunk size and the hash of the
// browser's one-time ECDH public key (so a stolen ticket cannot be used with
// another key, and the Pi can derive the chunk key).
//
//   nst1.<base64url(JSON claims)>.<base64url(Ed25519 signature over "nst1.<claims>")>
//
// Env: NSIGNAGE_TICKET_KEY            base64 PKCS#8 DER Ed25519 private key (npm run upload:keygen)
//      NSIGNAGE_TICKET_PUBLIC_KEYS    optional, comma-separated base64url raw public keys still
//                                     accepted by Pis during a key rotation
// =============================================
import crypto from 'node:crypto';
import { httpError } from './cloud.js';

export const TICKET_TTL_S = 15 * 60;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const RAW_ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let cached = null;

function loadKey() {
  const raw = String(process.env.NSIGNAGE_TICKET_KEY || '').trim();
  if (!raw) return null;
  if (cached?.raw === raw) return cached;
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('NSIGNAGE_TICKET_KEY is not an Ed25519 key');
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicRaw = spki.subarray(RAW_ED25519_SPKI_PREFIX.length);
  cached = { raw, privateKey, publicKey: b64u(publicRaw), kid: keyId(publicRaw) };
  return cached;
}

export const keyId = (publicRaw) => crypto.createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);

export const ticketsConfigured = () => {
  try { return Boolean(loadKey()); } catch { return false; }
};

/** Public keys a Pi should accept: [{ kid, publicKey }] (current first). */
export function ticketPublicKeys() {
  const k = loadKey();
  const out = k ? [{ kid: k.kid, publicKey: k.publicKey }] : [];
  for (const extra of String(process.env.NSIGNAGE_TICKET_PUBLIC_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const rawKey = Buffer.from(extra, 'base64url');
    if (rawKey.length === 32 && !out.some((x) => x.publicKey === extra)) out.push({ kid: keyId(rawKey), publicKey: extra });
  }
  return out;
}

/** Sign claims; adds v, kid, iss, iat, nbf, exp. */
export function signTicket(claims, { now = Date.now(), ttlS = TICKET_TTL_S } = {}) {
  const k = loadKey();
  if (!k) throw httpError(503, 'Direct upload is not configured on the server.', 'upload-not-configured');
  const iat = Math.floor(now / 1000);
  const body = { v: 1, kid: k.kid, iss: 'nsignage', ...claims, iat, nbf: iat - 30, exp: Math.min(iat + ttlS, claims.dl || Infinity) };
  const payload = b64u(JSON.stringify(body));
  const sig = crypto.sign(null, Buffer.from(`nst1.${payload}`), k.privateKey);
  return { ticket: `nst1.${payload}.${b64u(sig)}`, claims: body };
}

/** Verify (tests and diagnostics; the Pi does its own verification). Returns claims or throws. */
export function verifyTicket(ticket, { now = Date.now(), keys = ticketPublicKeys() } = {}) {
  const m = /^nst1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(ticket || ''));
  if (!m) throw new Error('malformed');
  const claims = JSON.parse(Buffer.from(m[1], 'base64url').toString());
  const key = keys.find((x) => x.kid === claims.kid);
  if (!key) throw new Error('unknown key');
  const pub = crypto.createPublicKey({ key: Buffer.concat([RAW_ED25519_SPKI_PREFIX, Buffer.from(key.publicKey, 'base64url')]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(`nst1.${m[1]}`), pub, Buffer.from(m[2], 'base64url'))) throw new Error('bad signature');
  const t = Math.floor(now / 1000);
  if (t < claims.nbf || t >= claims.exp) throw new Error('expired');
  return claims;
}

/** New Ed25519 key for NSIGNAGE_TICKET_KEY (staff script). */
export function generateTicketKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(RAW_ED25519_SPKI_PREFIX.length);
  return { privateKeyB64: der.toString('base64'), publicKey: b64u(publicRaw), kid: keyId(publicRaw) };
}

/** Tests only. */
export function resetTicketKeyCache() { cached = null; }
