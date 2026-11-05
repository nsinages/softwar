// /api/devices — Raspberry Pis added in this browser (no login; see _lib/auth.js).
//
//   GET                              list this browser's Pis (+ live status)
//   POST   { claimNonce, name?, location? }   Add Device (nonce comes from /api/find)
//   PATCH  ?deviceId=<id> { name?, location? }  rename
//   DELETE ?deviceId=<id>            remove from this browser
import { del } from '@vercel/blob';
import {
  redis, keys, send, handleError, httpError, readJsonBody, requireSameOrigin, rateLimit,
  clientIp, networkKey, getDevice, publicView, parse, NEARBY_WINDOW_MS, DEVICE_ID_RX,
} from './_lib/cloud.js';
import { requireBrowser, browserDeviceMeta } from './_lib/auth.js';

const MAX_DEVICES_PER_BROWSER = 200;
const MAX_BROWSERS_PER_DEVICE = 50;
const NONCE_RX = /^[A-Za-z0-9_-]{20,100}$/;

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '';
}

function view(device, meta, now) {
  return { ...publicView(device, now), name: meta?.name || '', location: meta?.location || '', addedAt: meta?.addedAt || null };
}

async function list(browser) {
  const meta = await browserDeviceMeta(browser.id);
  const ids = Object.keys(meta).filter((id) => DEVICE_ID_RX.test(id));
  const records = ids.length ? await redis().mget(...ids.map(keys.device)) : [];
  const now = Date.now();
  const devices = ids
    .map((id, i) => (records[i] ? view(records[i], meta[id], now) : null))
    .filter(Boolean)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  return { ok: true, devices };
}

async function claim(req, browser) {
  await rateLimit('claim', browser.id, 20, 600);
  const body = readJsonBody(req);
  const nonce = String(body.claimNonce || '');
  if (!NONCE_RX.test(nonce)) throw httpError(400, 'Click "Find Pi" first, then Add Device.', 'missing-nonce');

  const r = redis();
  const grant = await r.getdel(keys.nonce(nonce)); // single use
  if (!grant || grant.browserId !== browser.id) {
    throw httpError(410, 'This search result has expired. Click "Find Pi" again.', 'nonce-expired');
  }
  if (grant.net !== networkKey(clientIp(req))) {
    throw httpError(403, 'Your network changed since the search. Connect to the same Wi-Fi as the Pi and click "Find Pi" again.', 'network-changed');
  }
  const device = await getDevice(grant.deviceId);
  if (!device || Date.now() - (device.lastSeen || 0) > NEARBY_WINDOW_MS) {
    throw httpError(409, 'The Raspberry Pi went offline. Check its power and Wi-Fi, then click "Find Pi" again.', 'pi-offline');
  }

  const meta = await browserDeviceMeta(browser.id);
  if (Object.keys(meta).length >= MAX_DEVICES_PER_BROWSER) throw httpError(409, 'Device limit reached in this browser.');
  if ((await r.scard(keys.owners(device.deviceId))) >= MAX_BROWSERS_PER_DEVICE) {
    throw httpError(409, 'Too many browsers have added this Raspberry Pi.');
  }
  const addedNow = await r.sadd(keys.owners(device.deviceId), browser.id);
  if (!addedNow) throw httpError(409, 'This Raspberry Pi is already added in this browser.', 'duplicate');

  const entry = {
    name: cleanText(body.name, 64) || device.hostname || device.username,
    location: cleanText(body.location, 80),
    addedAt: Date.now(),
  };
  await r.hset(keys.browserDevices(browser.id), { [device.deviceId]: JSON.stringify(entry) });
  console.log('[N-SIGNAGE CLOUD] device added', JSON.stringify({ browser: browser.id, deviceId: device.deviceId }));
  return { ok: true, device: view(device, entry, Date.now()) };
}

async function ownedMeta(browser, deviceId) {
  if (!DEVICE_ID_RX.test(deviceId)) throw httpError(400, 'Invalid device id');
  const raw = await redis().hget(keys.browserDevices(browser.id), deviceId);
  if (!raw) throw httpError(404, 'This Raspberry Pi has not been added in this browser.', 'not-owner');
  return parse(raw);
}

async function rename(req, browser, deviceId) {
  const meta = await ownedMeta(browser, deviceId);
  const body = readJsonBody(req);
  const entry = {
    ...meta,
    ...(body.name !== undefined && { name: cleanText(body.name, 64) || meta.name }),
    ...(body.location !== undefined && { location: cleanText(body.location, 80) }),
  };
  await redis().hset(keys.browserDevices(browser.id), { [deviceId]: JSON.stringify(entry) });
  const device = await getDevice(deviceId);
  return { ok: true, device: device ? view(device, entry, Date.now()) : null };
}

async function remove(browser, deviceId) {
  await ownedMeta(browser, deviceId);
  const r = redis();
  await r.hdel(keys.browserDevices(browser.id), deviceId);
  await r.srem(keys.owners(deviceId), browser.id);
  console.log('[N-SIGNAGE CLOUD] device removed', JSON.stringify({ browser: browser.id, deviceId }));
  if ((await r.scard(keys.owners(deviceId))) > 0) return { ok: true }; // other browsers still use it

  // Last browser removed it: let the Pi register a fresh secret (SD card
  // re-flash) and delete the cloud copies of uploads. Files on the Pi stay.
  const device = await getDevice(deviceId);
  if (device) await r.set(keys.device(deviceId), { ...device, secretHash: null });
  const blobs = (await r.hgetall(keys.blobs(deviceId))) || {};
  const urls = Object.values(blobs).map((b) => parse(b).url).filter(Boolean);
  if (urls.length) {
    try { await del(urls); } catch (err) { console.warn('[N-SIGNAGE CLOUD] blob cleanup failed', err.message); }
  }
  await r.del(keys.blobs(deviceId), keys.commands(deviceId), keys.results(deviceId));
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    const browser = await requireBrowser(req);
    if (req.method === 'GET') return send(res, 200, await list(browser));
    requireSameOrigin(req);
    const deviceId = String(req.query?.deviceId || '');
    if (req.method === 'POST') return send(res, 200, await claim(req, browser));
    if (req.method === 'PATCH') return send(res, 200, await rename(req, browser, deviceId));
    if (req.method === 'DELETE') return send(res, 200, await remove(browser, deviceId));
    throw httpError(405, 'Method not allowed');
  } catch (err) {
    handleError(res, err);
  }
}
