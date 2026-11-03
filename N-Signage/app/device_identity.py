"""
N Signage — Device identity (shared by the Flask API and the discovery responder)

Everything here is read from the Pi itself. Nothing is taken from the network,
so the website can rely on these values to confirm which Pi it is talking to.
No passwords, Wi-Fi details or other credentials are ever included.
"""
import hashlib
import os
import pwd
import socket

DISCOVERY_PROTOCOL_VERSION = 1


def get_linux_username():
    """Actual Linux user this process runs as (the systemd `User=`)."""
    try:
        return pwd.getpwuid(os.geteuid()).pw_name
    except KeyError:
        return str(os.geteuid())


def get_hostname():
    return socket.gethostname()


def _read_hardware_seed():
    # Raspberry Pi CPU serial; fall back to systemd machine-id on other boards
    try:
        with open('/proc/cpuinfo') as f:
            for line in f:
                if line.lower().startswith('serial'):
                    serial = line.split(':', 1)[1].strip()
                    if serial.strip('0'):
                        return serial
    except OSError:
        pass
    for path in ('/etc/machine-id', '/var/lib/dbus/machine-id'):
        try:
            with open(path) as f:
                value = f.read().strip()
                if value:
                    return value
        except OSError:
            pass
    return get_hostname()


_DEVICE_ID = None


def get_device_id():
    """Stable 16-hex-char device identifier (hashed, so the raw serial is not exposed)."""
    global _DEVICE_ID
    if _DEVICE_ID is None:
        seed = _read_hardware_seed()
        _DEVICE_ID = hashlib.sha256(f'n-signage:{seed}'.encode()).hexdigest()[:16]
    return _DEVICE_ID


def get_local_ip_for(peer_ip, peer_port=9):
    """
    IPv4 address of the interface the Pi uses to reach `peer_ip`.
    No packet is sent; connect() on a UDP socket only picks the route.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((peer_ip, peer_port))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def get_identity():
    return {
        'pi_username': get_linux_username(),
        'hostname': get_hostname(),
        'device_id': get_device_id(),
        'discovery_protocol_version': DISCOVERY_PROTOCOL_VERSION,
    }
