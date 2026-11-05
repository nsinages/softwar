// GET /api/cron/cleanup — scheduled by vercel.json (daily; Vercel Hobby allows
// one run per day). Expires abandoned transfers and deletes relay copies that
// no active transfer needs. Transfers are also expired opportunistically when
// new ones are created.
//
// Auth: Vercel sends `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET
// configured the endpoint refuses to run.
import { send, handleError, httpError, safeEqual } from '../_lib/cloud.js';
import { blobConfigured } from '../_lib/blobStore.js';
import { expireTransfers, sweepOrphanBlobs } from '../_lib/transfers.js';

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw httpError(503, 'CRON_SECRET is not configured', 'cron-not-configured');
    if (!safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) throw httpError(401, 'Unauthorized');

    let expired = { checked: 0, expired: 0, copiesDeleted: 0 };
    for (let i = 0; i < 20; i += 1) { // up to 2000 per run
      const batch = await expireTransfers({ limit: 100 });
      expired = {
        checked: expired.checked + batch.checked,
        expired: expired.expired + batch.expired,
        copiesDeleted: expired.copiesDeleted + batch.copiesDeleted,
      };
      if (batch.checked < 100) break;
    }
    const sweep = blobConfigured() ? await sweepOrphanBlobs() : { skipped: 'blob-not-configured' };
    console.log('[N-SIGNAGE CRON] cleanup', JSON.stringify({ ...expired, ...sweep }));
    send(res, 200, { ok: true, ...expired, ...sweep });
  } catch (err) {
    handleError(res, err);
  }
}
