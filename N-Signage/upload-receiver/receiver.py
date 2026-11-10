#!/usr/bin/env python3
"""
N-Signage direct upload receiver (service: n-signage-upload, user ns).

Receives media DIRECTLY from the customer's browser, end-to-end encrypted,
through a Cloudflare Tunnel that forwards https://<hostname> to 127.0.0.1 only.
The website never holds media bytes; Cloudflare only sees ciphertext.

Separate from the installed cloud agent (V2.1): it never modifies V2.1 files.
It READS data/device_identity.json and data/cloud_secret, writes only to
media/ (hidden .upload-<id>.part files, then an atomic rename to a NEW name)
and to its own folder data/upload/.

Every request is checked; CORS is not relied on:
  ticket   Ed25519 signature by the website (keys from the authenticated heartbeat),
           version, issuer, audience == this Pi's device id, transfer id == URL,
           time window (clock synced to the website), deadline, size, checksum,
           file name, chunk size, and SHA-256(browser key) == X-NS-EPK
  website  is asked online whether the transfer is still allowed at the first
           chunk and again before the file is saved
  chunk    exact next index (or an identical retry of the last one), exact length,
           AES-256-GCM tag over ciphertext + (device, transfer, index, length, size, sha256)
  file     total size and SHA-256 before saving; never overwrites an existing file
Crypto must match shared/e2eCrypto.js.

Env (/etc/n-signage-upload.env):
  NSIGNAGE_UPLOAD_HOSTNAME   p-<16 hex>.nsinages.in  (this Pi's tunnel hostname)
  NSIGNAGE_CLOUD_URL         default https://software.nsinages.in
  NSIGNAGE_UPLOAD_ORIGIN     default https://software.nsinages.in (CORS, defence in depth)
  NSIGNAGE_UPLOAD_PORT       default 8090 (127.0.0.1 only)
  NSIGNAGE_HOME              default /home/ns/n-signage
"""
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import ssl
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

VERSION = '1.1.0'
BASE = Path(os.environ.get('NSIGNAGE_HOME') or '/home/ns/n-signage')
MEDIA = BASE / 'media'
DATA = BASE / 'data'
STATE_DIR = DATA / 'upload'
IDENTITY = DATA / 'device_identity.json'
SECRET = DATA / 'cloud_secret'
CLOUD_URL = os.environ.get('NSIGNAGE_CLOUD_URL', 'https://software.nsinages.in').rstrip('/')
HOSTNAME = os.environ.get('NSIGNAGE_UPLOAD_HOSTNAME', '').strip().lower()
ALLOWED_ORIGIN = os.environ.get('NSIGNAGE_UPLOAD_ORIGIN', 'https://software.nsinages.in').rstrip('/')
PORT = int(os.environ.get('NSIGNAGE_UPLOAD_PORT', '8090'))
ALLOW_HTTP_CLOUD = os.environ.get('NSIGNAGE_UPLOAD_ALLOW_HTTP_CLOUD') == '1'   # tests only

