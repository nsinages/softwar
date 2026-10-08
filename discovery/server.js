// =============================================
// N Signage V3 — Standalone Discovery Helper Server
//
// Use this when the website is served as a static build (no Vite server).
// Run it on any computer on the SAME Wi-Fi/LAN as the Raspberry Pi:
//
//   npm run discovery            (listens on 0.0.0.0:5055)
//   DISCOVERY_PORT=6000 npm run discovery
//
// Then build the website with VITE_DISCOVERY_URL=http://<helper-ip>:5055/discovery-api
// =============================================

import http from 'node:http';
import { discoveryRequestHandler } from './piDiscovery.js';

const PORT = Number(process.env.DISCOVERY_PORT) || 5055;
const PREFIX = '/discovery-api';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!req.url?.startsWith(PREFIX)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  req.url = req.url.slice(PREFIX.length) || '/';
  discoveryRequestHandler(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PI DISCOVERY] Helper listening on http://0.0.0.0:${PORT}${PREFIX}`);
});
