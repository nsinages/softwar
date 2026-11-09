"""
Unit tests for the Pi cloud agent's protocol-2 downloads (N-Signage/app/cloud_agent.py).

Only the network transport is replaced: an in-memory HTTPS handler (a subclass
of urllib.request.HTTPSHandler, so urllib's own redirect and error processing
and the agent's SafeRedirectHandler still run). Everything else is the real
agent code working in a temporary media/ and data/ folder.

Run: python tests/helpers/test_cloud_agent_v2.py   (also run by npm test)
"""
import collections
import hashlib
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

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, '..', '..', 'N-Signage', 'app'))
sys.path.insert(0, APP)
if 'pwd' not in sys.modules:
    try:
        import pwd  # noqa: F401
    except ImportError:
        fake = types.ModuleType('pwd')
        fake.getpwuid = lambda uid: types.SimpleNamespace(pw_name='nsignage')
        sys.modules['pwd'] = fake
        os.geteuid = getattr(os, 'geteuid', lambda: 1000)

import config  # noqa: E402
import cloud_agent as ca  # noqa: E402

TID = 'ptMHZ-BuXPuzjnjLjk1wPw'
HOST = 'https://abc123.private.blob.vercel-storage.com'
PUBLIC_HOST = 'https://abc123.public.blob.vercel-storage.com'
URL = f'{HOST}/transfers/0123456789abcdef/{TID}/promo-Xy7.mp4?vercel-blob-delegation=d&vercel-blob-signature=s'
DATA = b'\x00\x00\x00\x20ftypisom' + os.urandom(3 * 1024 * 1024 + 123)
SHA = hashlib.sha256(DATA).hexdigest()


def cmd(**over):
    c = {'id': '6f1c1b1e-1111-4222-8333-944455556666', 'type': 'download', 'transferId': TID,
         'url': URL, 'filename': 'promo.mp4', 'size': len(DATA), 'sha256': SHA}
    c.update(over)
    return c


class FakeNet(urllib.request.HTTPSHandler):
    """In-memory HTTPS: objects by URL without query, optional redirects, Range, truncation."""

    def __init__(self):
        super().__init__()
        self.objects = {}
        self.redirects = {}
        self.ignore_range = False
        self.truncate_next = None   # serve only this many bytes on the next request
        self.status_next = None
        self.requests = []

    def https_open(self, req):
        url = req.full_url
        base = url.split('?', 1)[0]
        rng = req.get_header('Range')
        self.requests.append({'url': url, 'range': rng})
        headers = http_headers()
        if self.status_next:
            code, self.status_next = self.status_next, None
            return self._resp(b'', headers, url, code)
        if base in self.redirects:
            headers['Location'] = self.redirects[base]
            return self._resp(b'', headers, url, 302)
        body = self.objects.get(base)
        if body is None:
            return self._resp(b'not found', headers, url, 404)
        code = 200
        if rng and not self.ignore_range:
            start = int(rng.split('=')[1].split('-')[0])
            if start >= len(body):
                return self._resp(b'', headers, url, 416)
            headers['Content-Range'] = f'bytes {start}-{len(body) - 1}/{len(body)}'
            body = body[start:]
            code = 206
        if self.truncate_next is not None:
            body, self.truncate_next = body[:self.truncate_next], None
        return self._resp(body, headers, url, code)

    @staticmethod
    def _resp(body, headers, url, code):
        r = urllib.response.addinfourl(io.BytesIO(body), headers, url, code)
        r.msg = 'OK' if code < 400 else 'Error'
        return r


def http_headers():
    import email.message
    return email.message.Message()


Usage = collections.namedtuple('Usage', 'total used free')


class AgentDownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='nsignage-agent-test-')
        config.MEDIA_FOLDER = os.path.join(self.tmp, 'media')
        config.DATA_FOLDER = os.path.join(self.tmp, 'data')
        os.makedirs(config.MEDIA_FOLDER)
        os.makedirs(config.DATA_FOLDER)
        ca.SECRET_FILE = os.path.join(config.DATA_FOLDER, 'cloud_secret')
        self.net = FakeNet()
        self.net.objects[URL.split('?')[0]] = DATA
        ca.EXTRA_HANDLERS = [self.net]
        self._disk = ca.disk_usage
        self._caps = list(ca.CAPABILITIES)

    def tearDown(self):
        ca.EXTRA_HANDLERS = []
        ca.disk_usage = self._disk
        ca.CAPABILITIES[:] = self._caps
        shutil.rmtree(self.tmp, ignore_errors=True)

    def media(self):
        return sorted(os.listdir(config.MEDIA_FOLDER))

    def assertReason(self, reason, c, transient=False):
        with self.assertRaises(ca.TransferError) as ctx:
            ca.download_transfer(c)
        self.assertEqual(ctx.exception.reason, reason, str(ctx.exception))
        self.assertEqual(ctx.exception.transient, transient)
        return ctx.exception

    # 5 / 8: valid private download, checksum verified, atomic placement
    def test_valid_private_download(self):
        seen = []
        name, digest, size = ca.download_transfer(cmd(), seen.append)
        self.assertEqual((name, digest, size), ('promo.mp4', SHA, len(DATA)))
        with open(os.path.join(config.MEDIA_FOLDER, name), 'rb') as f:
            self.assertEqual(f.read(), DATA)
        self.assertEqual(self.media(), ['promo.mp4'], 'no .part left behind')
        self.assertEqual(seen[-1], len(DATA), 'progress reported')
        self.assertEqual(ca.load_done()[TID]['name'], 'promo.mp4')
        self.assertIsNone(self.net.requests[0]['range'])
        if os.name == 'posix':
            self.assertEqual(os.stat(os.path.join(config.MEDIA_FOLDER, name)).st_mode & 0o777, 0o644)

    # 6: untrusted URLs are refused before any request
    def test_untrusted_urls_rejected(self):
        bad = [
            URL.replace('https://', 'http://'),
            URL.replace('abc123.private.blob.vercel-storage.com', 'evil.example.com'),
            URL.replace('abc123.private.blob.vercel-storage.com', 'abc123.private.blob.vercel-storage.com.evil.com'),
            URL.replace('https://', 'https://user:pw@'),
            URL.replace('vercel-storage.com/', 'vercel-storage.com:8443/'),
            URL.replace(TID, 'AAAAAAAAAAAAAAAAAAAAAA'),          # not this transfer's path
            URL.replace('/transfers/', '/media/'),
            '',
        ]
        for u in bad:
            self.assertReason('untrusted-url', cmd(url=u))
        self.assertReason('untrusted-url', cmd(transferId='../../x'))
        self.assertEqual(self.net.requests, [], 'no request was made')
        self.assertEqual(self.media(), [])

    def test_private_hosts_only_with_private_blob_capability(self):
        ca.CAPABILITIES[:] = [c for c in ca.CAPABILITIES if c != 'private-blob']
        self.assertReason('untrusted-url', cmd())
        public = URL.replace(HOST, PUBLIC_HOST)
        self.net.objects[public.split('?')[0]] = DATA
        self.assertEqual(ca.download_transfer(cmd(url=public))[0], 'promo.mp4')

    # 7: redirects only to trusted Blob hosts
    def test_unsafe_redirects_rejected(self):
        base = URL.split('?')[0]
        for target in ['https://evil.example.com/x.mp4', base.replace('https://', 'http://'), 'https://169.254.169.254/latest']:
            self.net.redirects[base] = target
            self.assertReason('untrusted-url', cmd())
        self.assertEqual(self.media(), [], 'nothing saved')

    def test_safe_redirect_followed(self):
        base = URL.split('?')[0]
        other = f'{PUBLIC_HOST}/transfers/0123456789abcdef/{TID}/promo-copy.mp4'
        self.net.redirects[base] = other
        self.net.objects[other] = DATA
        self.assertEqual(ca.download_transfer(cmd())[0], 'promo.mp4')

    # 9: corrupted download
    def test_checksum_mismatch_removes_part(self):
        self.assertReason('checksum-mismatch', cmd(sha256='0' * 64))
        self.assertEqual(self.media(), [], 'temp file removed, nothing visible')

    # 10: interrupted download resumes with Range
    def test_interrupted_download_resumes_with_range(self):
        self.net.truncate_next = 1024 * 1024 + 7
        e = self.assertReason('download-failed', cmd(), transient=True)
        self.assertIn('incomplete', str(e))
        part = ca.part_path(TID)
        self.assertEqual(os.path.getsize(part), 1024 * 1024 + 7, 'partial file kept for resume')
        self.assertNotIn('promo.mp4', self.media())
        name, digest, _ = ca.download_transfer(cmd())
        self.assertEqual(self.net.requests[-1]['range'], f'bytes={1024 * 1024 + 7}-')
        self.assertEqual((name, digest), ('promo.mp4', SHA))
        self.assertFalse(os.path.exists(part))

    def test_server_ignoring_range_restarts_cleanly(self):
        with open(ca.part_path(TID), 'wb') as f:
            f.write(DATA[:5000])
        self.net.ignore_range = True
        name, digest, _ = ca.download_transfer(cmd())
        self.assertEqual(digest, SHA)
        with open(os.path.join(config.MEDIA_FOLDER, name), 'rb') as f:
            self.assertEqual(f.read(), DATA)

    def test_expired_presigned_url_is_transient_and_keeps_part(self):
        with open(ca.part_path(TID), 'wb') as f:
            f.write(DATA[:1000])
        self.net.status_next = 403
        self.assertReason('download-failed', cmd(), transient=True)
        self.assertTrue(os.path.exists(ca.part_path(TID)))

    def test_relay_copy_gone_is_final(self):
        self.net.objects.clear()
        self.assertReason('download-failed', cmd(), transient=False)

    # 11: insufficient storage
    def test_insufficient_storage(self):
        ca.disk_usage = lambda p: Usage(8 * 2**30, 8 * 2**30 - 50 * 2**20, 50 * 2**20)
        with open(ca.part_path(TID), 'wb') as f:
            f.write(b'x' * 10)
        self.assertReason('insufficient-storage', cmd())
        self.assertEqual(self.media(), [], 'partial file removed')
        self.assertEqual(self.net.requests, [])

    def test_size_limits(self):
        self.assertReason('too-large', cmd(size=ca.MAX_DOWNLOAD_BYTES + 1))
        self.assertReason('size-mismatch', cmd(size=0))
        self.assertReason('unsupported-type', cmd(filename='run.sh'))
        self.net.objects[URL.split('?')[0]] = DATA + b'extra'
        self.assertReason('size-mismatch', cmd())
        self.assertEqual(self.media(), [])

    # 12: duplicate file names never overwrite
    def test_duplicate_filename_gets_new_name(self):
        existing = os.path.join(config.MEDIA_FOLDER, 'promo.mp4')
        with open(existing, 'wb') as f:
            f.write(b'local upload')
        name, _, _ = ca.download_transfer(cmd())
        self.assertEqual(name, 'promo_1.mp4')
        with open(existing, 'rb') as f:
            self.assertEqual(f.read(), b'local upload', 'existing file untouched')

    # 13: a repeated command for an already-saved transfer creates no second file
    def test_duplicate_transfer_command_reuses_file(self):
        first = ca.download_transfer(cmd())
        n = len(self.net.requests)
        again = ca.download_transfer(cmd(id='6f1c1b1e-1111-4222-8333-000000000002'))
        self.assertEqual(again, first)
        self.assertEqual(len(self.net.requests), n, 'not downloaded again')
        self.assertEqual(self.media(), ['promo.mp4'])
        # if the saved file was changed or deleted locally, it is downloaded again
        os.remove(os.path.join(config.MEDIA_FOLDER, 'promo.mp4'))
        self.assertEqual(ca.download_transfer(cmd())[0], 'promo.mp4')

    def test_part_files_never_listed_as_media(self):
        with open(ca.part_path(TID), 'wb') as f:
            f.write(b'x')
        open(os.path.join(config.MEDIA_FOLDER, 'a.jpg'), 'wb').close()
        self.assertEqual([m['name'] for m in ca.list_media()], ['a.jpg'])

    def test_cleanup_of_stale_part_files(self):
        old, orphan, live, running = (ca.part_path(t) for t in ('A' * 22, 'B' * 22, 'C' * 22, 'D' * 22))
        for p in (old, orphan, live, running):
            open(p, 'wb').close()
        now = time.time()
        os.utime(old, (now - 73 * 3600,) * 2)
        for p in (orphan, live, running):
            os.utime(p, (now - 2 * 3600,) * 2)
        ca.cleanup_parts(set(), set(), orphans=False)          # agent start: only the 72 h rule
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(orphan))
        ca.cleanup_parts({'C' * 22}, {'D' * 22})
        self.assertFalse(os.path.exists(orphan))
        self.assertTrue(os.path.exists(live) and os.path.exists(running))


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='nsignage-agent-loop-')
        config.MEDIA_FOLDER = os.path.join(self.tmp, 'media')
        config.DATA_FOLDER = os.path.join(self.tmp, 'data')
        os.makedirs(config.MEDIA_FOLDER)
        os.makedirs(config.DATA_FOLDER)
        ca.SECRET_FILE = os.path.join(config.DATA_FOLDER, 'cloud_secret')
        with open(ca.SECRET_FILE, 'w') as f:
            f.write('existing-device-secret-' + 'x' * 30)
        self.net = FakeNet()
        self.net.objects[URL.split('?')[0]] = DATA
        ca.EXTRA_HANDLERS = [self.net]

    def tearDown(self):
        ca.EXTRA_HANDLERS = []
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_identity_is_never_regenerated(self):
        agent = ca.Agent()
        self.assertEqual(agent.secret, 'existing-device-secret-' + 'x' * 30)
        with open(ca.SECRET_FILE) as f:
            self.assertEqual(f.read(), 'existing-device-secret-' + 'x' * 30)

    def test_announces_protocol_2_capabilities(self):
        self.assertEqual(ca.AGENT_PROTOCOL, 2)
        for c in ('sha256', 'range-resume', 'progress', 'storage', 'private-blob'):
            self.assertIn(c, ca.CAPABILITIES)
        self.assertNotIn('pairing', ca.CAPABILITIES, 'no pairing codes in the customer workflow')

    def test_success_result_carries_size_and_checksum(self):
        agent = ca.Agent()
        agent.running.add(cmd()['id'])
        agent.run_command(cmd())
        self.assertEqual(agent.results, [{'id': cmd()['id'], 'ok': True, 'filename': 'promo.mp4', 'sha256': SHA, 'size': len(DATA)}])

    def test_transient_failures_retry_silently_then_report(self):
        agent = ca.Agent()
        c = cmd()
        for i in range(ca.MAX_LOCAL_ATTEMPTS - 1):
            self.net.status_next = 503
            agent.running.add(c['id'])
            agent.run_command(c)
            self.assertEqual(agent.results, [], f'attempt {i + 1} not reported yet')
            self.assertNotIn(c['id'], agent.running)
        self.net.status_next = 503
        agent.run_command(c)
        self.assertEqual(len(agent.results), 1)
        self.assertEqual(agent.results[0]['reason'], 'download-failed')
        self.assertFalse(agent.results[0]['ok'])

    def test_final_failure_reports_reason(self):
        agent = ca.Agent()
        agent.run_command(cmd(sha256='1' * 64))
        self.assertEqual(agent.results[0]['reason'], 'checksum-mismatch')

    def test_delete_command_unchanged(self):
        path = os.path.join(config.MEDIA_FOLDER, 'old.jpg')
        open(path, 'wb').close()
        agent = ca.Agent()
        agent.run_command({'id': 'x1', 'type': 'delete', 'filename': 'old.jpg'})
        agent.run_command({'id': 'x2', 'type': 'delete', 'filename': '../data/cloud_secret'})
        self.assertFalse(os.path.exists(path))
        self.assertTrue(os.path.exists(ca.SECRET_FILE), 'no path traversal')
        self.assertTrue(all(r['ok'] for r in agent.results))


