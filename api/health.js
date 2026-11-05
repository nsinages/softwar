// GET /api/health — is the website's backend configured and reachable?
// Reports only flags and the database role name; never returns or logs secrets.
//   200 when the database is reachable with the schema and RLS in place, else 503.
import { send } from './_lib/cloud.js';
import { databaseHealth } from './_lib/db.js';
import { blobAccess } from './_lib/blobStore.js';

export default async function handler(req, res) {
  const database = await databaseHealth();
  const ok = Boolean(database.reachable && database.schema && database.rlsOnAllTables && !database.roleBypassesRls);
  let error;
  if (!database.configured) error = 'The Supabase database is not connected (DATABASE_URL is missing).';
  else if (!database.reachable) error = 'The Supabase database is configured but not reachable.';
  else if (!database.schema) error = 'The database schema is missing. Run supabase/migrations on the Supabase project.';
  else if (!database.rlsOnAllTables || database.roleBypassesRls) error = 'Row Level Security is not fully enforced for the API role.';
  send(res, ok ? 200 : 503, {
    ok,
    database: { provider: 'supabase-postgres', ...database },
    blob: { configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN), access: blobAccess() },
    cron: { configured: Boolean(process.env.CRON_SECRET) },
    region: process.env.VERCEL_REGION || null,
    ...(error && { error }),
  });
}
