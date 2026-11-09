"""
Unit tests for the MPV-install cloud agent: the real 2.0-ns1 ("V2.1") and the
merged 2.2-ns1 (N-Signage/mpv-agent/). Run once per file:
    AGENT_FILE=N-Signage/mpv-agent/cloud_agent_v2.1.py python tests/helpers/test_mpv_agent.py
    AGENT_FILE=N-Signage/mpv-agent/cloud_agent.py      python tests/helpers/test_mpv_agent.py
Shared behaviour must pass on both (proves 2.2 kept it); private-Blob behaviour
is checked on 2.2, and V2.1's refusal of private URLs is recorded as baseline.
Only the HTTPS transport is replaced (in-memory handler behind the agent's own
SafeBlobRedirect), plus the agent's paths and Linux-only pwd.
"""
import collections
import email.message
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
import urllib.request
import urllib.response
from pathlib import Path

if 'pwd' not in sys.modules:
    try:
        import pwd  # noqa: F401
    except ImportError:
        fake = types.ModuleType('pwd')
        fake.getpwuid = lambda uid: types.SimpleNamespace(pw_name='ns')
        sys.modules['pwd'] = fake
        os.geteuid = getattr(os, 'geteuid', lambda: 1000)

AGENT_FILE = os.environ['AGENT_FILE']
spec = importlib.util.spec_from_file_location('mpv_agent', AGENT_FILE)
ag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ag)
MERGED = 'private-blob' in ag.CAPABILITIES

TID = 'ptMHZ-BuXPuzjnjLjk1wPw'
CID = '6f1c1b1e-1111-4222-8333-944455556666'
PUB = 'https://abc123.public.blob.vercel-storage.com'
PRIV = 'https://abc123.private.blob.vercel-storage.com'
PATH = f'/transfers/0123456789abcdef/{TID}/promo-Xy7.mp4'
DATA = b'\x00\x00\x00\x20ftypisom' + os.urandom(3 * 1024 * 1024 + 321)
SHA = hashlib.sha256(DATA).hexdigest()
Usage = collections.namedtuple('Usage', 'total used free')


def cmd(url=PUB + PATH, **over):
    c = {'id': CID, 'type': 'download', 'transferId': TID, 'url': url, 'filename': 'promo.mp4', 'size': len(DATA), 'sha256': SHA}
    c.update(over)
    return c


class FakeNet(urllib.request.HTTPSHandler):
    def __init__(self):
        super().__init__()
        self.objects, self.redirects, self.requests = {}, {}, []
        self.ignore_range = False
        self.truncate_next = None
        self.status_next = None
        self.bad_range_next = False

    def https_open(self, req):
        url = req.full_url
        base = url.split('?', 1)[0]
        rng = req.get_header('Range')
        self.requests.append({'url': url, 'range': rng})
        h = email.message.Message()
        if self.status_next:
            code, self.status_next = self.status_next, None
            return self._r(b'', h, url, code)
        if base in self.redirects:
            h['Location'] = self.redirects[base]
            return self._r(b'', h, url, 302)
        body = self.objects.get(base)
        if body is None:
            return self._r(b'nf', h, url, 404)
        code = 200
        if rng and not self.ignore_range:
            start = int(rng.split('=')[1].split('-')[0])
            if start >= len(body):
                return self._r(b'', h, url, 416)
            first = start + 7 if self.bad_range_next else start
            self.bad_range_next = False
            h['Content-Range'] = f'bytes {first}-{len(body) - 1}/{len(body)}'
            body, code = body[start:], 206
        if self.truncate_next is not None:
            body, self.truncate_next = body[:self.truncate_next], None
        return self._r(body, h, url, code)

    @staticmethod
    def _r(body, h, url, code):
        r = urllib.response.addinfourl(io.BytesIO(body), h, url, code)
        r.msg = 'OK' if code < 400 else 'Error'
        return r


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='mpv-agent-'))
        ag.BASE, ag.DATA, ag.MEDIA = self.tmp, self.tmp / 'data', self.tmp / 'media'
        ag.IDENTITY, ag.SECRET = ag.DATA / 'device_identity.json', ag.DATA / 'cloud_secret'
        ag.MEDIA.mkdir(parents=True)
        ag.DATA.mkdir(parents=True)
        self.net = FakeNet()
        for host in (PUB, PRIV):
            self.net.objects[host + PATH] = DATA
        ag.open_blob = lambda req: urllib.request.build_opener(ag.SafeBlobRedirect(), self.net).open(req, timeout=60)
        self._disk = shutil.disk_usage

    def tearDown(self):
        shutil.disk_usage = self._disk
        shutil.rmtree(self.tmp, ignore_errors=True)

    def media(self):
        return sorted(p.name for p in ag.MEDIA.iterdir())

    def fails(self, reason, c, transient=None):
        with self.assertRaises(ag.TransferError) as ctx:
            ag.do_download(c, lambda n: None)
        self.assertEqual(ctx.exception.reason, reason, str(ctx.exception))
        if transient is not None:
            self.assertEqual(getattr(ctx.exception, 'transient', False), transient)
        return ctx.exception


