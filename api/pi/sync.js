// POST /api/pi/sync — called every few seconds by cloud_agent.py on each Pi.
// Auth: `Authorization: Bearer <device secret>` (separate from customer logins).
// The first sync of a device id registers the secret (stored as SHA-256);
// every later sync must present the same one.
//
// Body (agent 1.0): { deviceId, username, hostname, localIp, port, media,
//                     agentVersion, results }
// Optional (agent protocol 2, see docs/PI-AGENT-V2-CONTRACT.md):
//                   { protocol: 2, capabilities: [...], storage: { freeBytes, totalBytes },
//                     progress: [{ transferId, receivedBytes }] }
// Response: { ok, serverTime, commands, pollSeconds, registered }
//   registered: true when this Pi belongs to a customer account. Agents with the
//   'pairing' capability use it to stop/start showing a pairing code; older
//   agents ignore it.
//
// One database transaction per sync: authenticate/register (system context),
// then everything else in the Pi's own 'device' RLS context.
import {
  sha256, safeEqual, clientIp, networkKey, send, handleError, httpError, readJsonBody, bearerSecret,
  DEVICE_ID_RX, cleanReport, cleanResults, canReplaceSecret, IDLE_POLL_SECONDS, BUSY_POLL_SECONDS,
} from '../_lib/cloud.js';
import { withContext, setContext, ms } from '../_lib/db.js';
import {
  applyCommandResults, applyTransferProgress, pendingCommandsForPi, deleteRelayCopies,
} from '../_lib/transfers.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const body = readJsonBody(req);
    const deviceId = String(body.deviceId || '');
    if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
    const secretHash = sha256(bearerSecret(req));
    const report = cleanReport(body);
    const results = cleanResults(body.results);
    const net = networkKey(clientIp(req));
    const mediaJson = JSON.stringify(report.media);
    const mediaHash = sha256(mediaJson);

    let deleteUrls = [];
    let registered = false;
    const commands = await withContext('none', {}, async (t) => {
      // ---- authenticate or register (system context) ----
      await setContext(t, 'system');
      const [existing] = await t`
        select d.id, d.secret_hash, d.owner_id, d.last_seen_at, host(d.local_ip) as local_ip,
               exists (select 1 from nsignage.legacy_browser_devices l where l.device_id = d.id) as legacy_claimed
        from nsignage.devices d where d.id = ${deviceId} for update`;
      if (!existing) {
        await t`insert into nsignage.devices (id, secret_hash, pi_username) values (${deviceId}, ${secretHash}, ${report.username})`;
        console.log('[N-SIGNAGE CLOUD] new device registered', deviceId);
      } else if (!existing.secret_hash) {
        await t`update nsignage.devices set secret_hash = ${secretHash} where id = ${deviceId}`;
      } else if (!safeEqual(existing.secret_hash, secretHash)) {
        // A re-flashed SD card creates a new secret. Accept it only for a Pi that
        // no account (or legacy browser) has claimed and that has been silent for
        // a while; otherwise its owner must remove it first (that clears the secret).
        const owned = Boolean(existing.owner_id) || existing.legacy_claimed;
        if (!canReplaceSecret({ secretHash: existing.secret_hash, lastSeen: ms(existing.last_seen_at) }, owned)) {
          console.warn('[N-SIGNAGE CLOUD] sync rejected: secret mismatch', deviceId);
          throw httpError(401, 'Device secret does not match. Remove this Pi on the website (Devices → delete), then it can re-register.', 'bad-device-secret');
        }
        console.warn('[N-SIGNAGE CLOUD] device secret replaced for an unclaimed Pi', deviceId);
        await t`insert into nsignage.device_events (device_id, event_type) values (${deviceId}, 'secret-replaced')`;
        await t`update nsignage.devices set secret_hash = ${secretHash} where id = ${deviceId}`;
      }

      registered = Boolean(existing?.owner_id);
      // ---- everything else as this Pi only ----
      await setContext(t, 'device', { device: deviceId });
      await t`
        update nsignage.devices set
          pi_username = ${report.username}, hostname = ${report.hostname}, local_ip = ${report.localIp},
          api_port = ${report.port}, agent_version = ${report.agentVersion}, agent_protocol = ${report.protocol},
          capabilities = ${report.capabilities}::text[], current_media = ${report.currentMedia},
          storage_free_bytes = ${report.storage?.freeBytes ?? null}, storage_total_bytes = ${report.storage?.totalBytes ?? null},
          media = case when media_hash is distinct from ${mediaHash} then ${t.json(report.media)} else media end,
          media_hash = ${mediaHash},
          last_seen_at = now()
        where id = ${deviceId}`;
      // Connection history (only on changes, not on every heartbeat)
      if (existing && report.localIp && existing.local_ip && existing.local_ip !== report.localIp) {
        await t`insert into nsignage.device_events (device_id, event_type, ip_address, details)
                values (${deviceId}, 'ip-changed', ${report.localIp}::inet, ${t.json({ previous: existing.local_ip })})`;
      }
      if (!existing || Date.now() - ms(existing.last_seen_at) > 5 * 60_000) {
        await t`insert into nsignage.device_events (device_id, event_type, ip_address, details)
                values (${deviceId}, 'online', ${report.localIp}::inet, ${t.json({ agentVersion: report.agentVersion })})`;
      }
      if (net) {
        // Find Pi index; refreshed at most every 30 s per network
        await t`
          insert into nsignage.device_network_sightings (device_id, net_key) values (${deviceId}, ${net})
          on conflict (device_id, net_key) do update set seen_at = now()
          where nsignage.device_network_sightings.seen_at < now() - interval '30 seconds'`;
      }
      deleteUrls = await applyCommandResults(t, deviceId, results);
      await applyTransferProgress(t, deviceId, body.progress);
      return pendingCommandsForPi(t, deviceId);
    });
    await deleteRelayCopies(deleteUrls); // the Pi confirmed: remove relay copies after the commit

    send(res, 200, {
      ok: true,
      serverTime: Date.now(),
      commands,
      pollSeconds: commands.length ? BUSY_POLL_SECONDS : IDLE_POLL_SECONDS,
      registered,
    });
  } catch (err) {
    handleError(res, err);
  }
}