MiB = 1024 * 1024
MAX_FILE = 500 * MiB
MIN_CHUNK, MAX_CHUNK = 256 * 1024, 8 * MiB
TAG = 16
STORAGE_MARGIN = 200 * MiB
CLOCK_SKEW = 120
MAX_TICKET_LIFE = 3600
HEARTBEAT_S = 30
PART_MAX_AGE = 72 * 3600
MAX_CONCURRENT_CHUNKS = 2
EXTENSIONS = {'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'}
SAFE_NAME = re.compile(r'[^A-Za-z0-9._ ()-]')
TID_RX = re.compile(r'^[A-Za-z0-9_-]{22}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
DEVICE_RX = re.compile(r'^[0-9a-f]{16}$')
TICKET_RX = re.compile(r'^nst1\.([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{80,90})$')
CHUNK_PATH = re.compile(r'^/v1/transfers/([A-Za-z0-9_-]{22})/chunks/(\d{1,7})$')
STATUS_PATH = re.compile(r'^/v1/transfers/([A-Za-z0-9_-]{22})$')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('n-signage-upload')


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
class ReceiverError(Exception):
    def __init__(self, status, reason, message='', extra=None):
        super().__init__(message or reason)
        self.status, self.reason, self.extra = status, reason, extra or {}


def b64u_decode(s):
    s = str(s)
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def b64u_encode(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def allowed_name(name):
    return '.' in name and name.rsplit('.', 1)[-1].lower() in EXTENSIONS


def safe_filename(value):
    """Same rule as the installed agent (no directories, no hidden files)."""
    name = os.path.basename(str(value or ''))
    name = SAFE_NAME.sub('_', name).lstrip('._- ')[:180]
    return name if allowed_name(name) else ''


def write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.tmp-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def chunk_iv(index):
    return bytes(8) + index.to_bytes(4, 'big')


def chunk_aad(device_id, tid, index, plain_len, size, sha256):
    return f'nsignage-v1|{device_id}|{tid}|{index}|{plain_len}|{size}|{sha256}'.encode()


def reserve_name(filename):
    """Reserve a free name in media/ with O_EXCL (never overwrites), as V2.1 does."""
    base, ext = os.path.splitext(filename)
    for i in range(10000):
        name = f'{base}_{i}{ext}' if i else filename
        target = MEDIA / name
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            os.close(fd)
            return name, target
        except FileExistsError:
            continue
    raise ReceiverError(409, 'name-exhausted', 'Too many files with this name')


# ---------------------------------------------------------------------------
# identity, keys, clock, website
# ---------------------------------------------------------------------------
class Receiver:
    def __init__(self, cloud=None):
        self.device_id = self._device_id()
        self.secret = self._secret()
        self.key = self._receiver_key()
        pub = self.key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.public_key_b64 = b64u_encode(pub)
        self.fingerprint = hashlib.sha256(pub).hexdigest()
        self.clock_offset = 0.0
        self.ticket_keys = self._load_ticket_keys()
        self.locks = {}
        self.locks_guard = threading.Lock()
        self.hashers = {}
        self.chunk_slots = threading.BoundedSemaphore(MAX_CONCURRENT_CHUNKS)
        self.cloud = cloud or self._cloud_post
        self.key_cache = {}
        self.last_key_refresh = 0.0

    # --- read-only access to the installed agent's identity ---
    @staticmethod
    def _device_id():
        with IDENTITY.open() as f:
            value = json.load(f).get('device_id', '')
        if not DEVICE_RX.fullmatch(value):
            raise RuntimeError('data/device_identity.json has no valid device_id')
        return value

    @staticmethod
    def _secret():
        value = SECRET.read_text().strip()
        if len(value) < 32:
            raise RuntimeError('data/cloud_secret is missing or too short (the cloud agent creates it)')
        return value

    # --- this receiver's own key pair (private key never leaves the Pi) ---
    @staticmethod
    def _receiver_key():
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        path = STATE_DIR / 'receiver_key.pem'
        if path.exists():
            return serialization.load_pem_private_key(path.read_bytes(), password=None)
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(pem)
        log.info('Created the receiver key pair')
        return key

    def _load_ticket_keys(self):
        try:
            data = json.loads((STATE_DIR / 'ticket_keys.json').read_text())
            return {k['kid']: ed25519.Ed25519PublicKey.from_public_bytes(b64u_decode(k['publicKey'])) for k in data}
        except (OSError, ValueError, KeyError, TypeError):
            return {}

    def now(self):
        return time.time() + self.clock_offset

    # --- website (authenticated with the device secret, verified TLS) ---
    def _cloud_post(self, action, payload):
        url = f'{CLOUD_URL}/api/pi/receiver?action={action}'
        if not url.startswith('https://') and not ALLOW_HTTP_CLOUD:
            raise ReceiverError(500, 'cloud-not-https', 'Cloud URL must use HTTPS')
        req = urllib.request.Request(url, data=json.dumps({'deviceId': self.device_id, **payload}).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {self.secret}',
                                              'User-Agent': f'n-signage-upload/{VERSION}'})
        ctx = ssl.create_default_context() if url.startswith('https://') else None
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                return json.loads(r.read(1024 * 1024).decode() or '{}')
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read(65536).decode() or '{}')
            except ValueError:
                body = {}
            raise ReceiverError(502, body.get('reason') or f'cloud-http-{e.code}', body.get('error') or f'website answered HTTP {e.code}')
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ReceiverError(503, 'cloud-unreachable', f'website unreachable: {e}')

    def heartbeat(self):
        free = shutil.disk_usage(MEDIA).free
        sent = time.time()
        r = self.cloud('heartbeat', {'publicKey': self.public_key_b64, 'hostname': HOSTNAME or None,
                                     'version': VERSION, 'freeBytes': int(free)})
        if isinstance(r.get('serverTime'), (int, float)):
            # the reply arrived over verified TLS; take half the round trip as transit
            self.clock_offset = r['serverTime'] / 1000 - (sent + (time.time() - sent) / 2)
        keys = {}
        for k in r.get('ticketKeys') or []:
            try:
                raw = b64u_decode(k['publicKey'])
                if len(raw) == 32 and re.fullmatch(r'[0-9a-f]{16}', k['kid']):
                    keys[k['kid']] = ed25519.Ed25519PublicKey.from_public_bytes(raw)
            except (KeyError, ValueError, TypeError):
                continue
        if keys:
            self.ticket_keys = keys
            write_json_atomic(STATE_DIR / 'ticket_keys.json', [
                {'kid': kid, 'publicKey': b64u_encode(pk.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))}
                for kid, pk in keys.items()])
        if r.get('keyStatus') == 'pending':
            log.warning('The website has not accepted this receiver key yet: the owner must confirm the new key fingerprint %s', self.fingerprint)
        return r

    # --- tickets ---
    def verify_ticket(self, token, tid, epk_b64):
        m = TICKET_RX.fullmatch(token or '')
        if not m:
            raise ReceiverError(401, 'bad-ticket', 'Missing or malformed ticket')
        try:
            claims = json.loads(b64u_decode(m.group(1)))
            sig = b64u_decode(m.group(2))
        except ValueError:
            raise ReceiverError(401, 'bad-ticket', 'Malformed ticket')
        if not isinstance(claims, dict):
            raise ReceiverError(401, 'bad-ticket', 'Malformed ticket')
        key = self.ticket_keys.get(claims.get('kid'))
        if key is None and time.monotonic() - self.last_key_refresh > 10:
            # just started, or the website rotated its key: one rate-limited refresh over verified TLS
            self.last_key_refresh = time.monotonic()
            try:
                self.heartbeat()
            except ReceiverError:
                pass
            key = self.ticket_keys.get(claims.get('kid'))
        if key is None:
            raise ReceiverError(401, 'unknown-ticket-key', 'Ticket signed with an unknown key')
        try:
            key.verify(sig, f'nst1.{m.group(1)}'.encode())
        except InvalidSignature:
            raise ReceiverError(401, 'bad-ticket', 'Ticket signature is not valid')
        ints = {k: claims.get(k) for k in ('iat', 'nbf', 'exp', 'dl', 'size', 'chunk')}
        if any(not isinstance(v, int) or isinstance(v, bool) for v in ints.values()):
            raise ReceiverError(401, 'bad-ticket', 'Ticket fields missing')
        if claims.get('v') != 1 or claims.get('iss') != 'nsignage':
            raise ReceiverError(401, 'bad-ticket', 'Unsupported ticket')
        if claims.get('aud') != self.device_id:
            raise ReceiverError(403, 'wrong-device', 'This ticket is for another display')
        if claims.get('tid') != tid:
            raise ReceiverError(403, 'wrong-transfer', 'This ticket is for another transfer')
        now = self.now()
        if ints['exp'] - ints['iat'] > MAX_TICKET_LIFE or ints['exp'] > ints['dl'] + 1:
            raise ReceiverError(401, 'bad-ticket', 'Ticket lifetime not allowed')
        if now < ints['nbf'] - CLOCK_SKEW:
            raise ReceiverError(401, 'ticket-not-yet-valid', 'Ticket not valid yet')
        if now > ints['exp'] + CLOCK_SKEW:
            raise ReceiverError(401, 'ticket-expired', 'Ticket expired')
        if not (0 < ints['size'] <= MAX_FILE):
            raise ReceiverError(413, 'too-large', 'File size not allowed')
        if not (MIN_CHUNK <= ints['chunk'] <= MAX_CHUNK):
            raise ReceiverError(400, 'bad-ticket', 'Chunk size not allowed')
        if not isinstance(claims.get('sha256'), str) or not HEX64.fullmatch(claims['sha256']):
            raise ReceiverError(400, 'bad-ticket', 'Invalid checksum')
        name = claims.get('name')
        if not isinstance(name, str) or not name or safe_filename(name) != name:
            raise ReceiverError(400, 'unsupported-type', 'File name or type not allowed')
        try:
            epk_raw = b64u_decode(epk_b64 or '')
        except ValueError:
            epk_raw = b''
        if len(epk_raw) != 65 or epk_raw[0] != 4 or claims.get('epk') != hashlib.sha256(epk_raw).hexdigest():
            raise ReceiverError(403, 'wrong-key', 'Encryption key does not match the ticket')
        return claims, epk_raw

    def chunk_key(self, epk_raw, tid):
        cache_key = (epk_raw, tid)
        k = self.key_cache.get(cache_key)
        if k is None:
            try:
                peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk_raw)
            except ValueError:
                raise ReceiverError(400, 'wrong-key', 'Invalid encryption key')
            shared = self.key.exchange(ec.ECDH(), peer)
            k = HKDF(algorithm=hashes.SHA256(), length=32, salt=tid.encode(),
                     info=f'nsignage-media-v1|{self.device_id}'.encode()).derive(shared)
            if len(self.key_cache) > 32:
                self.key_cache.clear()
            self.key_cache[cache_key] = k
        return k

    # --- per-transfer state ---
    def lock_for(self, tid):
        with self.locks_guard:
            return self.locks.setdefault(tid, threading.Lock())

    @staticmethod
    def state_path(tid):
        return STATE_DIR / 'transfers' / f'{tid}.json'

    @staticmethod
    def part_path(tid):
        return MEDIA / f'.upload-{tid}.part'

    def load_state(self, tid):
        try:
            return json.loads(self.state_path(tid).read_text())
        except (OSError, ValueError):
            return None

    def save_state(self, st):
        write_json_atomic(self.state_path(st['tid']), st)

    def hasher_for(self, st):
        """Running SHA-256 of the plaintext received so far (rebuilt from the .part after a restart)."""
        h = self.hashers.get(st['tid'])
        if h is not None and h[1] == st['received']:
            return h[0]
        part = self.part_path(st['tid'])
        if part.exists() and part.stat().st_size > st['received']:
            with part.open('r+b') as f:   # crash between the data write and the state write
                f.truncate(st['received'])
        digest = hashlib.sha256()
        if st['received']:
            with part.open('rb') as f:
                for block in iter(lambda: f.read(MiB), b''):
                    digest.update(block)
        self.hashers[st['tid']] = (digest, st['received'])
        return digest

    def view(self, st):
        if not st:
            return {'nextIndex': 0, 'receivedBytes': 0, 'state': 'new'}
        out = {'nextIndex': st['next'], 'receivedBytes': st['received'], 'state': st['status']}
        if st['status'] == 'done':
            out.update({'done': True, 'savedAs': st['saved_as'], 'sha256': st['sha256']})
        return out

    def check_online(self, claims, phase):
        r = self.cloud('check', {'transferId': claims['tid'], 'size': claims['size'], 'sha256': claims['sha256'],
                                 'epk': claims['epk'], 'phase': phase})
        if not r.get('allowed'):
            raise ReceiverError(403, 'not-allowed', f"The website does not allow this transfer ({r.get('reason', 'denied')})")

    # --- request handling (called by the HTTP handler) ---
    def status(self, tid, token, epk):
        self.verify_ticket(token, tid, epk)
        return 200, self.view(self.load_state(tid))

    def put_chunk(self, tid, index, token, epk, length, read_body):
        claims, epk_raw = self.verify_ticket(token, tid, epk)
        size, chunk = claims['size'], claims['chunk']
        n_chunks = -(-size // chunk)
        if index >= n_chunks:
            raise ReceiverError(400, 'bad-index', 'Chunk index out of range')
        plain_len = min(chunk, size - index * chunk)
        if length != plain_len + TAG:
            raise ReceiverError(400, 'bad-length', f'Chunk {index} must be {plain_len + TAG} bytes')
        with self.lock_for(tid):
            st = self.load_state(tid)
            if st and st['status'] == 'done':
                return 200, self.view(st)
            if st and st['status'] == 'failed':
                self.discard(tid)
                st = None
            if st and any(st[k] != claims[k] for k in ('size', 'sha256', 'name', 'chunk')):
                raise ReceiverError(409, 'ticket-mismatch', 'Ticket does not match this transfer')
            if st is None:
                if index != 0:
                    raise ReceiverError(409, 'out-of-order', 'Start with chunk 0', {'nextIndex': 0})
                MEDIA.mkdir(parents=True, exist_ok=True)
                if size > shutil.disk_usage(MEDIA).free - STORAGE_MARGIN:
                    raise ReceiverError(507, 'insufficient-storage', 'Not enough free space on the SD card')
                self.check_online(claims, 'start')
                self.part_path(tid).unlink(missing_ok=True)
                st = {'tid': tid, 'size': size, 'sha256': claims['sha256'], 'name': claims['name'], 'chunk': chunk,
                      'next': 0, 'received': 0, 'last_digest': None, 'status': 'receiving',
                      'deadline': claims['dl'], 'created': int(time.time()), 'reported': False}
                self.save_state(st)
            if index not in (st['next'], st['next'] - 1):
                raise ReceiverError(409, 'out-of-order', f"Expected chunk {st['next']}", {'nextIndex': st['next']})
            with self.chunk_slots:
                body = read_body(length)
                if len(body) != length:
                    raise ReceiverError(400, 'bad-length', 'Chunk body incomplete')
                try:
                    plain = AESGCM(self.chunk_key(epk_raw, tid)).decrypt(
                        chunk_iv(index), body, chunk_aad(self.device_id, tid, index, plain_len, size, claims['sha256']))
                except InvalidTag:
                    raise ReceiverError(400, 'decrypt-failed', 'Chunk failed its integrity check')
                del body
                digest = hashlib.sha256(plain).hexdigest()
                if index == st['next'] - 1:
                    if digest != st['last_digest']:
                        raise ReceiverError(409, 'out-of-order', f"Expected chunk {st['next']}", {'nextIndex': st['next']})
                    return 200, self.view(st)   # identical retry of the last chunk
                hasher = self.hasher_for(st)
                with self.part_path(tid).open('ab') as out:
                    out.write(plain)
                    out.flush()
                    os.fsync(out.fileno())
                hasher.update(plain)
                st['next'] += 1
                st['received'] += plain_len
                st['last_digest'] = digest
                self.hashers[tid] = (hasher, st['received'])
                self.save_state(st)
                del plain
            if st['received'] < size:
                return 200, self.view(st)
            return self.finish(st, claims)

    def finish(self, st, claims):
        tid = st['tid']
        actual = self.hashers[tid][0].hexdigest()
        if actual != st['sha256'] or self.part_path(tid).stat().st_size != st['size']:
            self.fail(st, 'checksum-mismatch', 'The received file does not match its checksum')
            raise ReceiverError(422, 'checksum-mismatch', 'The received file does not match its checksum')
        try:
            self.check_online(claims, 'finish')
        except ReceiverError as e:
            if e.reason == 'not-allowed':
                self.fail(st, 'not-allowed', str(e), report=False)
            raise
        name, target = reserve_name(st['name'])
        try:
            os.replace(self.part_path(tid), target)
            os.chmod(target, 0o644)
        except OSError:
            target.unlink(missing_ok=True)
            raise
        self.hashers.pop(tid, None)
        st.update({'status': 'done', 'saved_as': name, 'completed': int(time.time())})
        self.save_state(st)
        log.info('Saved %s (%d bytes, SHA-256 verified)', name, st['size'])
        self.report(st)
        return 200, self.view(st)

    def fail(self, st, reason, message, report=True):
        self.part_path(st['tid']).unlink(missing_ok=True)
        self.hashers.pop(st['tid'], None)
        st.update({'status': 'failed', 'reason': reason, 'error': message[:300], 'next': 0, 'received': 0, 'reported': not report})
        self.save_state(st)
        if report:
            self.report(st)

    def discard(self, tid):
        self.part_path(tid).unlink(missing_ok=True)
        self.state_path(tid).unlink(missing_ok=True)
        self.hashers.pop(tid, None)

    def report(self, st):
        payload = {'transferId': st['tid'], 'ok': st['status'] == 'done'}
        if st['status'] == 'done':
            payload.update({'savedAs': st['saved_as'], 'sha256': st['sha256'], 'size': st['size']})
        else:
            payload.update({'reason': st.get('reason'), 'error': st.get('error')})
        try:
            self.cloud('result', payload)
            st['reported'] = True
            self.save_state(st)
        except ReceiverError as e:
            log.warning('Result for %s not reported yet (%s); will retry', st['tid'], e.reason)

    def housekeeping(self):
        """Retry unreported results; remove stale partial files and old state."""
        now = time.time()
        for path in (STATE_DIR / 'transfers').glob('*.json') if (STATE_DIR / 'transfers').exists() else []:
            try:
                st = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            tid = st.get('tid', '')
            if not TID_RX.fullmatch(tid):
                continue
            with self.lock_for(tid):
                if st['status'] in ('done', 'failed') and not st.get('reported'):
                    self.report(st)
                expired = now > st.get('deadline', 0) + 3600 or now - st.get('created', now) > PART_MAX_AGE
                if st['status'] == 'receiving' and expired:
                    self.discard(tid)
                elif st['status'] in ('done', 'failed') and st.get('reported') and now - st.get('created', now) > PART_MAX_AGE:
                    path.unlink(missing_ok=True)
        for part in MEDIA.glob('.upload-*.part'):
            try:
                if now - part.stat().st_mtime > PART_MAX_AGE:
                    part.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# HTTP (127.0.0.1 only; Cloudflare Tunnel connects here)
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    receiver = None
    server_version = 'n-signage-upload'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = 120

    def log_message(self, fmt, *args):  # no tickets or keys in logs
        log.debug('%s %s', self.command, self.path.split('?')[0])

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin == ALLOWED_ORIGIN:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _health(self):
        """Public diagnostics for the website's readiness check, readable from any origin (no secrets, no
        device id). The fingerprint lets the browser detect a tunnel hostname that leads to the wrong Pi;
        originAllowed tells it whether this receiver would accept uploads from the page's origin."""
        origin = self.headers.get('Origin')
        data = json.dumps({'ok': True, 'service': 'n-signage-upload', 'version': VERSION,
                           'fingerprint': self.receiver.fingerprint,
                           'originAllowed': origin is None or origin == ALLOWED_ORIGIN}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def _origin_ok(self):
        origin = self.headers.get('Origin')
        return origin is None or origin == ALLOWED_ORIGIN

    def _auth(self):
        a = self.headers.get('Authorization', '')
        return a[7:] if a.startswith('Bearer ') else ''

    def do_OPTIONS(self):
        if self.headers.get('Origin') != ALLOWED_ORIGIN:
            return self._send(403, {'ok': False, 'reason': 'origin'})
        self.send_response(204)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-NS-EPK')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _run(self, fn):
        try:
            if not self._origin_ok():
                raise ReceiverError(403, 'origin', 'Origin not allowed')
            status, body = fn()
            self._send(status, {'ok': True, **body})
        except ReceiverError as e:
            if e.status >= 500 or e.reason in ('decrypt-failed', 'wrong-device', 'bad-ticket'):
                log.warning('Refused %s %s: %s', self.command, self.path, e.reason)
            self._drain()
            # a refused PUT may leave unread body bytes on the connection: never reuse it
            self.close_connection = self.command == 'PUT'
            self._send(e.status, {'ok': False, 'reason': e.reason, 'error': str(e), **e.extra})
        except Exception as e:  # never leak details
            log.exception('Unexpected error: %s', e)
            self.close_connection = True
            self._drain()
            self._send(500, {'ok': False, 'reason': 'internal'})

    def _read_body(self, n):
        data = self.rfile.read(n)
        self._body_left -= len(data)
        return data

    def _drain(self):
        """Read and discard an unread request body (≤ one chunk) so the client receives the error reply
        instead of a connection reset. Larger bodies were already refused before this point."""
        left = getattr(self, '_body_left', 0)
        while 0 < left <= MAX_CHUNK + TAG:
            block = self.rfile.read(min(left, 1024 * 1024))
            if not block:
                break
            left -= len(block)
        self._body_left = 0

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/v1/health':
            return self._health()
        m = STATUS_PATH.fullmatch(path)
        if not m:
            return self._send(404, {'ok': False, 'reason': 'not-found'})
        return self._run(lambda: self.receiver.status(m.group(1), self._auth(), self.headers.get('X-NS-EPK')))

    def _drain_declared(self):
        """Before an early refusal: consume a declared body of at most one chunk (avoids TCP resets)."""
        try:
            self._body_left = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self._body_left = 0
        self._drain()

    def do_PUT(self):
        m = CHUNK_PATH.fullmatch(self.path.split('?')[0])
        if not m:
            self.close_connection = True
            self._drain_declared()
            return self._send(404, {'ok': False, 'reason': 'not-found'})
        if self.headers.get('Transfer-Encoding'):
            self.close_connection = True
            return self._send(411, {'ok': False, 'reason': 'length-required'})
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            self.close_connection = True
            return self._send(411, {'ok': False, 'reason': 'length-required'})
        if length < TAG or length > MAX_CHUNK + TAG:
            self.close_connection = True
            return self._send(413, {'ok': False, 'reason': 'bad-length'})
        tid, index = m.group(1), int(m.group(2))
        self._body_left = length
        return self._run(lambda: self.receiver.put_chunk(tid, index, self._auth(), self.headers.get('X-NS-EPK'), length, self._read_body))

    def do_POST(self):
        self.close_connection = True
        self._drain_declared()
        self._send(405, {'ok': False, 'reason': 'method'})

    do_DELETE = do_PATCH = do_POST


def background(receiver, stop):
    last_housekeeping = 0.0
    while not stop.is_set():
        try:
            receiver.heartbeat()
        except ReceiverError as e:
            log.warning('Heartbeat failed: %s', e)
        except Exception as e:  # keep running
            log.warning('Heartbeat error: %s', e)
        if time.monotonic() - last_housekeeping > 300:
            last_housekeeping = time.monotonic()
            try:
                receiver.housekeeping()
            except Exception as e:
                log.warning('Housekeeping error: %s', e)
        stop.wait(HEARTBEAT_S)


def main():
    if not HOSTNAME and not ALLOW_HTTP_CLOUD:
        log.error('NSIGNAGE_UPLOAD_HOSTNAME is not set (see /etc/n-signage-upload.env)')
        sys.exit(2)
    receiver = Receiver()
    Handler.receiver = receiver
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    httpd.daemon_threads = True
    stop = threading.Event()
    threading.Thread(target=background, args=(receiver, stop), daemon=True).start()
    log.info('N-Signage upload receiver %s for device %s on 127.0.0.1:%d (key fingerprint %s)',
             VERSION, receiver.device_id, httpd.server_address[1], receiver.fingerprint)
    print(json.dumps({'event': 'listening', 'port': httpd.server_address[1], 'fingerprint': receiver.fingerprint}), flush=True)
    try:
        httpd.serve_forever()
    finally:
        stop.set()


if __name__ == '__main__':
    main()
