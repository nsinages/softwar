"""
N Signage — Cloud agent

Lets the hosted website (e.g. https://software.nsinages.in) manage this Pi
from anywhere. The Pi connects OUT to the website's cloud relay every few
seconds, so no port forwarding or public IP is needed:

  POST <cloud>/api/pi/sync
    -> reports identity, local IP, the media list, free storage, download progress
    <- receives queued commands (download a file / delete a file)
    -> reports command results on the next sync

Registration: customers add this Pi on the website with Add Device → Pi Name
→ Find IP while on the same Wi-Fi (the website matches the Pi's username or
hostname against the Pis that check in from that network). No code is shown.

Pairing codes (agent 1.1, OFF since 2.2; PAIRING_ENABLED): the agent fetched a one-time pairing code (POST <cloud>/api/pi/pairing, same
device secret) and writes it to data/pairing.json. The local player
(/display, via GET /api/pairing on 127.0.0.1 only) shows it on screen, and the
customer types it into Add Device on the website. Once the website reports
the Pi as registered, the code is removed from the file and the screen.

Downloads (protocol 2, see docs/PI-AGENT-V2-CONTRACT.md):
  - only over HTTPS from Vercel Blob hosts (*.public / *.private
    .blob.vercel-storage.com), including every redirect; the URL path must
    belong to the transfer; private URLs are short-lived presigned links,
    the Pi never holds a storage credential
  - streamed to media/.transfer-<id>.part while hashing (SHA-256), resumed
    with HTTP Range after an interruption
  - size + SHA-256 verified, then moved atomically to a NEW name in media/
    (never overwrites); the player picks it up on its next /api/media poll
  - a repeated command for a transfer that is already saved re-uses that file
    (data/cloud_transfers.json), so retries never create duplicates

Device identity (device_identity.py) and data/cloud_secret are only read,
never regenerated.

Standard library only. Configure with environment variables (or
/etc/n-signage.env when run from n-signage-cloud.service):

  NSIGNAGE_CLOUD_URL   default https://software.nsinages.in
  NSIGNAGE_CLOUD       set to 0 to disable the agent
"""
import hashlib
import http.client
import json
import logging
import os
import re
import secrets
import shutil
import socket
import ssl
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import config
import device_identity

AGENT_VERSION = '2.2'
AGENT_PROTOCOL = 2
# Pairing codes are not part of the N-Signage customer workflow (Add Device uses
# Pi Name → Find IP). The code below is kept only so it can be re-enabled.
PAIRING_ENABLED = False
# Optional features this agent implements (see docs/PI-AGENT-V2-CONTRACT.md)
CAPABILITIES = ['sha256', 'range-resume', 'progress', 'storage', 'private-blob'] + (['pairing'] if PAIRING_ENABLED else [])
CLOUD_URL = os.environ.get('NSIGNAGE_CLOUD_URL', 'https://software.nsinages.in').rstrip('/')
SECRET_FILE = os.path.join(config.DATA_FOLDER, 'cloud_secret')
DEFAULT_POLL = 5
MAX_BACKOFF = 60
REQUEST_TIMEOUT = 20
DOWNLOAD_TIMEOUT = 60
CHUNK = 1024 * 1024
MAX_DOWNLOAD_BYTES = config.MAX_CONTENT_LENGTH
STORAGE_MARGIN = 100 * 1024 * 1024        # always leave this much free on the SD card
MAX_LOCAL_ATTEMPTS = 5                    # transient download failures retried before reporting
PART_MAX_AGE_S = 72 * 3600                # .part files older than this are removed
ORPHAN_PART_GRACE_S = 3600                # .part of a transfer the cloud no longer lists
DONE_KEEP = 500                           # remembered completed transfers (duplicate protection)

# Downloads are only accepted from Vercel Blob storage
PUBLIC_BLOB_HOST_RX = re.compile(r'^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$', re.I)
PRIVATE_BLOB_HOST_RX = re.compile(r'^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$', re.I)
BLOB_HOST_RX = PUBLIC_BLOB_HOST_RX        # kept for older tooling that imports it
SAFE_NAME_RX = re.compile(r'[^A-Za-z0-9._ ()-]')
TRANSFER_ID_RX = re.compile(r'^[A-Za-z0-9_-]{22}$')
SHA256_RX = re.compile(r'^[a-f0-9]{64}$')
PART_RX = re.compile(r'^\.transfer-([A-Za-z0-9_-]{22})\.part$')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('n-signage-cloud')


