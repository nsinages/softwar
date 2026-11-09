// GET /api/health — is the website's backend configured and reachable?
// Reports only flags and the database role name; never returns or logs secrets.
//   200 when the database is reachable with the schema and RLS in place, else 503.
// Media never passes through the website: uploads go browser → Pi receiver,
// so the only upload setting here is the ticket signing key.
import { send } from './_lib/cloud.js';
import { databaseHealth } from './_lib/db.js';
import { ticketsConfigured, ticketPublicKeys } from './_lib/tickets.js';

export default async function handler(req, res) {
  const database = await databaseHealth();
  const ok = Boolean(database.reachable && database.schema && database.rlsOnAllTables && !database.roleBypassesRls);
  let error;
  if (!database.configured) error = 'The Supabase database is not connected (DATABASE_URL is missing).';
  else if (!database.reachable) error = 'The Supabase database is configured but not reachable.';
  else if (!database.schema) error = 'The database schema is missing. Run supabase/migrations on the Supabase project.';
  else if (!database.rlsOnAllTables || database.roleBypassesRls) error = 'Row Level Security is not fully enforced for the API role.';
  const keys = ticketPublicKeys();
  send(res, ok ? 200 : 503, {
    ok,
    database: { provider: 'supabase-postgres', ...database },
    upload: { mode: 'direct-e2e', ticketKey: ticketsConfigured(), keyId: keys[0]?.kid || null, mediaStoredOnWebsite: false },
    cron: { configured: Boolean(process.env.CRON_SECRET) },
    region: process.env.VERCEL_REGION || null,
    ...(error && { error }),
  });
}
