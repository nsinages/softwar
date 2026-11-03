// =============================================
// N Signage — Raspberry Pi API proxy
//
// The browser talks to /pi-proxy/<ip>/<port>/<path> on the same origin and
// this forwards it to http://<ip>:<port>/<path>. Shared by the Vite dev
// server and the production server (server/index.js).
//
// Locked down so it cannot be used as an open proxy (SSRF):
//   - target must be a local-network IPv4 (no loopback, no 169.254.x.x)
//   - only the N-Signage API paths /api/* and /media/* are forwarded
//   - only a small allow-list of request headers is passed on
// =============================================

import http from 'node:http';
import { isLocalNetworkIPv4 } from '../discovery/piDiscovery.js';

const ROUTE_RX = /^\/(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,5})\/((?:api|media)\/[^?#]*)(\?.*)?$/;
const STATUS_TIMEOUT = 15000;
const UPLOAD_TIMEOUT = 10 * 60 * 1000;

const FORWARD_REQUEST_HEADERS = [
  'accept', 'content-type', 'content-length', 'range', 'if-range',
  'if-none-match', 'if-modified-since', 'x-api-key',
];
const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'cache-control', 'content-disposition',
];

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function isAllowedTarget(ip, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (ip.startsWith('127.') || ip.startsWith('169.254.') || ip.startsWith('0.')) return false;
  return isLocalNetworkIPv4(ip);
}

/**
 * Connect/Express style middleware. `req.url` is relative to the mount
 * point, e.g. "/10.10.40.94/5000/api/status".
 */
export function piProxyHandler(req, res) {
  const match = (req.url || '').match(ROUTE_RX);
  if (!match) {
    sendJson(res, 400, { error: 'Invalid Pi proxy URL' });
    return;
  }

  const [, ip, portStr, path, query = ''] = match;
  const port = Number(portStr);
  if (!isAllowedTarget(ip, port)) {
    sendJson(res, 403, { error: 'Target is not a local-network Raspberry Pi address' });
    return;
  }
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
    sendJson(res, 400, { error: 'Invalid path' });
    return;
  }

  const method = req.method || 'GET';
  if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const headers = { host: `${ip}:${port}` };
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }

  const isUpload = method === 'POST' && path === 'api/upload';
  const proxyReq = http.request(
    {
      hostname: ip,
      port,
      path: `/${path}${query}`,
      method,
      headers,
      timeout: isUpload ? UPLOAD_TIMEOUT : STATUS_TIMEOUT,
    },
    (proxyRes) => {
      const resHeaders = { 'x-content-type-options': 'nosniff' };
      for (const name of FORWARD_RESPONSE_HEADERS) {
        if (proxyRes.headers[name] !== undefined) resHeaders[name] = proxyRes.headers[name];
      }
      res.writeHead(proxyRes.statusCode || 502, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('timeout', () => proxyReq.destroy(new Error('Pi connection timeout')));
  proxyReq.on('error', (err) => {
    console.error(`[PI PROXY] ${method} ${ip}:${port}/${path} - ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Pi unreachable', message: err.message });
    } else {
      res.destroy();
    }
  });
  // Abort the upstream request if the browser goes away mid-transfer
  res.on('close', () => {
    if (!res.writableFinished) proxyReq.destroy();
  });

  req.pipe(proxyReq);
}
