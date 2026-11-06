// =============================================
// N Signage — the real /api functions inside the Vite DEV server (npm run dev)
//
// Development only: `vite build` and Vercel never load this file. It serves the
// same Vercel-style handlers from api/ that production uses, against the database
// in DATABASE_URL (read from a git-ignored env file). Nothing here reaches the
// browser bundle: only VITE_* variables are exposed by Vite, and none is set here.
// =============================================
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROUTES = ['auth', 'devices', 'device', 'find', 'transfer', 'health', 'pi/sync', 'pi/pairing', 'cron/cleanup'];

/** Load KEY=value lines into process.env (existing values win). Returns false if the file is missing. */
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return true;
}

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
