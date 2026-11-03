"""
N Signage — Cloud agent

Lets the hosted website (e.g. https://software.nsinages.in) manage this Pi
from anywhere. The Pi connects OUT to the website's cloud relay every few
seconds, so no port forwarding or public IP is needed:

  POST <cloud>/api/pi/sync
    -> reports identity, local IP and the media list
    <- receives queued commands (download a file / delete a file)
    -> reports command results on the next sync

Standard library only. Configure with environment variables (or
/etc/n-signage.env when run from n-signage-cloud.service):

  NSIGNAGE_CLOUD_URL   default https://software.nsinages.in
  NSIGNAGE_CLOUD       set to 0 to disable the agent
"""
import http.client
import json
import logging
import os
import re
import secrets
import socket
import ssl
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import config
import device_identity

AGENT_VERSION = '1.0'
CLOUD_URL = os.environ.get('NSIGNAGE_CLOUD_URL', 'https://software.nsinages.in').rstrip('/')
SECRET_FILE = os.path.join(config.DATA_FOLDER, 'cloud_secret')
DEFAULT_POLL = 5
MAX_BACKOFF = 60
REQUEST_TIMEOUT = 20
DOWNLOAD_TIMEOUT = 60
MAX_DOWNLOAD_BYTES = config.MAX_CONTENT_LENGTH
# Downloads are only accepted from Vercel Blob storage
BLOB_HOST_RX = re.compile(r'^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$', re.I)
SAFE_NAME_RX = re.compile(r'[^A-Za-z0-9._ ()-]')

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


def do_download(cmd):
    url = str(cmd.get('url') or '')
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or not BLOB_HOST_RX.match(u.hostname or ''):
        raise ValueError('Refusing to download from an untrusted address')
    filename = safe_filename(cmd.get('filename'))
    if not filename or not allowed(filename):
        raise ValueError('Unsupported file type')

    os.makedirs(config.MEDIA_FOLDER, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.download-', dir=config.MEDIA_FOLDER)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': f'n-signage-cloud-agent/{AGENT_VERSION}'})
        total = 0
        with os.fdopen(fd, 'wb') as out, urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise ValueError('File too large')
                out.write(chunk)
        name, path = unique_target(filename)
        os.replace(tmp, path)
        os.chmod(path, 0o644)
        log.info(f'Downloaded {name} ({total} bytes) from the cloud')
        return name
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


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


class Agent:
    def __init__(self):
        self.secret = load_secret()
        self.device_id = device_identity.get_device_id()
        self.results = []
        self.running = set()   # command ids being executed
        self.finished = set()  # ids already reported (until the cloud drops them)
        self.lock = threading.Lock()
        self.sync_count = 0

    def run_command(self, cmd):
        cid = cmd.get('id')
        try:
            if cmd.get('type') == 'download':
                name = do_download(cmd)
            elif cmd.get('type') == 'delete':
                name = do_delete(cmd)
            else:
                raise ValueError(f"Unknown command {cmd.get('type')!r}")
            result = {'id': cid, 'ok': True, 'filename': name}
        except Exception as e:  # report every failure back to the website
            log.error(f"Command {cmd.get('type')} failed: {e}")
            result = {'id': cid, 'ok': False, 'error': str(e)[:300]}
        with self.lock:
            self.running.discard(cid)
            self.finished.add(cid)
            self.results.append(result)

    def handle_commands(self, commands):
        live = {c.get('id') for c in commands}
        with self.lock:
            self.finished &= live  # forget ids the cloud no longer lists
            for cmd in commands:
                cid = cmd.get('id')
                if not isinstance(cid, str) or cid in self.running or cid in self.finished:
                    continue
                self.running.add(cid)
                threading.Thread(target=self.run_command, args=(cmd,), daemon=True).start()

    def sync(self):
        with self.lock:
            results = list(self.results)
        payload = {
            'deviceId': self.device_id,
            'username': device_identity.get_linux_username(),
            'hostname': device_identity.get_hostname(),
            'localIp': device_identity.get_local_ip_for('8.8.8.8', 53),
            'port': config.PORT,
            'media': list_media(),
            'agentVersion': AGENT_VERSION,
            'results': results,
        }
        headers = {'Authorization': f'Bearer {self.secret}'}
        url = f'{CLOUD_URL}/api/pi/sync'

        # Mostly IPv4; every 4th sync also over IPv6 when the network has it
        self.sync_count += 1
        if self.sync_count % 4 == 0:
            try:
                post_json(url, {**payload, 'results': []}, headers, socket.AF_INET6)
            except OSError:
                pass

        status, data = post_json(url, payload, headers, socket.AF_INET)
        if status != 200:
            raise RuntimeError(f"Cloud sync failed (HTTP {status}): {data.get('error', 'unknown error')}")
        with self.lock:
            sent = {r['id'] for r in results}
            self.results = [r for r in self.results if r['id'] not in sent]
        self.handle_commands(data.get('commands') or [])
        return int(data.get('pollSeconds') or DEFAULT_POLL)

    def loop(self):
        log.info(f'N-Signage cloud agent {AGENT_VERSION}: device {self.device_id}, '
                 f'user "{device_identity.get_linux_username()}", cloud {CLOUD_URL}')
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
