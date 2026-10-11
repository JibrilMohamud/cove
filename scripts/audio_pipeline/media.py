"""Bounded resumable acquisition of original Gutenberg files."""
import concurrent.futures,hashlib,json,pathlib,time,urllib.request,re
from urllib.parse import urlparse

def request(url,headers=None,method='GET',timeout=90):
    return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Cove-audio-pipeline/2.0',**(headers or {})},method=method),timeout=timeout)
def mirror_url(url):
    u=urlparse(url)
    if u.scheme!='https' or u.hostname not in ('www.gutenberg.org','gutenberg.org') or u.username or u.password:raise ValueError('Gutenberg source required')
    p=u.path;m=re.match(r'^/ebooks/(\d+)\.(epub3?)(?:\.(noimages|images))?
    m=re.match(r'^/(?:files|ebooks)/(\d+)/(.*)',p)
    if m:p='/'+('/'.join(m[1][:-1]) or '0')+'/'+m[1]+'/'+m[2]
    return 'https://gutenberg.pglaf.org'+p.replace('/cache/generated/','/cache/epub/').removeprefix('/dirs')
def sha256(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def download(url,target,headers=None,workers=3,chunk_size=1024*1024):
    target=pathlib.Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    with request(url,headers,method='HEAD') as r:size=int(r.headers.get('content-length','0'));etag=r.headers.get('etag') or r.headers.get('last-modified','')
    if not 0<size<=1024**3:raise ValueError('Unsupported source size')
    identity={'url':url,'size':size,'etag':etag};stamp=pathlib.Path(str(target)+'.source.json')
    if target.exists() and target.stat().st_size==size and stamp.exists() and json.loads(stamp.read_text())==identity:return target
    parts=pathlib.Path(str(target)+'.parts');parts.mkdir(exist_ok=True);fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()[:16]
    def piece(start):
        end=min(size-1,start+chunk_size-1);out=parts/f'{fingerprint}-{start}'
        if out.exists() and out.stat().st_size==end-start+1:return out
        for attempt in range(4):
            try:
                with request(url,{**(headers or {}),'Range':f'bytes={start}-{end}',**({'If-Range':etag} if etag else {})}) as r:
                    valid=r.status==206 and r.headers.get('Content-Range','').split('/')[0]==f'bytes {start}-{end}'
                    if not valid and not(r.status==200 and start==0 and end==size-1):raise ValueError('Source range/identity changed')
                    data=r.read(end-start+2)
                    if len(data)!=end-start+1:raise ValueError('Incomplete source segment')
                tmp=pathlib.Path(str(out)+'.tmp');tmp.write_bytes(data);tmp.replace(out);return out
            except Exception:
                if attempt==3:raise
                time.sleep(2**attempt)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:files=list(pool.map(piece,range(0,size,chunk_size)))
    tmp=pathlib.Path(str(target)+'.tmp')
    with tmp.open('wb') as output:
        for f in files:
            with f.open('rb') as src:
                for b in iter(lambda:src.read(1024*1024),b''):output.write(b)
    tmp.replace(target);stamp.write_text(json.dumps(identity))
    for f in files:f.unlink()
    return target
,p)
    if m:
        ident,fmt,variant=m.groups()
        filename=(f'pg{ident}-images'+('-3' if fmt=='epub3' else '')+'.epub') if variant=='images' else f'pg{ident}.epub'
        p=f'/cache/epub/{ident}/{filename}'
    m=re.match(r'^/(?:files|ebooks)/(\d+)/(.*)',p)
    if m:p='/'+('/'.join(m[1][:-1]) or '0')+'/'+m[1]+'/'+m[2]
    return 'https://gutenberg.pglaf.org'+p.replace('/cache/generated/','/cache/epub/').removeprefix('/dirs')
def sha256(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def download(url,target,headers=None,workers=3,chunk_size=1024*1024):
    target=pathlib.Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    with request(url,headers,method='HEAD') as r:size=int(r.headers.get('content-length','0'));etag=r.headers.get('etag') or r.headers.get('last-modified','')
    if not 0<size<=1024**3:raise ValueError('Unsupported source size')
    identity={'url':url,'size':size,'etag':etag};stamp=pathlib.Path(str(target)+'.source.json')
    if target.exists() and target.stat().st_size==size and stamp.exists() and json.loads(stamp.read_text())==identity:return target
    parts=pathlib.Path(str(target)+'.parts');parts.mkdir(exist_ok=True);fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()[:16]
    def piece(start):
        end=min(size-1,start+chunk_size-1);out=parts/f'{fingerprint}-{start}'
        if out.exists() and out.stat().st_size==end-start+1:return out
        for attempt in range(4):
            try:
                with request(url,{**(headers or {}),'Range':f'bytes={start}-{end}',**({'If-Range':etag} if etag else {})}) as r:
                    valid=r.status==206 and r.headers.get('Content-Range','').split('/')[0]==f'bytes {start}-{end}'
                    if not valid and not(r.status==200 and start==0 and end==size-1):raise ValueError('Source range/identity changed')
                    data=r.read(end-start+2)
                    if len(data)!=end-start+1:raise ValueError('Incomplete source segment')
                tmp=pathlib.Path(str(out)+'.tmp');tmp.write_bytes(data);tmp.replace(out);return out
            except Exception:
                if attempt==3:raise
                time.sleep(2**attempt)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:files=list(pool.map(piece,range(0,size,chunk_size)))
    tmp=pathlib.Path(str(target)+'.tmp')
    with tmp.open('wb') as output:
        for f in files:
            with f.open('rb') as src:
                for b in iter(lambda:src.read(1024*1024),b''):output.write(b)
    tmp.replace(target);stamp.write_text(json.dumps(identity))
    for f in files:f.unlink()
    return target
