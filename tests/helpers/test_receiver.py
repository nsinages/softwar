"""
Security tests for the Pi direct-upload receiver (N-Signage/upload-receiver/receiver.py).

Tickets are signed here with a test Ed25519 key and chunks are encrypted exactly
as the browser does (ECDH P-256 + HKDF-SHA256 → AES-256-GCM, same IV/AAD). The
website is a fake that records calls and can deny. Covers every check the
receiver must make itself (CORS is NOT relied on).

Run: python tests/helpers/test_receiver.py   (npm test runs it, also against cryptography 43 when available)
"""
import base64
import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from collections import namedtuple
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..', 'N-Signage', 'upload-receiver')))
import receiver as R  # noqa: E402

DEVICE = '0123456789abcdef'
OTHER_DEVICE = 'fedcba9876543210'
SECRET_VALUE = 'device-secret-' + 'x' * 40
MiB = 1024 * 1024
CHUNK = 256 * 1024
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()  # noqa: E731
Usage = namedtuple('Usage', 'total used free')

TICKET_KEY = ed25519.Ed25519PrivateKey.generate()
TICKET_PUB = TICKET_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
KID = hashlib.sha256(TICKET_PUB).hexdigest()[:16]
OTHER_KEY = ed25519.Ed25519PrivateKey.generate()


def make_ticket(claims, key=TICKET_KEY):
    payload = b64u(json.dumps(claims).encode())
    return f'nst1.{payload}.{b64u(key.sign(f"nst1.{payload}".encode()))}'


class FakeCloud:
    def __init__(self):
        self.calls = []
        self.deny = set()       # phases to deny: 'start', 'finish'
        self.down = False

    def __call__(self, action, payload):
        self.calls.append((action, payload))
        if self.down:
            raise R.ReceiverError(503, 'cloud-unreachable', 'website unreachable')
        if action == 'heartbeat':
            return {'serverTime': int(time.time() * 1000), 'ticketKeys': [{'kid': KID, 'publicKey': b64u(TICKET_PUB)}], 'keyStatus': 'pinned'}
        if action == 'check':
            return {'allowed': payload['phase'] not in self.deny, 'reason': 'cancelled' if payload['phase'] in self.deny else None}
        return {'ok': True, 'state': 'completed'}

    def actions(self, name):
        return [p for a, p in self.calls if a == name]


