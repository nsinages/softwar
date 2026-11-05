// =============================================
// N Signage — Relay storage (Vercel Blob) adapter
//
// Media passes through Vercel Blob only transiently: the browser uploads it,
// the Pi downloads it, and the copy is deleted when the Pi confirms (or when
// the transfer expires). Nothing here is a media library.
//
// Access mode (NSIGNAGE_BLOB_ACCESS):
//   public  (default) works with every installed Pi (agent 1.0 only accepts
//           *.public.blob.vercel-storage.com). The URL contains a random
//           transfer id + random suffix, is given only to the authenticated
//           Pi, never to browsers, and the blob is deleted after delivery.
//   private requires a private Blob store AND Pis that announce the
//           "private-blob" capability (agent protocol 2). The Pi then gets a
//           short-lived presigned GET URL on every sync.
//
// The backend is swappable (setBlobBackend) so tests can run without Vercel.
// =============================================
import { head, del, list, issueSignedToken, presignUrl } from '@vercel/blob';

export function blobAccess() {
  return String(process.env.NSIGNAGE_BLOB_ACCESS || 'public').toLowerCase() === 'private' ? 'private' : 'public';
}

export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

const HOST_RX = {
  public: /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i,
  private: /^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$/i,
};

/** Pathname of a blob URL in this store's access mode, or null if it is not one. */
export function blobPathname(url, access = blobAccess()) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOST_RX[access].test(u.hostname) || u.search || u.hash) return null;
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

const vercelBackend = {
  async head(url) {
    const h = await head(url);
    return h ? { size: h.size, contentType: h.contentType, pathname: h.pathname } : null;
  },
  async del(urls) {
    await del(urls);
  },
  async list(prefix, cursor) {
    const res = await list({ prefix, cursor, limit: 1000 });
    return {
      blobs: res.blobs.map((b) => ({ url: b.url, pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt).getTime() })),
      cursor: res.hasMore ? res.cursor : null,
    };
  },
  /** First `n` bytes of a blob (content check). */
  async readPrefix(url, n, access) {
    const headers = { Range: `bytes=0-${n - 1}` };
    if (access === 'private') headers.Authorization = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Blob read failed (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer()).subarray(0, n);
  },
  /** Short-lived GET URL for a private blob (never used in public mode). */
  async presignGet(pathname, validUntil) {
    const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
    return presignedUrl;
  },
};

let backend = vercelBackend;

/** Tests only: replace the storage backend. */
export function setBlobBackend(b) {
  backend = b || vercelBackend;
}

export const blobStore = {
  head: (url) => backend.head(url),
  del: (urls) => backend.del(urls),
  list: (prefix, cursor) => backend.list(prefix, cursor),
  readPrefix: (url, n, access = blobAccess()) => backend.readPrefix(url, n, access),
  presignGet: (pathname, validUntil) => backend.presignGet(pathname, validUntil),
};

/** Delete without failing the caller; returns true when the blob is gone. */
export async function safeDelete(urls) {
  const arr = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!arr.length) return true;
  try {
    await blobStore.del(arr);
    return true;
  } catch (err) {
    console.warn('[N-SIGNAGE CLOUD] blob delete failed', err.message);
    return false;
  }
}
