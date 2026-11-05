// =============================================
// N Signage — Streaming SHA-256 for files of any size
//
// WebCrypto's digest() needs the whole file in memory, which is not workable
// for large videos on phones. This hashes the file in 4 MB slices with an
// incremental SHA-256 (FIPS 180-4), yielding to the UI between slices.
// Small files use WebCrypto (faster, native).
// =============================================

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.bytes = 0;
  }

  block(d, o) {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      w[i] = (d[o + i * 4] << 24) | (d[o + i * 4 + 1] << 16) | (d[o + i * 4 + 2] << 8) | d[o + i * 4 + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]; const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0]; let b = h[1]; let c = h[2]; let dd = h[3]; let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + dd) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  update(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    let i = 0;
    this.bytes += d.length;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, d.length);
      this.buf.set(d.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= d.length; i += 64) this.block(d, i);
    if (i < d.length) { this.buf.set(d.subarray(i), 0); this.bufLen = d.length - i; }
    return this;
  }

  hex() {
    const bitLen = this.bytes * 8;
    const pad = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bitLen / 2 ** 32); const lo = bitLen >>> 0;
    const n = pad.length;
    pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
    pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
    const bytes = this.bytes;
    this.update(pad);
    this.bytes = bytes;
    return [...this.h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

const SLICE = 4 * 1024 * 1024;
const WEBCRYPTO_MAX = 32 * 1024 * 1024;

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * SHA-256 of a File/Blob as lowercase hex.
 * @param {Blob} file
 * @param {{ onProgress?: (fraction:number)=>void, signal?: AbortSignal }} [opts]
 */
export async function sha256File(file, { onProgress, signal } = {}) {
  const abortIfNeeded = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  if (file.size <= WEBCRYPTO_MAX && globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    abortIfNeeded();
    onProgress?.(1);
    return toHex(digest);
  }
  const h = new Sha256();
  for (let off = 0; off < file.size; off += SLICE) {
    abortIfNeeded();
    h.update(new Uint8Array(await file.slice(off, off + SLICE).arrayBuffer()));
    onProgress?.(Math.min(1, (off + SLICE) / file.size));
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  return h.hex();
}

/** First bytes of a file, for the content (magic number) check before upload. */
export async function readHead(file, n = 32) {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}
