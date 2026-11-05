// Browser utilities that can run in Node: streaming SHA-256 and media checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Sha256, sha256File } from '../src/utils/sha256.js';
import { checkMediaFile, safeMediaName, contentMatches, mediaTypeOf } from '../shared/mediaTypes.js';

const ref = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('incremental SHA-256 matches Node for many sizes and split points', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 65537]) {
    const data = crypto.randomBytes(len);
    assert.equal(new Sha256().update(data).hex(), ref(data), `len ${len}`);
    const h = new Sha256();
    for (let i = 0; i < len; i += 7) h.update(data.subarray(i, i + 7));
    assert.equal(h.hex(), ref(data), `chunked len ${len}`);
  }
  assert.equal(new Sha256().update(Buffer.from('abc')).hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256File: streaming path (> 32 MB) and WebCrypto path agree with Node', async () => {
  const big = crypto.randomBytes(33 * 1024 * 1024 + 123);
  let last = 0;
  assert.equal(await sha256File(new Blob([big]), { onProgress: (p) => { last = p; } }), ref(big));
  assert.equal(last, 1);
  const small = crypto.randomBytes(5000);
  assert.equal(await sha256File(new Blob([small])), ref(small));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(sha256File(new Blob([big]), { signal: ac.signal }), { name: 'AbortError' });
});

test('media checks: extensions, MIME, safe names, magic bytes', () => {
  for (const n of ['a.jpg', 'a.JPEG', 'a.png', 'a.gif', 'a.bmp', 'a.webp', 'a.mp4', 'a.mkv', 'a.mov', 'a.avi', 'a.webm', 'a.m4v']) {
    assert.equal(checkMediaFile(n, ''), '', n);
  }
  assert.notEqual(checkMediaFile('a.exe', ''), '');
  assert.notEqual(checkMediaFile('a.jpg', 'text/html'), '');
  assert.equal(checkMediaFile('a.mkv', 'application/octet-stream'), '');
  assert.equal(safeMediaName('../../.hidden/..evil name$%.MP4'), 'evil name__.mp4');
  assert.equal(safeMediaName('.jpg'), 'media.jpg');
  assert.equal(mediaTypeOf('x.webm').mime, 'video/webm');
  const pad = (b) => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);
  assert.ok(contentMatches('jpg', pad([0xff, 0xd8, 0xff, 0xe1])));
  assert.ok(contentMatches('png', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.ok(contentMatches('webp', pad(Buffer.from('RIFF\0\0\0\0WEBP'))));
  assert.ok(contentMatches('avi', pad(Buffer.from('RIFF\0\0\0\0AVI '))));
  assert.ok(contentMatches('mp4', pad(Buffer.from('\0\0\0\x18ftypmp42'))));
  assert.ok(contentMatches('mkv', pad([0x1a, 0x45, 0xdf, 0xa3])));
  assert.ok(!contentMatches('jpg', pad(Buffer.from('<html>'))));
  assert.ok(!contentMatches('mp4', pad([0xff, 0xd8, 0xff])));
});