# ---------------------------------------------------------------------------
# Identity & secret
# ---------------------------------------------------------------------------
def load_secret():
    """Random per-device secret, created once and kept in data/cloud_secret."""
    os.makedirs(config.DATA_FOLDER, exist_ok=True)
    try:
        with open(SECRET_FILE) as f:
            value = f.read().strip()
            if len(value) >= 32:
                return value
    except OSError:
        pass
    value = secrets.token_urlsafe(32)
    fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(value)
    log.info('Created a new cloud device secret')
    return value


def media_type(name):
    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if ext in config.VIDEO_EXTENSIONS:
        return 'video'
    if ext in config.IMAGE_EXTENSIONS:
        return 'image'
    return 'unknown'


def allowed(name):
    return '.' in name and name.rsplit('.', 1)[-1].lower() in config.ALLOWED_EXTENSIONS


def list_media():
    out = []
    try:
        for name in sorted(os.listdir(config.MEDIA_FOLDER)):
            path = os.path.join(config.MEDIA_FOLDER, name)
            if not name.startswith('.') and allowed(name) and os.path.isfile(path):
                out.append({'name': name, 'size': os.path.getsize(path), 'type': media_type(name)})
    except OSError as e:
        log.error(f'Could not list media: {e}')
    return out


def resolve_media_file(filename):
    """Existing media file directly inside MEDIA_FOLDER, or None (no traversal)."""
    if not filename or '/' in filename or '\\' in filename or filename.startswith('.') or not allowed(filename):
        return None
    media_dir = os.path.realpath(config.MEDIA_FOLDER)
    target = os.path.realpath(os.path.join(media_dir, filename))
    if os.path.dirname(target) != media_dir or not os.path.isfile(target):
        return None
    return target


def safe_filename(name):
    name = os.path.basename(str(name or ''))
    name = SAFE_NAME_RX.sub('_', name).lstrip('._- ')[-180:]
    return name


def disk_usage(path):
    """Indirection so tests can simulate a full SD card."""
    return shutil.disk_usage(path)


def storage_report():
    try:
        u = disk_usage(config.MEDIA_FOLDER)
        return {'freeBytes': int(u.free), 'totalBytes': int(u.total)}
    except OSError:
        return None


