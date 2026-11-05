// /api/devices — Raspberry Pis registered in the logged-in customer's account.
//
//   GET                              list this account's Pis (+ live status)
//   POST   { claimNonce, name?, location? }   Add Device (nonce comes from /api/find)
//   PATCH  ?deviceId=<id> { name?, location? }  rename
//   DELETE ?deviceId=<id>            remove from this account
import { del } from '@vercel/blob';
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin, rateLimit,
  clientIp, networkKey, getDevice, publicView, parse, NEARBY_WINDOW_MS, DEVICE_ID_RX,
} from './_lib/cloud.js';
import { requireAccount, accountDeviceMeta } from './_lib/auth.js';

const MAX_DEVICES_PER_ACCOUNT = 200;
const NONCE_RX = /^[A-Za-z0-9_-]{20,100}$/;

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '';
}

function view(device, meta, now) {
  return { ...publicView(device, now), name: meta?.name || '', location: meta?.location || '', addedAt: meta?.addedAt || null };
}

async function list(account) {
  const meta = await accountDeviceMeta(account.id);
  const ids = Object.keys(meta).filter((id) => DEVICE_ID_RX.test(id));
  const records = ids.length ? await redis().mget(...ids.map(keys.device)) : [];
  const now = Date.now();
  const devices = ids
    .map((id, i) => (records[i] ? view(records[i], meta[id], now) : null))
    .filter(Boolean)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  return { ok: true, devices };
}

async function claim(req, account) {
  await rateLimit('claim', account.id, 20, 600);
  const body = readJsonBody(req);
  const nonce = String(body.claimNonce || '');
  if (!NONCE_RX.test(nonce)) throw httpError(400, 'Click "Find Pi" first, then Add Device.', 'missing-nonce');

  const r = redis();
  const grant = await r.getdel(keys.nonce(nonce)); // single use
  if (!grant || grant.accountId !== account.id) {
    throw httpError(410, 'This search result has expired. Click "Find Pi" again.', 'nonce-expired');
  }
  if (grant.net !== networkKey(clientIp(req))) {
    throw httpError(403, 'Your network changed since the search. Connect to the same Wi-Fi as the Pi and click "Find Pi" again.', 'network-changed');
  }
  const device = await getDevice(grant.deviceId);
  if (!device || Date.now() - (device.lastSeen || 0) > NEARBY_WINDOW_MS) {
    throw httpError(409, 'The Raspberry Pi went offline. Check its power and Wi-Fi, then click "Find Pi" again.', 'pi-offline');
  }

  const meta = await accountDeviceMeta(account.id);
  if (Object.keys(meta).length >= MAX_DEVICES_PER_ACCOUNT) throw httpError(409, 'Device limit reached for this account.');

  const owned = await r.set(keys.owner(device.deviceId), account.id, { nx: true });
  if (owned !== 'OK') {
    const owner = await r.get(keys.owner(device.deviceId));
    if (owner === account.id) throw httpError(409, 'This Raspberry Pi is already in your account.', 'duplicate');
    throw httpError(409, 'This Raspberry Pi is registered to another account. Ask that account to remove it first.', 'owned-by-other');
  }
  const entry = {
    name: cleanText(body.name, 64) || device.hostname || device.username,
    location: cleanText(body.location, 80),
    addedAt: Date.now(),
  };
  await r.hset(keys.accountDevices(account.id), { [device.deviceId]: JSON.stringify(entry) });
  console.log('[N-SIGNAGE CLOUD] device claimed', JSON.stringify({ account: account.id, deviceId: device.deviceId }));
  return { ok: true, device: view(device, entry, Date.now()) };
}

async function ownedMeta(account, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
  const raw = await redis().hget(keys.accountDevices(account.id), deviceId);
  if (!raw) throw httpError(404, 'This Raspberry Pi is not in your account.', 'not-owner');
  return parse(raw);
}

async function rename(req, account, deviceId) {
  const meta = await ownedMeta(account, deviceId);
  const body = readJsonBody(req);
  const entry = {
    ...meta,
    ...(body.name !== undefined && { name: cleanText(body.name, 64) || meta.name }),
    ...(body.location !== undefined && { location: cleanText(body.location, 80) }),
  };
  await redis().hset(keys.accountDevices(account.id), { [deviceId]: JSON.stringify(entry) });
  const device = await getDevice(deviceId);
  return { ok: true, device: device ? view(device, entry, Date.now()) : null };
}

async function remove(account, deviceId) {
  await ownedMeta(account, deviceId);
  const r = redis();
  await r.hdel(keys.accountDevices(account.id), deviceId);
  if ((await r.get(keys.owner(deviceId))) === account.id) await r.del(keys.owner(deviceId));

  // Let the Pi register a fresh secret (e.g. after an SD card re-flash)
  const device = await getDevice(deviceId);
  if (device) await r.set(keys.device(deviceId), { ...device, secretHash: null });

  // Remove cloud copies of this account's uploads; files on the Pi stay.
  const blobs = (await r.hgetall(keys.blobs(deviceId))) || {};
  const urls = Object.values(blobs).map((b) => parse(b).url).filter(Boolean);
  if (urls.length) {
    try { await del(urls); } catch (err) { console.warn('[N-SIGNAGE CLOUD] blob cleanup failed', err.message); }
  }
  await r.del(keys.blobs(deviceId), keys.commands(deviceId), keys.results(deviceId));
  console.log('[N-SIGNAGE CLOUD] device removed', JSON.stringify({ account: account.id, deviceId }));
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    const account = await requireAccount(req);
    if (req.method === 'GET') return send(res, 200, await list(account));
    requireSameOrigin(req);
    const deviceId = String(req.query?.deviceId || '');
    if (req.method === 'POST') return send(res, 200, await claim(req, account));
    if (req.method === 'PATCH') return send(res, 200, await rename(req, account, deviceId));
    if (req.method === 'DELETE') return send(res, 200, await remove(account, deviceId));
    throw httpError(405, 'Method not allowed');
  } catch (err) {
    handleError(res, err);
  }
}
