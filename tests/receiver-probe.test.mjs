// Browser readiness probe (shared/directUpload.js probeReceiver): every way the path
// browser → Cloudflare → tunnel → Pi receiver can fail gets its own, accurate answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeReceiver } from '../shared/directUpload.js';

const FP = 'a'.repeat(64);
const target = { url: 'https://p-0123456789abcdef.nsinages.in', fingerprint: FP };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch stub: `cors` answers the readable request, `noCors` the fallback; a function that throws = network failure. */
function stub({ cors, noCors }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, mode: init.mode, credentials: init.credentials });
    const h = init.mode === 'no-cors' ? noCors : cors;
    if (typeof h === 'function') return h();
    return h;
  };
  return { fetchImpl, calls };
}
const netFail = () => { throw new TypeError('Failed to fetch'); };

test('healthy receiver with the pinned key and this origin allowed → ready', async () => {
  const { fetchImpl, calls } = stub({ cors: json(200, { ok: true, service: 'n-signage-upload', version: '1.1.0', fingerprint: FP, originAllowed: true }) });
  const r = await probeReceiver(target, { fetchImpl });
  assert.deepEqual(r, { ok: true, version: '1.1.0' });
  assert.equal(calls[0].url, `${target.url}/v1/health`);
  assert.equal(calls[0].credentials, 'omit', 'no cookies or tickets go to the Pi for a health check');
});

test('Cloudflare answers but not the receiver (tunnel not connected, e.g. error 1033) → tunnel-down', async () => {
  const { fetchImpl } = stub({ cors: netFail, noCors: new Response(null, { status: 200 }) });
  const r = await probeReceiver(target, { fetchImpl });
  assert.equal(r.reason, 'tunnel-down');
  assert.match(r.message, /Cloudflare Tunnel is not connected/);
  assert.match(r.message, /p-0123456789abcdef\.nsinages\.in/);
});

test('nothing answers (DNS or network) → tunnel-unreachable, never "not installed"', async () => {
  const { fetchImpl } = stub({ cors: netFail, noCors: netFail });
  const r = await probeReceiver(target, { fetchImpl });
  assert.equal(r.reason, 'tunnel-unreachable');
  assert.doesNotMatch(r.message, /not installed/);
});

test('a readable 5xx (receiver behind the tunnel failing) → tunnel-down with the HTTP status', async () => {
  const { fetchImpl } = stub({ cors: json(502, { error: 'bad gateway' }) });
  const r = await probeReceiver(target, { fetchImpl });
  assert.equal(r.reason, 'tunnel-down'); assert.match(r.message, /HTTP 502/);
});

test('hostname leads to another Pi (different key) or to something else → wrong-receiver', async () => {
  let { fetchImpl } = stub({ cors: json(200, { ok: true, service: 'n-signage-upload', fingerprint: 'b'.repeat(64), originAllowed: true }) });
  assert.equal((await probeReceiver(target, { fetchImpl })).reason, 'wrong-receiver');
  ({ fetchImpl } = stub({ cors: json(200, { hello: 'world' }) }));
  assert.equal((await probeReceiver(target, { fetchImpl })).reason, 'wrong-receiver');
  ({ fetchImpl } = stub({ cors: json(404, { ok: false }) }));
  assert.equal((await probeReceiver(target, { fetchImpl })).reason, 'wrong-receiver');
});

test('receiver configured for another website address → origin-mismatch', async () => {
  const { fetchImpl } = stub({ cors: json(200, { ok: true, service: 'n-signage-upload', fingerprint: FP, originAllowed: false }) });
  assert.equal((await probeReceiver(target, { fetchImpl })).reason, 'origin-mismatch');
});

test('a hanging receiver times out instead of blocking the upload page', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))));
  const t0 = Date.now();
  const r = await probeReceiver(target, { fetchImpl: hang, timeoutMs: 100 });
  assert.equal(r.reason, 'tunnel-unreachable');
  assert.ok(Date.now() - t0 < 2000);
});

test('the customer cancelling during the check is a cancel, not an error', async () => {
  const ac = new AbortController();
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))));
  const p = probeReceiver(target, { fetchImpl: hang, signal: ac.signal, timeoutMs: 5000 });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
});