# ---------------------------------------------------------------------------
# HTTP — alternate IPv4 / IPv6 so the cloud learns both public addresses of
# this network (the browser may reach the website over either one).
# ---------------------------------------------------------------------------
class FamilyHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, family, **kw):
        super().__init__(host, **kw)
        self._family = family

    def connect(self):
        last_err = None
        for af, st, proto, _, addr in socket.getaddrinfo(self.host, self.port, self._family, socket.SOCK_STREAM):
            sock = socket.socket(af, st, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(addr)
            except OSError as e:
                sock.close()
                last_err = e
                continue
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
            return
        raise last_err or OSError('No address to connect to')


def post_json(url, payload, headers, family=socket.AF_INET):
    u = urllib.parse.urlsplit(url)
    body = json.dumps(payload).encode()
    hdrs = {'Content-Type': 'application/json', 'User-Agent': f'n-signage-cloud-agent/{AGENT_VERSION}', **headers}
    if u.scheme == 'https':
        conn = FamilyHTTPSConnection(u.hostname, family, port=u.port or 443, timeout=REQUEST_TIMEOUT,
                                     context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=REQUEST_TIMEOUT)
    try:
        conn.request('POST', u.path or '/', body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read(1024 * 1024)
        try:
            parsed = json.loads(data.decode() or '{}')
        except ValueError:
            parsed = {}
        return resp.status, parsed
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Pairing code — shown on this display so its owner can add it on the website
# ---------------------------------------------------------------------------
PAIRING_REFRESH_BEFORE_S = 60   # fetch a new code this long before the current one expires
PAIRING_RETRY_S = 60            # after a network/server error
PAIRING_RATE_LIMITED_S = 300    # after HTTP 429


def pairing_file():
    return os.path.join(config.DATA_FOLDER, 'pairing.json')


def write_json_atomic(path, data, mode=0o600):
    """Atomically replace a small JSON file in data/."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.tmp-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def write_pairing_state(state):
    """Atomically replace data/pairing.json (read by the local player, app.py)."""
    write_json_atomic(pairing_file(), state)


# ---------------------------------------------------------------------------
# Download security: trusted hosts only, also for redirects
# ---------------------------------------------------------------------------
class TransferError(Exception):
    """A download failure with a contract `reason`. transient → keep the .part and try again later."""

    def __init__(self, reason, message, transient=False):
        super().__init__(message)
        self.reason = reason
        self.transient = transient


def trusted_blob_url(url):
    """HTTPS on a Vercel Blob host (private hosts only when private-blob is implemented), default port, no credentials."""
    try:
        u = urllib.parse.urlsplit(str(url or ''))
        port = u.port
    except ValueError:
        return False
    if u.scheme != 'https' or u.username or u.password or port not in (None, 443):
        return False
    host = u.hostname or ''
    if PUBLIC_BLOB_HOST_RX.match(host):
        return True
    return 'private-blob' in CAPABILITIES and bool(PRIVATE_BLOB_HOST_RX.match(host))


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another trusted Vercel Blob URL."""
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        if not trusted_blob_url(target):
            raise TransferError('untrusted-url', 'Refusing a redirect to an untrusted address')
        return super().redirect_request(req, fp, code, msg, headers, target)


# Tests may replace the network layer with an in-memory HTTPS handler (subclass
# of urllib.request.HTTPSHandler); production uses certificate-verified HTTPS.
EXTRA_HANDLERS = []


def make_opener():
    handlers = list(EXTRA_HANDLERS) or [urllib.request.HTTPSHandler(context=ssl.create_default_context())]
    return urllib.request.build_opener(SafeRedirectHandler(), *handlers)


# ---------------------------------------------------------------------------
# Completed transfers (duplicate protection across retries and restarts)
# ---------------------------------------------------------------------------
_done_lock = threading.Lock()


def done_file():
    return os.path.join(config.DATA_FOLDER, 'cloud_transfers.json')


def load_done():
    try:
        with open(done_file()) as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def remember_done(transfer_id, name, sha256, size):
    with _done_lock:
        done = load_done()
        done[transfer_id] = {'name': name, 'sha256': sha256, 'size': size, 'at': int(time.time())}
        if len(done) > DONE_KEEP:
            for key in sorted(done, key=lambda k: done[k].get('at', 0))[:len(done) - DONE_KEEP]:
                del done[key]
        write_json_atomic(done_file(), done)


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(CHUNK), b''):
            h.update(chunk)
    return h.hexdigest()


def already_saved(transfer_id, size, sha256):
    """Name of the media file this transfer already produced (verified again), or None."""
    rec = load_done().get(transfer_id)
    if not rec:
        return None
    path = resolve_media_file(rec.get('name'))
    if not path or os.path.getsize(path) != size or file_sha256(path) != sha256:
        return None
    return rec['name']


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def unique_target(filename):
    """Reserve a free name in MEDIA_FOLDER (never overwrites an existing file)."""
    base, ext = os.path.splitext(filename)
    for counter in range(10000):
        name = f'{base}_{counter}{ext}' if counter else f'{base}{ext}'
        path = os.path.join(config.MEDIA_FOLDER, name)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            os.close(fd)
            return name, path
        except FileExistsError:
            continue
    raise RuntimeError('Too many files with this name')


def part_path(transfer_id):
    return os.path.join(config.MEDIA_FOLDER, f'.transfer-{transfer_id}.part')


def remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def place_file(tmp, filename):
    """Atomically move a verified temp file to a new, never-existing media name."""
    name, path = unique_target(filename)
    try:
        os.replace(tmp, path)
    except OSError:
        remove_quietly(path)   # the empty reservation
        raise
    os.chmod(path, 0o644)
    return name


def _http_failure(err):
    code = getattr(err, 'code', None)
    if code in (404, 410):
        return TransferError('download-failed', f'The cloud copy is no longer available (HTTP {code})')
    # 403: presigned URL expired → a fresh one comes with the next sync; 429/5xx: try again
    return TransferError('download-failed', f'Download failed (HTTP {code})', transient=True)


def _fetch_into(opener, url, part, offset, expected_size, hasher, on_progress):
    """Stream the remaining bytes into `part`. Returns (new length, hasher)."""
    headers = {'User-Agent': f'n-signage-cloud-agent/{AGENT_VERSION}'}
    if offset:
        headers['Range'] = f'bytes={offset}-'
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=DOWNLOAD_TIMEOUT) as resp:
        if not trusted_blob_url(resp.geturl()):
            raise TransferError('untrusted-url', 'Refusing to download from an untrusted address')
        status = resp.getcode()
        mode = 'ab'
        if offset and status == 206:
            m = re.match(r'bytes (\d+)-', resp.headers.get('Content-Range', ''))
            if not m or int(m.group(1)) != offset:
                raise TransferError('download-failed', 'The server resumed at the wrong position', transient=True)
        elif offset:
            # Range ignored (200): start again from the beginning
            log.info('Server ignored the resume request; downloading from the start')
            offset = 0
            hasher = hashlib.sha256()
            mode = 'wb'
        total = offset
        with open(part, mode) as out:
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > expected_size:
                    raise TransferError('size-mismatch', 'The file is larger than expected')
                hasher.update(chunk)
                out.write(chunk)
                on_progress(total)
            out.flush()
            os.fsync(out.fileno())
    return total, hasher


