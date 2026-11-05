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
// Setting NSIGNAGE_NETWORK_CLAIM=off disables the Find Pi path once every Pi
// can show pairing codes.
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin, rateLimit,
  clientIp, networkKey, getDevice, publicView, parse, NEARBY_WINDOW_MS, DEVICE_ID_RX, networkClaimEnabled,
} from './_lib/cloud.js';
import {
  requireUser, userDeviceMeta, deviceOwnerId, linkDevice, legacyBrowserId, legacyBrowserDevices,
} from './_lib/auth.js';
import { redeemPairCode } from './_lib/pairing.js';
import { cancelDeviceTransfers, deleteLegacyBlobs } from './_lib/transfers.js';

const NONCE_RX = /^[A-Za-z0-9_-]{20,100}$/;

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '';
}

function view(device, meta, now) {
  return {
    ...publicView(device, now),
    name: meta?.name || '',
    location: meta?.location || '',
    addedAt: meta?.addedAt || null,
    via: meta?.via || null,
  };
}

async function list(user) {
  const meta = await userDeviceMeta(user.id);
  const ids = Object.keys(meta).filter((id) => DEVICE_ID_RX.test(id));
  const records = ids.length ? await redis().mget(...ids.map(keys.device)) : [];
  const now = Date.now();
  const devices = ids
    .map((id, i) => (records[i] ? view(records[i], meta[id], now) : null))
    .filter(Boolean)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  return { ok: true, devices, networkClaim: networkClaimEnabled() };
}

/** Did this Pi sync from the caller's public network within the last 2 minutes? */
async function onSameNetwork(req, deviceId) {
  const net = networkKey(clientIp(req));
  if (!net) return false;
  const score = await redis().zscore(keys.net(net), deviceId);
  return score !== null && score !== undefined && Date.now() - Number(score) <= NEARBY_WINDOW_MS;
}

async function claimByNonce(req, user, body) {
  if (!networkClaimEnabled()) {
    throw httpError(403, 'Use the pairing code shown on the display to add it.', 'network-claim-disabled');
  }
  await rateLimit('claim', user.id, 20, 600);
  const nonce = String(body.claimNonce || '');
  if (!NONCE_RX.test(nonce)) throw httpError(400, 'Click "Find Pi" first, then Add Device.', 'missing-nonce');

  const grant = await redis().getdel(keys.nonce(nonce)); // single use
  if (!grant || grant.userId !== user.id) {
    throw httpError(410, 'This search result has expired. Click "Find Pi" again.', 'nonce-expired');
  }
  if (grant.net !== networkKey(clientIp(req))) {
    throw httpError(403, 'Your network changed since the search. Connect to the same Wi-Fi as the Pi and click "Find Pi" again.', 'network-changed');
  }
  const device = await getDevice(grant.deviceId);
  if (!device || Date.now() - (device.lastSeen || 0) > NEARBY_WINDOW_MS) {
    throw httpError(409, 'The Raspberry Pi went offline. Check its power and Wi-Fi, then click "Find Pi" again.', 'pi-offline');
  }
  const entry = await linkDevice(user, device, {
    name: cleanText(body.name, 64), location: cleanText(body.location, 80), via: 'network',
  });
  return { ok: true, device: view(device, entry, Date.now()) };
}

async function claimByCode(req, user, body) {
  await rateLimit('pair-ip', clientIp(req), 20, 600);
  await rateLimit('pair-user', user.id, 10, 600);
  const deviceId = await redeemPairCode(body.code);
  const device = await getDevice(deviceId);
  if (!device) throw httpError(404, 'Raspberry Pi not found in the cloud');
  const entry = await linkDevice(user, device, {
    name: cleanText(body.name, 64), location: cleanText(body.location, 80), via: 'pairing-code',
  });
  return { ok: true, device: view(device, entry, Date.now()) };
}

// ---- One-time link of devices added before accounts existed --------------------

async function legacyList(req, user) {
  const browserId = await legacyBrowserId(req);
  if (!browserId) return { ok: true, available: false, devices: [] };
  const meta = await legacyBrowserDevices(browserId);
  const ids = Object.keys(meta).slice(0, 100);
  const r = redis();
  const now = Date.now();
  const devices = [];
  for (const id of ids) {
    const device = await getDevice(id);
    const owner = await deviceOwnerId(id);
    const inBrowser = await r.sismember(keys.owners(id), browserId);
    let status;
    if (owner === user.id) status = 'linked';
    else if (owner) status = 'other-account';
    else if (!device) status = 'missing';
    else if (!inBrowser) status = 'removed';
    else status = 'linkable';
    devices.push({
      deviceId: id,
      name: meta[id]?.name || device?.hostname || '',
      location: meta[id]?.location || '',
      hostname: device?.hostname || null,
      username: device?.username || null,
      online: device ? publicView(device, now).online : false,
      status,
      sameNetwork: status === 'linkable' ? await onSameNetwork(req, id) : false,
      pairingSupported: Array.isArray(device?.capabilities) && device.capabilities.includes('pairing'),
    });
  }
  return { ok: true, available: true, devices };
}