class Shared(Base):
    """Behaviour of the installed V2.1 that 2.2 must keep."""

    def test_identity_and_secret_are_read_never_regenerated(self):
        ag.IDENTITY.write_text(json.dumps({'device_id': '0123456789abcdef'}))
        ag.SECRET.write_text('existing-secret-' + 'x' * 40)
        ag.SECRET.chmod(0o600)
        a = ag.Agent()
        self.assertEqual(a.id, '0123456789abcdef')
        self.assertEqual(a.secret, 'existing-secret-' + 'x' * 40)
        self.assertEqual(ag.SECRET.read_text(), 'existing-secret-' + 'x' * 40)
        ag.IDENTITY.write_text(json.dumps({'device_id': 'not-hex'}))
        with self.assertRaises(RuntimeError):
            ag.Agent()

    def test_sync_payload_and_command_handling(self):
        ag.IDENTITY.write_text(json.dumps({'device_id': '0123456789abcdef'}))
        sent = []
        ag.post_json = lambda url, payload, bearer: (sent.append((url, payload, bearer)) or (200, {'commands': [], 'pollSeconds': 2}))
        (ag.MEDIA / 'a.jpg').write_bytes(b'x')
        (ag.MEDIA / f'.transfer-{TID}.part').write_bytes(b'y')
        a = ag.Agent()
        self.assertEqual(a.sync(), 2)
        url, p, bearer = sent[0]
        self.assertTrue(url.endswith('/api/pi/sync'))
        self.assertEqual(bearer, a.secret)
        for k in ('deviceId', 'username', 'hostname', 'localIp', 'port', 'media', 'agentVersion', 'results', 'protocol', 'capabilities', 'storage', 'progress'):
            self.assertIn(k, p)
        self.assertEqual((p['deviceId'], p['port'], p['protocol']), ('0123456789abcdef', 5000, 2))
        self.assertEqual([m['name'] for m in p['media']], ['a.jpg'], '.part never listed')
        for c in ('sha256', 'range-resume', 'progress', 'storage'):
            self.assertIn(c, p['capabilities'])
        self.assertNotIn('pairing', p['capabilities'])

    def test_cloud_url_must_be_https(self):
        with self.assertRaises(ValueError):
            ag.post_json('http://example.com/api/pi/sync', {}, 'x')

    def test_public_download_verified_and_placed(self):
        seen = []
        r = ag.do_download(cmd(), seen.append)
        self.assertEqual(r, {'filename': 'promo.mp4', 'sha256': SHA, 'size': len(DATA)})
        self.assertEqual((ag.MEDIA / 'promo.mp4').read_bytes(), DATA)
        self.assertEqual(self.media(), ['promo.mp4'])
        self.assertEqual(seen[-1], len(DATA))

    def test_checksum_mismatch(self):
        self.fails('checksum-mismatch', cmd(sha256='0' * 64))
        self.assertEqual(self.media(), [])

    def test_resume_from_partial_file_with_range(self):
        (ag.MEDIA / f'.transfer-{TID}.part').write_bytes(DATA[:1048583])
        r = ag.do_download(cmd(), lambda n: None)
        self.assertEqual(self.net.requests[-1]['range'], 'bytes=1048583-')
        self.assertEqual(r['sha256'], SHA)
        self.assertEqual(self.media(), ['promo.mp4'])

    def test_server_ignoring_range_restarts(self):
        (ag.MEDIA / f'.transfer-{TID}.part').write_bytes(DATA[:5000])
        self.net.ignore_range = True
        self.assertEqual(ag.do_download(cmd(), lambda n: None)['sha256'], SHA)

    def test_invalid_resume_range_rejected(self):
        (ag.MEDIA / f'.transfer-{TID}.part').write_bytes(DATA[:5000])
        self.net.bad_range_next = True
        self.fails('download-failed', cmd())
        self.assertEqual(self.media(), [], 'bad partial file removed')

    def test_insufficient_storage(self):
        shutil.disk_usage = lambda p: Usage(8 * 2**30, 0, 100 * 2**20)
        self.fails('insufficient-storage', cmd())
        self.assertEqual(self.net.requests, [])

    def test_size_limits_and_types(self):
        self.fails('download-failed', cmd(size=ag.MAX_BYTES + 1))
        self.fails('download-failed', cmd(sha256='nothex'))
        self.fails('unsupported-type', cmd(filename='run.sh'))
        self.net.objects[PUB + PATH] = DATA + b'extra'
        self.fails('size-mismatch', cmd())
        self.assertEqual([n for n in self.media() if not n.startswith('.')], [])

    def test_duplicate_filename_never_overwrites(self):
        (ag.MEDIA / 'promo.mp4').write_bytes(b'local upload')
        self.assertEqual(ag.do_download(cmd(), lambda n: None)['filename'], 'promo_1.mp4')
        self.assertEqual((ag.MEDIA / 'promo.mp4').read_bytes(), b'local upload')

    def test_untrusted_urls_rejected(self):
        for u in [(PUB + PATH).replace('https://', 'http://'), 'https://evil.example.com' + PATH,
                  (PUB + PATH).replace('https://', 'https://u:p@'), (PUB + PATH).replace('.com/', '.com:8443/'),
                  PUB + PATH + '#frag', '']:
            self.fails('untrusted-url', cmd(url=u))
        self.assertEqual(self.net.requests, [])

    def test_redirect_to_untrusted_host_rejected(self):
        for target in ['https://evil.example.com/x.mp4', (PUB + PATH).replace('https://', 'http://')]:
            self.net.redirects[PUB + PATH] = target
            self.fails('untrusted-url', cmd())
        self.assertEqual(self.media(), [])

    def test_delete_command(self):
        ag.IDENTITY.write_text(json.dumps({'device_id': '0123456789abcdef'}))
        (ag.MEDIA / 'old.jpg').write_bytes(b'x')
        a = ag.Agent()
        a.run_command({'id': 'd1', 'type': 'delete', 'filename': 'old.jpg'})
        a.run_command({'id': 'd2', 'type': 'delete', 'filename': '../data/device_identity.json'})
        self.assertFalse((ag.MEDIA / 'old.jpg').exists())
        self.assertTrue(ag.IDENTITY.exists())
        self.assertEqual([r['ok'] for r in a.results], [True, False])


