"""
Checks the Pi player's GET /api/pairing route (N-Signage/app/app.py) with
Flask's test client. Env: DATA_DIR (holds pairing.json written by the agent).
Prints one JSON object with the observed responses.
"""
import json
import os
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..', 'N-Signage', 'app')))
if 'pwd' not in sys.modules:
    try:
        import pwd  # noqa: F401
    except ImportError:
        fake = types.ModuleType('pwd')
        fake.getpwuid = lambda uid: types.SimpleNamespace(pw_name='nsignage')
        sys.modules['pwd'] = fake
        os.geteuid = getattr(os, 'geteuid', lambda: 1000)

import config  # noqa: E402
config.DATA_FOLDER = os.environ['DATA_DIR']
import app as player  # noqa: E402

client = player.app.test_client()


def get(addr):
    r = client.get('/api/pairing', environ_base={'REMOTE_ADDR': addr})
    return {'status': r.status_code, 'body': r.get_json(), 'cors': r.headers.get('Access-Control-Allow-Origin'),
            'cache': r.headers.get('Cache-Control')}


out = {'agentFile': get('127.0.0.1'), 'lan': get('192.168.1.50'), 'ipv6Loopback': get('::1')}
path = os.path.join(config.DATA_FOLDER, 'pairing.json')
original = open(path).read() if os.path.exists(path) else None
try:
    with open(path, 'w') as f:
        json.dump({'state': 'code', 'code': 'ABCD-EFGH', 'expiresAt': int(time.time() * 1000) - 1000}, f)
    out['expired'] = get('127.0.0.1')
    with open(path, 'w') as f:
        json.dump({'state': 'code', 'code': 'ABCD-EFGH', 'expiresAt': int(time.time() * 1000) + 60000}, f)
    out['valid'] = get('127.0.0.1')
    os.remove(path)
    out['missing'] = get('127.0.0.1')
finally:
    if original is not None:
        with open(path, 'w') as f:
            f.write(original)
status = client.get('/api/status', environ_base={'REMOTE_ADDR': '192.168.1.50'})
out['statusCors'] = status.headers.get('Access-Control-Allow-Origin')
print(json.dumps(out))
