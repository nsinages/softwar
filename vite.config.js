import path from 'node:path'
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

// `npm run dev` = the CUSTOMER website (login, accounts, Supabase) with the real
// /api functions, like software.nsinages.in. The database comes from the
// git-ignored env file (default .env.supabase-test.local; override with
// NSIGNAGE_ENV_FILE). Dev server only: `vite build` never loads it.
function customerApiPlugin() {
  return {
    name: 'n-signage-customer-api',
    async configureServer(server) {
      const root = path.resolve('.')
      const { loadEnvFile, apiMiddleware } = await import('./scripts/lib/devApi.mjs')
      const envFile = process.env.NSIGNAGE_ENV_FILE || '.env.supabase-test.local'
      if (!loadEnvFile(envFile) && !process.env.DATABASE_URL) {
        server.config.logger.warn(`[n-signage] ${envFile} not found: /api will answer "database not configured". See docs/SUPABASE-SETUP.md.`)
      } else if (process.env.DATABASE_URL) {
        const u = new URL(process.env.DATABASE_URL)
        server.config.logger.info(`[n-signage] customer website with /api on ${u.hostname} as ${decodeURIComponent(u.username).split('.')[0]} (credentials not shown)`)
      }
      process.env.CRON_SECRET ||= 'local-dev-cron-secret'
      server.middlewares.use(apiMiddleware(root))
    },
  }
}

export default defineConfig(({ command, mode }) => {
  // Dev server: customer website by default; `vite --mode lan` (npm run dev:lan) = the
  // local-network dashboard. Builds keep choosing the mode at runtime from the host
  // name (public domain → customer website, localhost/LAN → local dashboard).
  const devMode = command === 'serve' ? (mode === 'lan' ? 'lan' : 'cloud') : null
  return {
    plugins: [
      react(),
      lanHelpersPlugin(),
      ...(devMode === 'cloud' ? [customerApiPlugin()] : []),
    ],

    ...(devMode && { define: { 'import.meta.env.VITE_CONNECTION_MODE': JSON.stringify(devMode) } }),

    build: {
      sourcemap: false,
    },

    server: {
      host: '0.0.0.0',
      port: 5173
    }
  }
})