class LocalPlayerCompatibilityTests(unittest.TestCase):
    """18: the LAN upload and the player's media list are unchanged (Flask app.py)."""

    def setUp(self):
        try:
            import flask  # noqa: F401
        except ImportError:
            self.skipTest('Flask not installed')
        self.tmp = tempfile.mkdtemp(prefix='nsignage-player-')
        config.MEDIA_FOLDER = os.path.join(self.tmp, 'media')
        config.DATA_FOLDER = os.path.join(self.tmp, 'data')
        os.makedirs(config.MEDIA_FOLDER)
        os.makedirs(config.DATA_FOLDER)
        import app as player
        self.client = player.app.test_client()

    def tearDown(self):
        shutil.rmtree(getattr(self, 'tmp', ''), ignore_errors=True)

    def test_lan_upload_and_media_list_ignore_part_files(self):
        with open(os.path.join(config.MEDIA_FOLDER, f'.transfer-{TID}.part'), 'wb') as f:
            f.write(b'partial')
        r = self.client.post('/api/upload', data={'file': (io.BytesIO(b'\xff\xd8\xff\xe0' + b'x' * 100), 'shop.jpg')},
                             content_type='multipart/form-data')
        self.assertEqual(r.status_code, 201, r.get_data(as_text=True))
        r2 = self.client.post('/api/upload', data={'file': (io.BytesIO(b'\xff\xd8\xff\xe0'), 'shop.jpg')},
                              content_type='multipart/form-data')
        self.assertEqual(r2.get_json()['filename'], 'shop_1.jpg')
        names = [m['name'] for m in self.client.get('/api/media').get_json()['media']]
        self.assertEqual(names, ['shop.jpg', 'shop_1.jpg'], 'the player never sees .part files')


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=2).result
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
                      'skipped': len(result.skipped)}))
    sys.exit(0 if result.wasSuccessful() else 1)
