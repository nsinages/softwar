// GET /api/health — is the cloud relay configured and reachable?
// Reports only true/false flags; never returns or logs secret values.
import { redis, redisConfigured, send } from './_lib/cloud.js';

export default async function handler(req, res) {
  const blob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const configured = redisConfigured();
  let reachable = false;
  let error;
  if (configured) {
    try {
      reachable = (await redis().ping()) === 'PONG';
    } catch (err) {
      error = 'Redis is configured but not reachable';
      console.error('[N-SIGNAGE CLOUD] health: redis ping failed', err.message);
    }
  }
  const ok = configured && reachable;
  send(res, ok ? 200 : 503, {
    ok,
    redis: { configured, reachable },
    blob: { configured: blob },
    ...(!configured && { error: 'Upstash Redis is not connected to this Vercel project.' }),
    ...(error && { error }),
  });
}
