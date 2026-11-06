"""
Runs the UNMODIFIED Pi agent (N-Signage/app/cloud_agent.py, version 1.0)
against a local copy of the cloud API, to prove the new website stays
compatible with Pis that have not been updated.

Only two things are stubbed, because this runs on a developer PC, not a Pi:
  - the Linux-only `pwd` module (username lookup)
  - urllib.request.urlopen for the Vercel Blob URL (served from a local file
    listed in BLOB_MAP), since the agent only downloads over HTTPS from
    *.public.blob.vercel-storage.com
Env: CLOUD_URL, WORKDIR, BLOB_MAP (json file {url: local_path}), DURATION
"""
import io
import json
import os
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, '..', '..', 'N-Signage', 'app'))
sys.path.insert(0, APP)
# AGENT_DIR: run a specific cloud_agent.py (e.g. the frozen 1.0 copy in tests/fixtures/agent-1.0);
# config.py and device_identity.py always come from the current Pi app.
if os.environ.get('AGENT_DIR'):
    sys.path.insert(0, os.path.abspath(os.environ['AGENT_DIR']))

if 'pwd' not in sys.modules:
    try:
        import pwd  # noqa: F401  (real Linux)
    except ImportError:
        fake = types.ModuleType('pwd')
        fake.getpwuid = lambda uid: types.SimpleNamespace(pw_name='nsignage')
        sys.modules['pwd'] = fake
        os.geteuid = getattr(os, 'geteuid', lambda: 1000)

os.environ['NSIGNAGE_CLOUD_URL'] = os.environ['CLOUD_URL']
import config  # noqa: E402

work = os.environ['WORKDIR']
config.MEDIA_FOLDER = os.path.join(work, 'media')
config.DATA_FOLDER = os.path.join(work, 'data')
os.makedirs(config.MEDIA_FOLDER, exist_ok=True)

import cloud_agent  # noqa: E402
import device_identity  # noqa: E402

# DEVICE_ID: simulate a specific Pi (several simulated Pis can run on one PC)
if os.environ.get('DEVICE_ID'):
    device_identity._DEVICE_ID = os.environ['DEVICE_ID']

cloud_agent.SECRET_FILE = os.path.join(config.DATA_FOLDER, 'cloud_secret')
real_urlopen = cloud_agent.urllib.request.urlopen


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def fake_urlopen(req, timeout=None):
    url = req.full_url if hasattr(req, 'full_url') else req
    with open(os.environ['BLOB_MAP']) as f:
        mapping = json.load(f)
    if url not in mapping:
        raise OSError(f'HTTP Error 404: {url}')
    with open(mapping[url], 'rb') as f:
        return _Resp(f.read())


cloud_agent.urllib.request.urlopen = fake_urlopen

agent = cloud_agent.Agent()
print(json.dumps({'event': 'start', 'deviceId': agent.device_id, 'agentVersion': cloud_agent.AGENT_VERSION}), flush=True)
deadline = time.time() + float(os.environ.get('DURATION', '30'))
while time.time() < deadline:
    try:
        agent.sync()
    except Exception as e:  # report and keep going, like the real loop
        print(json.dumps({'event': 'error', 'error': str(e)}), flush=True)
    time.sleep(0.5)
print(json.dumps({'event': 'done', 'media': sorted(os.listdir(config.MEDIA_FOLDER))}), flush=True)