class Browser:
    """What the browser does (shared/e2eCrypto.js), in Python."""

    def __init__(self, receiver_pub_b64, tid, device=DEVICE):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.epk_raw = self.key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.epk = b64u(self.epk_raw)
        self.epk_hash = hashlib.sha256(self.epk_raw).hexdigest()
        peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), R.b64u_decode(receiver_pub_b64))
        shared = self.key.exchange(ec.ECDH(), peer)
        self.aes = AESGCM(HKDF(algorithm=hashes.SHA256(), length=32, salt=tid.encode(), info=f'nsignage-media-v1|{device}'.encode()).derive(shared))
        self.tid, self.device = tid, device

    def chunk(self, data, index, size, sha, chunk=CHUNK, device=None):
        plain = data[index * chunk:(index + 1) * chunk]
        aad = f'nsignage-v1|{device or self.device}|{self.tid}|{index}|{len(plain)}|{size}|{sha}'.encode()
        return self.aes.encrypt(bytes(8) + index.to_bytes(4, 'big'), plain, aad)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='ns-receiver-'))
        R.BASE, R.MEDIA, R.DATA = self.tmp, self.tmp / 'media', self.tmp / 'data'
        R.STATE_DIR, R.IDENTITY, R.SECRET = R.DATA / 'upload', R.DATA / 'device_identity.json', R.DATA / 'cloud_secret'
        R.MEDIA.mkdir(parents=True)
        R.DATA.mkdir(parents=True)
        R.IDENTITY.write_text(json.dumps({'device_id': DEVICE}))
        R.SECRET.write_text(SECRET_VALUE)
        self.identity_before = (R.IDENTITY.read_bytes(), R.SECRET.read_bytes())
        self.cloud = FakeCloud()
        self.rx = R.Receiver(cloud=self.cloud)
        self.rx.heartbeat()
        self.data = os.urandom(3 * CHUNK + 12345)   # 4 chunks, last one short
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.tid = 'AbCdEfGhIjKlMnOpQrStUv'
        self.browser = Browser(self.rx.public_key_b64, self.tid)
        self._disk = shutil.disk_usage

    def tearDown(self):
        shutil.disk_usage = self._disk
        self.assertEqual((R.IDENTITY.read_bytes(), R.SECRET.read_bytes()), self.identity_before, 'identity files never modified')
        shutil.rmtree(self.tmp, ignore_errors=True)

    def claims(self, **over):
        now = int(time.time())
        c = {'v': 1, 'kid': KID, 'iss': 'nsignage', 'aud': DEVICE, 'tid': self.tid, 'name': 'promo.mp4', 'size': len(self.data),
             'sha256': self.sha, 'chunk': CHUNK, 'epk': self.browser.epk_hash, 'iat': now, 'nbf': now - 30, 'exp': now + 900, 'dl': now + 86400}
        c.update(over)
        return c

    def put(self, index, ticket=None, browser=None, body=None, length=None, epk=None, **claims):
        b = browser or self.browser
        if body is None:
            body = b.chunk(self.data, index, len(self.data), self.sha)
        return self.rx.put_chunk(self.tid, index, ticket or make_ticket(self.claims(epk=b.epk_hash, **claims)),
                                 epk or b.epk, len(body) if length is None else length, lambda n: body[:n])

    def refused(self, status, reason, fn):
        with self.assertRaises(R.ReceiverError) as ctx:
            fn()
        self.assertEqual((ctx.exception.status, ctx.exception.reason), (status, reason), str(ctx.exception))
        return ctx.exception

    def send_all(self, browser=None, start=0):
        n = -(-len(self.data) // CHUNK)
        last = None
        for i in range(start, n):
            last = self.put(i, browser=browser)[1]
        return last

    def media(self):
        return sorted(p.name for p in R.MEDIA.iterdir())


class HappyPath(Base):
    def test_full_transfer_verified_saved_reported(self):
        out = self.send_all()
        self.assertTrue(out['done'])
        self.assertEqual(out['savedAs'], 'promo.mp4')
        saved = R.MEDIA / 'promo.mp4'
        self.assertEqual(hashlib.sha256(saved.read_bytes()).hexdigest(), self.sha)
        self.assertEqual(self.media(), ['promo.mp4'], 'no partial file left')
        if os.name == 'posix':
            self.assertEqual(saved.stat().st_mode & 0o777, 0o644)
        self.assertEqual([p['phase'] for p in self.cloud.actions('check')], ['start', 'finish'])
        res = self.cloud.actions('result')[-1]
        self.assertEqual((res['ok'], res['savedAs'], res['sha256'], res['size']), (True, 'promo.mp4', self.sha, len(self.data)))

    def test_receiver_key_created_once_private_and_reused(self):
        key_file = R.STATE_DIR / 'receiver_key.pem'
        self.assertTrue(key_file.exists())
        if os.name == 'posix':
            self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
        again = R.Receiver(cloud=self.cloud)
        self.assertEqual(again.public_key_b64, self.rx.public_key_b64)

    def test_part_file_is_hidden_while_receiving(self):
        self.put(0)
        self.assertTrue(all(n.startswith('.') for n in self.media()), 'players ignore hidden files')

    def test_existing_file_never_overwritten(self):
        (R.MEDIA / 'promo.mp4').write_bytes(b'local upload')
        self.assertEqual(self.send_all()['savedAs'], 'promo_1.mp4')
        self.assertEqual((R.MEDIA / 'promo.mp4').read_bytes(), b'local upload')

    def test_done_transfer_is_idempotent(self):
        self.send_all()
        again = self.put(3)[1]
        self.assertTrue(again['done'])
        self.assertEqual(self.media(), ['promo.mp4'], 'no second file')
        self.assertEqual(self.rx.status(self.tid, make_ticket(self.claims()), self.browser.epk)[1]['savedAs'], 'promo.mp4')


class Tickets(Base):
    def no_trace(self):
        self.assertFalse(R.Receiver.state_path(self.tid).exists())
        self.assertEqual(self.media(), [])

    def test_signature_and_format(self):
        good = make_ticket(self.claims())
        prefix, payload, sig = good.split('.')
        forged_claims = b64u(json.dumps(self.claims(size=1)).encode())
        self.refused(401, 'bad-ticket', lambda: self.put(0, ticket=f'{prefix}.{forged_claims}.{sig}'))
        self.refused(401, 'bad-ticket', lambda: self.put(0, ticket=make_ticket(self.claims(), key=OTHER_KEY)))
        self.refused(401, 'bad-ticket', lambda: self.put(0, ticket='garbage'))
        self.refused(401, 'bad-ticket', lambda: self.put(0, ticket=' '))
        self.refused(401, 'unknown-ticket-key', lambda: self.put(0, ticket=make_ticket(self.claims(kid='0' * 16))))
        self.refused(401, 'bad-ticket', lambda: self.put(0, v=2))
        self.refused(401, 'bad-ticket', lambda: self.put(0, iss='someone'))
        self.no_trace()

    def test_audience_transfer_and_key_binding(self):
        self.refused(403, 'wrong-device', lambda: self.put(0, aud=OTHER_DEVICE))
        self.refused(403, 'wrong-transfer', lambda: self.put(0, tid='ZZZZZZZZZZZZZZZZZZZZZZ'))
        other = Browser(self.rx.public_key_b64, self.tid)
        # ticket bound to this browser's key, request made with another key
        self.refused(403, 'wrong-key', lambda: self.rx.put_chunk(self.tid, 0, make_ticket(self.claims()), other.epk, 10, lambda n: b''))
        self.refused(403, 'wrong-key', lambda: self.rx.put_chunk(self.tid, 0, make_ticket(self.claims()), 'not-a-key', 10, lambda n: b''))
        self.no_trace()

    def test_time_window_uses_website_clock(self):
        now = int(time.time())
        self.refused(401, 'ticket-expired', lambda: self.put(0, iat=now - 2000, nbf=now - 2000, exp=now - 500))
        self.refused(401, 'ticket-not-yet-valid', lambda: self.put(0, iat=now + 600, nbf=now + 600, exp=now + 1200))
        self.refused(401, 'bad-ticket', lambda: self.put(0, exp=now + 7200))           # lifetime above 1 hour
        self.refused(401, 'bad-ticket', lambda: self.put(0, dl=now + 60, exp=now + 900))  # beyond the transfer deadline
        # the Pi's own clock is 10 minutes wrong, but it follows the website's time from the heartbeat
        self.rx.clock_offset = 0
        real = time.time
        try:
            R.time.time = lambda: real() - 600
            self.rx.heartbeat()
            self.assertTrue(self.put(0)[1]['nextIndex'] == 1)
        finally:
            R.time.time = real
        self.assertTrue(R.time.time is real)

    def test_file_limits(self):
        self.refused(413, 'too-large', lambda: self.put(0, size=R.MAX_FILE + 1))
        self.refused(400, 'bad-ticket', lambda: self.put(0, chunk=1024))
        self.refused(400, 'bad-ticket', lambda: self.put(0, chunk=16 * MiB))
        self.refused(400, 'bad-ticket', lambda: self.put(0, sha256='nothex'))
        for name in ('../promo.mp4', '.hidden.mp4', 'run.sh', 'a/b.mp4', ''):
            self.refused(400, 'unsupported-type', lambda name=name: self.put(0, name=name))
        self.no_trace()


class Chunks(Base):
    def test_exact_length_checked_before_reading(self):
        read = []
        self.refused(400, 'bad-length', lambda: self.rx.put_chunk(self.tid, 0, make_ticket(self.claims()), self.browser.epk, CHUNK, lambda n: read.append(n) or b''))
        self.assertEqual(read, [], 'body never read')
        self.refused(400, 'bad-index', lambda: self.put(4, body=b'x' * 32))

    def test_order_and_resync(self):
        e = self.refused(409, 'out-of-order', lambda: self.put(2))
        self.assertEqual(e.extra['nextIndex'], 0)
        self.put(0)
        e = self.refused(409, 'out-of-order', lambda: self.put(2))
        self.assertEqual(e.extra['nextIndex'], 1)

    def test_tampered_reordered_or_foreign_chunks_rejected(self):
        self.put(0)
        good = self.browser.chunk(self.data, 1, len(self.data), self.sha)
        flipped = bytearray(good)
        flipped[100] ^= 1
        self.refused(400, 'decrypt-failed', lambda: self.put(1, body=bytes(flipped)))
        swapped = self.browser.chunk(self.data, 2, len(self.data), self.sha)  # chunk 2 sent as chunk 1
        self.refused(400, 'decrypt-failed', lambda: self.put(1, body=swapped))
        foreign = self.browser.chunk(self.data, 1, len(self.data), self.sha, device=OTHER_DEVICE)
        self.refused(400, 'decrypt-failed', lambda: self.put(1, body=foreign))
        st = self.rx.load_state(self.tid)
        self.assertEqual((st['next'], st['received']), (1, CHUNK), 'refused chunks change nothing')
        self.assertEqual(self.put(1, body=good)[1]['nextIndex'], 2)

    def test_identical_retry_is_idempotent_and_different_retry_refused(self):
        self.put(0)
        self.put(1)
        again = self.put(1)[1]
        self.assertEqual((again['nextIndex'], again['receivedBytes']), (2, 2 * CHUNK), 'identical retry: no duplicate data')
        other_data = os.urandom(len(self.data))
        other_body = self.browser.chunk(other_data, 1, len(self.data), self.sha)
        self.refused(409, 'out-of-order', lambda: self.put(1, body=other_body))
        self.assertEqual(R.Receiver.part_path(self.tid).stat().st_size, 2 * CHUNK)

    def test_ticket_must_describe_the_same_file_all_along(self):
        self.put(0)
        self.refused(409, 'ticket-mismatch', lambda: self.put(1, name='other.mp4'))


class FileChecksAndWebsite(Base):
    def test_wrong_checksum_rejected_part_deleted_reported(self):
        wrong = hashlib.sha256(b'other').hexdigest()
        n = -(-len(self.data) // CHUNK)
        for i in range(n - 1):
            body = self.browser.chunk(self.data, i, len(self.data), wrong)
            self.put(i, body=body, sha256=wrong)
        last = self.browser.chunk(self.data, n - 1, len(self.data), wrong)
        self.refused(422, 'checksum-mismatch', lambda: self.put(n - 1, body=last, sha256=wrong))
        self.assertEqual(self.media(), [])
        self.assertEqual(self.cloud.actions('result')[-1]['reason'], 'checksum-mismatch')

    def test_website_denies_at_start_and_finish(self):
        self.cloud.deny = {'start'}
        self.refused(403, 'not-allowed', lambda: self.put(0))
        self.assertFalse(R.Receiver.state_path(self.tid).exists())
        self.cloud.deny = {'finish'}
        n = -(-len(self.data) // CHUNK)
        for i in range(n - 1):
            self.put(i)
        self.refused(403, 'not-allowed', lambda: self.put(n - 1))
        self.assertEqual(self.media(), [], 'cancelled transfer: nothing saved, part removed')

    def test_website_unreachable_writes_nothing(self):
        self.cloud.down = True
        self.refused(503, 'cloud-unreachable', lambda: self.put(0))
        self.assertEqual(self.media(), [])

    def test_insufficient_storage(self):
        shutil.disk_usage = lambda p: Usage(8 * 2**30, 0, 100 * MiB)
        self.refused(507, 'insufficient-storage', lambda: self.put(0))
        self.assertEqual(self.media(), [])


class Resume(Base):
    def test_resume_after_restart_with_a_new_browser_key(self):
        self.put(0)
        self.put(1)
        restarted = R.Receiver(cloud=self.cloud)           # service restart: memory gone
        restarted.heartbeat()
        self.rx = restarted
        new_browser = Browser(self.rx.public_key_b64, self.tid)   # page reload: new one-time key, new ticket
        st = self.rx.status(self.tid, make_ticket(self.claims(epk=new_browser.epk_hash)), new_browser.epk)[1]
        self.assertEqual(st['nextIndex'], 2)
        out = self.send_all(browser=new_browser, start=2)
        self.assertTrue(out['done'])
        self.assertEqual(hashlib.sha256((R.MEDIA / 'promo.mp4').read_bytes()).hexdigest(), self.sha)

    def test_crash_between_data_and_state_write_is_repaired(self):
        self.put(0)
        with R.Receiver.part_path(self.tid).open('ab') as f:   # data appended, state not yet updated
            f.write(b'garbage after a crash')
        self.rx = R.Receiver(cloud=self.cloud)
        self.rx.heartbeat()
        self.assertTrue(self.send_all(start=1)['done'])
        self.assertEqual(hashlib.sha256((R.MEDIA / 'promo.mp4').read_bytes()).hexdigest(), self.sha)

    def test_housekeeping_expires_and_retries(self):
        self.put(0)
        st = self.rx.load_state(self.tid)
        st['deadline'] = int(time.time()) - 7200
        self.rx.save_state(st)
        self.rx.housekeeping()
        self.assertFalse(R.Receiver.state_path(self.tid).exists())
        self.assertEqual(self.media(), [], 'expired partial upload removed')
        # unreported success is retried
        self.tid = 'ZyXwVuTsRqPoNmLkJiHgFe'
        self.browser = Browser(self.rx.public_key_b64, self.tid)
        self.cloud.calls.clear()
        real = self.cloud.__call__
        state = {'fail': True}

        def flaky(action, payload):
            if action == 'result' and state['fail']:
                raise R.ReceiverError(503, 'cloud-unreachable')
            return real(action, payload)
        self.rx.cloud = flaky
        self.send_all()
        self.assertFalse(self.rx.load_state(self.tid)['reported'])
        state['fail'] = False
        self.rx.housekeeping()
        self.assertTrue(self.rx.load_state(self.tid)['reported'])


class HttpLayer(Base):
    def setUp(self):
        super().setUp()
        R.Handler.receiver = self.rx
        self.httpd = R.ThreadingHTTPServer(('127.0.0.1', 0), R.Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        hdrs = dict(r.getheaders())
        c.close()
        return r.status, (json.loads(data) if data else {}), hdrs

    def test_cors_preflight_and_origin(self):
        st, _, h = self.req('OPTIONS', f'/v1/transfers/{self.tid}/chunks/0', headers={'Origin': R.ALLOWED_ORIGIN})
        self.assertEqual(st, 204)
        self.assertEqual(h.get('Access-Control-Allow-Origin'), R.ALLOWED_ORIGIN)
        self.assertIn('X-NS-EPK', h.get('Access-Control-Allow-Headers'))
        st, _, h = self.req('OPTIONS', f'/v1/transfers/{self.tid}/chunks/0', headers={'Origin': 'https://evil.example'})
        self.assertEqual(st, 403)
        self.assertNotIn('Access-Control-Allow-Origin', h)

    def test_put_over_http_with_all_checks(self):
        body = self.browser.chunk(self.data, 0, len(self.data), self.sha)
        auth = {'Authorization': 'Bearer ' + make_ticket(self.claims()), 'X-NS-EPK': self.browser.epk, 'Content-Type': 'application/octet-stream'}
        st, j, _ = self.req('PUT', f'/v1/transfers/{self.tid}/chunks/0', body, {**auth, 'Origin': 'https://evil.example'})
        self.assertEqual((st, j['reason']), (403, 'origin'), 'a page on another origin is refused even with a ticket')
        st, j, h = self.req('PUT', f'/v1/transfers/{self.tid}/chunks/0', body, {**auth, 'Origin': R.ALLOWED_ORIGIN})
        self.assertEqual((st, j['nextIndex']), (200, 1))
        self.assertEqual(h.get('Access-Control-Allow-Origin'), R.ALLOWED_ORIGIN)
        st, j, _ = self.req('PUT', f'/v1/transfers/{self.tid}/chunks/1', body, {k: v for k, v in auth.items() if k != 'Authorization'})
        self.assertEqual((st, j['reason']), (401, 'bad-ticket'), 'no ticket, no write (CORS is not the protection)')
        self.assertNotIn('nst1.', json.dumps(j), 'tickets never echoed')

    def test_length_and_method_rules(self):
        auth = {'Authorization': 'Bearer ' + make_ticket(self.claims()), 'X-NS-EPK': self.browser.epk}
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.putrequest('PUT', f'/v1/transfers/{self.tid}/chunks/0')
        for k, v in auth.items():
            c.putheader(k, v)
        c.putheader('Transfer-Encoding', 'chunked')
        c.endheaders()
        r = c.getresponse()
        self.assertEqual(r.status, 411)
        c.close()
        st, j, _ = self.req('PUT', f'/v1/transfers/{self.tid}/chunks/0', None, {**auth, 'Content-Length': str(R.MAX_CHUNK + 17)})
        self.assertEqual(st, 413)
        self.assertEqual(self.req('GET', '/v1/whatever')[0], 404)
        self.assertEqual(self.req('POST', f'/v1/transfers/{self.tid}/chunks/0', b'x')[0], 405)
        self.assertEqual(self.req('GET', '/../../etc/passwd')[0], 404)
        st, j, _ = self.req('GET', '/v1/health')
        self.assertEqual((st, j['service']), (200, 'n-signage-upload'))
        self.assertNotIn(DEVICE, json.dumps(j), 'health reveals no identity')


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=2).result
    import cryptography
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
                      'skipped': len(result.skipped), 'cryptography': cryptography.__version__}))
    sys.exit(0 if result.wasSuccessful() else 1)
