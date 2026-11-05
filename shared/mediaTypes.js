// =============================================
// N Signage — Supported media (shared by the website and the cloud API)
//
// Must stay in line with the Pi (N-Signage/app/config.py ALLOWED_EXTENSIONS).
// =============================================

export const MEDIA_TYPES = {
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  png: { mime: 'image/png', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  bmp: { mime: 'image/bmp', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  mp4: { mime: 'video/mp4', kind: 'video' },
  m4v: { mime: 'video/x-m4v', kind: 'video' },
  mov: { mime: 'video/quicktime', kind: 'video' },
  mkv: { mime: 'video/x-matroska', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
  avi: { mime: 'video/x-msvideo', kind: 'video' },
};

export const IMAGE_EXTS = Object.keys(MEDIA_TYPES).filter((e) => MEDIA_TYPES[e].kind === 'image');
export const VIDEO_EXTS = Object.keys(MEDIA_TYPES).filter((e) => MEDIA_TYPES[e].kind === 'video');

// MIME types browsers report for these files (some report nothing for mkv/avi)
const BROWSER_MIMES = new Set([
  ...Object.values(MEDIA_TYPES).map((t) => t.mime),
  'image/x-ms-bmp', 'image/pjpeg', 'video/avi', 'video/msvideo', 'video/x-mkv', 'application/x-matroska',
]);

/** Default relay limit; the Pi agent 1.0 refuses files over 500 MB. */
export const DEFAULT_MAX_UPLOAD_MB = 500;

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function mediaTypeOf(name) {
  return MEDIA_TYPES[extOf(name)] || null;
}

/** File name + browser-reported MIME type check. Returns an error message or ''. */
export function checkMediaFile(name, browserMime = '') {
  const t = mediaTypeOf(name);
  if (!t) {
    return `Unsupported file type. Allowed: ${[...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => e.toUpperCase()).join(', ')}.`;
  }
  if (browserMime && browserMime !== 'application/octet-stream' && !BROWSER_MIMES.has(browserMime)) {
    return `The file content type (${browserMime}) does not match a supported image or video.`;
  }
  return '';
}

/**
 * Same rules as the Pi agent's safe_filename(): basename only, letters,
 * digits and ". _ ( ) -" and spaces; never starts with "." (no hidden files,
 * no path traversal). Keeps the extension.
 */
export function safeMediaName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const ext = extOf(base);
  let stem = base.slice(0, base.length - (ext ? ext.length + 1 : 0));
  stem = stem.replace(/[^A-Za-z0-9._ ()-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 150).trim();
  return `${stem || 'media'}.${ext}`;
}

const ascii = (buf, start, len) => String.fromCharCode(...buf.slice(start, start + len));

/**
 * Magic-byte check of the first bytes of a file (≥ 12 bytes). Catches files
 * renamed to a media extension. Returns true when the content matches `ext`.
 */
export function contentMatches(ext, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return false;
  switch (ext) {
    case 'jpg': case 'jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'png': return b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a;
    case 'gif': return ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a';
    case 'bmp': return ascii(b, 0, 2) === 'BM';
    case 'webp': return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
    case 'avi': return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ';
    case 'mkv': case 'webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'mp4': case 'm4v': case 'mov':
      // ISO base media: box type at offset 4 (ftyp, or older QuickTime atoms)
      return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(ascii(b, 4, 4));
    default: return false;
  }
}