@unittest.skipUnless(MERGED, 'V2.1 has no private Blob support')
class PrivateBlob(Base):
    """What 2.2 adds."""

    def test_private_presigned_download(self):
        url = PRIV + PATH + '?vercel-blob-delegation=d&vercel-blob-signature=s'
        self.assertEqual(ag.do_download(cmd(url=url), lambda n: None)['sha256'], SHA)
        self.assertNotIn('authorization', json.dumps(self.net.requests).lower())

    def test_redirect_between_trusted_hosts_allowed(self):
        self.net.redirects[PUB + PATH] = PRIV + PATH
        self.assertEqual(ag.do_download(cmd(), lambda n: None)['filename'], 'promo.mp4')

    def test_url_must_belong_to_the_transfer(self):
        self.fails('untrusted-url', cmd(url=PRIV + PATH.replace(TID, 'A' * 22)))
        self.fails('untrusted-url', cmd(url=PRIV + '/media/promo.mp4'))

    def test_expired_url_or_network_drop_keeps_part_for_resume(self):
        (ag.MEDIA / f'.transfer-{TID}.part').write_bytes(DATA[:1000])
        self.net.status_next = 403
        self.fails('download-failed', cmd(url=PRIV + PATH), transient=True)
        self.assertTrue((ag.MEDIA / f'.transfer-{TID}.part').exists())
        self.net.truncate_next = 2000
        self.fails('download-failed', cmd(url=PRIV + PATH), transient=True)
        self.assertEqual((ag.MEDIA / f'.transfer-{TID}.part').stat().st_size, 3000)
        self.assertEqual(ag.do_download(cmd(url=PRIV + PATH), lambda n: None)['sha256'], SHA)

    def test_copy_gone_is_final(self):
        self.net.objects.clear()
        self.fails('download-failed', cmd(url=PRIV + PATH), transient=False)

    def test_repeated_command_reuses_saved_file(self):
        first = ag.do_download(cmd(url=PRIV + PATH), lambda n: None)
        n = len(self.net.requests)
        self.assertEqual(ag.do_download(cmd(url=PRIV + PATH, id='6f1c1b1e-1111-4222-8333-000000000002'), lambda n: None), first)
        self.assertEqual(len(self.net.requests), n)
        self.assertEqual(self.media(), ['promo.mp4'])

    def test_transient_failures_retried_then_reported(self):
        ag.IDENTITY.write_text(json.dumps({'device_id': '0123456789abcdef'}))
        a = ag.Agent()
        c = cmd(url=PRIV + PATH)
        for _ in range(ag.MAX_LOCAL_ATTEMPTS - 1):
            self.net.status_next = 503
            a.running.add(c['id'])
            a.run_command(c)
            self.assertEqual(a.results, [])
        self.net.status_next = 503
        a.run_command(c)
        self.assertEqual((a.results[0]['ok'], a.results[0]['reason']), (False, 'download-failed'))


@unittest.skipIf(MERGED, 'baseline of the installed V2.1 only')
class V21Baseline(Base):
    def test_v21_refuses_private_blob_urls(self):
        self.fails('untrusted-url', cmd(url=PRIV + PATH))


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=2).result
    print(json.dumps({'agent': os.path.basename(AGENT_FILE), 'version': ag.AGENT_VERSION, 'tests': result.testsRun,
                      'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped)}))
    sys.exit(0 if result.wasSuccessful() else 1)
