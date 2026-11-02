import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'http'
import { discoveryRequestHandler } from './discovery/piDiscovery.js'

function piProxyPlugin() {
  return {
    name: 'pi-proxy',
    

    configureServer(server) {
      server.middlewares.use('/pi-proxy', (req, res) => {
        const match = req.url?.match(/^\/([^/]+)\/(\d+)\/(.*)$/)

        if (!match) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            error: 'Invalid Pi proxy URL',
            received: req.url
          }))
          return
        }

        const [, ip, port, path] = match

        console.log(
          `[PI PROXY] ${req.method || 'GET'} http://${ip}:${port}/${path}`
        )

        // Strip hop-by-hop headers that must not be forwarded
        const HOP_BY_HOP = new Set([
          'connection', 'keep-alive', 'transfer-encoding',
          'te', 'trailer', 'upgrade', 'proxy-authorization',
          'proxy-authenticate',
        ])
        const forwardHeaders = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) {
            forwardHeaders[k] = v
          }
        }
        forwardHeaders['host'] = `${ip}:${port}`

        const proxyReq = http.request(
          {
            hostname: ip,
            port: Number(port),
            path: `/${path}`,
            method: req.method || 'GET',
            headers: forwardHeaders,
            // Use a longer timeout for upload requests (file transfers)
            timeout: ((req.method === 'POST' || req.method === 'PUT') && path.includes('upload')) ? 300000 : 15000
          },
          (proxyRes) => {
            console.log(`[PI PROXY RESPONSE] ${ip}:${port}/${path} -> HTTP ${proxyRes.statusCode}`)
            // Also strip hop-by-hop from the response before sending to browser
            const resHeaders = {}
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (!HOP_BY_HOP.has(k.toLowerCase())) {
                resHeaders[k] = v
              }
            }
            // Ensure CORS headers so browser accepts the proxied response
            resHeaders['access-control-allow-origin'] = '*'

            res.writeHead(proxyRes.statusCode || 502, resHeaders)
            proxyRes.pipe(res)
          }
        )

        proxyReq.on('timeout', () => {
          proxyReq.destroy(new Error('Pi connection timeout'))
        })

        proxyReq.on('error', (err) => {
          console.error(
            `[PI PROXY ERROR] ${ip}:${port} - ${err.message}`
          )

          if (!res.headersSent) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'Pi unreachable',
              pi: ip,
              port: Number(port),
              message: err.message
            }))
          }
        })

        req.pipe(proxyReq)
      })
    }
  }
}

// V3: LAN Pi discovery helper (mDNS / DNS-SD). Browsers cannot do this
// themselves, so the server that hosts the site answers /discovery-api/*.
function piDiscoveryPlugin() {
  return {
    name: 'pi-discovery',
    configureServer(server) {
      server.middlewares.use('/discovery-api', discoveryRequestHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/discovery-api', discoveryRequestHandler)
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    piProxyPlugin(),
    piDiscoveryPlugin()
  ],

  server: {
    host: '0.0.0.0',
    port: 5173
  }
})