// =============================================
// N Signage — the real /api functions inside the Vite DEV server (npm run dev)
//
// Development only: `vite build` and Vercel never load this file. It serves the
// same Vercel-style handlers from api/ that production uses, against the database
// in DATABASE_URL (from the git-ignored `.env`). Nothing here reaches the
// browser bundle: only VITE_* variables are exposed by Vite, and none is set here.
// =============================================
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export { loadEnvFile } from './env.mjs';

const ROUTES = ['auth', 'devices', 'device', 'find', 'transfer', 'health', 'pi/sync', 'pi/pairing', 'cron/cleanup'];

/** Connect-style middleware: /api/<route> → api/<route>.js default export. */
export function apiMiddleware(root) {
  const handlers = {};
  const load = async (name) => {
    handlers[name] ||= (await import(pathToFileURL(path.join(root, 'api', `${name}.js`)).href)).default;
    return handlers[name];
  };
  return (req, res, next) => {
    const u = new URL(req.url, 'http://localhost');
    if (!u.pathname.startsWith('/api/')) return next();
    const name = u.pathname.slice(5).replace(/\/$/, '');
    if (!ROUTES.includes(name)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":false,"error":"Not found"}');
      return undefined;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        req.query = Object.fromEntries(u.searchParams);
        const ct = String(req.headers['content-type'] || '');
        req.body = ct.includes('json') && raw.length ? JSON.parse(raw.toString()) : raw.toString();
        req.headers['x-real-ip'] = req.socket.remoteAddress || '127.0.0.1'; // never trust a client-sent header
        await (await load(name))(req, res);
      } catch (err) {
        console.error('[dev api]', err.message);
        if (!res.headersSent) { res.statusCode = 500; res.end('{"ok":false,"error":"Server error"}'); }
      }
    });
    return undefined;
  };
}
