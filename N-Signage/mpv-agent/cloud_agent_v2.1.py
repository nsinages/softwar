#!/usr/bin/env python3
"""N-Signage cloud agent v2, adapted for the existing MPV-based Pi installation."""
import hashlib, http.client, json, logging, os, pwd, re, secrets, shutil, socket, ssl, threading, time, urllib.parse, urllib.request
from pathlib import Path

BASE = Path('/home/ns/n-signage')
DATA = BASE / 'data'
MEDIA = BASE / 'media'
IDENTITY = DATA / 'device_identity.json'
SECRET = DATA / 'cloud_secret'
CLOUD_URL = os.environ.get('NSIGNAGE_CLOUD_URL', 'https://software.nsinages.in').rstrip('/')
AGENT_VERSION = '2.0-ns1'
CAPABILITIES = ['sha256', 'range-resume', 'progress', 'storage']
MAX_BYTES = 500 * 1024 * 1024
STORAGE_MARGIN = 200 * 1024 * 1024
POLL = 5
MAX_BACKOFF = 60
EXTENSIONS = {'mp4','webm','mov','avi','mkv','m4v','jpg','jpeg','png','gif','bmp','webp'}
VIDEO = {'mp4','webm','mov','avi','mkv','m4v'}
SAFE_NAME = re.compile(r'[^A-Za-z0-9._ ()-]')
PUBLIC_HOST = re.compile(r'^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$', re.I)
TRANSFER_ID_RX = re.compile(r'^[A-Za-z0-9_-]{22}$')
COMMAND_ID_RX = re.compile(r'^[0-9a-f-]{36}$', re.I)
PRIVATE_HOST = re.compile(r'^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$', re.I)
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('n-signage-cloud')


def device_id():
    with IDENTITY.open() as f: value = json.load(f).get('device_id', '')
    if not re.fullmatch(r'[0-9a-f]{16}', value): raise RuntimeError('Existing device_identity.json has an invalid device_id')
    return value


