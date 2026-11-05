// /api/devices — the Raspberry Pis registered to the logged-in customer account.
//
//   GET                                          list this account's Pis (+ live status)
//   POST   { claimNonce, name?, location? }      Add Device found by Find Pi (same Wi-Fi proof)
//   POST   ?action=pair { code, name?, location? }   Add Device with the pairing code shown on the Pi
//   GET    ?action=legacy                        Pis added in this browser before accounts existed
//   POST   ?action=link-legacy { deviceId, code? }   link one of those to this account
//   PATCH  ?deviceId=<id> { name?, location? }   rename
//   DELETE ?deviceId=<id>                        unregister (media on the Pi is not touched)
//
// Ownership is always proven, never assumed:
//   - Find Pi: the browser and the Pi share the same public network right now
//     (single-use 3-minute nonce bound to this account and that network), or
//   - pairing code: the customer can read the code on that display's screen.
// Every ownership change is ONE database transaction; claims are single
// UPDATE … WHERE owner_id IS NULL statements, so a Pi can never get two owners.
import {
  send, handleError, httpError, readJsonBody, requireSameOrigin, clientIp, networkKey, publicView, sha256, keyHash,
  NEARBY_WINDOW_MS, DEVICE_ID_RX, networkClaimEnabled, deviceFromRow,
} from './_lib/cloud.js';
import { withCustomer, requireUser, linkDevice, legacyBrowserId, requireOwnedDevice } from './_lib/auth.js';
import { setContext, rateLimit } from './_lib/db.js';
import { redeemPairCode } from './_lib/pairing.js';
import { cancelDeviceTransfers, deleteRelayCopies } from './_lib/transfers.js';

const NONCE_RX = /^[A-Za-z0-9_-]{20,100}$/;

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '';
}

function view(device, now = Date.now()) {
  return {
    ...publicView(device, now),
    name: device.nickname || '',
    location: device.location || '',
    addedAt: device.addedAt || null,
    via: device.addedVia || null,
  };
}

async function list(t, user) {
  const rows = await t`select * from nsignage.devices where owner_id = ${user.id} order by added_at`;
  const now = Date.now();
  return { ok: true, devices: rows.map((r) => view(deviceFromRow(r), now)), networkClaim: networkClaimEnabled() };
}

/** Did this Pi sync from the caller's public network within the last 2 minutes? (system context) */
async function onSameNetwork(t, req, deviceId) {
  const net = networkKey(clientIp(req));
  if (!net) return false;
  const [r] = await t`select 1 from nsignage.device_network_sightings
                      where device_id = ${deviceId} and net_key = ${net}
                        and seen_at > now() - make_interval(secs => ${NEARBY_WINDOW_MS / 1000})`;
  return Boolean(r);
}

async function claimByNonce(t, req, user, body) {
  if (!networkClaimEnabled()) {
    throw httpError(403, 'Use the pairing code shown on the display to add it.', 'network-claim-disabled');
  }
  const nonce = String(body.claimNonce || '');
  if (!NONCE_RX.test(nonce)) throw httpError(400, 'Click "Find Pi" first, then Add Device.', 'missing-nonce');
  await setContext(t, 'system');
  // single use: the row is deleted as it is read
  const [grant] = await t`delete from nsignage.claim_nonces
                          where nonce_hash = ${sha256(nonce)} and expires_at > now() returning *`;
  if (!grant || grant.user_id !== user.id) {
    throw httpError(410, 'This search result has expired. Click "Find Pi" again.', 'nonce-expired');
  }
  if (grant.net_key !== networkKey(clientIp(req))) {
    throw httpError(403, 'Your network changed since the search. Connect to the same Wi-Fi as the Pi and click "Find Pi" again.', 'network-changed');
  }
  const [d] = await t`select last_seen_at from nsignage.devices where id = ${grant.device_id}`;
  if (!d || Date.now() - d.last_seen_at.getTime() > NEARBY_WINDOW_MS) {
    throw httpError(409, 'The Raspberry Pi went offline. Check its power and Wi-Fi, then click "Find Pi" again.', 'pi-offline');
  }
  const device = await linkDevice(t, user, grant.device_id, {
    name: cleanText(body.name, 64), location: cleanText(body.location, 80), via: 'network',
  });
  return { ok: true, device: view(device) };
}

async function claimByCode(t, user, body) {
  await setContext(t, 'system');
  const deviceId = await redeemPairCode(t, body.code, user.id);
  const device = await linkDevice(t, user, deviceId, {
    name: cleanText(body.name, 64), location: cleanText(body.location, 80), via: 'pairing-code',
  });
  return { ok: true, device: view(device) };
}

// ---- One-time link of devices added before accounts existed --------------------

async function legacyList(t, req, user) {
  await setContext(t, 'system');
  const browserId = await legacyBrowserId(t, req);
  if (!browserId) return { ok: true, available: false, devices: [] };
  const rows = await t`
    select l.device_id, l.name, l.location, d.owner_id, d.hostname, d.pi_username, d.last_seen_at, d.capabilities
    from nsignage.legacy_browser_devices l join nsignage.devices d on d.id = l.device_id
    where l.browser_id = ${browserId}
    order by l.added_at nulls last
    limit 100`;
  const now = Date.now();
  const devices = [];
  for (const r of rows) {
    const status = r.owner_id === user.id ? 'linked' : r.owner_id ? 'other-account' : 'linkable';
    devices.push({
      deviceId: r.device_id,
      name: r.name || r.hostname || '',
      location: r.location || '',
      hostname: r.hostname || null,
      username: r.pi_username,
      online: now - r.last_seen_at.getTime() < 60_000,
      status,
      sameNetwork: status === 'linkable' ? await onSameNetwork(t, req, r.device_id) : false,
      pairingSupported: (r.capabilities || []).includes('pairing'),
    });
  }
  return { ok: true, available: true, devices };
}

