// =============================================
// N Signage — Production server
//
// Serves the built website (dist/) and, on the same origin, the two LAN
// helpers the browser cannot do itself:
//   /pi-proxy/<ip>/<port>/...   → Raspberry Pi Flask API (server/piProxy.js)
//   /discovery-api/...          → Pi discovery (discovery/piDiscovery.js)
//
// Run it on a computer on the SAME network as the Raspberry Pis:
//   npm run build && npm start          (listens on 0.0.0.0:8080)
//   PORT=3000 HOST=0.0.0.0 npm start
// =============================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piProxyHandler } from './piProxy.js';
import { discoveryRequestHandler } from '../discovery/piDiscovery.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const INDEX = path.join(DIST, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function mount(prefix, handler) {
  return (req, res) => {
    req.url = req.url.slice(prefix.length) || '/';
    handler(req, res);
  };
}

const proxy = mount('/pi-proxy', piProxyHandler);
const discovery = mount('/discovery-api', discoveryRequestHandler);

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  const filePath = path.resolve(DIST, '.' + pathname);
  const inDist = filePath === DIST || filePath.startsWith(DIST + path.sep);
  let target = INDEX;
  if (inDist && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    target = filePath;
  } else if (path.extname(pathname)) {
    // A missing asset is a real 404, not the SPA shell
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const isHashedAsset = target.startsWith(path.join(DIST, 'assets') + path.sep);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(target).pipe(res);
}

if (!fs.existsSync(INDEX)) {
  console.error(`[N-SIGNAGE] ${INDEX} not found. Run "npm run build" first.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/pi-proxy/')) return proxy(req, res);
  if (url.startsWith('/discovery-api/')) return discovery(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[N-SIGNAGE] Serving ${DIST} on http://${HOST}:${PORT}`);
});
