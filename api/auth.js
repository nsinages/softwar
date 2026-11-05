// /api/auth?action=session — anonymous browser session for the hosted website.
// There is no login: the page calls this once on load, and the browser gets
// (or keeps) its HttpOnly session cookie. The Pis it adds are saved under it.
//
//   POST action=session  → { ok, browser: { id, createdAt }, created }
import {
  send, handleError, httpError, requireSameOrigin, rateLimit, clientIp,
} from './_lib/cloud.js';
import { ensureBrowser, currentBrowser } from './_lib/auth.js';

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    if (action !== 'session') throw httpError(404, 'Unknown action');
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    requireSameOrigin(req);
    // Only creating new sessions is rate limited; existing ones are free to refresh
    if (!(await currentBrowser(req))) await rateLimit('session', clientIp(req), 60, 3600);
    const { browser, created } = await ensureBrowser(req, res);
    send(res, 200, { ok: true, browser: { id: browser.id, createdAt: browser.createdAt }, created });
  } catch (err) {
    handleError(res, err);
  }
}
