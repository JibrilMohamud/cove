"""Resumable production worker; secrets come from hidden stdin or environment."""
import argparse,hashlib,json,os,pathlib,sys,threading,time,urllib.request,urllib.error
from .catalog import bulk,edition,epub_source,text_record
from .media import download,mirror_url,sha256
from .epub_index import build
from .align import transcribe,align
class Api:
    def __init__(self,config):
        self.base=config['siteUrl'].rstrip('/')+'/api/fore';token=config.get('pipelineToken') or hashlib.sha256(('fore-audio-pipeline:'+config['siteBearer']).encode()).hexdigest()
        self.headers={'Authorization':'Bearer '+token,'User-Agent':'Cove-audio-pipeline/2.0'}
        if config.get('siteBearer'):self.headers['OAI-Sites-Authorization']='Bearer '+config['siteBearer']
    def call(self,path,method='GET',data=None,file=None,headers=None):
        h={**self.headers,**(headers or {})};payload=None
        if file:payload=open(file,'rb');h.update({'Content-Length':str(pathlib.Path(file).stat().st_size),'Content-Type':'application/octet-stream'})
        elif data is not None:payload=json.dumps(data).encode();h['Content-Type']='application/json'
        try:
            with urllib.request.urlopen(urllib.request.Request(self.base+path,data=payload,headers=h,method=method),timeout=180) as r:return json.load(r)
        except urllib.error.HTTPError as error:raise RuntimeError(f'API {error.code}: '+error.read(1500).decode(errors='replace')) from None
        finally:
            if file:payload.close()
    def finish(self,job,status,error=''):return self.call('/pipeline/jobs/'+job['id'],'PUT',{'leaseToken':job['lease_token'],'status':status,'error':error[:1000]})
def process(api,job,cache,threads):
    p=job['payload']
    if job['kind']=='discover':
        result=edition(p['gutenbergId'],p['candidates'],enrich=True)
        if not result:api.call('/pipeline/retire','POST',{'gutenbergId':p['gutenbergId']});return 'skipped','Not eligible public-domain audio'
        e,fp=result;api.call('/pipeline/edition','PUT',{'edition':e,'fingerprints':fp});return 'done',''
    e=api.call('/audio/'+p['editionId']);t=next((t for t in e['tracks'] if t['id']==p['trackId']),None)
    if not t or t['url']!=p['sourceUrl']:return 'skipped','Superseded source'
    folder=cache/e['id'];folder.mkdir(parents=True,exist_ok=True);audio=download(mirror_url(t['url']),folder/(p['fingerprint']+'.audio'));checksum=sha256(audio)
    import av
    with av.open(str(audio)) as media:duration=media.duration/av.time_base
    api.call(f"/pipeline/media/{e['id']}/{t['id']}",'PUT',file=audio,headers={'x-content-sha256':checksum,'x-audio-duration':str(duration),'x-source-url':t['url']})
    if not e['bookId']:return 'review','Playback ready; matching text edition needs editorial pairing'
    api.call('/pipeline/book','PUT',text_record(e['bookId']));text=folder/'book.epub'
    if e.get('epubSha256'):download(api.base+f"/audio/{e['id']}/text",text,headers=api.headers)
    else:download(mirror_url(epub_source(e['bookId'])),text)
    index_file=folder/(sha256(text)+'.index.json')
    if index_file.exists():index=json.loads(index_file.read_text())
    else:index=build(text);index_file.write_text(json.dumps(index))
    api.call('/pipeline/text/'+e['id'],'PUT',file=text,headers={'x-content-sha256':index['epubSha256'],'x-book-id':e['bookId']})
    model='base.en' if e['language']=='en' else 'small'
    transcript=transcribe(audio,folder/(checksum+'.transcript.json'),model=model,language=e['language'],threads=threads);result=align(index,transcript,t['id'],checksum)
    if result['status']!='checked' and model=='base.en':
        transcript=transcribe(audio,folder/(checksum+'.small.transcript.json'),model='small.en',language='en',threads=threads);result=align(index,transcript,t['id'],checksum)
    result['duration']=duration;(folder/(t['id']+'.map.json')).write_text(json.dumps(result))
    if result['status']!='checked':return 'review',result.get('reason','Timing needs review')
    api.call(f"/pipeline/alignment/{e['id']}/{t['id']}",'PUT',result);return 'done',''
def config_from_stdin():
    if not sys.stdin.isatty():return json.load(sys.stdin)
    import termios
    old=termios.tcgetattr(sys.stdin);new=termios.tcgetattr(sys.stdin);new[3]&=~termios.ECHO;termios.tcsetattr(sys.stdin,termios.TCSADRAIN,new);print('Ready for pipeline configuration on hidden stdin.',flush=True)
    try:return json.loads(sys.stdin.readline())
    finally:termios.tcsetattr(sys.stdin,termios.TCSADRAIN,old)
def run(config,args):
    api=Api(config);cache=pathlib.Path(args.cache);cache.mkdir(parents=True,exist_ok=True);os.environ.setdefault('FORE_RDF_CACHE',str(cache/'rdf'))
    if not args.no_discovery:
        items=bulk(cache)
        for i in range(0,len(items),100):api.call('/pipeline/discover','POST',{'items':items[i:i+100]})
        print(json.dumps({'discovered':len(items)}),flush=True)
    deadline=time.monotonic()+args.minutes*60;done=0
    while time.monotonic()<deadline and done<args.max_jobs:
        # Alternate discovery and media so a catalog backlog cannot starve playback/alignment.
        kind=args.kind or ('discover' if done%3==0 else 'track')
        job=api.call('/pipeline/claim','POST',{'kind':kind})
        if not job and not args.kind:job=api.call('/pipeline/claim','POST',{})
        if not job:break
        stop=threading.Event()
        def heartbeat():
            while not stop.wait(300):
                try:api.finish(job,'heartbeat')
                except Exception:return
        threading.Thread(target=heartbeat,daemon=True).start()
        try:status,error=process(api,job,cache,args.threads);api.finish(job,status,error);print(json.dumps({'job':job['id'],'status':status,'detail':error}),flush=True)
        except Exception as error:
            detail=str(error)[:900]
            try:api.finish(job,'retry',detail)
            except Exception:pass
            print(json.dumps({'job':job['id'],'status':'retry','detail':detail}),flush=True)
        finally:stop.set()
        done+=1
    print(json.dumps({'processed':done,'pipeline':api.call('/audio-status')}),flush=True)
def main():
    p=argparse.ArgumentParser();p.add_argument('--stdin',action='store_true');p.add_argument('--cache',default='.sites-runtime/pipeline');p.add_argument('--minutes',type=int,default=30);p.add_argument('--max-jobs',type=int,default=100);p.add_argument('--kind',choices=['discover','track']);p.add_argument('--no-discovery',action='store_true');p.add_argument('--threads',type=int,default=4);a=p.parse_args()
    site_url=os.environ.get('COVE_APP_INTERNAL_URL') or os.environ.get('FORE_SITE_URL')
    if not site_url:raise RuntimeError('COVE_APP_INTERNAL_URL binding or FORE_SITE_URL is required')
    config=config_from_stdin() if a.stdin else {'siteUrl':site_url,'pipelineToken':os.environ['FORE_SERVICE_TOKEN'],'siteBearer':os.environ.get('FORE_SITE_BEARER','')};run(config,a)
if __name__=='__main__':main()