def download_transfer(cmd, on_progress=lambda n: None):
    """
    Protocol-2 download of one transfer. Returns (saved_name, sha256, size).
    Raises TransferError with a contract reason.
    """
    transfer_id = str(cmd.get('transferId') or '')
    url = str(cmd.get('url') or '')
    filename = safe_filename(cmd.get('filename'))
    expected_sha = str(cmd.get('sha256') or '').lower()
    expected_size = cmd.get('size')

    if not TRANSFER_ID_RX.match(transfer_id):
        raise TransferError('untrusted-url', 'Download command without a valid transfer id')
    if not trusted_blob_url(url):
        raise TransferError('untrusted-url', 'Refusing to download from an untrusted address')
    path = urllib.parse.unquote(urllib.parse.urlsplit(url).path)
    if f'/{transfer_id}/' not in path or not path.startswith('/transfers/'):
        raise TransferError('untrusted-url', 'The download address does not belong to this transfer')
    if not filename or not allowed(filename):
        raise TransferError('unsupported-type', 'Unsupported file type')
    if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size <= 0:
        raise TransferError('size-mismatch', 'Download command without a valid size')
    if expected_size > MAX_DOWNLOAD_BYTES:
        raise TransferError('too-large', f'File too large (limit {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB)')
    if not SHA256_RX.match(expected_sha):
        raise TransferError('checksum-mismatch', 'Download command without a valid SHA-256')

    os.makedirs(config.MEDIA_FOLDER, exist_ok=True)

    # Duplicate command (e.g. a retry after a lost report): reuse the saved file
    existing = already_saved(transfer_id, expected_size, expected_sha)
    if existing:
        log.info(f'Transfer {transfer_id} is already saved as {existing}; not downloading again')
        return existing, expected_sha, expected_size

    part = part_path(transfer_id)
    hasher = hashlib.sha256()
    offset = 0
    if os.path.isfile(part):
        offset = os.path.getsize(part)
        if offset > expected_size:
            remove_quietly(part)
            offset = 0
        elif offset:
            with open(part, 'rb') as f:   # re-hash what is already there
                for chunk in iter(lambda: f.read(CHUNK), b''):
                    hasher.update(chunk)
            log.info(f'Resuming transfer {transfer_id} at {offset} of {expected_size} bytes')

    try:
        free = disk_usage(config.MEDIA_FOLDER).free
    except OSError:
        free = None
    if free is not None and expected_size - offset > free - STORAGE_MARGIN:
        remove_quietly(part)
        raise TransferError('insufficient-storage',
                            f'Not enough free space on the SD card ({max(0, free) // (1024 * 1024)} MB free)')

    total = offset
    if offset < expected_size:
        opener = make_opener()
        try:
            total, hasher = _fetch_into(opener, url, part, offset, expected_size, hasher, on_progress)
        except TransferError as e:
            if not e.transient:
                remove_quietly(part)
            raise
        except urllib.error.HTTPError as e:
            if e.code == 416:            # our partial file does not fit the object: start over next time
                remove_quietly(part)
                raise TransferError('download-failed', 'Could not resume the download; restarting', transient=True)
            failure = _http_failure(e)
            if not failure.transient:
                remove_quietly(part)
            raise failure
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            reason = getattr(e, 'reason', e)
            if isinstance(reason, TransferError):
                if not reason.transient:
                    remove_quietly(part)
                raise reason
            raise TransferError('download-failed', f'Network error: {reason}', transient=True)

    if total != expected_size:
        # connection closed early: keep what we have and resume later
        raise TransferError('download-failed', f'Download incomplete ({total} of {expected_size} bytes)', transient=True)
    digest = hasher.hexdigest()
    if digest != expected_sha:
        remove_quietly(part)
        raise TransferError('checksum-mismatch', 'The downloaded file does not match its checksum')

    name = place_file(part, filename)
    remember_done(transfer_id, name, digest, total)
    log.info(f'Downloaded {name} ({total} bytes, SHA-256 verified) from the cloud')
    return name, digest, total