async function linkLegacy(req, user, body) {
  await rateLimit('link-legacy', user.id, 30, 600);
  const deviceId = String(body.deviceId || '');
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
  const browserId = await legacyBrowserId(req);
  if (!browserId) {
    throw httpError(403, 'Open this website in the browser you used before accounts existed to link its devices.', 'no-legacy-session');
  }
  // 1. This browser really added the Pi under the old system
  if (!(await redis().sismember(keys.owners(deviceId), browserId))) {
    throw httpError(404, 'This Raspberry Pi was not added in this browser.', 'not-legacy-owner');
  }
  const device = await getDevice(deviceId);
  if (!device) throw httpError(404, 'Raspberry Pi not found in the cloud');
  // 2. A second, current proof of control: pairing code, or being on the Pi's network now
  let via;
  if (body.code) {
    await rateLimit('pair-user', user.id, 10, 600);
    await redeemPairCode(body.code, deviceId);
    via = 'legacy+pairing-code';
  } else if (await onSameNetwork(req, deviceId)) {
    via = 'legacy+network';
  } else {
    throw httpError(403, 'To confirm this display is yours, connect this phone or computer to the same Wi-Fi as the display (or enter the pairing code shown on it), then try again.', 'verify-required');
  }
  const meta = (await legacyBrowserDevices(browserId))[deviceId] || {};
  const entry = await linkDevice(user, device, { name: meta.name || '', location: meta.location || '', via });
  return { ok: true, device: view(device, entry, Date.now()) };
}

// ---- Rename / unregister ---------------------------------------------------------

async function ownedMeta(user, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
  const raw = await redis().hget(keys.userDevices(user.id), deviceId);
  if (!raw || (await deviceOwnerId(deviceId)) !== user.id) {
    throw httpError(404, 'This Raspberry Pi is not registered to your account.', 'not-owner');
  }
  return parse(raw);
}

async function rename(req, user, deviceId) {
  const meta = await ownedMeta(user, deviceId);
  const body = readJsonBody(req);
  const entry = {
    ...meta,
    ...(body.name !== undefined && { name: cleanText(body.name, 64) || meta.name }),
    ...(body.location !== undefined && { location: cleanText(body.location, 80) }),
  };
  await redis().hset(keys.userDevices(user.id), { [deviceId]: JSON.stringify(entry) });
  const device = await getDevice(deviceId);
  return { ok: true, device: device ? view(device, entry, Date.now()) : null };
}

async function remove(user, deviceId) {
  await ownedMeta(user, deviceId);
  const r = redis();
  await r.hdel(keys.userDevices(user.id), deviceId);
  await r.del(keys.deviceOwner(deviceId));
  // The account owner's explicit removal also ends the old anonymous-browser
  // association, so the Pi is fully unclaimed and can be added again.
  await r.del(keys.owners(deviceId));
  const cancelled = await cancelDeviceTransfers(user.id, deviceId, 'Device removed from the account');

  // Let the Pi register a fresh secret (SD card re-flash) and drop cloud-side
  // queues and any old cloud media copies. Files on the Pi are NOT deleted.
  const device = await getDevice(deviceId);
  if (device) await r.set(keys.device(deviceId), { ...device, secretHash: null });
  await deleteLegacyBlobs(deviceId);
  await r.del(keys.commands(deviceId), keys.results(deviceId), keys.pairDevice(deviceId));
  console.log('[N-SIGNAGE CLOUD] device removed', JSON.stringify({ user: user.id, deviceId, cancelledTransfers: cancelled }));
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    const { user } = await requireUser(req);
    const action = String(req.query?.action || '');
    if (req.method === 'GET' && action === 'legacy') return send(res, 200, await legacyList(req, user));
    if (req.method === 'GET') return send(res, 200, await list(user));
    requireSameOrigin(req);
    const deviceId = String(req.query?.deviceId || '');
    if (req.method === 'POST') {
      const body = readJsonBody(req);
      if (action === 'pair') return send(res, 200, await claimByCode(req, user, body));
      if (action === 'link-legacy') return send(res, 200, await linkLegacy(req, user, body));
      if (!action) return send(res, 200, await claimByNonce(req, user, body));
      throw httpError(404, 'Unknown action');
    }
    if (req.method === 'PATCH') return send(res, 200, await rename(req, user, deviceId));
    if (req.method === 'DELETE') return send(res, 200, await remove(user, deviceId));
    throw httpError(405, 'Method not allowed');
  } catch (err) {
    handleError(res, err);
  }
}
