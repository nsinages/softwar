// Pi upload receiver security suite (Python, tests/helpers/test_receiver.py) and the
// staff provisioning script (Cloudflare API calls, mocked: nothing is created).
// NSIGNAGE_PY43=<python with cryptography 43.0.0> also runs the suite with the Pi's exact version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { plan, apply } from '../scripts/provision-tunnel.mjs';
import { generateTicketKey, keyId } from '../api/_lib/tickets.js';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import cryptography']).status === 0);

function runSuite(py) {
  const r = spawnSync(py, [path.resolve('tests/helpers/test_receiver.py')], { encoding: 'utf8', env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`.slice(-6000));
  const s = JSON.parse((r.stdout || '').trim().split('\n').pop());
  assert.equal(s.failures + s.errors, 0);
  assert.ok(s.tests >= 20, `ran ${s.tests}`);
  return s;
}

test('receiver security suite (Python)', { timeout: 300_000, skip: !python && 'Python + cryptography not installed' }, () => {
  runSuite(python);
});

test('receiver security suite with cryptography 43.0.0 (the Pi\'s version)', { timeout: 300_000, skip: !process.env.NSIGNAGE_PY43 && 'set NSIGNAGE_PY43' }, () => {
  assert.equal(runSuite(process.env.NSIGNAGE_PY43).cryptography, '43.0.0');
});

test('tunnel provisioning: random first-level hostname, ingress only to 127.0.0.1:8090, proxied CNAME, token kept out of output', async () => {
  assert.throws(() => plan('nope'));
  const p = plan('0123456789abcdef');
  assert.match(p.hostname, /^p-[0-9a-f]{16}\.nsinages\.in$/);
  assert.ok(!p.hostname.includes('0123456789abcdef'), 'device id not exposed in DNS');
  assert.deepEqual(p.ingress.map((r) => r.service), ['http://127.0.0.1:8090', 'http_status:404']);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), auth: init.headers.Authorization });
    const result = url.endsWith('/cfd_tunnel') ? { id: 'a'.repeat(32) } : url.endsWith('/token') ? 'tunnel-token-value' : {};
    return { status: 200, json: async () => ({ success: true, result }) };
  };
  const out = await apply(p, { token: 'cf-test', accountId: 'acc', zoneId: 'zone', fetchImpl });
  assert.equal(out.tunnelToken, 'tunnel-token-value');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace('https://api.cloudflare.com/client/v4', '')}`), [
    'POST /accounts/acc/cfd_tunnel',
    `PUT /accounts/acc/cfd_tunnel/${'a'.repeat(32)}/configurations`,
    'POST /zones/zone/dns_records',
    `GET /accounts/acc/cfd_tunnel/${'a'.repeat(32)}/token`,
  ]);
  assert.equal(calls[0].body.config_src, 'cloudflare');
  assert.deepEqual(calls[1].body.config.ingress, p.ingress);
  assert.deepEqual([calls[2].body.type, calls[2].body.name, calls[2].body.content, calls[2].body.proxied], ['CNAME', p.hostname, `${'a'.repeat(32)}.cfargotunnel.com`, true]);
  assert.ok(calls.every((c) => c.auth === 'Bearer cf-test'));
});

test('ticket key generation: Ed25519, key id derived from the public key', () => {
  const k = generateTicketKey();
  assert.equal(Buffer.from(k.publicKey, 'base64url').length, 32);
  assert.equal(k.kid, keyId(Buffer.from(k.publicKey, 'base64url')));
  assert.ok(Buffer.from(k.privateKeyB64, 'base64').length > 40);
});
