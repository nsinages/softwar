import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { piProxyHandler } from './server/piProxy.js'
import { discoveryRequestHandler } from './discovery/piDiscovery.js'

// Same-origin LAN helpers for `vite` / `vite preview`. In production the
// identical handlers are served by server/index.js (`npm start`).
function lanHelpersPlugin() {
  const mount = (server) => {
    server.middlewares.use('/pi-proxy', piProxyHandler)
    server.middlewares.use('/discovery-api', discoveryRequestHandler)
  }
  return {
    name: 'n-signage-lan-helpers',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

export default defineConfig({
  plugins: [
    react(),
    lanHelpersPlugin()
  ],

  build: {
    sourcemap: false,
  },

  server: {
    host: '0.0.0.0',
    port: 5173
  }
})