def do_download_legacy(cmd):
    """Commands queued by the pre-transfer flow (no transferId, no checksum)."""
    url = str(cmd.get('url') or '')
    if not trusted_blob_url(url):
        raise TransferError('untrusted-url', 'Refusing to download from an untrusted address')
    filename = safe_filename(cmd.get('filename'))
    if not filename or not allowed(filename):
        raise TransferError('unsupported-type', 'Unsupported file type')
    os.makedirs(config.MEDIA_FOLDER, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.download-', dir=config.MEDIA_FOLDER)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': f'n-signage-cloud-agent/{AGENT_VERSION}'})
        h = hashlib.sha256()
        total = 0
        with os.fdopen(fd, 'wb') as out, make_opener().open(req, timeout=DOWNLOAD_TIMEOUT) as resp:
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise TransferError('too-large', 'File too large')
                h.update(chunk)
                out.write(chunk)
        name = place_file(tmp, filename)
        log.info(f'Downloaded {name} ({total} bytes) from the cloud')
        return name, h.hexdigest(), total
    finally:
        remove_quietly(tmp)


def do_delete(cmd):
    filename = str(cmd.get('filename') or '')
    target = resolve_media_file(filename)
    if not target:
        # Already gone counts as success
        log.info(f'Delete requested for missing file {filename!r}')
        return filename
    os.remove(target)
    log.info(f'Deleted {filename} (cloud request)')
    return filename


def cleanup_parts(live_transfers, running_transfers, now=None, orphans=True):
    """
    Remove stale temp files: any older than 72 h, and (orphans=True, only with a
    command list from the cloud) those of transfers the cloud no longer lists.
    """
    now = time.time() if now is None else now
    try:
        names = os.listdir(config.MEDIA_FOLDER)
    except OSError:
        return 0
    removed = 0
    for name in names:
        m = PART_RX.match(name)
        if not m and not name.startswith('.download-'):
            continue
        path = os.path.join(config.MEDIA_FOLDER, name)
        try:
            age = now - os.path.getmtime(path)
        except OSError:
            continue
        tid = m.group(1) if m else None
        if tid in running_transfers:
            continue
        orphan = orphans and tid is not None and tid not in live_transfers and age > ORPHAN_PART_GRACE_S
        if age > PART_MAX_AGE_S or orphan:
            remove_quietly(path)
            removed += 1
    if removed:
        log.info(f'Removed {removed} stale partial download file(s)')
    return removed