def secret():
    DATA.mkdir(parents=True, exist_ok=True)
    try:
        value = SECRET.read_text().strip()
        if len(value) >= 32: return value
    except OSError: pass
    value = secrets.token_urlsafe(48)
    fd = os.open(SECRET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(value)
    return value


def linux_username():
    try: return pwd.getpwuid(os.geteuid()).pw_name
    except KeyError: return str(os.geteuid())


def local_ip():
    s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(('8.8.8.8',53)); return s.getsockname()[0]
    except OSError: return None
    finally: s.close()


def allowed(name): return '.' in name and name.rsplit('.',1)[-1].lower() in EXTENSIONS

def media_list():
    out=[]
    for p in sorted(MEDIA.iterdir()):
        if p.is_file() and not p.name.startswith('.') and allowed(p.name):
            ext=p.suffix[1:].lower(); out.append({'name':p.name,'size':p.stat().st_size,'type':'video' if ext in VIDEO else 'image'})
    return out


def post_json(url, payload, bearer):
    u=urllib.parse.urlsplit(url)
    if u.scheme != 'https' or not u.hostname: raise ValueError('Cloud URL must use HTTPS')
    body=json.dumps(payload,separators=(',',':')).encode()
    conn=http.client.HTTPSConnection(u.hostname,u.port or 443,timeout=20,context=ssl.create_default_context())
    try:
        conn.request('POST',u.path or '/',body,{'Content-Type':'application/json','Authorization':'Bearer '+bearer,'User-Agent':'n-signage-cloud-agent/'+AGENT_VERSION})
        r=conn.getresponse(); raw=r.read(1024*1024)
        try: data=json.loads(raw.decode() or '{}')
        except ValueError: data={}
        return r.status,data
    finally: conn.close()


class SafeBlobRedirect(urllib.request.HTTPRedirectHandler):
    """Do not let a trusted Blob URL redirect downloads to an untrusted host."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlsplit(newurl)
        if (u.scheme != 'https' or not PUBLIC_HOST.fullmatch(u.hostname or '')
                or u.username or u.password or u.fragment or u.port not in (None, 443)):
            raise TransferError('Refusing redirect to an untrusted address', 'untrusted-url')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_blob(req):
    opener = urllib.request.build_opener(SafeBlobRedirect())
    return opener.open(req, timeout=60)


def safe_filename(value):
    name=os.path.basename(str(value or ''))
    name=SAFE_NAME.sub('_',name).lstrip('._- ')[:180]
    return name if allowed(name) else ''


def reserve_name(filename):
    base,ext=os.path.splitext(filename)
    for i in range(10000):
        name=f'{base}_{i}{ext}' if i else filename
        target=MEDIA/name
        try:
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644); os.close(fd); return name,target
        except FileExistsError: continue
    raise RuntimeError('Too many files with this name')


def do_download(cmd, progress_callback):
    url=str(cmd.get('url') or '')
    u=urllib.parse.urlsplit(url)
    if (u.scheme!='https' or not PUBLIC_HOST.fullmatch(u.hostname or '') or u.username or u.password
            or u.fragment or u.port not in (None, 443)):
        raise TransferError('Refusing untrusted download URL','untrusted-url')
    filename=safe_filename(cmd.get('filename'))
    if not filename: raise TransferError('Unsupported file type','unsupported-type')
    expected_size=cmd.get('size'); expected_hash=str(cmd.get('sha256') or '').lower()
    if not isinstance(expected_size,int) or expected_size<0 or expected_size>MAX_BYTES or not re.fullmatch(r'[0-9a-f]{64}',expected_hash):
        raise TransferError('Invalid transfer size or checksum','download-failed')
    MEDIA.mkdir(parents=True,exist_ok=True)
    free=shutil.disk_usage(MEDIA).free
    transfer_id=str(cmd.get('transferId') or '')
    command_id=str(cmd.get('id') or '')
    if transfer_id and not TRANSFER_ID_RX.fullmatch(transfer_id):
        raise TransferError('Invalid transfer identifier','download-failed')
    if not transfer_id and not COMMAND_ID_RX.fullmatch(command_id):
        raise TransferError('Invalid command identifier','download-failed')
    part=MEDIA/('.transfer-'+(transfer_id or command_id)+'.part')
    if expected_size > max(0,free-STORAGE_MARGIN) + (part.stat().st_size if part.exists() else 0):
        raise TransferError('Not enough free space on the SD card','insufficient-storage')
    offset=part.stat().st_size if part.exists() else 0
    if offset>expected_size: part.unlink(); offset=0
    digest=hashlib.sha256()
    if offset:
        with part.open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''): digest.update(chunk)
    if offset == expected_size:
        actual_hash=digest.hexdigest()
        if actual_hash != expected_hash:
            part.unlink(missing_ok=True)
            raise TransferError('SHA-256 checksum does not match','checksum-mismatch')
        name,target=reserve_name(filename)
        try:
            os.replace(part,target); os.chmod(target,0o644)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return {'filename':name,'sha256':actual_hash,'size':expected_size}
    headers={'User-Agent':'n-signage-cloud-agent/'+AGENT_VERSION}
    if offset: headers['Range']=f'bytes={offset}-'
    req=urllib.request.Request(url,headers=headers)
    try:
        with open_blob(req) as resp:
            if offset and resp.status==206:
                content_range = resp.headers.get('Content-Range', '')
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', content_range)
                if not match or int(match.group(1)) != offset or int(match.group(2)) >= expected_size or int(match.group(3)) != expected_size:
                    part.unlink(missing_ok=True)
                    raise TransferError('Server returned an invalid resume range','download-failed')
                mode='ab'
            else:
                offset=0; digest=hashlib.sha256(); mode='wb'
            received=offset
            with part.open(mode) as out:
                while True:
                    chunk=resp.read(1024*1024)
                    if not chunk: break
                    received+=len(chunk)
                    if received>expected_size or received>MAX_BYTES: raise TransferError('Downloaded file exceeds expected size','size-mismatch')
                    out.write(chunk); digest.update(chunk); progress_callback(received)
                out.flush(); os.fsync(out.fileno())
    except TransferError: raise
    except Exception as e: raise TransferError(str(e)[:250],'download-failed')
    actual_hash=digest.hexdigest()
    if received!=expected_size:
        try: part.unlink()
        except OSError: pass
        raise TransferError(f'Expected {expected_size} bytes but received {received}','size-mismatch')
    if actual_hash!=expected_hash:
        try: part.unlink()
        except OSError: pass
        raise TransferError('SHA-256 checksum does not match','checksum-mismatch')
    name,target=reserve_name(filename)
    try:
        os.replace(part,target); os.chmod(target,0o644)
    except Exception:
        try: target.unlink()
        except OSError: pass
        raise
    return {'filename':name,'sha256':actual_hash,'size':received}


class TransferError(Exception):
    def __init__(self,message,reason): super().__init__(message); self.reason=reason


class Agent:
    def __init__(self):
        self.id=device_id(); self.secret=secret(); self.results=[]; self.running=set(); self.finished=set(); self.progress={}; self.lock=threading.Lock(); self.sync_count=0
        self.cleanup_parts(); self.last_cleanup=time.monotonic()

    def cleanup_parts(self):
        now=time.time()
        for p in MEDIA.glob('.transfer-*.part'):
            try:
                if now-p.stat().st_mtime>72*3600: p.unlink()
            except OSError: pass

    def run_command(self,cmd):
        cid=cmd.get('id')
        try:
            if cmd.get('type')=='download':
                tid=str(cmd.get('transferId') or cid)
                def report(n):
                    with self.lock: self.progress[tid]=n
                result=do_download(cmd,report)
                item={'id':cid,'ok':True,**result}
            elif cmd.get('type')=='delete':
                name=str(cmd.get('filename') or '')
                if '/' in name or '\\' in name or name.startswith('.') or not allowed(name): raise TransferError('Invalid filename','unsupported-type')
                target=MEDIA/name
                if target.is_file(): target.unlink()
                item={'id':cid,'ok':True,'filename':name}
            else: raise TransferError('Unknown command type','download-failed')
        except Exception as e:
            item={'id':cid,'ok':False,'error':str(e)[:300]}
            if isinstance(e,TransferError): item['reason']=e.reason
            log.error('Command failed (%s): %s',cid,e)
        with self.lock:
            self.running.discard(cid); self.finished.add(cid); self.results.append(item)
            self.progress.pop(str(cmd.get('transferId') or cid),None)

    def sync(self):
        with self.lock: results=list(self.results); progress=[{'transferId':k,'receivedBytes':v} for k,v in self.progress.items()]
        usage=shutil.disk_usage(MEDIA)
        payload={'deviceId':self.id,'username':linux_username(),'hostname':socket.gethostname(),'localIp':local_ip(),'port':5000,'media':media_list(),'agentVersion':AGENT_VERSION,'results':results,'protocol':2,'capabilities':CAPABILITIES,'storage':{'freeBytes':usage.free,'totalBytes':usage.total},'progress':progress}
        status,data=post_json(CLOUD_URL+'/api/pi/sync',payload,self.secret)
        if status!=200: raise RuntimeError(f'Cloud sync failed (HTTP {status}): {data.get("error","unknown error")}')
        with self.lock:
            sent={r['id'] for r in results}; self.results=[r for r in self.results if r['id'] not in sent]
        commands=data.get('commands') or []; live={c.get('id') for c in commands}
        with self.lock: self.finished &= live
        for cmd in commands:
            cid=cmd.get('id')
            with self.lock:
                if not isinstance(cid,str) or cid in self.running or cid in self.finished: continue
                self.running.add(cid)
            threading.Thread(target=self.run_command,args=(cmd,),daemon=True).start()
        return int(data.get('pollSeconds') or POLL)

    def loop(self):
        log.info('N-Signage cloud agent %s started for existing device identity',AGENT_VERSION)
        backoff=POLL
        while True:
            try: wait=self.sync(); backoff=POLL
            except Exception as e:
                log.warning('%s; retrying',e); wait=backoff; backoff=min(backoff*2,MAX_BACKOFF)
            if time.monotonic()-self.last_cleanup >= 3600:
                self.cleanup_parts(); self.last_cleanup=time.monotonic()
            time.sleep(max(1,min(wait,MAX_BACKOFF)))

if __name__=='__main__':
    if os.environ.get('NSIGNAGE_CLOUD','1').strip()=='0': raise SystemExit(0)
    Agent().loop()