async function linkLegacy(t, req, user, body) {
  const deviceId = String(body.deviceId || '');
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
  await setContext(t, 'system');
  const browserId = await legacyBrowserId(t, req);
  if (!browserId) {
    throw httpError(403, 'Open this website in the browser you used before accounts existed to link its devices.', 'no-legacy-session');
  }
  // 1. This browser really added the Pi under the old system
  const [legacy] = await t`select name, location from nsignage.legacy_browser_devices
                           where browser_id = ${browserId} and device_id = ${deviceId}`;
  if (!legacy) throw httpError(404, 'This Raspberry Pi was not added in this browser.', 'not-legacy-owner');
  // 2. A second, current proof of control: pairing code, or being on the Pi's network now
  let via;
  if (body.code) {
    await redeemPairCode(t, body.code, user.id, deviceId);
    via = 'legacy+pairing-code';
  } else if (await onSameNetwork(t, req, deviceId)) {
    via = 'legacy+network';
  } else {
    throw httpError(403, 'To confirm this display is yours, connect this phone or computer to the same Wi-Fi as the display (or enter the pairing code shown on it), then try again.', 'verify-required');
  }
  const device = await linkDevice(t, user, deviceId, { name: legacy.name || '', location: legacy.location || '', via });
  return { ok: true, device: view(device) };
}

// ---- Rename / unregister ---------------------------------------------------------

async function rename(t, req, user, deviceId) {
  const current = await requireOwnedDevice(t, user, deviceId);
  const body = readJsonBody(req);
  const name = body.name !== undefined ? cleanText(body.name, 64) || current.nickname : current.nickname;
  const location = body.location !== undefined ? cleanText(body.location, 80) : current.location;
  // RLS + guard trigger: a customer can only change nickname/location of their own Pi
  const [r] = await t`update nsignage.devices set nickname = ${name || null}, location = ${location || null}
                      where id = ${deviceId} and owner_id = ${user.id} returning *`;
  return { ok: true, device: view(deviceFromRow(r)) };
}

async function remove(t, user, deviceId) {
  await requireOwnedDevice(t, user, deviceId);
  await setContext(t, 'system');
  const urls = await cancelDeviceTransfers(t, deviceId, 'Device removed from the account');
  await t`update nsignage.device_commands set state = 'withdrawn' where device_id = ${deviceId} and state = 'queued'`;
  await t`delete from nsignage.pairing_codes where device_id = ${deviceId}`;
  await t`delete from nsignage.legacy_browser_devices where device_id = ${deviceId}`;
  const legacy = await t`select url from nsignage.legacy_relay_copies where device_id = ${deviceId} and deleted_at is null`;
  // Unclaim, and let the Pi register a fresh secret (SD card re-flash). Files on the Pi are NOT deleted.
  const [r] = await t`update nsignage.devices
                      set owner_id = null, added_at = null, added_via = null, nickname = null, location = null, secret_hash = null
                      where id = ${deviceId} and owner_id = ${user.id} returning id`;
  if (!r) throw httpError(404, 'This Raspberry Pi is not registered to your account.', 'not-owner');
  await t`insert into nsignage.security_events (event, user_id, device_id) values ('device-removed', ${user.id}, ${deviceId})`;
  console.log('[N-SIGNAGE CLOUD] device removed', JSON.stringify({ user: user.id, deviceId }));
  return { result: { ok: true }, urls: [...urls, ...legacy.map((x) => x.url)] };
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '');
    const deviceId = String(req.query?.deviceId || '');
    if (req.method !== 'GET') requireSameOrigin(req);
    const body = req.method === 'POST' ? readJsonBody(req) : {};

    // Rate limits run in their own committed transactions BEFORE the main one:
    // a failed claim must not roll them back, and nesting would hold two connections.
    const claiming = req.method === 'POST' && ['pair', 'link-legacy', ''].includes(action);
    if (claiming) {
      const { user } = await requireUser(req);
      const usesCode = action === 'pair' || Boolean(body.code);
      if (usesCode) await rateLimit('pair-ip', keyHash(clientIp(req)), 20, 600);
      const [bucket, limit] = usesCode ? ['pair-user', 10] : action === 'link-legacy' ? ['link-legacy', 30] : ['claim', 20];
      await rateLimit(bucket, keyHash(user.id), limit, 600);
    }

    let urls = [];
    const result = await withCustomer(req, async (t, { user }) => {
      if (req.method === 'GET' && action === 'legacy') return legacyList(t, req, user);
      if (req.method === 'GET') return list(t, user);
      if (req.method === 'POST') {
        if (action === 'pair') return claimByCode(t, user, body);
        if (action === 'link-legacy') return linkLegacy(t, req, user, body);
        if (!action) return claimByNonce(t, req, user, body);
        throw httpError(404, 'Unknown action');
      }
      if (req.method === 'PATCH') return rename(t, req, user, deviceId);
      if (req.method === 'DELETE') {
        const r = await remove(t, user, deviceId);
        urls = r.urls;
        return r.result;
      }
      throw httpError(405, 'Method not allowed');
    });
    if (urls.length) await deleteRelayCopies(urls); // after the commit
    send(res, 200, result);
  } catch (err) {
    handleError(res, err);
  }
}
