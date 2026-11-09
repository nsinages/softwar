// Local dev servers: a browser on this PC/LAN must count as this PC's PUBLIC
// address (as on Vercel), otherwise Find IP can never match a Pi locally.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { devClientIp, isLocalAddress, resetDevClientIp } from '../scripts/lib/devClientIp.mjs';

const saved = { VERCEL: process.env.VERCEL, NSIGNAGE_DEV_PUBLIC_IP: process.env.NSIGNAGE_DEV_PUBLIC_IP };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetDevClientIp();
});
const lookup = async () => '27.60.175.51';

test('loopback and LAN addresses are local; public ones are not', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.137.1', '10.75.215.22', '172.20.1.1', 'fe80::1', 'fd12::3', '100.64.0.9', ''])
    assert.ok(isLocalAddress(ip), ip);
  for (const ip of ['27.60.175.51', '203.0.113.9', '2401:4900:e845::1', '172.32.0.1'])
    assert.ok(!isLocalAddress(ip), ip);
});

test('a browser on this PC or LAN gets the PC\'s public IPv4; public callers keep theirs', async () => {
  delete process.env.VERCEL; delete process.env.NSIGNAGE_DEV_PUBLIC_IP;
  assert.equal(await devClientIp('127.0.0.1', { lookup }), '27.60.175.51');
  assert.equal(await devClientIp('::ffff:192.168.137.20', { lookup }), '27.60.175.51');
  assert.equal(await devClientIp('203.0.113.9', { lookup }), '203.0.113.9');
});

test('override, opt-out, lookup failure, and never on Vercel', async () => {
  delete process.env.VERCEL;
  process.env.NSIGNAGE_DEV_PUBLIC_IP = '198.51.100.7';
  assert.equal(await devClientIp('127.0.0.1', { lookup }), '198.51.100.7');
  process.env.NSIGNAGE_DEV_PUBLIC_IP = 'off';
  assert.equal(await devClientIp('127.0.0.1', { lookup }), '127.0.0.1');
  delete process.env.NSIGNAGE_DEV_PUBLIC_IP;
  assert.equal(await devClientIp('127.0.0.1', { lookup: async () => null }), '127.0.0.1', 'falls back without crashing');
  process.env.VERCEL = '1';
  assert.equal(await devClientIp('10.0.0.5', { lookup }), '10.0.0.5', 'Vercel supplies the real address itself');
});
