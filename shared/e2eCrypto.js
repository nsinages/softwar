// =============================================
// N Signage — end-to-end encryption of media chunks (browser → Pi receiver)
//
// Runs in the browser and in Node 20+ (WebCrypto only, no dependencies). The
// Pi side is N-Signage/upload-receiver/receiver.py; both MUST stay in step.
//
//   receiver key   P-256 key pair generated ON the Pi; only the public key leaves it
//   per transfer   the browser makes a one-time P-256 key pair (epk)
//   chunk key      HKDF-SHA256(ECDH(epk, receiver), salt = transferId,
//                  info = "nsignage-media-v1|<deviceId>") → AES-256-GCM key
//                  (non-extractable: it never leaves the browser's crypto engine)
//   chunk i        AES-256-GCM, iv = 8 zero bytes ‖ uint32be(i)   (unique per key)
//                  aad = "nsignage-v1|<deviceId>|<transferId>|<i>|<plainLen>|<size>|<sha256>"
//                  → a chunk cannot be moved, reordered, truncated or reused elsewhere
// The website sees only public keys and metadata; Cloudflare sees only ciphertext.
// =============================================

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export function b64uEncode(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (bytes) => hex(await subtle().digest('SHA-256', bytes));

export const chunkAad = ({ deviceId, transferId, index, plainLen, size, sha256 }) =>
  enc.encode(`nsignage-v1|${deviceId}|${transferId}|${index}|${plainLen}|${size}|${sha256}`);

export function chunkIv(index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('chunk index out of range');
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

/** SHA-256 fingerprint (hex) of a receiver public key, as the website shows it. */
export const receiverFingerprint = async (publicKeyB64u) => sha256Hex(b64uDecode(publicKeyB64u));

/**
 * One-time session for one transfer to one Pi. Returns { epk, epkHash, encryptChunk }.
 * The derived AES key is non-extractable and is never returned.
 */
export async function createUploadSession({ receiverPublicKey, deviceId, transferId }) {
  const raw = b64uDecode(receiverPublicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('invalid receiver key');
  const piKey = await subtle().importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epkRaw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { epk: b64uEncode(epkRaw), epkHash: await sha256Hex(epkRaw), pair, piKey, deviceId, transferId: transferId || null };
}

/** Bind the session to its transfer id (known only after create) and derive the chunk key. */
export async function deriveChunkKey(session, transferId) {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: session.piKey }, session.pair.privateKey, 256);
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(transferId), info: enc.encode(`nsignage-media-v1|${session.deviceId}`) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  return { ...session, transferId, key };
}

/** Encrypt chunk `index` (plaintext Uint8Array) → ciphertext + 16-byte tag. */
export async function encryptChunk(keyed, { index, plain, size, sha256 }) {
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: chunkIv(index), additionalData: chunkAad({ deviceId: keyed.deviceId, transferId: keyed.transferId, index, plainLen: plain.byteLength, size, sha256 }), tagLength: 128 },
    keyed.key, plain,
  );
  return new Uint8Array(ct);
}
