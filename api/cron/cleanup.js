// GET /api/cron/cleanup — scheduled by vercel.json (daily; Vercel Hobby allows
// one run per day). Expires abandoned transfers, deletes relay copies that no
// active transfer needs, and purges expired rows (sessions, nonces, pairing
// codes, rate limits, old security events and finished transfers).
//
// Auth: Vercel sends `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET
// configured the endpoint refuses to run.
import { send, handleError, httpError, safeEqual } from '../_lib/cloud.js';
import { asSystem } from '../_lib/db.js';
import { blobConfigured } from '../_lib/blobStore.js';
import { expireTransfers, sweepOrphanBlobs, deleteRelayCopies } from '../_lib/transfers.js';

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw httpError(503, 'CRON_SECRET is not configured', 'cron-not-configured');
    if (!safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) throw httpError(401, 'Unauthorized');

    let checked = 0; let expired = 0; let copiesDeleted = 0;
    for (let i = 0; i < 20; i += 1) { // up to 2000 per run
      const batch = await asSystem((t) => expireTransfers(t, 100));
      checked += batch.checked;
      expired += batch.expired;
      copiesDeleted += await deleteRelayCopies(batch.deleteAfterCommit);
      if (batch.checked < 100) break;
    }
    const sweep = blobConfigured() ? await sweepOrphanBlobs() : { skipped: 'blob-not-configured' };
    const purged = await asSystem(async (t) => {
      const [{ r }] = await t`select nsignage.purge_expired() as r`;
      const sightings = await t`delete from nsignage.device_network_sightings where seen_at < now() - interval '15 minutes' returning 1`;
      return { ...r, sightings: sightings.length };
    });
    const out = { checked, expired, copiesDeleted, ...sweep, purged };
    console.log('[N-SIGNAGE CRON] cleanup', JSON.stringify(out));
    send(res, 200, { ok: true, ...out });
  } catch (err) {
    handleError(res, err);
  }
}