class Agent:
    def __init__(self):
        self.secret = load_secret()
        self.device_id = device_identity.get_device_id()
        self.results = []
        self.running = set()             # command ids being executed
        self.running_transfers = set()   # transfer ids being downloaded
        self.finished = set()            # ids already reported (until the cloud drops them)
        self.attempts = {}               # command id -> transient failures so far
        self.retry_at = {}               # command id -> time.monotonic() of the next try
        self.progress = {}               # transfer id -> bytes received
        self.lock = threading.Lock()
        self.sync_count = 0
        self.last_cleanup = 0.0
        self.pairing_registered = None   # last 'registered' value reported by the cloud
        self.pairing_code_expires = 0.0  # time.monotonic() when the current code expires
        self.pairing_retry_at = 0.0

    def set_registered(self):
        if self.pairing_registered is not True:
            write_pairing_state({'state': 'registered'})
            log.info('This display is registered to a customer account')
        self.pairing_registered = True
        self.pairing_code_expires = 0.0

    def update_pairing(self, registered):
        """Keep a valid pairing code on screen while the Pi has no owner. Never raises."""
        if registered is None:
            return  # website without pairing support: change nothing
        if registered:
            self.set_registered()
            return
        if self.pairing_registered is not False:
            log.info('This display is not registered to an account yet; a pairing code will be shown')
        self.pairing_registered = False
        now = time.monotonic()
        if now < self.pairing_code_expires - PAIRING_REFRESH_BEFORE_S or now < self.pairing_retry_at:
            return
        try:
            status, data = post_json(f'{CLOUD_URL}/api/pi/pairing', {'deviceId': self.device_id},
                                     {'Authorization': f'Bearer {self.secret}'})
        except OSError as e:
            status, data = 0, {'error': str(e)}
        if status == 200 and isinstance(data.get('code'), str):
            ttl = int(data.get('ttlSeconds') or 600)
            self.pairing_code_expires = now + ttl
            write_pairing_state({'state': 'code', 'code': data['code'],
                                 'expiresAt': int((time.time() + ttl) * 1000)})
            log.info('New pairing code shown on the display')  # never log the code itself
        elif status == 409:
            self.set_registered()  # claimed between the sync and this request
        else:
            self.pairing_retry_at = now + (PAIRING_RATE_LIMITED_S if status == 429 else PAIRING_RETRY_S)
            log.warning(f"Could not get a pairing code (HTTP {status or 'no connection'}); retrying later")

    def _report(self, cid, result):
        with self.lock:
            self.running.discard(cid)
            self.finished.add(cid)
            self.attempts.pop(cid, None)
            self.retry_at.pop(cid, None)
            self.results.append(result)

    def run_command(self, cmd):
        cid = cmd.get('id')
        tid = cmd.get('transferId')
        try:
            if cmd.get('type') == 'download':
                if tid:
                    def progress(n, _tid=tid):
                        self.progress[_tid] = n
                    name, digest, size = download_transfer(cmd, progress)
                else:
                    name, digest, size = do_download_legacy(cmd)
                result = {'id': cid, 'ok': True, 'filename': name, 'sha256': digest, 'size': size}
            elif cmd.get('type') == 'delete':
                result = {'id': cid, 'ok': True, 'filename': do_delete(cmd)}
            else:
                raise TransferError('unsupported-command', f"Unknown command {cmd.get('type')!r}")
        except TransferError as e:
            with self.lock:
                tries = self.attempts.get(cid, 0) + 1
                self.attempts[cid] = tries
            if e.transient and tries < MAX_LOCAL_ATTEMPTS:
                # keep the .part; the next sync brings a fresh (presigned) URL and we resume
                log.warning(f'Download attempt {tries} failed ({e}); will resume')
                with self.lock:
                    self.running.discard(cid)
                    self.retry_at[cid] = time.monotonic() + min(60, 5 * tries)
                    if tid:
                        self.running_transfers.discard(tid)
                return
            log.error(f"Command {cmd.get('type')} failed: {e}")
            result = {'id': cid, 'ok': False, 'error': str(e)[:300], 'reason': e.reason}
        except Exception as e:  # report every failure back to the website
            log.error(f"Command {cmd.get('type')} failed: {e}")
            result = {'id': cid, 'ok': False, 'error': str(e)[:300]}
        finally:
            if tid:
                with self.lock:
                    self.running_transfers.discard(tid)
                self.progress.pop(tid, None)
        self._report(cid, result)

    def handle_commands(self, commands):
        live = {c.get('id') for c in commands}
        now = time.monotonic()
        with self.lock:
            self.finished &= live  # forget ids the cloud no longer lists
            for gone in [k for k in self.attempts if k not in live]:
                self.attempts.pop(gone, None)
                self.retry_at.pop(gone, None)
            for cmd in commands:
                cid = cmd.get('id')
                tid = cmd.get('transferId')
                if not isinstance(cid, str) or cid in self.running or cid in self.finished:
                    continue
                if now < self.retry_at.get(cid, 0):
                    continue
                if tid and tid in self.running_transfers:
                    continue  # an older attempt of the same transfer is still running
                self.running.add(cid)
                if tid:
                    self.running_transfers.add(tid)
                threading.Thread(target=self.run_command, args=(cmd,), daemon=True).start()
            running_transfers = set(self.running_transfers)
        live_transfers = {c.get('transferId') for c in commands if c.get('transferId')}
        if time.monotonic() - self.last_cleanup > 60:
            self.last_cleanup = time.monotonic()
            cleanup_parts(live_transfers, running_transfers)

    def sync(self):
        with self.lock:
            results = list(self.results)
        progress = [{'transferId': t, 'receivedBytes': int(n)} for t, n in list(self.progress.items())][:20]
        payload = {
            'deviceId': self.device_id,
            'username': device_identity.get_linux_username(),
            'hostname': device_identity.get_hostname(),
            'localIp': device_identity.get_local_ip_for('8.8.8.8', 53),
            'port': config.PORT,
            'media': list_media(),
            'agentVersion': AGENT_VERSION,
            'protocol': AGENT_PROTOCOL,
            'capabilities': CAPABILITIES,
            'results': results,
            'progress': progress,
        }
        storage = storage_report()
        if storage:
            payload['storage'] = storage
        headers = {'Authorization': f'Bearer {self.secret}'}
        url = f'{CLOUD_URL}/api/pi/sync'

        # Mostly IPv4; every 4th sync also over IPv6 when the network has it
        self.sync_count += 1
        if self.sync_count % 4 == 0:
            try:
                post_json(url, {**payload, 'results': [], 'progress': []}, headers, socket.AF_INET6)
            except OSError:
                pass

        status, data = post_json(url, payload, headers, socket.AF_INET)
        if status != 200:
            raise RuntimeError(f"Cloud sync failed (HTTP {status}): {data.get('error', 'unknown error')}")
        with self.lock:
            sent = {r['id'] for r in results}
            self.results = [r for r in self.results if r['id'] not in sent]
        self.handle_commands(data.get('commands') or [])
        if PAIRING_ENABLED:
            try:
                self.update_pairing(data.get('registered'))
            except Exception as e:  # pairing must never stop media sync
                log.warning(f'Pairing update failed: {e}')
        return int(data.get('pollSeconds') or DEFAULT_POLL)

    def loop(self):
        log.info(f'N-Signage cloud agent {AGENT_VERSION} (protocol {AGENT_PROTOCOL}): device {self.device_id}, '
                 f'user "{device_identity.get_linux_username()}", cloud {CLOUD_URL}')
        cleanup_parts(set(), set(), orphans=False)  # only the 72 h rule before the first sync
        backoff = DEFAULT_POLL
        connected = False
        while True:
            try:
                wait = self.sync()
                if not connected:
                    log.info('Connected to the cloud')
                    connected = True
                backoff = DEFAULT_POLL
            except Exception as e:
                if connected or backoff == DEFAULT_POLL:
                    log.warning(f'{e}; retrying')
                connected = False
                wait = backoff
                backoff = min(backoff * 2, MAX_BACKOFF)
            time.sleep(max(1, min(wait, MAX_BACKOFF)))


if __name__ == '__main__':
    if os.environ.get('NSIGNAGE_CLOUD', '1').strip() == '0':
        log.info('Cloud agent disabled (NSIGNAGE_CLOUD=0)')
        sys.exit(0)
    Agent().loop()
