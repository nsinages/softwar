// LAN direct upload (development only): identity check and "off unless enabled".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityMatches, findLanRoute, lanUploadEnabled } from '../src/api/lanUpload.js';

const device = { cloud: true, piDeviceId: '0123456789abcdef', registration: 'verified', deviceId: 'ns', hostname: 'ns', ip: '192.168.137.98', port: 5000 };

test('identity: device_id must match when the Pi reports one', () => {
  assert.equal(identityMatches(device, { device_id: '0123456789abcdef', pi_username: 'x', hostname: 'y' }), true);
  assert.equal(identityMatches(device, { device_id: 'ffffffffffffffff', pi_username: 'ns', hostname: 'ns' }), false);
});

test('identity: without device_id, both username and hostname must match', () => {
  assert.equal(identityMatches(device, { pi_username: 'ns', hostname: 'ns' }), true);
  assert.equal(identityMatches(device, { pi_username: 'NS', hostname: 'Ns' }), true);
  assert.equal(identityMatches(device, { pi_username: 'ns', hostname: 'other' }), false);
  assert.equal(identityMatches(device, { pi_username: 'ns' }), false);
  assert.equal(identityMatches({ ...device, hostname: undefined }, { pi_username: 'ns', hostname: '' }), false);
  assert.equal(identityMatches(device, null), false);
});

test('disabled outside the Vite dev server: no network probe, cloud transfer is used', async () => {
  assert.equal(lanUploadEnabled(), false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('must not probe'); };
  try {
    assert.equal(await findLanRoute(device), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
