// /api/devices — the Raspberry Pis registered to the logged-in customer account.
//
//   GET                                          list this account's Pis (+ live status)
//   POST   { claimNonce, name?, location? }      Add Device found by Find Pi (same Wi-Fi proof)
//   POST   ?action=pair { code, name?, location? }   Add Device with the pairing code shown on the Pi
//   POST   ?action=save { name, ip, hostname?, deviceUid?, code?, location? }
//                                                Add Device by name + IP address. Without a pairing code the
//                                                record is SAVED (status unknown) until the Pi itself is verified.
//   GET    ?action=legacy                        Pis added in this browser before accounts existed
//   POST   ?action=link-legacy { deviceId, code? }   link one of those to this account
//   PATCH  ?deviceId=<id> { name?, location?, ip?, hostname? }   rename (IP/hostname only for saved records)
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
import crypto from 'node:crypto';
import net from 'node:net';
import { withCustomer, requireUser, linkDevice, legacyBrowserId, requireOwnedDevice } from './_lib/auth.js';
import { setContext, rateLimit } from './_lib/db.js';
import { redeemPairCode } from './_lib/pairing.js';
import { cancelDeviceTransfers, deleteRelayCopies } from './_lib/transfers.js';

const NONCE_RX = /^[A-Za-z0-9_-]{20,100}$/;
const HOSTNAME_RX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const MAX_DEVICES_PER_CUSTOMER = 200;

/** Customer-entered IP address: IPv4 or IPv6, no ranges/masks. */
function cleanIp(raw) {
  const ip = String(raw ?? '').trim();
  if (!ip) throw httpError(400, 'Enter the Raspberry Pi IP address, for example 192.168.1.120.', 'bad-ip');
  if (ip.length > 45 || !net.isIP(ip)) throw httpError(400, `"${ip.slice(0, 45)}" is not a valid IP address. Example: 192.168.1.120`, 'bad-ip');
  return ip;
}

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
    expectedDeviceUid: device.expectedDeviceUid || null,
  };
}

