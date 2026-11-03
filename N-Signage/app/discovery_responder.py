"""
N Signage — LAN Discovery Responder (UDP)

Runs as its own systemd service (n-signage-discovery.service) next to the
V2 Flask API, so the player and the existing API are never affected.

Protocol v1 (JSON over UDP, port DISCOVERY_PORT):

  request  (broadcast by the website's LAN helper)
    {"type": "nsignage-discover", "v": 1, "nonce": "<16-64 hex chars>"}

  response (unicast back to the sender)
    {"type": "nsignage-announce", "v": 1, "nonce": "<echoed>",
     "pi_username": "...", "hostname": "...", "device_id": "...",
     "ip": "<this Pi's IPv4 on that network>", "api_port": 5000,
     "discovery_protocol_version": 1}

The Pi always reports its own identity; it never echoes anything the
requester claims. The website decides whether the username matches.
Only requests from the Pi's own local networks are answered, and replies
are rate limited so the responder cannot be used for traffic amplification.
"""
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
import device_identity  # noqa: E402

DISCOVERY_PORT = int(os.environ.get('NSIGNAGE_DISCOVERY_PORT', '50500'))
MAX_REQUEST_BYTES = 512
NONCE_RX = re.compile(r'^[0-9a-f]{16,64}$')
REPLIES_PER_SOURCE_PER_SEC = 5
REPLIES_GLOBAL_PER_SEC = 50
LOCAL_NETS_TTL = 30

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('n-signage-discovery')

_local_nets = []
_local_nets_at = 0.0


def local_networks():
    """Subnets of this Pi's IPv4 interfaces (cached), via `ip -4 -o addr`."""
    global _local_nets, _local_nets_at
    now = time.monotonic()
    if now - _local_nets_at < LOCAL_NETS_TTL:
        return _local_nets
    nets = []
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show'],
                             capture_output=True, text=True, timeout=2).stdout
        for m in re.finditer(r'\binet (\d+\.\d+\.\d+\.\d+/\d+)', out):
            iface = ipaddress.ip_interface(m.group(1))
            if not iface.is_loopback:
                nets.append(iface.network)
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        logger.warning(f'Could not read local interfaces: {e}')
    _local_nets, _local_nets_at = nets, now
    return nets


def is_local_source(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.is_loopback or addr.is_multicast or addr.is_unspecified:
        return False
    if addr.is_private or addr.is_link_local:
        return True
    # Some LANs (e.g. campus networks) use public ranges: accept same-subnet only
    return any(addr in net for net in local_networks())


class RateLimiter:
    def __init__(self):
        self.window = 0
        self.per_source = {}
        self.total = 0

    def allow(self, ip):
        sec = int(time.monotonic())
        if sec != self.window:
            self.window, self.per_source, self.total = sec, {}, 0
        count = self.per_source.get(ip, 0)
        if count >= REPLIES_PER_SOURCE_PER_SEC or self.total >= REPLIES_GLOBAL_PER_SEC:
            return False
        self.per_source[ip] = count + 1
        self.total += 1
        return True


def parse_request(data):
    if len(data) > MAX_REQUEST_BYTES:
        return None
    try:
        msg = json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(msg, dict) or msg.get('type') != 'nsignage-discover' or msg.get('v') != 1:
        return None
    nonce = msg.get('nonce')
    if not isinstance(nonce, str) or not NONCE_RX.match(nonce):
        return None
    return nonce


def build_response(nonce, peer_ip, peer_port):
    ip = device_identity.get_local_ip_for(peer_ip, peer_port)
    if not ip:
        return None
    body = {
        'type': 'nsignage-announce',
        'v': 1,
        'nonce': nonce,
        **device_identity.get_identity(),
        'ip': ip,
        'api_port': config.PORT,
    }
    return json.dumps(body, separators=(',', ':')).encode('utf-8')


def serve():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(('0.0.0.0', DISCOVERY_PORT))
    identity = device_identity.get_identity()
    logger.info(
        f'Discovery responder listening on UDP {DISCOVERY_PORT} '
        f'(user={identity["pi_username"]}, host={identity["hostname"]}, id={identity["device_id"]})'
    )

    limiter = RateLimiter()
    while True:
        try:
            data, (peer_ip, peer_port) = sock.recvfrom(MAX_REQUEST_BYTES + 1)
        except OSError as e:
            logger.error(f'recvfrom failed: {e}')
            time.sleep(1)
            continue

        nonce = parse_request(data)
        if nonce is None:
            continue
        if not is_local_source(peer_ip):
            logger.warning(f'Ignored discovery request from non-local address {peer_ip}')
            continue
        if not limiter.allow(peer_ip):
            continue

        reply = build_response(nonce, peer_ip, peer_port)
        if reply is None:
            continue
        try:
            sock.sendto(reply, (peer_ip, peer_port))
            logger.info(f'Answered discovery request from {peer_ip}:{peer_port}')
        except OSError as e:
            logger.warning(f'Reply to {peer_ip}:{peer_port} failed: {e}')


if __name__ == '__main__':
    serve()