async function list(t, user) {
  // Source of truth: Supabase (verified Pis and saved records of this customer only; RLS enforces it too)
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

/**
 * Add Device by name + IP. With a pairing code the real Pi is verified and linked;
 * otherwise a SAVED record is stored for this customer. It claims no Pi: an IP
 * address or a typed device UID proves nothing. One transaction.
 */
async function saveDevice(t, user, body) {
  const name = cleanText(body.name, 64);
  if (!name) throw httpError(400, 'Enter a name for the Raspberry Pi, for example "Shop Display 01".', 'bad-name');
  const ip = cleanIp(body.ip);
  const hostname = cleanText(body.hostname, 253);
  if (hostname && !HOSTNAME_RX.test(hostname)) throw httpError(400, 'The hostname may only contain letters, numbers, "-" and ".".', 'bad-hostname');
  const deviceUid = String(body.deviceUid || '').trim().toLowerCase();
  if (deviceUid && !DEVICE_ID_RX.test(deviceUid)) throw httpError(400, 'The device UID has 16 characters (0-9 and a-f), as shown on the display.', 'bad-uid');
  const location = cleanText(body.location, 80);

  if (body.code) {
    // Verified registration: the pairing code proves the customer can see this display
    await setContext(t, 'system');
    const deviceId = await redeemPairCode(t, body.code, user.id, deviceUid || null);
    const device = await linkDevice(t, user, deviceId, { name, location, via: 'pairing-code' });
    return { ok: true, verified: true, device: view(device) };
  }

  await setContext(t, 'system');
  const [{ n }] = await t`select count(*)::int as n from nsignage.devices where owner_id = ${user.id}`;
  if (n >= MAX_DEVICES_PER_CUSTOMER) throw httpError(409, 'Device limit reached for this account.');
  const [dup] = await t`select nickname from nsignage.devices
                        where owner_id = ${user.id} and registration = 'saved' and local_ip = ${ip}::inet`;
  if (dup) throw httpError(409, `You already saved a device with IP ${ip} ("${dup.nickname}").`, 'duplicate');
  const id = `saved_${crypto.randomBytes(12).toString('hex')}`;
  const [r] = await t`
    insert into nsignage.devices (id, registration, owner_id, added_at, added_via, nickname, location, local_ip, hostname, expected_device_uid)
    values (${id}, 'saved', ${user.id}, now(), 'manual', ${name}, ${location || null}, ${ip}::inet, ${hostname || null}, ${deviceUid || null})
    returning *`;
  await t`insert into nsignage.device_events (device_id, event_type, ip_address, details)
          values (${id}, 'saved', ${ip}::inet, ${t.json({ by: 'customer' })})`;
  await t`insert into nsignage.security_events (event, user_id, device_id) values ('device-saved', ${user.id}, ${id})`;
  await setContext(t, 'user', { user: user.id });
  console.log('[N-SIGNAGE CLOUD] device saved', JSON.stringify({ user: user.id, deviceId: id }));
  return { ok: true, verified: false, device: view(deviceFromRow(r)) };
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
  const current = await requireOwnedDevice(t, user, deviceId, { allowSaved: true });
  const body = readJsonBody(req);
  const name = body.name !== undefined ? cleanText(body.name, 64) || current.nickname : current.nickname;
  const location = body.location !== undefined ? cleanText(body.location, 80) : current.location;
  if (current.registration === 'saved') {
    // A saved record's IP/hostname are the customer's own data
    const ip = body.ip !== undefined ? cleanIp(body.ip) : current.localIp;
    const hostname = body.hostname !== undefined ? cleanText(body.hostname, 253) : current.hostname;
    if (hostname && !HOSTNAME_RX.test(hostname)) throw httpError(400, 'The hostname may only contain letters, numbers, "-" and ".".', 'bad-hostname');
    const [r] = await t`update nsignage.devices
                        set nickname = ${name || null}, location = ${location || null}, local_ip = ${ip}::inet, hostname = ${hostname || null}
                        where id = ${deviceId} and owner_id = ${user.id} returning *`;
    return { ok: true, device: view(deviceFromRow(r)) };
  }
  // RLS + guard trigger: for a verified Pi a customer can only change name/location (the Pi reports IP/hostname)
  const [r] = await t`update nsignage.devices set nickname = ${name || null}, location = ${location || null}
                      where id = ${deviceId} and owner_id = ${user.id} returning *`;
  return { ok: true, device: view(deviceFromRow(r)) };
}

async function remove(t, user, deviceId) {
  const current = await requireOwnedDevice(t, user, deviceId, { allowSaved: true });
  await setContext(t, 'system');
  if (current.registration === 'saved') {
    // A saved record belongs only to this customer: delete it (its events go with it)
    await t`delete from nsignage.devices where id = ${deviceId} and owner_id = ${user.id} and registration = 'saved'`;
    await t`insert into nsignage.security_events (event, user_id, device_id) values ('device-removed', ${user.id}, ${deviceId})`;
    return { result: { ok: true }, urls: [] };
  }
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
    const claiming = req.method === 'POST' && ['pair', 'link-legacy', 'save', ''].includes(action);
    if (claiming) {
      const { user } = await requireUser(req);
      const usesCode = action === 'pair' || Boolean(body.code);
      if (usesCode) await rateLimit('pair-ip', keyHash(clientIp(req)), 20, 600);
      const [bucket, limit] = usesCode ? ['pair-user', 10]
        : action === 'link-legacy' ? ['link-legacy', 30]
          : action === 'save' ? ['save-device', 30] : ['claim', 20];
      await rateLimit(bucket, keyHash(user.id), limit, 600);
    }

    let urls = [];
    const result = await withCustomer(req, async (t, { user }) => {
      if (req.method === 'GET' && action === 'legacy') return legacyList(t, req, user);
      if (req.method === 'GET') return list(t, user);
      if (req.method === 'POST') {
        if (action === 'pair') return claimByCode(t, user, body);
        if (action === 'save') return saveDevice(t, user, body);
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
